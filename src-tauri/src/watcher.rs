//! Watches the folder currently open in the UI and emits `fs-change` when it changes,
//! so the listing stays live without polling. The frontend debounces the events.

use std::path::Path;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct DirWatcher {
    inner: Mutex<Option<(String, RecommendedWatcher)>>,
}

impl DirWatcher {
    pub fn watch(&self, app: AppHandle, dir: String) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().is_some_and(|(d, _)| d == &dir) {
            return Ok(());
        }
        *guard = None; // drop the previous watcher first
        let emit_dir = dir.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if !matches!(ev.kind, notify::EventKind::Access(_)) {
                    let _ = app.emit("fs-change", &emit_dir);
                }
            }
        })
        .map_err(|e| e.to_string())?;
        watcher.watch(Path::new(&dir), RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
        *guard = Some((dir, watcher));
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut g) = self.inner.lock() {
            *g = None;
        }
    }
}
