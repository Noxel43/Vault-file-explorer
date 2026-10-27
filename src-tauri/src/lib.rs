mod db;
mod fs_ops;
mod watcher;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    db: Mutex<Connection>,
    data_dir: String,
}

impl AppState {
    fn conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.db.lock().map_err(|e| e.to_string())
    }
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Run blocking filesystem work off the main thread so the UI never stalls.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)
}

// ---------------------------------------------------------------- app info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    tier: &'static str,
    data_dir: String,
    platform: &'static str,
}

fn tier() -> &'static str {
    if cfg!(feature = "tier-full") {
        "full"
    } else if cfg!(feature = "tier-standard") {
        "standard"
    } else {
        "lite"
    }
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tier: tier(),
        data_dir: state.data_dir.clone(),
        platform: std::env::consts::OS,
    }
}

// ---------------------------------------------------------------- filesystem

#[tauri::command]
async fn list_dir(path: String) -> CmdResult<fs_ops::DirListing> {
    blocking(move || fs_ops::list_dir(&path)).await?
}

#[tauri::command]
async fn stat_paths(paths: Vec<String>) -> CmdResult<Vec<fs_ops::Entry>> {
    blocking(move || fs_ops::stat_paths(&paths)).await
}

#[tauri::command]
fn resolve_path(input: String) -> CmdResult<String> {
    fs_ops::resolve_path(&input)
}

#[tauri::command]
async fn get_drives() -> CmdResult<Vec<fs_ops::Drive>> {
    blocking(fs_ops::drives).await
}

#[tauri::command]
fn get_places(app: AppHandle) -> Vec<fs_ops::Place> {
    fs_ops::places(&app)
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().open_path(path, None::<&str>).map_err(err)
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener().reveal_item_in_dir(path).map_err(err)
}

#[tauri::command]
fn create_folder(dir: String, name: String) -> CmdResult<String> {
    fs_ops::create_folder(&dir, &name)
}

#[tauri::command]
fn create_file(dir: String, name: String) -> CmdResult<String> {
    fs_ops::create_file(&dir, &name)
}

#[tauri::command]
fn rename_path(state: State<AppState>, path: String, new_name: String) -> CmdResult<String> {
    let dest = fs_ops::rename(&path, &new_name)?;
    let mut conn = state.conn()?;
    db::move_path(&mut conn, &path, &dest).map_err(err)?;
    Ok(dest)
}

#[tauri::command]
async fn delete_paths(app: AppHandle, paths: Vec<String>, permanent: bool) -> CmdResult<()> {
    let p = paths.clone();
    blocking(move || fs_ops::delete(&p, permanent)).await??;
    // Recycled files keep their metadata so a restore brings it back; permanent deletes forget it.
    if permanent {
        let state = app.state::<AppState>();
        let mut conn = state.conn()?;
        db::forget_paths(&mut conn, &paths).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn transfer_paths(
    app: AppHandle,
    paths: Vec<String>,
    dest_dir: String,
    mode: String,
) -> CmdResult<fs_ops::TransferResult> {
    let mv = mode == "move";
    let result = blocking(move || fs_ops::transfer(&paths, &dest_dir, mv)).await?;
    let state = app.state::<AppState>();
    let mut conn = state.conn()?;
    for (from, to) in &result.done {
        if mv {
            db::move_path(&mut conn, from, to).map_err(err)?;
        } else {
            db::copy_meta(&conn, from, to).map_err(err)?;
        }
    }
    Ok(result)
}

#[tauri::command]
fn watch_dir(app: AppHandle, watcher: State<watcher::DirWatcher>, path: String) -> CmdResult<()> {
    watcher.watch(app, path)
}

#[tauri::command]
fn unwatch_dir(watcher: State<watcher::DirWatcher>) {
    watcher.stop();
}

// ---------------------------------------------------------------- metadata

#[tauri::command]
fn get_meta(state: State<AppState>, path: String) -> CmdResult<db::FileMeta> {
    db::get_meta(&*state.conn()?, &path).map_err(err)
}

#[tauri::command]
fn set_meta(
    state: State<AppState>,
    path: String,
    description: String,
    keywords: Vec<String>,
    rating: i64,
) -> CmdResult<db::FileMeta> {
    db::set_meta(&*state.conn()?, &path, &description, &keywords, rating).map_err(err)
}

#[tauri::command]
fn get_folder_meta(state: State<AppState>, dir: String) -> CmdResult<Vec<db::MetaSummary>> {
    db::folder_meta(&*state.conn()?, &dir).map_err(err)
}

#[tauri::command]
fn list_tags(state: State<AppState>) -> CmdResult<Vec<db::TagWithCount>> {
    db::list_tags(&*state.conn()?).map_err(err)
}

#[tauri::command]
fn update_tag(state: State<AppState>, id: i64, name: String, color: String) -> CmdResult<()> {
    db::update_tag(&*state.conn()?, id, &name, &color).map_err(err)
}

#[tauri::command]
fn delete_tag(state: State<AppState>, id: i64) -> CmdResult<()> {
    db::delete_tag(&mut *state.conn()?, id).map_err(err)
}

#[tauri::command]
fn add_tag(state: State<AppState>, paths: Vec<String>, name: String) -> CmdResult<db::Tag> {
    if name.trim().is_empty() {
        return Err("Tag name is empty".into());
    }
    db::add_tag(&mut *state.conn()?, &paths, &name).map_err(err)
}

#[tauri::command]
fn remove_tag(state: State<AppState>, paths: Vec<String>, tag_id: i64) -> CmdResult<()> {
    db::remove_tag(&mut *state.conn()?, &paths, tag_id).map_err(err)
}

#[tauri::command]
fn paths_with_tag(state: State<AppState>, tag_id: i64) -> CmdResult<Vec<String>> {
    db::paths_with_tag(&*state.conn()?, tag_id).map_err(err)
}

// ---------------------------------------------------------------- views & settings

#[tauri::command]
fn get_folder_view(state: State<AppState>, path: String) -> CmdResult<Option<String>> {
    db::get_folder_view(&*state.conn()?, &path).map_err(err)
}

#[tauri::command]
fn set_folder_view(state: State<AppState>, path: String, settings: String) -> CmdResult<()> {
    db::set_folder_view(&*state.conn()?, &path, &settings).map_err(err)
}

#[tauri::command]
fn clear_folder_view(state: State<AppState>, path: String) -> CmdResult<()> {
    db::clear_folder_view(&*state.conn()?, &path).map_err(err)
}

#[tauri::command]
fn get_settings(state: State<AppState>, keys: Vec<String>) -> CmdResult<HashMap<String, String>> {
    let conn = state.conn()?;
    let mut out = HashMap::new();
    for k in keys {
        if let Some(v) = db::get_setting(&conn, &k).map_err(err)? {
            out.insert(k, v);
        }
    }
    Ok(out)
}

#[tauri::command]
fn set_setting(state: State<AppState>, key: String, value: String) -> CmdResult<()> {
    db::set_setting(&*state.conn()?, &key, &value).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("vault.db"))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                data_dir: fs_ops::clean(&data_dir),
            });
            app.manage(watcher::DirWatcher::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_dir,
            stat_paths,
            resolve_path,
            get_drives,
            get_places,
            open_path,
            reveal_path,
            create_folder,
            create_file,
            rename_path,
            delete_paths,
            transfer_paths,
            watch_dir,
            unwatch_dir,
            get_meta,
            set_meta,
            get_folder_meta,
            list_tags,
            update_tag,
            delete_tag,
            add_tag,
            remove_tag,
            paths_with_tag,
            get_folder_view,
            set_folder_view,
            clear_folder_view,
            get_settings,
            set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vault");
}
