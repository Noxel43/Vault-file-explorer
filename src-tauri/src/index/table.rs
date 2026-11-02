//! The searchable copy of the index, held in memory as flat columns.
//!
//! SQLite is the durable store, but even an indexed substring query over millions of names
//! can't reach "instant" for common terms. Lowercased names live in one contiguous buffer
//! here instead, so a query is a SIMD scan of that buffer across all cores, and filtering or
//! sorting millions of rows touches only small fixed-size columns. Rows are looked up in
//! SQLite afterwards, only for the results actually returned.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use memchr::memmem::Finder;
use regex::bytes::{Regex, RegexBuilder};

use crate::fs_ops::{F_DIR, F_HIDDEN, F_SYSTEM};

/// Marks a removed row until the next compaction. Doesn't clash with the `fs_ops` flags.
const F_DEAD: u8 = 128;

const DIR_HIDDEN: u8 = 1;
/// System, cache and program folders: searchable, but ranked below the user's own files.
const DIR_NOISY: u8 = 2;

const NOISY_PARTS: [&str; 7] = [
    "\\appdata\\",
    "\\windows\\",
    "\\program files\\",
    "\\program files (x86)\\",
    "\\programdata\\",
    "\\$",
    "\\.",
];

/// Parallelism isn't worth the thread start-up below this many rows.
const PARALLEL_ROWS: usize = 50_000;
const COMPACT_MIN_DEAD: usize = 100_000;

// ---------------------------------------------------------------- categories

const CATEGORIES_JSON: &str = include_str!("../../../src/lib/categories.json");

pub const CAT_FOLDER: u8 = 0;
pub const CAT_OTHER: u8 = 1;

struct Categories {
    names: Vec<String>,
    by_ext: HashMap<String, u8>,
}

/// The extension table is shared with the frontend, so the two can't disagree.
fn categories() -> &'static Categories {
    static CATEGORIES: OnceLock<Categories> = OnceLock::new();
    CATEGORIES.get_or_init(|| {
        let table: Vec<(String, String)> =
            serde_json::from_str(CATEGORIES_JSON).expect("categories.json is valid");
        let mut names = vec!["folder".to_string(), "other".to_string()];
        let mut by_ext = HashMap::new();
        for (name, exts) in table {
            let id = names.len() as u8;
            names.push(name);
            for ext in exts.split_whitespace() {
                by_ext.insert(ext.to_string(), id); // later categories win, as in fileTypes.ts
            }
        }
        Categories { names, by_ext }
    })
}

pub fn category_names() -> &'static [String] {
    &categories().names
}

pub fn category_id(name: &str) -> Option<u8> {
    category_names()
        .iter()
        .position(|n| n == name)
        .map(|i| i as u8)
}

fn category_of(lower_name: &str, is_dir: bool) -> u8 {
    if is_dir {
        return CAT_FOLDER;
    }
    match lower_name.rfind('.') {
        Some(dot) if dot > 0 => categories()
            .by_ext
            .get(&lower_name[dot + 1..])
            .copied()
            .unwrap_or(CAT_OTHER),
        _ => CAT_OTHER,
    }
}

// ---------------------------------------------------------------- table

struct DirInfo {
    /// Lowercase, always ending in one backslash so prefix tests can't match "C:\foobar" for "C:\foo".
    lower: Box<str>,
    depth: u8,
    flags: u8,
}

pub struct NewRow<'a> {
    pub id: u32,
    pub dir: u32,
    pub lower_name: &'a str,
    pub size: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
    pub flags: u8,
}

#[derive(Default)]
pub struct Table {
    /// SQLite row ids: AUTOINCREMENT makes these strictly increasing, so they can be binary searched.
    ids: Vec<u32>,
    name_at: Vec<u32>,
    /// NUL-terminated lowercase names. NUL can't appear in a file name or a query.
    names: Vec<u8>,
    dir: Vec<u32>,
    size: Vec<u64>,
    /// Seconds are precise enough to filter and sort by, and half the size of milliseconds.
    modified: Vec<u32>,
    created: Vec<u32>,
    flags: Vec<u8>,
    category: Vec<u8>,
    /// Indexed by SQLite dir id.
    dirs: Vec<Option<DirInfo>>,
    live_dirs: usize,
    live: usize,
    dead: usize,
}

fn seconds(ms: u64) -> u32 {
    (ms / 1000).min(u32::MAX as u64) as u32
}

pub fn dir_key(lower_path: &str) -> String {
    let trimmed = lower_path.trim_end_matches('\\');
    format!("{trimmed}\\")
}

impl Table {
    pub fn reserve(&mut self, rows: usize, name_bytes: usize) {
        self.ids.reserve(rows);
        self.name_at.reserve(rows);
        self.names.reserve(name_bytes + rows);
        self.dir.reserve(rows);
        self.size.reserve(rows);
        self.modified.reserve(rows);
        self.created.reserve(rows);
        self.flags.reserve(rows);
        self.category.reserve(rows);
    }

    pub fn live_rows(&self) -> usize {
        self.live
    }

    pub fn live_dirs(&self) -> usize {
        self.live_dirs
    }

    /// Approximate heap use of the table, shown in Settings.
    pub fn memory_bytes(&self) -> usize {
        let dirs: usize = self.dirs.iter().flatten().map(|d| d.lower.len() + 16).sum();
        self.ids.capacity() * 4
            + self.name_at.capacity() * 4
            + self.names.capacity()
            + self.dir.capacity() * 4
            + self.size.capacity() * 8
            + self.modified.capacity() * 4
            + self.created.capacity() * 4
            + self.flags.capacity()
            + self.category.capacity()
            + self.dirs.capacity() * size_of::<Option<DirInfo>>()
            + dirs
    }

    pub fn set_dir(&mut self, id: u32, lower_path: &str, hidden: bool) {
        let lower = dir_key(lower_path);
        let mut flags = if hidden { DIR_HIDDEN } else { 0 };
        if NOISY_PARTS.iter().any(|part| lower.contains(part)) {
            flags |= DIR_NOISY;
        }
        let depth = lower.bytes().filter(|&b| b == b'\\').count().min(255) as u8;
        let slot = id as usize;
        if self.dirs.len() <= slot {
            self.dirs.resize_with(slot + 1, || None);
        }
        if self.dirs[slot].is_none() {
            self.live_dirs += 1;
        }
        self.dirs[slot] = Some(DirInfo {
            lower: lower.into(),
            depth,
            flags,
        });
    }

    pub fn remove_dir(&mut self, id: u32) {
        if let Some(slot) = self.dirs.get_mut(id as usize)
            && slot.take().is_some()
        {
            self.live_dirs -= 1;
        }
    }

    pub fn push(&mut self, row: NewRow) {
        debug_assert!(self.ids.last().is_none_or(|&last| last < row.id));
        self.ids.push(row.id);
        self.name_at.push(self.names.len() as u32);
        self.names.extend_from_slice(row.lower_name.as_bytes());
        self.names.push(0);
        self.dir.push(row.dir);
        self.size.push(row.size);
        self.modified.push(seconds(row.modified_ms));
        self.created.push(seconds(row.created_ms));
        self.flags.push(row.flags);
        self.category
            .push(category_of(row.lower_name, row.flags & F_DIR != 0));
        self.live += 1;
    }

    fn row_of(&self, id: u32) -> Option<usize> {
        self.ids.binary_search(&id).ok()
    }

    /// Size, dates and flags of an existing row. A changed name is a new row instead.
    pub fn update(&mut self, id: u32, size: u64, modified_ms: u64, created_ms: u64, flags: u8) {
        let Some(row) = self.row_of(id) else { return };
        if self.flags[row] & F_DEAD != 0 {
            return;
        }
        self.size[row] = size;
        self.modified[row] = seconds(modified_ms);
        self.created[row] = seconds(created_ms);
        if (self.flags[row] ^ flags) & F_DIR != 0 {
            let name = std::str::from_utf8(self.name(row)).unwrap_or("");
            self.category[row] = category_of(name, flags & F_DIR != 0);
        }
        self.flags[row] = flags;
    }

    pub fn remove(&mut self, id: u32) {
        if let Some(row) = self.row_of(id)
            && self.flags[row] & F_DEAD == 0
        {
            self.flags[row] |= F_DEAD;
            self.live -= 1;
            self.dead += 1;
        }
    }

    /// Reclaims removed rows once they're worth the pause (a fraction of a second at most).
    pub fn compact_if_needed(&mut self) {
        if self.dead < COMPACT_MIN_DEAD || self.dead < self.live / 4 {
            return;
        }
        let mut names = Vec::with_capacity(self.names.len());
        let mut kept = 0;
        for row in 0..self.ids.len() {
            if self.flags[row] & F_DEAD != 0 {
                continue;
            }
            let at = names.len() as u32;
            names.extend_from_slice(self.name(row));
            names.push(0);
            self.ids[kept] = self.ids[row];
            self.name_at[kept] = at;
            self.dir[kept] = self.dir[row];
            self.size[kept] = self.size[row];
            self.modified[kept] = self.modified[row];
            self.created[kept] = self.created[row];
            self.flags[kept] = self.flags[row];
            self.category[kept] = self.category[row];
            kept += 1;
        }
        self.names = names;
        self.ids.truncate(kept);
        self.name_at.truncate(kept);
        self.dir.truncate(kept);
        self.size.truncate(kept);
        self.modified.truncate(kept);
        self.created.truncate(kept);
        self.flags.truncate(kept);
        self.category.truncate(kept);
        self.dead = 0;
    }

    fn name(&self, row: usize) -> &[u8] {
        let start = self.name_at[row] as usize;
        let end = self
            .name_at
            .get(row + 1)
            .map_or(self.names.len(), |&n| n as usize);
        &self.names[start..end - 1]
    }

    fn dir_info(&self, row: usize) -> Option<&DirInfo> {
        self.dirs.get(self.dir[row] as usize)?.as_ref()
    }
}

// ---------------------------------------------------------------- queries

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SortKey {
    Relevance,
    Name,
    Folder,
    Modified,
    Created,
    Size,
    Type,
}

pub struct Query {
    /// Each must appear in the name, and they rank results by how they match.
    pub terms: Vec<String>,
    /// Each must appear in the folder path, from terms like `docs\report`.
    pub dir_terms: Vec<String>,
    /// Lowercase folder this search is limited to.
    pub scope: Option<String>,
    pub pattern: Option<NamePattern>,
    pub types: Option<Vec<u8>>,
    pub use_created: bool,
    pub date_from_ms: Option<u64>,
    pub date_to_ms: Option<u64>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    pub show_hidden: bool,
    /// Row ids carrying the requested tags.
    pub allowed: Option<HashSet<u32>>,
    pub sort: SortKey,
    pub descending: bool,
    pub folders_first: bool,
    pub limit: usize,
}

impl Default for Query {
    fn default() -> Self {
        Query {
            terms: vec![],
            dir_terms: vec![],
            scope: None,
            pattern: None,
            types: None,
            use_created: false,
            date_from_ms: None,
            date_to_ms: None,
            size_min: None,
            size_max: None,
            show_hidden: true,
            allowed: None,
            sort: SortKey::Relevance,
            descending: false,
            folders_first: false,
            limit: 1000,
        }
    }
}

/// Splits the search box text. Spaces separate terms, quotes keep a phrase together, and a
/// backslash splits a term into a folder part and a name part: `docs\report` is "report" in
/// any folder whose path contains "docs\".
pub fn parse_terms(query: &str) -> (Vec<String>, Vec<String>) {
    let lower = query.to_lowercase();
    let mut terms = Vec::new();
    let mut dir_terms = Vec::new();
    let mut add = |token: &str| {
        if token.is_empty() {
            return;
        }
        let token = token.replace('/', "\\");
        match token.rsplit_once('\\') {
            Some((dir, name)) => {
                if !dir.is_empty() {
                    dir_terms.push(format!("{dir}\\"));
                }
                if !name.is_empty() {
                    terms.push(name.to_string());
                }
            }
            None => terms.push(token),
        }
    };
    for (i, part) in lower.split('"').enumerate() {
        if i % 2 == 1 {
            add(part); // inside quotes
        } else {
            part.split_whitespace().for_each(&mut add);
        }
    }
    (terms, dir_terms)
}

/// The filter bar's pattern box: a list of globs, or a regex.
pub struct NamePattern {
    include: Vec<Regex>,
    exclude: Vec<Regex>,
}

fn glob_regex(glob: &str) -> Result<Regex, String> {
    let mut re = String::from("^");
    for ch in glob.chars() {
        match ch {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    build_regex(&re)
}

fn build_regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .build()
        .map_err(|e| e.to_string())
}

impl NamePattern {
    /// Same syntax as the folder filter in filters.ts: `;` or `,` separates globs, `!` excludes.
    pub fn parse(pattern: &str, is_regex: bool) -> Result<Option<NamePattern>, String> {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Ok(None);
        }
        if is_regex {
            return Ok(Some(NamePattern {
                include: vec![build_regex(pattern)?],
                exclude: vec![],
            }));
        }
        let mut include = Vec::new();
        let mut exclude = Vec::new();
        for part in pattern
            .split([';', ','])
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            match part.strip_prefix('!') {
                Some(rest) => exclude.push(glob_regex(rest)?),
                None => include.push(glob_regex(part)?),
            }
        }
        Ok(Some(NamePattern { include, exclude }))
    }

    fn matches(&self, name: &[u8]) -> bool {
        (self.include.is_empty() || self.include.iter().any(|r| r.is_match(name)))
            && !self.exclude.iter().any(|r| r.is_match(name))
    }
}

pub struct Outcome {
    /// Row ids of the best `limit` matches, in display order.
    pub ids: Vec<u32>,
    pub total: usize,
    /// Matches per category, ignoring the type filter so the type menu can offer the others.
    pub categories: Vec<u32>,
    /// A newer search started, so this one gave up.
    pub stale: bool,
}

struct Compiled<'q> {
    q: &'q Query,
    finders: Vec<Finder<'static>>,
    /// Allowed dir ids, when the query depends on the folder path.
    dirs_ok: Option<Vec<bool>>,
    types: Option<[bool; 256]>,
    from_s: Option<u32>,
    to_s: Option<u32>,
}

impl Compiled<'_> {
    /// Every filter except the type, which is applied afterwards so categories can be counted.
    fn passes(&self, t: &Table, row: usize) -> bool {
        let flags = t.flags[row];
        if flags & F_DEAD != 0 {
            return false;
        }
        let q = self.q;
        if !q.show_hidden {
            if flags & (F_HIDDEN | F_SYSTEM) != 0 {
                return false;
            }
            if t.dir_info(row).is_some_and(|d| d.flags & DIR_HIDDEN != 0) {
                return false;
            }
        }
        if let Some(ok) = &self.dirs_ok
            && !ok.get(t.dir[row] as usize).copied().unwrap_or(false)
        {
            return false;
        }
        if q.size_min.is_some() || q.size_max.is_some() {
            // Same rule as the folder filter: size filters only make sense for files.
            if flags & F_DIR != 0 {
                return false;
            }
            let size = t.size[row];
            if q.size_min.is_some_and(|m| size < m) || q.size_max.is_some_and(|m| size > m) {
                return false;
            }
        }
        if self.from_s.is_some() || self.to_s.is_some() {
            let at = if q.use_created {
                t.created[row]
            } else {
                t.modified[row]
            };
            if self.from_s.is_some_and(|f| at < f) || self.to_s.is_some_and(|e| at >= e) {
                return false;
            }
        }
        if let Some(allowed) = &q.allowed
            && !allowed.contains(&t.ids[row])
        {
            return false;
        }
        let name = t.name(row);
        // The first finder is the one the scan already used.
        if self.finders.iter().skip(1).any(|f| f.find(name).is_none()) {
            return false;
        }
        q.pattern.as_ref().is_none_or(|p| p.matches(name))
    }

    fn scan_rows(
        &self,
        t: &Table,
        start: usize,
        end: usize,
        generation: &AtomicU64,
        mine: u64,
    ) -> Option<Scan> {
        let mut scan = Scan {
            hits: Vec::new(),
            categories: vec![0; 256],
        };
        let mut accept = |row: usize| {
            if self.passes(t, row) {
                let cat = t.category[row];
                scan.categories[cat as usize] += 1;
                if self.types.is_none_or(|ok| ok[cat as usize]) {
                    scan.hits.push(row as u32);
                }
            }
        };
        if let Some(finder) = self.finders.first() {
            // Scanning the whole buffer at once is what makes this fast. Hits arrive in row
            // order, so each lookup only searches what's left.
            let from = t.name_at[start] as usize;
            let to = t.name_at.get(end).map_or(t.names.len(), |&n| n as usize);
            let mut next_row = start;
            for (count, hit) in finder.find_iter(&t.names[from..to]).enumerate() {
                let hit = (from + hit) as u32;
                if hit < t.name_at.get(next_row).copied().unwrap_or(u32::MAX) {
                    continue; // another hit inside a name that already matched
                }
                let row = next_row + t.name_at[next_row..end].partition_point(|&at| at <= hit) - 1;
                accept(row);
                next_row = row + 1;
                if next_row >= end {
                    break;
                }
                if count & 0x3FFF == 0 && generation.load(AtomicOrdering::Relaxed) != mine {
                    return None;
                }
            }
        } else {
            for row in start..end {
                accept(row);
                if row & 0x3FFF == 0 && generation.load(AtomicOrdering::Relaxed) != mine {
                    return None;
                }
            }
        }
        Some(scan)
    }
}

struct Scan {
    hits: Vec<u32>,
    categories: Vec<u32>,
}

fn word_start(name: &[u8], at: usize) -> bool {
    at == 0 || !name[at - 1].is_ascii_alphanumeric()
}

/// Lower is better: how the term matches, then whether the folder is one people care about,
/// then how shallow it is and how short the name is.
fn relevance(t: &Table, row: usize, term: Option<&[u8]>) -> u64 {
    let name = t.name(row);
    let bucket = match term {
        None => 0,
        Some(term) if name == term => 0,
        Some(term) if name.rsplit_once_dot() == Some(term) => 1,
        Some(term) if name.starts_with(term) => 2,
        Some(term) => {
            let starts_word = memchr::memmem::find_iter(name, term).any(|at| word_start(name, at));
            if starts_word { 3 } else { 4 }
        }
    };
    let (depth, dir_flags) = t
        .dir_info(row)
        .map_or((255, 0), |d| (d.depth as u64, d.flags));
    let hidden = t.flags[row] & (F_HIDDEN | F_SYSTEM) != 0 || dir_flags & DIR_HIDDEN != 0;
    let noise = u64::from(hidden || dir_flags & DIR_NOISY != 0);
    (noise << 44) | (bucket << 40) | (depth << 24) | (name.len().min(0xFF_FFFF) as u64)
}

trait NameExt {
    fn rsplit_once_dot(&self) -> Option<&[u8]>;
    fn extension(&self) -> &[u8];
}

impl NameExt for [u8] {
    /// The name without its extension.
    fn rsplit_once_dot(&self) -> Option<&[u8]> {
        let dot = self.iter().rposition(|&b| b == b'.')?;
        (dot > 0).then(|| &self[..dot])
    }

    fn extension(&self) -> &[u8] {
        match self.rsplit_once_dot() {
            Some(stem) => &self[stem.len() + 1..],
            None => &[],
        }
    }
}

/// Orders "file2" before "file10", matching the numeric collation of folder listings.
fn natural_cmp(a: &[u8], b: &[u8]) -> Ordering {
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let start_a = i;
            let start_b = j;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let trim = |s: &'_ [u8]| -> usize { s.iter().take_while(|&&c| c == b'0').count() };
            let na = &a[start_a + trim(&a[start_a..i]).min(i - start_a)..i];
            let nb = &b[start_b + trim(&b[start_b..j]).min(j - start_b)..j];
            let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            if a[i] != b[j] {
                return a[i].cmp(&b[j]);
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

/// Orders `items` and keeps the first `limit`, without paying to sort the rest.
fn top_k<T>(items: &mut Vec<T>, limit: usize, cmp: impl Fn(&T, &T) -> Ordering) {
    if limit > 0 && items.len() > limit {
        items.select_nth_unstable_by(limit - 1, &cmp);
        items.truncate(limit);
    }
    items.sort_unstable_by(&cmp);
}

impl Table {
    fn dirs_allowed(&self, q: &Query) -> Option<Vec<bool>> {
        if q.scope.is_none() && q.dir_terms.is_empty() {
            return None;
        }
        let scope = q.scope.as_deref().map(dir_key);
        Some(
            self.dirs
                .iter()
                .map(|slot| {
                    slot.as_ref().is_some_and(|d| {
                        scope
                            .as_ref()
                            .is_none_or(|s| d.lower.starts_with(s.as_str()))
                            && q.dir_terms
                                .iter()
                                .all(|term| d.lower.contains(term.as_str()))
                    })
                })
                .collect(),
        )
    }

    /// Runs a query. `generation` lets a newer search cancel this one.
    pub fn search(&self, q: &Query, generation: &AtomicU64, mine: u64) -> Outcome {
        // Scan for the longest term: it's the most selective, so fewest rows need checking.
        let mut scan_terms: Vec<&String> = q.terms.iter().collect();
        scan_terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
        let types = q.types.as_ref().map(|list| {
            let mut ok = [false; 256];
            list.iter().for_each(|&cat| ok[cat as usize] = true);
            ok
        });
        let compiled = Compiled {
            q,
            finders: scan_terms
                .iter()
                .map(|t| Finder::new(t.as_bytes()).into_owned())
                .collect(),
            dirs_ok: self.dirs_allowed(q),
            types,
            from_s: q.date_from_ms.map(seconds),
            to_s: q.date_to_ms.map(seconds),
        };

        let rows = self.ids.len();
        let threads = if rows < PARALLEL_ROWS {
            1
        } else {
            std::thread::available_parallelism()
                .map_or(1, |n| n.get())
                .min(16)
        };
        let chunk = rows.div_ceil(threads).max(1);
        let scans: Vec<Option<Scan>> = if threads == 1 {
            vec![if rows == 0 {
                Some(Scan {
                    hits: vec![],
                    categories: vec![0; 256],
                })
            } else {
                compiled.scan_rows(self, 0, rows, generation, mine)
            }]
        } else {
            std::thread::scope(|scope| {
                let workers: Vec<_> = (0..threads)
                    .map(|i| {
                        let start = (i * chunk).min(rows);
                        let end = (start + chunk).min(rows);
                        let compiled = &compiled;
                        scope.spawn(move || {
                            if start == end {
                                Some(Scan {
                                    hits: vec![],
                                    categories: vec![0; 256],
                                })
                            } else {
                                compiled.scan_rows(self, start, end, generation, mine)
                            }
                        })
                    })
                    .collect();
                workers
                    .into_iter()
                    .map(|w| w.join().expect("search worker panicked"))
                    .collect()
            })
        };

        let names = category_names();
        let mut categories = vec![0u32; names.len()];
        let mut hits = Vec::new();
        for scan in scans {
            let Some(scan) = scan else {
                return Outcome {
                    ids: vec![],
                    total: 0,
                    categories,
                    stale: true,
                };
            };
            hits.extend_from_slice(&scan.hits);
            for (slot, count) in categories.iter_mut().zip(&scan.categories) {
                *slot += count;
            }
        }
        let total = hits.len();
        let ids = self
            .order(hits, q)
            .into_iter()
            .map(|row| self.ids[row as usize])
            .collect();
        Outcome {
            ids,
            total,
            categories,
            stale: false,
        }
    }

    fn order(&self, mut hits: Vec<u32>, q: &Query) -> Vec<u32> {
        let limit = q.limit;
        let folder_rank = |row: u32| {
            if q.folders_first && self.flags[row as usize] & F_DIR != 0 {
                0u8
            } else {
                1
            }
        };
        let dir = |ord: Ordering| if q.descending { ord.reverse() } else { ord };
        let by_name = |a: u32, b: u32| natural_cmp(self.name(a as usize), self.name(b as usize));
        match q.sort {
            SortKey::Relevance => {
                let term = q.terms.first().map(|t| t.as_bytes());
                let mut keyed: Vec<(u64, u32)> = hits
                    .iter()
                    .map(|&row| (relevance(self, row as usize, term), row))
                    .collect();
                top_k(&mut keyed, limit, |a, b| {
                    a.0.cmp(&b.0).then_with(|| by_name(a.1, b.1))
                });
                keyed.into_iter().map(|(_, row)| row).collect()
            }
            SortKey::Size | SortKey::Modified | SortKey::Created => {
                let value = |row: u32| match q.sort {
                    SortKey::Size => self.size[row as usize],
                    SortKey::Modified => self.modified[row as usize] as u64,
                    _ => self.created[row as usize] as u64,
                };
                top_k(&mut hits, limit, |&a, &b| {
                    folder_rank(a)
                        .cmp(&folder_rank(b))
                        .then_with(|| dir(value(a).cmp(&value(b))))
                        .then_with(|| by_name(a, b))
                });
                hits
            }
            SortKey::Name => {
                top_k(&mut hits, limit, |&a, &b| {
                    folder_rank(a)
                        .cmp(&folder_rank(b))
                        .then_with(|| dir(by_name(a, b)))
                });
                hits
            }
            SortKey::Type => {
                top_k(&mut hits, limit, |&a, &b| {
                    let ext = |row: u32| self.name(row as usize).extension();
                    folder_rank(a)
                        .cmp(&folder_rank(b))
                        .then_with(|| dir(ext(a).cmp(ext(b))))
                        .then_with(|| by_name(a, b))
                });
                hits
            }
            SortKey::Folder => {
                let path = |row: u32| self.dir_info(row as usize).map_or("", |d| &d.lower);
                top_k(&mut hits, limit, |&a, &b| {
                    folder_rank(a)
                        .cmp(&folder_rank(b))
                        .then_with(|| dir(natural_cmp(path(a).as_bytes(), path(b).as_bytes())))
                        .then_with(|| by_name(a, b))
                });
                hits
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Table {
        let mut t = Table::default();
        t.set_dir(1, r"c:\users\me\docs", false);
        t.set_dir(2, r"c:\users\me\docs\old stuff", false);
        t.set_dir(3, r"c:\windows\system32", false);
        t.set_dir(4, r"c:\users\me\appdata\hidden", true);
        let rows: [(u32, &str, u64, u64, u8); 9] = [
            (1, "report.pdf", 500, 1_000_000, 0),
            (2, "quarterly report 2.pdf", 2_000, 2_000_000, 0),
            (3, "quarterly report 10.pdf", 3_000, 3_000_000, 0),
            (4, "notes.txt", 10, 4_000_000, 0),
            (5, "photos", 0, 5_000_000, F_DIR),
            (6, "report", 4_000, 6_000_000, F_DIR),
            (7, "ntdll.dll", 9_000, 7_000_000, F_SYSTEM),
            (8, "report.pdf", 800, 8_000_000, 0),
            (9, "preporter.txt", 1, 9_000_000, 0),
        ];
        let dirs = [1, 1, 1, 1, 1, 1, 3, 4, 2];
        for ((id, name, size, modified, flags), dir) in rows.into_iter().zip(dirs) {
            t.push(NewRow {
                id,
                dir,
                lower_name: name,
                size,
                modified_ms: modified,
                created_ms: modified / 2,
                flags,
            });
        }
        t
    }

    fn run(t: &Table, q: Query) -> Vec<u32> {
        t.search(&q, &AtomicU64::new(0), 0).ids
    }

    fn with_terms(text: &str) -> Query {
        let (terms, dir_terms) = parse_terms(text);
        Query {
            terms,
            dir_terms,
            ..Query::default()
        }
    }

    #[test]
    fn parses_terms_phrases_and_folders() {
        let (terms, dirs) = parse_terms(r#"Report "Old Stuff" docs\Q3 c:/users/ \"#);
        assert_eq!(terms, vec!["report", "old stuff", "q3"]);
        assert_eq!(dirs, vec!["docs\\", "c:\\users\\"]);
        assert_eq!(parse_terms("   "), (vec![], vec![]));
    }

    #[test]
    fn matches_every_term_case_folded_by_the_query() {
        let t = table();
        assert_eq!(run(&t, with_terms("quarterly 10")), vec![3]);
        assert!(run(&t, with_terms("missing")).is_empty());
        assert_eq!(run(&t, with_terms("rt 2 pdf")), vec![2]);
    }

    #[test]
    fn best_match_ranks_exact_then_stem_then_prefix_then_word_then_noise() {
        let t = table();
        let order = run(
            &t,
            Query {
                show_hidden: true,
                ..with_terms("report")
            },
        );
        // 6: exact folder name, 1: stem, 2/3: word match, 9: mid-word, 8: same stem but in a hidden folder.
        assert_eq!(order, vec![6, 1, 2, 3, 9, 8]);
    }

    #[test]
    fn hidden_covers_system_files_and_everything_in_hidden_folders() {
        let t = table();
        let found = run(
            &t,
            Query {
                show_hidden: false,
                ..with_terms("report")
            },
        );
        assert!(!found.contains(&8));
        let dlls = run(
            &t,
            Query {
                show_hidden: false,
                ..with_terms("ntdll")
            },
        );
        assert!(dlls.is_empty());
        assert_eq!(run(&t, with_terms("ntdll")), vec![7]);
    }

    #[test]
    fn filters_by_folder_scope_and_folder_terms() {
        let t = table();
        let scoped = Query {
            scope: Some(r"c:\users\me\docs\old stuff".into()),
            ..Query::default()
        };
        assert_eq!(run(&t, scoped), vec![9]);
        // A sibling that merely shares the prefix isn't inside the scope.
        let sibling = Query {
            scope: Some(r"c:\users\me\do".into()),
            ..Query::default()
        };
        assert!(run(&t, sibling).is_empty());
        assert_eq!(run(&t, with_terms(r#""old stuff\pre""#)), vec![9]);
        assert_eq!(run(&t, with_terms(r"system32\")), vec![7]);
    }

    #[test]
    fn filters_by_size_date_type_and_pattern() {
        let t = table();
        // Size filters leave out folders, like the folder filter does.
        let big = Query {
            size_min: Some(2_000),
            sort: SortKey::Size,
            descending: true,
            ..Query::default()
        };
        assert_eq!(run(&t, big), vec![7, 3, 2]);
        let small = Query {
            size_max: Some(10),
            sort: SortKey::Size,
            ..Query::default()
        };
        assert_eq!(run(&t, small), vec![9, 4]);

        let recent = Query {
            date_from_ms: Some(8_000_000),
            sort: SortKey::Modified,
            descending: true,
            ..Query::default()
        };
        assert_eq!(run(&t, recent), vec![9, 8]);
        let created = Query {
            use_created: true,
            date_to_ms: Some(1_000_000),
            sort: SortKey::Created,
            ..Query::default()
        };
        assert_eq!(run(&t, created), vec![1]);

        let pdfs = category_id("pdf").unwrap();
        let typed = Query {
            types: Some(vec![pdfs]),
            sort: SortKey::Modified,
            ..Query::default()
        };
        assert_eq!(run(&t, typed), vec![1, 2, 3, 8]);

        let glob = NamePattern::parse("*.txt; !notes*", false).unwrap();
        assert_eq!(
            run(
                &t,
                Query {
                    pattern: glob,
                    ..Query::default()
                }
            ),
            vec![9]
        );
        let regex = NamePattern::parse(r"^report\.PDF$", true).unwrap();
        assert_eq!(
            run(
                &t,
                Query {
                    pattern: regex,
                    ..Query::default()
                }
            ),
            vec![1, 8]
        );
        assert!(NamePattern::parse("(", true).is_err());
    }

    #[test]
    fn counts_categories_regardless_of_the_type_filter() {
        let t = table();
        let txt = category_id("text").unwrap();
        let out = t.search(
            &Query {
                types: Some(vec![txt]),
                ..with_terms("report")
            },
            &AtomicU64::new(0),
            0,
        );
        assert_eq!(out.total, 1);
        assert_eq!(out.categories[category_id("pdf").unwrap() as usize], 4);
        assert_eq!(out.categories[CAT_FOLDER as usize], 1);
    }

    #[test]
    fn sorts_naturally_and_caps_results_but_reports_the_total() {
        let t = table();
        let sorted = run(
            &t,
            Query {
                sort: SortKey::Name,
                ..with_terms("quarterly")
            },
        );
        assert_eq!(sorted, vec![2, 3]);
        let reversed = run(
            &t,
            Query {
                sort: SortKey::Name,
                descending: true,
                ..with_terms("quarterly")
            },
        );
        assert_eq!(reversed, vec![3, 2]);
        assert_eq!(natural_cmp(b"a007b", b"a7c"), Ordering::Less);

        let capped = t.search(
            &Query {
                limit: 2,
                ..Query::default()
            },
            &AtomicU64::new(0),
            0,
        );
        assert_eq!((capped.ids.len(), capped.total), (2, 9));

        let first = run(
            &t,
            Query {
                sort: SortKey::Name,
                folders_first: true,
                ..Query::default()
            },
        );
        assert_eq!(&first[..2], &[5, 6]);
    }

    #[test]
    fn updates_removes_and_compacts() {
        let mut t = table();
        t.update(1, 77, 42_000, 42_000, 0);
        let big = Query {
            size_min: Some(77),
            size_max: Some(77),
            ..Query::default()
        };
        assert_eq!(run(&t, big), vec![1]);

        t.remove(1);
        assert_eq!(t.live_rows(), 8);
        assert_eq!(run(&t, with_terms("notes")), vec![4]);
        assert!(!run(&t, with_terms("report")).contains(&1));

        // Forced: the threshold is too high to reach in a small test.
        t.dead = COMPACT_MIN_DEAD;
        t.live = 8;
        t.compact_if_needed();
        assert_eq!(t.ids.len(), 8);
        assert_eq!(run(&t, with_terms("notes")), vec![4]);
        assert_eq!(run(&t, with_terms("ntdll")), vec![7]);

        t.push(NewRow {
            id: 50,
            dir: 1,
            lower_name: "new.txt",
            size: 1,
            modified_ms: 0,
            created_ms: 0,
            flags: 0,
        });
        assert_eq!(run(&t, with_terms("new")), vec![50]);
    }

    #[test]
    fn a_newer_search_cancels_an_older_one() {
        let t = table();
        let out = t.search(&Query::default(), &AtomicU64::new(5), 4);
        assert!(out.stale);
    }

    #[test]
    fn category_table_matches_the_frontend_rules() {
        assert_eq!(category_of("a.png", false), category_id("image").unwrap());
        assert_eq!(category_of("a.ts", false), category_id("code").unwrap());
        assert_eq!(
            category_of("a.bat", false),
            category_id("executable").unwrap()
        );
        assert_eq!(category_of(".gitignore", false), CAT_OTHER);
        assert_eq!(category_of("noext", false), CAT_OTHER);
        assert_eq!(category_of("a.png", true), CAT_FOLDER);
    }
}
