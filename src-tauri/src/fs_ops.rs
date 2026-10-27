//! Filesystem access: listing, stat, drives, well-known places, and file operations.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// Only set when entries come from different folders (e.g. tag views).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the Unix epoch (0 if unknown).
    pub modified: u64,
    pub created: u64,
    pub hidden: bool,
    pub system: bool,
    pub readonly: bool,
    pub symlink: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<Entry>,
    /// Entries that could not be read (permission errors etc.).
    pub skipped: usize,
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn attrs(md: &fs::Metadata) -> (bool, bool) {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    let a = md.file_attributes();
    (a & HIDDEN != 0, a & SYSTEM != 0)
}

#[cfg(not(windows))]
fn attrs(_md: &fs::Metadata) -> (bool, bool) {
    (false, false)
}

fn entry_from(name: String, md: &fs::Metadata, symlink: bool) -> Entry {
    let (hidden, system) = attrs(md);
    let hidden = hidden || (cfg!(not(windows)) && name.starts_with('.'));
    Entry {
        is_dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        modified: ms(md.modified()),
        created: ms(md.created()),
        hidden,
        system,
        readonly: md.permissions().readonly(),
        symlink,
        path: None,
        name,
    }
}

/// Strip Windows verbatim prefixes and normalise the path for display/storage.
pub fn clean(path: &Path) -> String {
    let s = dunce::simplified(path).to_string_lossy().into_owned();
    // "C:" -> "C:\" so drive roots are usable paths
    if s.len() == 2 && s.ends_with(':') { format!("{s}\\") } else { s }
}

pub fn list_dir(path: &str) -> Result<DirListing, String> {
    let dir = PathBuf::from(path);
    let read = fs::read_dir(&dir).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let mut entries = Vec::with_capacity(256);
    let mut skipped = 0;
    for item in read {
        let Ok(item) = item else {
            skipped += 1;
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        // On Windows, DirEntry::metadata comes straight from the directory enumeration
        // (no extra syscall per file), which is what keeps large folders fast.
        let Ok(md) = item.metadata() else {
            skipped += 1;
            continue;
        };
        let symlink = md.file_type().is_symlink();
        if symlink {
            // Follow links/junctions so linked folders behave like folders.
            match fs::metadata(item.path()) {
                Ok(target) => {
                    let mut e = entry_from(name, &target, true);
                    let (h, s) = attrs(&md);
                    e.hidden |= h;
                    e.system |= s;
                    entries.push(e);
                }
                Err(_) => entries.push(entry_from(name, &md, true)),
            }
        } else {
            entries.push(entry_from(name, &md, false));
        }
    }
    Ok(DirListing { path: clean(&dir), entries, skipped })
}

pub fn stat_paths(paths: &[String]) -> Vec<Entry> {
    paths
        .iter()
        .filter_map(|p| {
            let path = Path::new(p);
            let md = fs::metadata(path).ok()?;
            let symlink = fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| clean(path));
            let mut e = entry_from(name, &md, symlink);
            e.path = Some(clean(path));
            Some(e)
        })
        .collect()
}

/// Expand `~` and `%VAR%` and canonicalise a user-typed path.
pub fn resolve_path(input: &str) -> Result<String, String> {
    let mut s = input.trim().trim_matches('"').to_string();
    if s.is_empty() {
        return Err("Empty path".into());
    }
    if s == "~" || s.starts_with("~/") || s.starts_with("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            s = format!("{}{}", home.to_string_lossy(), &s[1..]);
        }
    }
    // %VAR% expansion
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let var = &after[..end];
                match std::env::var(var) {
                    Ok(v) if !var.is_empty() => out.push_str(&v),
                    _ => {
                        out.push('%');
                        out.push_str(var);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    if out.len() == 2 && out.ends_with(':') {
        out.push('\\');
    }
    let canon = dunce::canonicalize(&out).map_err(|e| format!("{out}: {e}"))?;
    Ok(clean(&canon))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub kind: String,
    pub total: u64,
    pub free: u64,
}

#[cfg(windows)]
pub fn drives() -> Vec<Drive> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let kind = match unsafe { GetDriveTypeW(wide.as_ptr()) } {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "cdrom",
            6 => "ramdisk",
            _ => "unknown",
        };
        let mut label_buf = [0u16; 261];
        let has_label = unsafe {
            GetVolumeInformationW(
                wide.as_ptr(),
                label_buf.as_mut_ptr(),
                label_buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        } != 0;
        let label = if has_label {
            let len = label_buf.iter().position(|&c| c == 0).unwrap_or(0);
            String::from_utf16_lossy(&label_buf[..len])
        } else {
            String::new()
        };
        let (mut free, mut total) = (0u64, 0u64);
        unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut());
        }
        let label = if label.is_empty() {
            match kind {
                "fixed" => "Local Disk".to_string(),
                "removable" => "Removable Disk".to_string(),
                "network" => "Network Drive".to_string(),
                "cdrom" => "CD Drive".to_string(),
                _ => "Drive".to_string(),
            }
        } else {
            label
        };
        out.push(Drive { path: root, label, kind: kind.into(), total, free });
    }
    out
}

#[cfg(not(windows))]
pub fn drives() -> Vec<Drive> {
    vec![Drive { path: "/".into(), label: "Root".into(), kind: "fixed".into(), total: 0, free: 0 }]
}

/// Pick a name that doesn't exist yet in `dir`: "name", "name (2)", "name (3)"…
pub fn unique_name(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(name);
    let (stem, ext) = match (p.file_stem(), p.extension()) {
        (Some(s), Some(e)) if !name.starts_with('.') => {
            (s.to_string_lossy().into_owned(), format!(".{}", e.to_string_lossy()))
        }
        _ => (name.to_string(), String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|c| !c.exists())
        .expect("unbounded search always finds a free name")
}

fn validate_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Invalid name".into());
    }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
        return Err(format!("A file name can't contain '{c}'"));
    }
    Ok(())
}

pub fn create_folder(dir: &str, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let target = unique_name(Path::new(dir), name.trim());
    fs::create_dir(&target).map_err(|e| e.to_string())?;
    Ok(clean(&target))
}

pub fn create_file(dir: &str, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let target = unique_name(Path::new(dir), name.trim());
    fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| e.to_string())?;
    Ok(clean(&target))
}

pub fn rename(path: &str, new_name: &str) -> Result<String, String> {
    validate_name(new_name)?;
    let src = Path::new(path);
    let parent = src.parent().ok_or("Cannot rename a drive root")?;
    let dest = parent.join(new_name.trim());
    let same_file = dest.to_string_lossy().eq_ignore_ascii_case(&src.to_string_lossy());
    if dest.exists() && !same_file {
        return Err(format!("\"{}\" already exists", new_name.trim()));
    }
    fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(clean(&dest))
}

fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    let md = fs::symlink_metadata(src)?;
    if md.is_dir() {
        fs::create_dir_all(dest)?;
        for item in fs::read_dir(src)? {
            let item = item?;
            copy_recursive(&item.path(), &dest.join(item.file_name()))?;
        }
    } else {
        fs::copy(src, dest)?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    /// (source, destination) pairs that succeeded.
    pub done: Vec<(String, String)>,
    pub errors: Vec<String>,
}

pub fn transfer(paths: &[String], dest_dir: &str, mv: bool) -> TransferResult {
    let dest_dir = Path::new(dest_dir);
    let mut result = TransferResult { done: vec![], errors: vec![] };
    for p in paths {
        let src = Path::new(p);
        let Some(name) = src.file_name() else {
            result.errors.push(format!("{p}: cannot copy a drive root"));
            continue;
        };
        if dest_dir.starts_with(src) {
            result.errors.push(format!("{p}: cannot copy a folder into itself"));
            continue;
        }
        let same_dir = src.parent().map(|d| d == dest_dir).unwrap_or(false);
        if mv && same_dir {
            continue; // moving into the folder it's already in is a no-op
        }
        let dest = unique_name(dest_dir, &name.to_string_lossy());
        let outcome = if mv {
            fs::rename(src, &dest).or_else(|_| {
                // Cross-volume move: copy then remove.
                copy_recursive(src, &dest)?;
                if src.is_dir() { fs::remove_dir_all(src) } else { fs::remove_file(src) }
            })
        } else {
            copy_recursive(src, &dest)
        };
        match outcome {
            Ok(()) => result.done.push((p.clone(), clean(&dest))),
            Err(e) => result.errors.push(format!("{p}: {e}")),
        }
    }
    result
}

pub fn delete(paths: &[String], permanent: bool) -> Result<(), String> {
    if permanent {
        for p in paths {
            let path = Path::new(p);
            let r = if fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
            r.map_err(|e| format!("{p}: {e}"))?;
        }
        Ok(())
    } else {
        trash::delete_all(paths).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub fn places<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<Place> {
    use tauri::Manager;
    let p = app.path();
    let candidates = [
        ("home", "Home", p.home_dir()),
        ("desktop", "Desktop", p.desktop_dir()),
        ("documents", "Documents", p.document_dir()),
        ("downloads", "Downloads", p.download_dir()),
        ("pictures", "Pictures", p.picture_dir()),
        ("music", "Music", p.audio_dir()),
        ("videos", "Videos", p.video_dir()),
    ];
    candidates
        .into_iter()
        .filter_map(|(id, name, dir)| {
            let dir = dir.ok()?;
            dir.exists().then(|| Place { id: id.into(), name: name.into(), path: clean(&dir) })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vault-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unique_names() {
        let d = tmp("unique");
        fs::write(d.join("a.txt"), "").unwrap();
        fs::write(d.join("a (2).txt"), "").unwrap();
        assert_eq!(unique_name(&d, "a.txt").file_name().unwrap(), "a (3).txt");
        assert_eq!(unique_name(&d, "b.txt").file_name().unwrap(), "b.txt");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn list_and_transfer() {
        let d = tmp("transfer");
        fs::create_dir(d.join("src")).unwrap();
        fs::write(d.join("src").join("f.txt"), "hi").unwrap();
        fs::create_dir(d.join("dst")).unwrap();
        let listing = list_dir(&d.to_string_lossy()).unwrap();
        assert_eq!(listing.entries.len(), 2);
        let r = transfer(&[d.join("src").to_string_lossy().into()], &d.join("dst").to_string_lossy(), false);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(d.join("dst").join("src").join("f.txt").exists());
        // into itself is refused
        let r = transfer(&[d.join("dst").to_string_lossy().into()], &d.join("dst").join("src").to_string_lossy(), true);
        assert_eq!(r.errors.len(), 1);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rejects_bad_names() {
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("  ").is_err());
        assert!(validate_name("ok name.txt").is_ok());
    }
}
