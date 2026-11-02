//! Background file indexing. One low-priority thread per drive walks the filesystem and diffs
//! each folder against SQLite; a watcher keeps it current afterwards. Nothing here runs on a
//! thread the UI waits for, and walking never blocks searching.

mod store;
mod table;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use store::Store;
use table::{NamePattern, NewRow, Query, SortKey, Table};

use crate::fs_ops::{self, F_DIR, F_HIDDEN, F_SYMLINK, F_SYSTEM, Packed};

/// Windows has no cheap way to ask what changed while Vault was closed without elevation, so a
/// launch re-walks if the last walk is older than this. It's a background diff, not a rebuild.
const RESCAN_ON_LAUNCH_AFTER: Duration = Duration::from_secs(60 * 60);
/// The watcher's buffer can overflow unnoticed under heavy churn, so walks also repeat.
const RESCAN_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// Lets a launch finish before a re-walk adds disk activity.
const RESCAN_DELAY: Duration = Duration::from_secs(20);
const WATCH_FLUSH_EVERY: Duration = Duration::from_millis(1500);
/// More results than anyone reads; past this, refining the search is the better tool.
const MAX_RESULTS: usize = 5_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lower_key(path: &str) -> String {
    path.to_lowercase()
}

/// What to index. Plain names exclude that folder anywhere; paths exclude one place.
struct Config {
    roots: Vec<String>,
    exclude_names: HashSet<String>,
    exclude_paths: Vec<String>,
    key: String,
}

impl Config {
    fn new(roots: &[String], excludes: &[String]) -> Config {
        let mut resolved: Vec<String> = roots
            .iter()
            .filter_map(|r| fs_ops::resolve_path(r).ok())
            .collect::<Vec<_>>();
        resolved.sort_by_key(|r| lower_key(r));
        resolved.dedup_by_key(|r| lower_key(r));
        // A folder inside another root would be walked twice.
        let mut kept: Vec<String> = Vec::new();
        for root in resolved {
            let lower = lower_key(&root);
            let covered = kept
                .iter()
                .any(|k| lower.starts_with(&table::dir_key(&lower_key(k))));
            if !covered {
                kept.push(root);
            }
        }

        let mut exclude_names = HashSet::new();
        let mut exclude_paths = Vec::new();
        for raw in excludes {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            if raw.contains(['\\', '/', '%', ':']) {
                // Allowed to not exist yet: nothing is excluded until it does.
                let expanded = fs_ops::resolve_path(raw).unwrap_or_else(|_| raw.to_string());
                exclude_paths.push(lower_key(expanded.trim_end_matches('\\')));
            } else {
                exclude_names.insert(lower_key(raw));
            }
        }
        let mut sorted_names: Vec<&String> = exclude_names.iter().collect();
        sorted_names.sort();
        let key =
            serde_json::to_string(&(&kept, &sorted_names, &exclude_paths)).unwrap_or_default();
        Config {
            roots: kept,
            exclude_names,
            exclude_paths,
            key,
        }
    }

    fn excludes_child(&self, lower_path: &str, lower_name: &str) -> bool {
        self.exclude_names.contains(lower_name)
            || self.exclude_paths.iter().any(|p| p == lower_path)
    }

    /// Is this path meant to be in the index at all?
    fn covers(&self, lower_path: &str) -> bool {
        let under_root = self.roots.iter().any(|r| {
            let root = lower_key(r);
            lower_path == root.trim_end_matches('\\')
                || lower_path.starts_with(&table::dir_key(&root))
        });
        if !under_root {
            return false;
        }
        if lower_path
            .split('\\')
            .any(|part| self.exclude_names.contains(part))
        {
            return false;
        }
        !self
            .exclude_paths
            .iter()
            .any(|p| lower_path == p || lower_path.starts_with(&table::dir_key(p)))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    /// "off", "loading", "scanning" or "idle".
    pub state: &'static str,
    pub files: usize,
    pub dirs: usize,
    /// Changes whenever the indexed rows do, however the count comes out.
    pub revision: u64,
    pub folders_walked: u64,
    /// Folders Windows wouldn't let the walk read.
    pub skipped: u64,
    /// When the last full walk finished, in ms since the epoch. 0 if none has.
    pub last_scan: u64,
    pub memory_bytes: usize,
    pub disk_bytes: u64,
    pub roots: Vec<String>,
}

struct Run {
    cancel: Arc<AtomicBool>,
    key: String,
    thread: Option<JoinHandle<()>>,
}

struct Inner {
    db_path: PathBuf,
    /// The data folder's own files (this index included) never go through the watcher queue.
    data_dir: String,
    store: Mutex<Option<Store>>,
    /// Searches read through this, so a walk's transaction never delays one.
    reader: Mutex<Option<Connection>>,
    table: RwLock<Table>,
    ready: AtomicBool,
    search_generation: AtomicU64,
    config: RwLock<Option<Arc<Config>>>,
    scanning: AtomicBool,
    subtree_walks: AtomicUsize,
    folders_walked: AtomicU64,
    skipped: AtomicU64,
    last_scan: AtomicU64,
    rescan_requested: AtomicBool,
    run: Mutex<Option<Run>>,
}

pub struct Index(Arc<Inner>);

type Emit = Box<dyn Fn(&IndexStatus) + Send + 'static>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub pattern: String,
    pub pattern_mode: String,
    pub types: Vec<String>,
    pub date_field: String,
    pub date_from: Option<u64>,
    pub date_to: Option<u64>,
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    pub show_hidden: bool,
    pub scope: Option<String>,
    pub sort_key: String,
    pub sort_dir: String,
    pub folders_first: bool,
}

/// `[name, flags, size, modified, created, index into dirs]`, the listing format plus a folder.
#[derive(Debug, Serialize)]
pub struct ResultRow(String, u8, u64, u64, u64, u32);

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub rows: Vec<ResultRow>,
    pub dirs: Vec<String>,
    pub total: usize,
    pub categories: HashMap<String, u32>,
    pub pattern_error: Option<String>,
    /// False while the index is still loading from disk.
    pub ready: bool,
    pub stale: bool,
    pub took_ms: u64,
}

fn sort_key(name: &str) -> SortKey {
    match name {
        "name" => SortKey::Name,
        "folder" => SortKey::Folder,
        "modified" => SortKey::Modified,
        "created" => SortKey::Created,
        "size" => SortKey::Size,
        "type" => SortKey::Type,
        _ => SortKey::Relevance,
    }
}

#[cfg(windows)]
fn lower_thread_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
    };
    // Lowers disk priority as well as CPU, so walking a drive doesn't make the PC feel busy.
    // SAFETY: only changes this thread's own scheduling.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

#[cfg(not(windows))]
fn lower_thread_priority() {}

/// One directory entry as enumeration reports it, without following links.
fn scan_item(item: &fs::DirEntry) -> Option<Packed> {
    let md = item.metadata().ok()?;
    let name = item.file_name().to_string_lossy().into_owned();
    Some(pack(name, &md))
}

fn pack(name: String, md: &fs::Metadata) -> Packed {
    let symlink = md.file_type().is_symlink();
    let mut packed = Packed::from(fs_ops::entry_from(name, md, symlink));
    if symlink && link_is_dir(md) {
        packed.1 |= F_DIR; // shown as the folder it points at, but never walked into
    }
    packed
}

#[cfg(windows)]
fn link_is_dir(md: &fs::Metadata) -> bool {
    use std::os::windows::fs::FileTypeExt;
    md.file_type().is_symlink_dir()
}

#[cfg(not(windows))]
fn link_is_dir(_md: &fs::Metadata) -> bool {
    false
}

fn split_path(path: &str) -> Option<(String, String)> {
    let p = Path::new(path);
    Some((
        fs_ops::clean(p.parent()?),
        p.file_name()?.to_string_lossy().into_owned(),
    ))
}

impl Inner {
    /// Makes one folder's rows match what was just read from disk.
    /// Returns the subfolders to walk next, with whether they count as hidden.
    fn sync_dir(
        &self,
        dir: &str,
        hidden: bool,
        scanned: Vec<Packed>,
    ) -> rusqlite::Result<Vec<(String, bool)>> {
        let lower: Vec<String> = scanned.iter().map(|s| s.0.to_lowercase()).collect();
        let mut guard = self.store.lock().expect("index store lock");
        let Some(store) = guard.as_mut() else {
            return Ok(vec![]);
        };

        let known = store.find_dir(dir)?;
        let dir_id = match known {
            Some((id, was_hidden)) => {
                if was_hidden != hidden {
                    store.set_dir_hidden(id, hidden)?;
                }
                id
            }
            None => store.insert_dir(dir, hidden)?,
        };
        let mut existing: HashMap<String, store::Row> = if known.is_some() {
            store
                .children(dir_id)?
                .into_iter()
                .map(|r| (r.name.to_lowercase(), r))
                .collect()
        } else {
            HashMap::new()
        };

        enum Change {
            Add(u32, usize),
            Update(u32, usize),
            Remove(u32),
            RemoveTree(Vec<u32>, Vec<u32>),
        }
        let mut changes = Vec::new();
        let mut subdirs = Vec::new();

        for (i, s) in scanned.iter().enumerate() {
            let Packed(name, flags, size, modified, created) = s;
            let walks = flags & F_DIR != 0 && flags & F_SYMLINK == 0;
            if walks {
                let child_hidden = hidden || flags & (F_HIDDEN | F_SYSTEM) != 0;
                subdirs.push((fs_ops::clean(&Path::new(dir).join(name)), child_hidden));
            }
            match existing.remove(&lower[i]) {
                Some(old) => {
                    let unchanged = old.name == *name
                        && old.size == *size
                        && old.modified == *modified
                        && old.created == *created
                        && old.flags == *flags;
                    if unchanged {
                        continue;
                    }
                    // A folder replaced by a file (or link) takes its contents with it.
                    let old_walked = old.flags & F_DIR != 0 && old.flags & F_SYMLINK == 0;
                    if old_walked && !walks {
                        let path = fs_ops::clean(&Path::new(dir).join(&old.name));
                        let (dirs, entries) = store.delete_subtree(&path)?;
                        changes.push(Change::RemoveTree(dirs, entries));
                    }
                    store.update_entry(old.id, name, *size, *modified, *created, *flags)?;
                    changes.push(Change::Update(old.id as u32, i));
                }
                None => {
                    let id =
                        store.insert_entry(dir_id, name, *size, *modified, *created, *flags)?;
                    changes.push(Change::Add(id as u32, i));
                }
            }
        }
        for old in existing.into_values() {
            if old.flags & F_DIR != 0 && old.flags & F_SYMLINK == 0 {
                let path = fs_ops::clean(&Path::new(dir).join(&old.name));
                let (dirs, entries) = store.delete_subtree(&path)?;
                changes.push(Change::RemoveTree(dirs, entries));
            }
            store.delete_entry(old.id)?;
            changes.push(Change::Remove(old.id as u32));
        }

        // Applied while the store lock is held, so rows reach the table in id order.
        let changed_dir = known.is_none_or(|(_, was)| was != hidden);
        if changed_dir || !changes.is_empty() {
            let mut table = self.table.write().expect("index table lock");
            if changed_dir {
                table.set_dir(dir_id as u32, &lower_key(dir), hidden);
            }
            for change in changes {
                match change {
                    Change::Add(id, i) => {
                        let s = &scanned[i];
                        table.push(NewRow {
                            id,
                            dir: dir_id as u32,
                            lower_name: &lower[i],
                            size: s.2,
                            modified_ms: s.3,
                            created_ms: s.4,
                            flags: s.1,
                        });
                    }
                    Change::Update(id, i) => {
                        let s = &scanned[i];
                        table.update(id, s.2, s.3, s.4, s.1);
                    }
                    Change::Remove(id) => table.remove(id),
                    Change::RemoveTree(dirs, entries) => {
                        entries.into_iter().for_each(|id| table.remove(id));
                        dirs.into_iter().for_each(|id| table.remove_dir(id));
                    }
                }
            }
            table.compact_if_needed();
        }
        store.commit_if_due()?;
        Ok(subdirs)
    }

    /// Walks a folder and everything under it. Returns false if it was cancelled.
    fn walk(&self, root: String, hidden: bool, config: &Config, cancel: &AtomicBool) -> bool {
        let mut stack = vec![(root, hidden)];
        while let Some((dir, hidden)) = stack.pop() {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            // An unreadable folder says nothing about its contents, so its rows stay as they are.
            let Ok(read) = fs::read_dir(&dir) else {
                self.skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            let dir_lower = lower_key(&dir);
            let scanned: Vec<Packed> = read
                .flatten()
                .filter_map(|item| scan_item(&item))
                .filter(|p| {
                    let name = p.0.to_lowercase();
                    let path = lower_key(&fs_ops::clean(&Path::new(&dir_lower).join(&name)));
                    !config.excludes_child(&path, &name)
                })
                .collect();
            self.folders_walked.fetch_add(1, Ordering::Relaxed);
            match self.sync_dir(&dir, hidden, scanned) {
                Ok(subdirs) => stack.extend(subdirs),
                Err(e) => eprintln!("index: {dir}: {e}"),
            }
        }
        true
    }

    /// Brings specific paths up to date, for watcher events and Vault's own file operations.
    fn touch(self: &Arc<Self>, paths: impl IntoIterator<Item = String>) {
        let Some(config) = self.config.read().expect("index config lock").clone() else {
            return;
        };
        // Grouped by folder: one change event per file in a big copy shouldn't be one diff each.
        let mut new_dirs: Vec<(String, bool)> = Vec::new();
        for path in paths {
            let lower = lower_key(path.trim_end_matches('\\'));
            if !config.covers(&lower) || lower.starts_with(&self.data_dir) {
                continue;
            }
            let Some((dir, name)) = split_path(&path) else {
                continue;
            };
            if let Err(e) = self.touch_one(&dir, &name, &path, &mut new_dirs) {
                eprintln!("index: {path}: {e}");
            }
        }
        if let Some(store) = self.store.lock().expect("index store lock").as_mut() {
            let _ = store.commit();
        }
        for (dir, hidden) in new_dirs {
            self.spawn_subtree_walk(dir, hidden, config.clone());
        }
    }

    fn touch_one(
        &self,
        dir: &str,
        name: &str,
        path: &str,
        new_dirs: &mut Vec<(String, bool)>,
    ) -> rusqlite::Result<()> {
        let current = fs::symlink_metadata(path)
            .ok()
            .map(|md| pack(name.to_string(), &md));
        let lower_name = name.to_lowercase();
        let mut guard = self.store.lock().expect("index store lock");
        let Some(store) = guard.as_mut() else {
            return Ok(());
        };

        let known = store.find_dir(dir)?;
        let (dir_id, hidden) = match (known, &current) {
            (Some(found), _) => found,
            (None, None) => return Ok(()), // gone from a folder that isn't indexed either
            (None, Some(_)) => {
                let id = store.insert_dir(dir, false)?;
                self.table.write().expect("index table lock").set_dir(
                    id as u32,
                    &lower_key(dir),
                    false,
                );
                (id, false)
            }
        };
        let old = store
            .children(dir_id)?
            .into_iter()
            .find(|r| r.name.to_lowercase() == lower_name);
        let mut table = self.table.write().expect("index table lock");
        match (old, current) {
            (None, None) => {}
            (Some(old), None) => {
                if old.flags & F_DIR != 0 && old.flags & F_SYMLINK == 0 {
                    let (dirs, entries) = store.delete_subtree(path)?;
                    entries.into_iter().for_each(|id| table.remove(id));
                    dirs.into_iter().for_each(|id| table.remove_dir(id));
                }
                store.delete_entry(old.id)?;
                table.remove(old.id as u32);
            }
            (Some(old), Some(Packed(name, flags, size, modified, created))) => {
                store.update_entry(old.id, &name, size, modified, created, flags)?;
                table.update(old.id as u32, size, modified, created, flags);
            }
            (None, Some(Packed(name, flags, size, modified, created))) => {
                let id = store.insert_entry(dir_id, &name, size, modified, created, flags)?;
                table.push(NewRow {
                    id: id as u32,
                    dir: dir_id as u32,
                    lower_name: &lower_name,
                    size,
                    modified_ms: modified,
                    created_ms: created,
                    flags,
                });
                if flags & F_DIR != 0 && flags & F_SYMLINK == 0 {
                    // Created by a rename or a move, so it may arrive already full.
                    let child_hidden = hidden || flags & (F_HIDDEN | F_SYSTEM) != 0;
                    new_dirs.push((path.to_string(), child_hidden));
                }
            }
        }
        table.compact_if_needed();
        Ok(())
    }

    fn spawn_subtree_walk(self: &Arc<Self>, dir: String, hidden: bool, config: Arc<Config>) {
        let cancel = match self.run.lock().expect("index run lock").as_ref() {
            Some(run) => run.cancel.clone(),
            None => return,
        };
        let inner = self.clone();
        inner.subtree_walks.fetch_add(1, Ordering::Relaxed);
        thread::spawn(move || {
            lower_thread_priority();
            inner.walk(dir, hidden, &config, &cancel);
            inner.subtree_walks.fetch_sub(1, Ordering::Relaxed);
        });
    }

    fn open_store(&self) -> rusqlite::Result<()> {
        let mut guard = self.store.lock().expect("index store lock");
        if guard.is_some() {
            return Ok(());
        }
        let conn = match store::open(&self.db_path) {
            Ok(conn) => conn,
            Err(e) => {
                // It's only a cache: a damaged file is replaced, never a reason to fail.
                eprintln!("index: rebuilding after {e}");
                for suffix in ["", "-wal", "-shm"] {
                    let _ = fs::remove_file(format!("{}{suffix}", self.db_path.display()));
                }
                store::open(&self.db_path)?
            }
        };
        *guard = Some(Store::new(conn));
        *self.reader.lock().expect("index reader lock") = Some(store::open(&self.db_path)?);
        Ok(())
    }

    fn load_table(&self) -> rusqlite::Result<()> {
        if self.ready.load(Ordering::Acquire) {
            return Ok(());
        }
        let guard = self.store.lock().expect("index store lock");
        let Some(store) = guard.as_ref() else {
            return Ok(());
        };
        // Built aside so searches see an empty index, never half of one.
        let mut fresh = Table::default();
        store.load_into(&mut fresh)?;
        *self.table.write().expect("index table lock") = fresh;
        self.last_scan.store(
            store
                .get_meta("last_scan")?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            Ordering::Relaxed,
        );
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Drops the folders of roots that are no longer configured.
    fn forget_removed_roots(&self, config: &Config) -> rusqlite::Result<bool> {
        let mut guard = self.store.lock().expect("index store lock");
        let Some(store) = guard.as_mut() else {
            return Ok(false);
        };
        let same = store.get_meta("config")?.as_deref() == Some(config.key.as_str());
        if same {
            return Ok(false);
        }
        let previous: Vec<String> = store
            .get_meta("roots")?
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        for root in previous {
            let lower = lower_key(&root);
            if !config.covers(lower.trim_end_matches('\\')) {
                let (dirs, entries) = store.delete_subtree(&root)?;
                let mut table = self.table.write().expect("index table lock");
                entries.into_iter().for_each(|id| table.remove(id));
                dirs.into_iter().for_each(|id| table.remove_dir(id));
            }
        }
        store.set_meta("config", &config.key)?;
        store.set_meta(
            "roots",
            &serde_json::to_string(&config.roots).unwrap_or_default(),
        )?;
        store.commit()?;
        Ok(true)
    }

    fn start_full_walk(
        self: &Arc<Self>,
        config: &Arc<Config>,
        cancel: &Arc<AtomicBool>,
    ) -> Vec<JoinHandle<bool>> {
        self.scanning.store(true, Ordering::Relaxed);
        self.folders_walked.store(0, Ordering::Relaxed);
        self.skipped.store(0, Ordering::Relaxed);
        // One thread per root: a slow disk shouldn't hold back a fast one.
        config
            .roots
            .iter()
            .map(|root| {
                let inner = self.clone();
                let root = root.clone();
                let config = config.clone();
                let cancel = cancel.clone();
                thread::spawn(move || {
                    lower_thread_priority();
                    inner.walk(root, false, &config, &cancel)
                })
            })
            .collect()
    }

    fn status(&self) -> IndexStatus {
        let running = self.config.read().expect("index config lock").clone();
        let table = self.table.read().expect("index table lock");
        let disk_bytes = ["", "-wal"]
            .iter()
            .filter_map(|s| fs::metadata(format!("{}{s}", self.db_path.display())).ok())
            .map(|md| md.len())
            .sum();
        let state = match &running {
            None => "off",
            Some(_) if !self.ready.load(Ordering::Acquire) => "loading",
            Some(_) if self.scanning.load(Ordering::Relaxed) => "scanning",
            Some(_) if self.subtree_walks.load(Ordering::Relaxed) > 0 => "scanning",
            Some(_) => "idle",
        };
        IndexStatus {
            state,
            files: table.live_rows(),
            dirs: table.live_dirs(),
            revision: table.revision(),
            folders_walked: self.folders_walked.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
            last_scan: self.last_scan.load(Ordering::Relaxed),
            memory_bytes: table.memory_bytes(),
            disk_bytes,
            roots: running.map(|c| c.roots.clone()).unwrap_or_default(),
        }
    }

    /// Opens the index, walks when it's due, applies watcher events, reports progress.
    fn maintain(self: Arc<Self>, config: Arc<Config>, cancel: Arc<AtomicBool>, emit: Emit) {
        lower_thread_priority();
        let mut last_status = self.status();
        emit(&last_status);

        if let Err(e) = self.open_store().and_then(|()| self.load_table()) {
            eprintln!("index: can't open: {e}");
            return;
        }
        let config_changed = match self.forget_removed_roots(&config) {
            Ok(changed) => changed,
            Err(e) => {
                eprintln!("index: {e}");
                false
            }
        };

        // Watching begins before the walk, so nothing that changes during it is missed.
        let queue: Arc<Mutex<HashSet<String>>> = Arc::default();
        let _watchers: Vec<RecommendedWatcher> = config
            .roots
            .iter()
            .filter_map(|root| {
                let queue = queue.clone();
                let mut watcher =
                    notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                        let Ok(event) = res else { return };
                        if matches!(event.kind, notify::EventKind::Access(_)) {
                            return;
                        }
                        if let Ok(mut q) = queue.lock() {
                            q.extend(event.paths.iter().map(|p| fs_ops::clean(p)));
                        }
                    })
                    .ok()?;
                watcher
                    .watch(Path::new(root), RecursiveMode::Recursive)
                    .ok()?;
                Some(watcher)
            })
            .collect();

        let last = self.last_scan.load(Ordering::Relaxed);
        let empty = self
            .store
            .lock()
            .expect("index store lock")
            .as_ref()
            .is_none_or(|s| s.is_empty().unwrap_or(true));
        let started = Instant::now();
        let stale_at_launch =
            now_ms().saturating_sub(last) > RESCAN_ON_LAUNCH_AFTER.as_millis() as u64;
        let mut next_walk = if empty || config_changed {
            Some(started)
        } else if stale_at_launch {
            Some(started + RESCAN_DELAY)
        } else {
            let since = now_ms().saturating_sub(last);
            Some(started + RESCAN_EVERY.saturating_sub(Duration::from_millis(since)))
        };
        let mut walkers: Vec<JoinHandle<bool>> = Vec::new();
        let mut last_flush = Instant::now();

        while !cancel.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(250));

            if self.rescan_requested.swap(false, Ordering::Relaxed) {
                next_walk = Some(Instant::now());
            }
            if walkers.is_empty() && next_walk.is_some_and(|at| Instant::now() >= at) {
                next_walk = None;
                walkers = self.start_full_walk(&config, &cancel);
            }
            if !walkers.is_empty() && walkers.iter().all(|w| w.is_finished()) {
                let finished = walkers.drain(..).all(|w| w.join().unwrap_or(false));
                self.scanning.store(false, Ordering::Relaxed);
                if finished {
                    let at = now_ms();
                    self.last_scan.store(at, Ordering::Relaxed);
                    if let Some(store) = self.store.lock().expect("index store lock").as_mut() {
                        let _ = store.set_meta("last_scan", &at.to_string());
                        let _ = store.commit();
                    }
                    next_walk = Some(Instant::now() + RESCAN_EVERY);
                }
            }
            if last_flush.elapsed() >= WATCH_FLUSH_EVERY {
                last_flush = Instant::now();
                let batch = std::mem::take(&mut *queue.lock().expect("index queue lock"));
                if !batch.is_empty() {
                    self.touch(batch);
                }
                if let Some(store) = self.store.lock().expect("index store lock").as_mut() {
                    let _ = store.commit_if_due();
                }
            }
            let status = self.status();
            if status != last_status {
                emit(&status);
                last_status = status;
            }
        }
        for walker in walkers {
            let _ = walker.join();
        }
        self.scanning.store(false, Ordering::Relaxed);
        if let Some(store) = self.store.lock().expect("index store lock").as_mut() {
            let _ = store.commit();
        }
    }
}

impl Index {
    pub fn new(data_dir: &Path) -> Index {
        Index(Arc::new(Inner {
            db_path: data_dir.join("index.db"),
            data_dir: lower_key(&fs_ops::clean(data_dir)),
            store: Mutex::default(),
            reader: Mutex::default(),
            table: RwLock::default(),
            ready: AtomicBool::new(false),
            search_generation: AtomicU64::new(0),
            config: RwLock::default(),
            scanning: AtomicBool::new(false),
            subtree_walks: AtomicUsize::new(0),
            folders_walked: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            last_scan: AtomicU64::new(0),
            rescan_requested: AtomicBool::new(false),
            run: Mutex::default(),
        }))
    }

    /// Starts indexing, or applies a new configuration. Returns at once; everything is background.
    pub fn start(
        &self,
        roots: &[String],
        excludes: &[String],
        emit: impl Fn(&IndexStatus) + Send + 'static,
    ) {
        let config = Arc::new(Config::new(roots, excludes));
        let mut run = self.0.run.lock().expect("index run lock");
        if run.as_ref().is_some_and(|r| r.key == config.key) {
            return;
        }
        Self::halt(&mut run);
        *self.0.config.write().expect("index config lock") = Some(config.clone());
        let cancel = Arc::new(AtomicBool::new(false));
        let inner = self.0.clone();
        let (key, thread_cancel) = (config.key.clone(), cancel.clone());
        let thread = thread::spawn(move || inner.maintain(config, thread_cancel, Box::new(emit)));
        *run = Some(Run {
            cancel,
            key,
            thread: Some(thread),
        });
    }

    fn halt(run: &mut Option<Run>) {
        if let Some(mut old) = run.take() {
            old.cancel.store(true, Ordering::Relaxed);
            if let Some(thread) = old.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Stops indexing and frees the memory. What's on disk stays for next time.
    pub fn stop(&self) {
        let mut run = self.0.run.lock().expect("index run lock");
        Self::halt(&mut run);
        *self.0.config.write().expect("index config lock") = None;
        self.0.ready.store(false, Ordering::Release);
        *self.0.table.write().expect("index table lock") = Table::default();
        *self.0.store.lock().expect("index store lock") = None;
        *self.0.reader.lock().expect("index reader lock") = None;
    }

    /// Throws the index away and walks everything again.
    pub fn rebuild(&self) -> Result<(), String> {
        {
            let mut guard = self.0.store.lock().expect("index store lock");
            let Some(store) = guard.as_mut() else {
                return Err("Indexing is off".into());
            };
            store.clear().map_err(|e| e.to_string())?;
            *self.0.table.write().expect("index table lock") = Table::default();
        }
        self.0.last_scan.store(0, Ordering::Relaxed);
        self.0.rescan_requested.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn status(&self) -> IndexStatus {
        self.0.status()
    }

    pub fn touch(&self, paths: impl IntoIterator<Item = String>) {
        self.0.touch(paths);
    }

    /// Row ids of paths carrying a tag, for the tag filter.
    pub fn ids_of(&self, paths: &[String]) -> HashSet<u32> {
        let guard = self.0.reader.lock().expect("index reader lock");
        let Some(conn) = guard.as_ref() else {
            return HashSet::new();
        };
        paths
            .iter()
            .filter_map(|path| {
                let (dir, name) = split_path(path)?;
                store::entry_id(conn, &dir, &name).ok().flatten()
            })
            .collect()
    }

    pub fn search(&self, params: SearchParams, allowed: Option<HashSet<u32>>) -> SearchResults {
        let started = Instant::now();
        let inner = &self.0;
        let mine = inner.search_generation.fetch_add(1, Ordering::Relaxed) + 1;
        if !inner.ready.load(Ordering::Acquire) {
            return SearchResults::default();
        }

        let (pattern, pattern_error) =
            match NamePattern::parse(&params.pattern, params.pattern_mode == "regex") {
                Ok(pattern) => (pattern, None),
                Err(e) => (None, Some(e)),
            };
        let (terms, dir_terms) = table::parse_terms(&params.query);
        let query = Query {
            terms,
            dir_terms,
            scope: params.scope.as_deref().map(lower_key),
            pattern,
            types: (!params.types.is_empty()).then(|| {
                params
                    .types
                    .iter()
                    .filter_map(|t| table::category_id(t))
                    .collect()
            }),
            use_created: params.date_field == "created",
            date_from_ms: params.date_from,
            date_to_ms: params.date_to,
            size_min: params.size_min,
            size_max: params.size_max,
            show_hidden: params.show_hidden,
            allowed,
            sort: sort_key(&params.sort_key),
            descending: params.sort_dir == "desc",
            folders_first: params.folders_first,
            limit: MAX_RESULTS,
        };

        let outcome = inner.table.read().expect("index table lock").search(
            &query,
            &inner.search_generation,
            mine,
        );
        let categories = table::category_names()
            .iter()
            .zip(&outcome.categories)
            .filter(|(_, count)| **count > 0)
            .map(|(name, count)| (name.clone(), *count))
            .collect();
        let mut results = SearchResults {
            total: outcome.total,
            categories,
            pattern_error,
            ready: true,
            stale: outcome.stale,
            ..SearchResults::default()
        };
        if outcome.stale {
            return results;
        }

        let found = {
            let guard = inner.reader.lock().expect("index reader lock");
            guard.as_ref().map(|conn| store::fetch(conn, &outcome.ids))
        };
        let mut dir_slots: HashMap<String, u32> = HashMap::new();
        for row in found.and_then(Result::ok).unwrap_or_default() {
            let slot = *dir_slots.entry(row.dir).or_insert_with_key(|dir| {
                results.dirs.push(dir.clone());
                results.dirs.len() as u32 - 1
            });
            results.rows.push(ResultRow(
                row.name,
                row.flags,
                row.size,
                row.modified,
                row.created,
                slot,
            ));
        }
        results.took_ms = started.elapsed().as_millis() as u64;
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        index: Index,
    }

    impl Fixture {
        fn new(name: &str, excludes: &[&str]) -> Fixture {
            let base =
                std::env::temp_dir().join(format!("vault_index_{}_{name}", std::process::id()));
            let _ = fs::remove_dir_all(&base);
            let root = base.join("tree");
            fs::create_dir_all(root.join("docs/old")).unwrap();
            fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
            fs::write(root.join("docs/report.pdf"), b"12345").unwrap();
            fs::write(root.join("docs/old/report-2019.pdf"), b"12").unwrap();
            fs::write(root.join("node_modules/pkg/report.js"), b"x").unwrap();
            fs::write(root.join("top.txt"), b"hello").unwrap();
            let root = fs::canonicalize(&root)
                .map(|p| PathBuf::from(fs_ops::clean(&p)))
                .unwrap();
            let data = base.join("data");
            fs::create_dir_all(&data).unwrap();
            let index = Index::new(&data);
            let excludes: Vec<String> = excludes.iter().map(|s| s.to_string()).collect();
            index.start(&[root.to_string_lossy().into_owned()], &excludes, |_| {});
            let fixture = Fixture { root, index };
            fixture.wait_idle();
            fixture
        }

        fn wait_idle(&self) {
            let deadline = Instant::now() + Duration::from_secs(20);
            thread::sleep(Duration::from_millis(600));
            while self.index.status().state != "idle" {
                assert!(
                    Instant::now() < deadline,
                    "index never went idle: {:?}",
                    self.index.status()
                );
                thread::sleep(Duration::from_millis(50));
            }
            // Past the commit that makes rows visible to the reader.
            thread::sleep(Duration::from_millis(300));
            if let Some(store) = self.index.0.store.lock().unwrap().as_mut() {
                store.commit().unwrap();
            }
        }

        fn names(&self, query: &str) -> Vec<String> {
            let mut names: Vec<String> = self
                .index
                .search(params(query), None)
                .rows
                .into_iter()
                .map(|r| r.0)
                .collect();
            names.sort();
            names
        }

        fn path(&self, rel: &str) -> String {
            self.root
                .join(rel.replace('/', "\\"))
                .to_string_lossy()
                .into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.index.stop();
            if let Some(base) = self.root.parent() {
                let _ = fs::remove_dir_all(base);
            }
        }
    }

    fn params(query: &str) -> SearchParams {
        SearchParams {
            query: query.into(),
            pattern: String::new(),
            pattern_mode: "glob".into(),
            types: vec![],
            date_field: "modified".into(),
            date_from: None,
            date_to: None,
            size_min: None,
            size_max: None,
            show_hidden: true,
            scope: None,
            sort_key: "relevance".into(),
            sort_dir: "asc".into(),
            folders_first: false,
        }
    }

    #[test]
    fn walks_excludes_and_finds() {
        let f = Fixture::new("walk", &["node_modules"]);
        assert_eq!(f.names("report"), vec!["report-2019.pdf", "report.pdf"]);
        assert!(f.names("pkg").is_empty(), "excluded folders aren't indexed");
        assert_eq!(f.names("docs"), vec!["docs"]);

        let results = f.index.search(params("report.pdf"), None);
        let row = &results.rows[0];
        assert_eq!(row.2, 5);
        assert_eq!(results.dirs[row.5 as usize], f.path("docs"));

        let mut typed = params("");
        typed.types = vec!["pdf".into()];
        assert_eq!(f.index.search(typed, None).total, 2);
    }

    #[test]
    fn touch_tracks_creates_changes_renames_and_deletes() {
        let f = Fixture::new("touch", &["node_modules"]);

        fs::write(f.path("docs/fresh.txt"), b"1").unwrap();
        f.index.touch([f.path("docs/fresh.txt")]);
        assert_eq!(f.names("fresh"), vec!["fresh.txt"]);

        fs::write(f.path("docs/fresh.txt"), b"123456789").unwrap();
        f.index.touch([f.path("docs/fresh.txt")]);
        assert_eq!(f.index.search(params("fresh"), None).rows[0].2, 9);

        // Renaming a full folder: the children come along through a subtree walk.
        fs::rename(f.path("docs/old"), f.path("docs/archive")).unwrap();
        f.index.touch([f.path("docs/old"), f.path("docs/archive")]);
        f.wait_idle();
        assert!(f.names("old").is_empty());
        let results = f.index.search(params("2019"), None);
        assert_eq!(results.dirs, vec![f.path("docs/archive")]);

        fs::remove_file(f.path("docs/fresh.txt")).unwrap();
        fs::remove_dir_all(f.path("docs/archive")).unwrap();
        f.index
            .touch([f.path("docs/fresh.txt"), f.path("docs/archive")]);
        assert!(f.names("fresh").is_empty());
        assert!(f.names("2019").is_empty());

        // Paths outside the index are ignored.
        f.index.touch([
            f.path("node_modules/pkg/report.js"),
            r"Z:\not\here.txt".to_string(),
        ]);
        assert!(f.names("report.js").is_empty());
    }

    #[test]
    fn rewalk_diffs_and_unreadable_roots_keep_rows() {
        let f = Fixture::new("rewalk", &["node_modules"]);
        let before = f.index.status().files;

        fs::write(f.path("added.txt"), b"1").unwrap();
        fs::remove_file(f.path("top.txt")).unwrap();
        let config = f.index.0.config.read().unwrap().clone().unwrap();
        let root = f.root.to_string_lossy().into_owned();
        assert!(
            f.index
                .0
                .walk(root, false, &config, &AtomicBool::new(false))
        );
        f.index
            .0
            .store
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(f.names("added"), vec!["added.txt"]);
        assert!(f.names("top").is_empty());
        assert_eq!(f.index.status().files, before);

        // A folder that can't be read (an unplugged drive, say) isn't a folder that emptied.
        assert!(f.index.0.walk(
            r"Z:\gone\missing".into(),
            false,
            &config,
            &AtomicBool::new(false)
        ));
        assert_eq!(f.index.status().files, before);
    }

    #[test]
    fn survives_restart_and_reconfiguration() {
        let f = Fixture::new("restart", &["node_modules"]);
        let root = f.root.to_string_lossy().into_owned();
        f.index.stop();
        assert_eq!(f.index.status().state, "off");
        assert!(!f.index.search(params("report"), None).ready);

        // Excluding "docs" removes what's already there; no longer excluding node_modules adds it.
        f.index
            .start(std::slice::from_ref(&root), &["docs".to_string()], |_| {});
        f.wait_idle();
        assert_eq!(f.names("report"), vec!["report.js"]);

        f.index.rebuild().unwrap();
        f.wait_idle();
        assert_eq!(f.names("report"), vec!["report.js"]);

        // A root that's no longer configured is forgotten.
        let other = f.root.parent().unwrap().join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("elsewhere.txt"), b"1").unwrap();
        f.index
            .start(&[other.to_string_lossy().into_owned()], &[], |_| {});
        f.wait_idle();
        assert!(f.names("report").is_empty());
        assert_eq!(f.names("elsewhere"), vec!["elsewhere.txt"]);
    }

    #[test]
    fn config_prunes_nested_roots_and_expands_excludes() {
        let f = Fixture::new("config", &[]);
        let root = f.root.to_string_lossy().into_owned();
        let docs = f.path("docs");
        let config = Config::new(
            &[docs, root.clone(), root.clone()],
            &["$Recycle.Bin".into(), f.path("docs/old")],
        );
        assert_eq!(config.roots, vec![root]);
        assert!(config.exclude_names.contains("$recycle.bin"));
        assert!(!config.covers(&lower_key(&f.path("docs/old/x.txt"))));
        assert!(!config.covers(&lower_key(&f.path("a/$RECYCLE.BIN/x"))));
        assert!(config.covers(&lower_key(&f.path("docs/older.txt"))));
        assert!(!config.covers(r"z:\elsewhere"));
    }
}
