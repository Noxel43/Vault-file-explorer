//! The durable side of the index: a SQLite file of its own, apart from vault.db. It's large,
//! churns constantly, and can always be rebuilt, none of which is true of the user's metadata.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, params};

use super::table::{NewRow, Table};

const SCHEMA_VERSION: i32 = 1;
const COMMIT_ROWS: usize = 5_000;
const COMMIT_EVERY: Duration = Duration::from_secs(1);

pub struct Row {
    pub id: i64,
    pub name: String,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub flags: u8,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;",
    )?;
    conn.set_prepared_statement_cache_capacity(32);
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != SCHEMA_VERSION {
        // A cache, so an old format is simply rebuilt.
        conn.execute_batch(&format!(
            "BEGIN;
             DROP TABLE IF EXISTS entries;
             DROP TABLE IF EXISTS dirs;
             DROP TABLE IF EXISTS index_meta;
             CREATE TABLE dirs (
                 id     INTEGER PRIMARY KEY AUTOINCREMENT,
                 path   TEXT NOT NULL UNIQUE COLLATE NOCASE,
                 hidden INTEGER NOT NULL
             );
             CREATE TABLE entries (
                 id       INTEGER PRIMARY KEY AUTOINCREMENT,
                 dir_id   INTEGER NOT NULL,
                 name     TEXT NOT NULL,
                 size     INTEGER NOT NULL,
                 modified INTEGER NOT NULL,
                 created  INTEGER NOT NULL,
                 flags    INTEGER NOT NULL
             );
             CREATE INDEX idx_entries_dir ON entries(dir_id);
             CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = {SCHEMA_VERSION};
             COMMIT;"
        ))?;
    }
    Ok(conn)
}

/// The prefix of everything under a folder, for range scans on the path index.
fn subtree_range(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('\\');
    // ']' is the character after '\', so this range holds exactly the paths starting "<path>\".
    (format!("{trimmed}\\"), format!("{trimmed}]"))
}

/// The single writer. All of it runs inside one long transaction, committed in batches.
pub struct Store {
    conn: Connection,
    in_tx: bool,
    dirty: usize,
    last_commit: Instant,
}

impl Store {
    pub fn new(conn: Connection) -> Store {
        Store {
            conn,
            in_tx: false,
            dirty: 0,
            last_commit: Instant::now(),
        }
    }

    fn begin(&mut self) -> rusqlite::Result<()> {
        if !self.in_tx {
            self.conn.execute_batch("BEGIN")?;
            self.in_tx = true;
        }
        self.dirty += 1;
        Ok(())
    }

    pub fn commit(&mut self) -> rusqlite::Result<()> {
        if self.in_tx {
            self.conn.execute_batch("COMMIT")?;
            self.in_tx = false;
        }
        self.dirty = 0;
        self.last_commit = Instant::now();
        Ok(())
    }

    /// Makes changes visible to the reader connection without paying for a commit per folder.
    pub fn commit_if_due(&mut self) -> rusqlite::Result<()> {
        if self.in_tx && (self.dirty >= COMMIT_ROWS || self.last_commit.elapsed() >= COMMIT_EVERY) {
            self.commit()?;
        }
        Ok(())
    }

    pub fn is_empty(&self) -> rusqlite::Result<bool> {
        self.conn
            .query_row("SELECT NOT EXISTS (SELECT 1 FROM dirs)", [], |r| r.get(0))
    }

    pub fn get_meta(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT value FROM index_meta WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.begin()?;
        self.conn.execute(
            "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn clear(&mut self) -> rusqlite::Result<()> {
        self.commit()?;
        self.conn.execute_batch(
            "BEGIN;
             DELETE FROM entries;
             DELETE FROM dirs;
             DELETE FROM index_meta WHERE key = 'last_scan';
             COMMIT;",
        )
    }

    /// Fills the search table in row order, which also keeps its ids increasing.
    pub fn load_into(&self, table: &mut Table) -> rusqlite::Result<()> {
        let (rows, bytes): (i64, Option<i64>) = self.conn.query_row(
            "SELECT count(*), sum(length(CAST(name AS BLOB))) FROM entries",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        table.reserve(rows as usize, bytes.unwrap_or(0) as usize);

        let mut dirs = self.conn.prepare("SELECT id, path, hidden FROM dirs")?;
        let mut query = dirs.query([])?;
        while let Some(r) = query.next()? {
            let path = r.get_ref(1)?.as_str()?.to_lowercase();
            table.set_dir(r.get::<_, i64>(0)? as u32, &path, r.get(2)?);
        }

        let mut entries = self.conn.prepare(
            "SELECT id, dir_id, name, size, modified, created, flags FROM entries ORDER BY id",
        )?;
        let mut query = entries.query([])?;
        while let Some(r) = query.next()? {
            let name = r.get_ref(2)?.as_str()?;
            let lower = name.to_lowercase();
            table.push(NewRow {
                id: r.get::<_, i64>(0)? as u32,
                dir: r.get::<_, i64>(1)? as u32,
                lower_name: &lower,
                size: r.get::<_, i64>(3)? as u64,
                modified_ms: r.get::<_, i64>(4)? as u64,
                created_ms: r.get::<_, i64>(5)? as u64,
                flags: r.get(6)?,
            });
        }
        Ok(())
    }

    /// The id of a folder and whether it's hidden, if it's known.
    pub fn find_dir(&self, path: &str) -> rusqlite::Result<Option<(i64, bool)>> {
        self.conn
            .prepare_cached("SELECT id, hidden FROM dirs WHERE path = ?1")?
            .query_row(params![path], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
    }

    pub fn insert_dir(&mut self, path: &str, hidden: bool) -> rusqlite::Result<i64> {
        self.begin()?;
        self.conn
            .prepare_cached("INSERT INTO dirs (path, hidden) VALUES (?1, ?2)")?
            .execute(params![path, hidden])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_dir_hidden(&mut self, id: i64, hidden: bool) -> rusqlite::Result<()> {
        self.begin()?;
        self.conn
            .prepare_cached("UPDATE dirs SET hidden = ?2 WHERE id = ?1")?
            .execute(params![id, hidden])?;
        Ok(())
    }

    pub fn children(&self, dir_id: i64) -> rusqlite::Result<Vec<Row>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, name, size, modified, created, flags FROM entries WHERE dir_id = ?1",
        )?;
        let rows = stmt.query_map(params![dir_id], |r| {
            Ok(Row {
                id: r.get(0)?,
                name: r.get(1)?,
                size: r.get::<_, i64>(2)? as u64,
                modified: r.get::<_, i64>(3)? as u64,
                created: r.get::<_, i64>(4)? as u64,
                flags: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn insert_entry(
        &mut self,
        dir_id: i64,
        name: &str,
        size: u64,
        modified: u64,
        created: u64,
        flags: u8,
    ) -> rusqlite::Result<i64> {
        self.begin()?;
        self.conn
            .prepare_cached(
                "INSERT INTO entries (dir_id, name, size, modified, created, flags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?
            .execute(params![
                dir_id,
                name,
                size as i64,
                modified as i64,
                created as i64,
                flags
            ])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn update_entry(
        &mut self,
        id: i64,
        name: &str,
        size: u64,
        modified: u64,
        created: u64,
        flags: u8,
    ) -> rusqlite::Result<()> {
        self.begin()?;
        self.conn
            .prepare_cached(
                "UPDATE entries SET name = ?2, size = ?3, modified = ?4, created = ?5, flags = ?6
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                name,
                size as i64,
                modified as i64,
                created as i64,
                flags
            ])?;
        Ok(())
    }

    pub fn delete_entry(&mut self, id: i64) -> rusqlite::Result<()> {
        self.begin()?;
        self.conn
            .prepare_cached("DELETE FROM entries WHERE id = ?1")?
            .execute(params![id])?;
        Ok(())
    }

    /// Forgets a folder and all it contains. Returns the removed (dir ids, entry ids).
    pub fn delete_subtree(&mut self, path: &str) -> rusqlite::Result<(Vec<u32>, Vec<u32>)> {
        self.begin()?;
        let (from, to) = subtree_range(path);
        let dir_ids: Vec<i64> = self
            .conn
            .prepare_cached("SELECT id FROM dirs WHERE path = ?1 OR (path >= ?2 AND path < ?3)")?
            .query_map(params![path, from, to], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let mut entry_ids = Vec::new();
        for &dir in &dir_ids {
            let mut select = self
                .conn
                .prepare_cached("SELECT id FROM entries WHERE dir_id = ?1")?;
            for id in select.query_map(params![dir], |r| r.get::<_, i64>(0))? {
                entry_ids.push(id? as u32);
            }
            self.conn
                .prepare_cached("DELETE FROM entries WHERE dir_id = ?1")?
                .execute(params![dir])?;
            self.conn
                .prepare_cached("DELETE FROM dirs WHERE id = ?1")?
                .execute(params![dir])?;
        }
        self.dirty += entry_ids.len();
        Ok((dir_ids.into_iter().map(|d| d as u32).collect(), entry_ids))
    }
}

/// What the search command needs to show a row.
pub struct Found {
    pub name: String,
    pub dir: String,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub flags: u8,
}

/// Looks up result rows in display order. Rows deleted since the scan are just skipped.
pub fn fetch(conn: &Connection, ids: &[u32]) -> rusqlite::Result<Vec<Found>> {
    let mut stmt = conn.prepare_cached(
        "SELECT e.name, d.path, e.size, e.modified, e.created, e.flags
         FROM entries e JOIN dirs d ON d.id = e.dir_id WHERE e.id = ?1",
    )?;
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        let found = stmt
            .query_row(params![id], |r| {
                Ok(Found {
                    name: r.get(0)?,
                    dir: r.get(1)?,
                    size: r.get::<_, i64>(2)? as u64,
                    modified: r.get::<_, i64>(3)? as u64,
                    created: r.get::<_, i64>(4)? as u64,
                    flags: r.get(5)?,
                })
            })
            .optional()?;
        out.extend(found);
    }
    Ok(out)
}

/// The row id of a full path, for turning tagged files (from vault.db) into search filters.
pub fn entry_id(conn: &Connection, dir: &str, name: &str) -> rusqlite::Result<Option<u32>> {
    conn.prepare_cached(
        "SELECT e.id FROM entries e JOIN dirs d ON d.id = e.dir_id
         WHERE d.path = ?1 AND e.name = ?2 COLLATE NOCASE",
    )?
    .query_row(params![dir, name], |r| r.get(0))
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let dir = std::env::temp_dir().join(format!(
            "vault_store_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.db");
        let _ = std::fs::remove_file(&path);
        Store::new(open(&path).unwrap())
    }

    #[test]
    fn deletes_exactly_one_subtree() {
        let mut s = store();
        let a = s.insert_dir(r"C:\a", false).unwrap();
        let b = s.insert_dir(r"C:\a\b", false).unwrap();
        let sibling = s.insert_dir(r"C:\ab", false).unwrap();
        let keep = s.insert_entry(sibling, "keep.txt", 1, 0, 0, 0).unwrap();
        let x = s.insert_entry(a, "x.txt", 1, 0, 0, 0).unwrap();
        let y = s.insert_entry(b, "y.txt", 1, 0, 0, 0).unwrap();

        let (dirs, entries) = s.delete_subtree(r"C:\a").unwrap();
        assert_eq!(dirs.len(), 2);
        let mut entries: Vec<i64> = entries.into_iter().map(i64::from).collect();
        entries.sort();
        assert_eq!(entries, vec![x, y]);
        assert_eq!(s.children(sibling).unwrap()[0].id, keep);
        assert!(s.find_dir(r"C:\a\b").unwrap().is_none());
        assert!(
            s.find_dir(r"c:\AB").unwrap().is_some(),
            "paths are case-insensitive"
        );
    }

    #[test]
    fn subtree_of_a_drive_root() {
        let mut s = store();
        let root = s.insert_dir("C:\\", false).unwrap();
        s.insert_entry(root, "f.txt", 1, 0, 0, 0).unwrap();
        s.insert_dir(r"C:\a", false).unwrap();
        s.insert_dir("D:\\", false).unwrap();
        let (dirs, entries) = s.delete_subtree("C:\\").unwrap();
        assert_eq!((dirs.len(), entries.len()), (2, 1));
        assert!(s.find_dir("D:\\").unwrap().is_some());
    }

    #[test]
    fn loads_and_fetches_rows() {
        let mut s = store();
        let dir = s.insert_dir(r"C:\Docs", false).unwrap();
        let id = s
            .insert_entry(dir, "Report.PDF", 12, 3000, 2000, 0)
            .unwrap();
        s.commit().unwrap();

        let mut table = Table::default();
        s.load_into(&mut table).unwrap();
        assert_eq!((table.live_rows(), table.live_dirs()), (1, 1));

        let found = fetch(&s.conn, &[id as u32, 999]).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].name.as_str(), found[0].dir.as_str()),
            ("Report.PDF", r"C:\Docs")
        );
        assert_eq!(
            entry_id(&s.conn, r"c:\docs", "report.pdf").unwrap(),
            Some(id as u32)
        );
    }
}
