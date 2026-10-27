//! SQLite storage for everything Vault knows about files that the filesystem doesn't:
//! tags, descriptions, keywords, ratings, per-folder view settings and app settings.
//!
//! Paths are stored as absolute strings. On Windows the filesystem is case-insensitive,
//! so path columns use `COLLATE NOCASE`.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i32 = 1;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS files (
                 path        TEXT PRIMARY KEY COLLATE NOCASE,
                 parent      TEXT NOT NULL COLLATE NOCASE,
                 description TEXT NOT NULL DEFAULT '',
                 keywords    TEXT NOT NULL DEFAULT '[]',
                 rating      INTEGER NOT NULL DEFAULT 0,
                 thumbnail   TEXT,
                 updated_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent);

             CREATE TABLE IF NOT EXISTS tags (
                 id    INTEGER PRIMARY KEY,
                 name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
                 color TEXT NOT NULL DEFAULT '#7c8cff'
             );

             CREATE TABLE IF NOT EXISTS file_tags (
                 path   TEXT NOT NULL COLLATE NOCASE
                        REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
                 tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                 PRIMARY KEY (path, tag_id)
             );
             CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);

             CREATE TABLE IF NOT EXISTS folder_views (
                 path     TEXT PRIMARY KEY COLLATE NOCASE,
                 settings TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             COMMIT;",
        )?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parent_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagWithCount {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub rating: i64,
    pub tags: Vec<Tag>,
}

/// Compact per-file summary used to decorate a folder listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaSummary {
    pub path: String,
    pub tag_ids: Vec<i64>,
    pub rating: i64,
    pub has_notes: bool,
}

fn ensure_file_row(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO files (path, parent, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO NOTHING",
        params![path, parent_of(path), now_ms()],
    )?;
    Ok(())
}

/// Remove a file row if it no longer carries any information.
fn prune_file_row(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM files WHERE path = ?1
           AND description = '' AND keywords = '[]' AND rating = 0 AND thumbnail IS NULL
           AND NOT EXISTS (SELECT 1 FROM file_tags WHERE file_tags.path = files.path)",
        params![path],
    )?;
    Ok(())
}

pub fn tags_for(conn: &Connection, path: &str) -> rusqlite::Result<Vec<Tag>> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.id, t.name, t.color FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
         WHERE ft.path = ?1 ORDER BY t.name",
    )?;
    let rows = stmt.query_map(params![path], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn get_meta(conn: &Connection, path: &str) -> rusqlite::Result<FileMeta> {
    let row = conn
        .query_row(
            "SELECT description, keywords, rating FROM files WHERE path = ?1",
            params![path],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let (description, keywords, rating) = row.unwrap_or_else(|| (String::new(), "[]".into(), 0));
    Ok(FileMeta {
        path: path.to_string(),
        description,
        keywords: serde_json::from_str(&keywords).unwrap_or_default(),
        rating,
        tags: tags_for(conn, path)?,
    })
}

pub fn set_meta(
    conn: &Connection,
    path: &str,
    description: &str,
    keywords: &[String],
    rating: i64,
) -> rusqlite::Result<FileMeta> {
    let keywords_json = serde_json::to_string(keywords).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO files (path, parent, description, keywords, rating, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(path) DO UPDATE SET
            description = excluded.description,
            keywords = excluded.keywords,
            rating = excluded.rating,
            updated_at = excluded.updated_at",
        params![
            path,
            parent_of(path),
            description,
            keywords_json,
            rating.clamp(0, 5),
            now_ms()
        ],
    )?;
    prune_file_row(conn, path)?;
    get_meta(conn, path)
}

pub fn folder_meta(conn: &Connection, dir: &str) -> rusqlite::Result<Vec<MetaSummary>> {
    let mut stmt = conn.prepare_cached(
        "SELECT f.path, f.rating, (f.description <> '' OR f.keywords <> '[]'),
                (SELECT group_concat(tag_id) FROM file_tags ft WHERE ft.path = f.path)
         FROM files f WHERE f.parent = ?1",
    )?;
    let rows = stmt.query_map(params![dir], |r| {
        let tag_csv: Option<String> = r.get(3)?;
        Ok(MetaSummary {
            path: r.get(0)?,
            rating: r.get(1)?,
            has_notes: r.get(2)?,
            tag_ids: tag_csv
                .map(|s| s.split(',').filter_map(|t| t.parse().ok()).collect())
                .unwrap_or_default(),
        })
    })?;
    rows.collect()
}

pub fn list_tags(conn: &Connection) -> rusqlite::Result<Vec<TagWithCount>> {
    let mut stmt = conn.prepare_cached(
        "SELECT t.id, t.name, t.color, (SELECT count(*) FROM file_tags ft WHERE ft.tag_id = t.id)
         FROM tags t ORDER BY t.name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagWithCount {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            count: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn upsert_tag(conn: &Connection, name: &str, color: Option<&str>) -> rusqlite::Result<Tag> {
    let name = name.trim();
    if let Some(tag) = conn
        .query_row(
            "SELECT id, name, color FROM tags WHERE name = ?1",
            params![name],
            |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                })
            },
        )
        .optional()?
    {
        return Ok(tag);
    }
    let color = color
        .map(str::to_string)
        .unwrap_or_else(|| default_tag_color(name));
    conn.execute(
        "INSERT INTO tags (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;
    Ok(Tag {
        id: conn.last_insert_rowid(),
        name: name.to_string(),
        color,
    })
}

/// Pick a stable, pleasant colour for a new tag based on its name.
fn default_tag_color(name: &str) -> String {
    const PALETTE: [&str; 10] = [
        "#7c8cff", "#4fc3f7", "#4dd0a1", "#a5d65c", "#ffd54f", "#ffab5e", "#ff7a85", "#f06fc0",
        "#b388ff", "#90a4ae",
    ];
    let hash = name
        .to_lowercase()
        .bytes()
        .fold(5381u32, |h, b| h.wrapping_mul(33) ^ b as u32);
    PALETTE[(hash as usize) % PALETTE.len()].to_string()
}

pub fn update_tag(conn: &Connection, id: i64, name: &str, color: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE tags SET name = ?2, color = ?3 WHERE id = ?1",
        params![id, name.trim(), color],
    )?;
    Ok(())
}

pub fn delete_tag(conn: &mut Connection, id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let paths: Vec<String> = {
        let mut stmt = tx.prepare("SELECT path FROM file_tags WHERE tag_id = ?1")?;
        stmt.query_map(params![id], |r| r.get(0))?
            .collect::<Result<_, _>>()?
    };
    tx.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
    for p in &paths {
        prune_file_row(&tx, p)?;
    }
    tx.commit()
}

pub fn add_tag(conn: &mut Connection, paths: &[String], tag_name: &str) -> rusqlite::Result<Tag> {
    let tx = conn.transaction()?;
    let tag = upsert_tag(&tx, tag_name, None)?;
    for p in paths {
        ensure_file_row(&tx, p)?;
        tx.execute(
            "INSERT OR IGNORE INTO file_tags (path, tag_id) VALUES (?1, ?2)",
            params![p, tag.id],
        )?;
    }
    tx.commit()?;
    Ok(tag)
}

pub fn remove_tag(conn: &mut Connection, paths: &[String], tag_id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for p in paths {
        tx.execute(
            "DELETE FROM file_tags WHERE path = ?1 AND tag_id = ?2",
            params![p, tag_id],
        )?;
        prune_file_row(&tx, p)?;
    }
    tx.commit()
}

pub fn paths_with_tag(conn: &Connection, tag_id: i64) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare_cached("SELECT path FROM file_tags WHERE tag_id = ?1 ORDER BY path")?;
    let rows = stmt.query_map(params![tag_id], |r| r.get(0))?;
    rows.collect()
}

/// Keep metadata attached when a file or folder is renamed/moved inside Vault.
/// Rewrites the path itself and every descendant path.
pub fn move_path(conn: &mut Connection, from: &str, to: &str) -> rusqlite::Result<()> {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let prefix = format!("{from}{sep}");
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE files SET path = ?2, parent = ?3 WHERE path = ?1",
        params![from, to, parent_of(to)],
    )?;
    // Descendants: path starts with "<from>\"
    tx.execute(
        "UPDATE files SET
            path = ?2 || substr(path, length(?1) + 1),
            parent = ?2 || substr(parent, length(?1) + 1)
         WHERE substr(path, 1, length(?3)) = ?3 COLLATE NOCASE",
        params![from, to, prefix],
    )?;
    tx.execute(
        "UPDATE folder_views SET path = ?2 || substr(path, length(?1) + 1)
         WHERE path = ?1 OR substr(path, 1, length(?3)) = ?3 COLLATE NOCASE",
        params![from, to, prefix],
    )?;
    tx.commit()
}

/// Forget metadata for permanently removed paths (and their descendants).
pub fn forget_paths(conn: &mut Connection, paths: &[String]) -> rusqlite::Result<()> {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let tx = conn.transaction()?;
    for p in paths {
        let prefix = format!("{p}{sep}");
        tx.execute(
            "DELETE FROM files WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2 COLLATE NOCASE",
            params![p, prefix],
        )?;
        tx.execute(
            "DELETE FROM folder_views WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2 COLLATE NOCASE",
            params![p, prefix],
        )?;
    }
    tx.commit()
}

/// Copy metadata from one path to another (used when copying files).
pub fn copy_meta(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<()> {
    let changed = conn.execute(
        "INSERT OR REPLACE INTO files (path, parent, description, keywords, rating, thumbnail, updated_at)
         SELECT ?2, ?3, description, keywords, rating, thumbnail, ?4 FROM files WHERE path = ?1",
        params![from, to, parent_of(to), now_ms()],
    )?;
    if changed > 0 {
        conn.execute(
            "INSERT OR IGNORE INTO file_tags (path, tag_id) SELECT ?2, tag_id FROM file_tags WHERE path = ?1",
            params![from, to],
        )?;
    }
    Ok(())
}

pub fn get_folder_view(conn: &Connection, path: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT settings FROM folder_views WHERE path = ?1",
        params![path],
        |r| r.get(0),
    )
    .optional()
}

pub fn set_folder_view(conn: &Connection, path: &str, settings: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO folder_views (path, settings) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET settings = excluded.settings",
        params![path, settings],
    )?;
    Ok(())
}

pub fn clear_folder_view(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM folder_views WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn meta_roundtrip_and_prune() {
        let conn = mem();
        let p = r"C:\a\b.txt";
        let m = set_meta(&conn, p, "hello", &["x".into()], 3).unwrap();
        assert_eq!(m.description, "hello");
        assert_eq!(m.keywords, vec!["x"]);
        assert_eq!(folder_meta(&conn, r"C:\a").unwrap().len(), 1);
        set_meta(&conn, p, "", &[], 0).unwrap();
        assert_eq!(folder_meta(&conn, r"C:\a").unwrap().len(), 0);
    }

    #[test]
    fn tags_follow_moves() {
        let mut conn = mem();
        add_tag(&mut conn, &[r"C:\a\sub\f.txt".into()], "Work").unwrap();
        move_path(&mut conn, r"C:\a\sub", r"C:\a\renamed").unwrap();
        let m = get_meta(&conn, r"C:\a\renamed\f.txt").unwrap();
        assert_eq!(m.tags.len(), 1);
        assert_eq!(folder_meta(&conn, r"C:\a\renamed").unwrap().len(), 1);
        // tag names are case-insensitive
        let t = upsert_tag(&conn, "work", None).unwrap();
        assert_eq!(t.name, "Work");
    }

    #[test]
    fn remove_last_tag_prunes_row() {
        let mut conn = mem();
        let t = add_tag(&mut conn, &[r"C:\x.txt".into()], "a").unwrap();
        remove_tag(&mut conn, &[r"C:\x.txt".into()], t.id).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
