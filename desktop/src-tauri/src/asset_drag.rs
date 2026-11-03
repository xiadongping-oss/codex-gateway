use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Url};

pub fn ticket(url: &Url) -> Option<String> {
    if url.scheme() != "cgw-workspace" || url.host_str() != Some("asset-drag")
        || !url.username().is_empty() || url.password().is_some() || url.port().is_some()
        || url.query().is_some() || url.fragment().is_some() { return None; }
    let id = url.path().strip_prefix('/')?;
    let parsed = uuid::Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id).then(|| id.to_string())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest { files: Vec<String>, created_at: u64 }

// The web page can provide only a random export ticket, never a filesystem path.
pub fn files(root: &Path, id: &str, now: u64) -> Result<Vec<PathBuf>, String> {
    if uuid::Uuid::parse_str(id).map(|v| v.to_string() != id).unwrap_or(true) { return Err("拖拽文件不可用".into()); }
    let dir = root.join(id);
    if std::fs::symlink_metadata(&dir).map_err(|_| "请重新准备拖拽文件")?.file_type().is_symlink() { return Err("拖拽目录无效".into()); }
    let canonical = dunce::canonicalize(&dir).map_err(|_| "请重新准备拖拽文件")?;
    let manifest_path = canonical.join("manifest.json");
    let meta = std::fs::symlink_metadata(&manifest_path).map_err(|_| "拖拽清单不存在")?;
    if meta.file_type().is_symlink() || meta.len() > 4096 { return Err("拖拽清单无效".into()); }
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(&manifest_path).map_err(|_| "拖拽清单不可读")?).map_err(|_| "拖拽清单无效")?;
    if manifest.created_at > now || now - manifest.created_at > 15 * 60 * 1000 || manifest.files.is_empty() || manifest.files.len() > 3 { return Err("拖拽已过期，请重新准备文件".into()); }
    manifest.files.iter().map(|name| {
        let preview = name.strip_prefix("preview-").and_then(|v| v.strip_suffix(".png")).map(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())).unwrap_or(false);
        if !["original.png", "original.jpeg", "original.webp", "instructions.txt"].contains(&name.as_str()) && !preview { return Err("拖拽文件类型无效".into()); }
        let file = canonical.join(name);
        let info = std::fs::symlink_metadata(&file).map_err(|_| "拖拽文件不存在")?;
        let absolute = dunce::canonicalize(&file).map_err(|_| "拖拽文件不可读")?;
        if info.file_type().is_symlink() || !info.is_file() || info.len() > 30 * 1024 * 1024 || absolute.parent() != Some(canonical.as_path()) { return Err("拖拽文件无效".into()); }
        Ok(absolute)
    }).collect()
}
fn result(app: &tauri::AppHandle, label: &str, status: &str) {
    if let Some(view) = app.get_webview(label) {
        let value = serde_json::to_string(status).unwrap();
        let _ = view.eval(format!("(()=>{{const emit=w=>w.dispatchEvent(new CustomEvent('cgw:asset-drag-result',{{detail:{value}}}));emit(window);for(const f of document.querySelectorAll('iframe')){{try{{emit(f.contentWindow)}}catch{{}}}}}})()"));
    }
}
pub fn start(app: &tauri::AppHandle, label: &str, root: &Path, id: &str, automated_smoke: bool) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let paths = match files(root, id, now) { Ok(paths) => paths, Err(_) => { result(app, label, "error"); return; } };
    if automated_smoke { result(app, label, "cancelled"); return; }
    let Some(window) = app.get_window("main") else { return; };
    let callback_app = app.clone(); let callback_label = label.to_string();
    #[cfg(any(windows, target_os = "macos"))]
    if drag::start_drag(&window, drag::DragItem::Files(paths), drag::Image::Raw(include_bytes!("../icons/icon.png").to_vec()), move |outcome, _| {
        result(&callback_app, &callback_label, match outcome { drag::DragResult::Dropped => "dropped", drag::DragResult::Cancel => "cancelled" });
    }, drag::Options::default()).is_err() { result(app, label, "error"); }
    #[cfg(not(any(windows, target_os = "macos")))]
    { let _ = (window, paths, callback_app, callback_label); result(app, label, "error"); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ticket_rejects_paths_and_extra_parameters() {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(ticket(&format!("cgw-workspace://asset-drag/{id}").parse().unwrap()), Some(id.clone()));
        for url in [format!("cgw-workspace://asset-drag/{id}?path=C:/secret"), format!("cgw-workspace://asset-drag/{id}/../other"), "cgw-workspace://asset-drag/C:/secret".into(), format!("https://asset-drag/{id}")] { assert!(ticket(&url.parse().unwrap()).is_none()); }
    }
    #[test]
    fn only_fresh_exported_files_can_leave_the_app() {
        let root = std::env::temp_dir().join(format!("cgw-asset-drag-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string(); let dir = root.join(&id); std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("original.png"), b"fixture").unwrap();
        std::fs::write(dir.join("manifest.json"), br#"{"files":["original.png"],"createdAt":1000}"#).unwrap();
        assert_eq!(files(&root, &id, 1001).unwrap().len(), 1);
        assert!(files(&root, &id, 1000000).is_err());
        std::fs::write(dir.join("manifest.json"), br#"{"files":["../secret"],"createdAt":1000}"#).unwrap();
        assert!(files(&root, &id, 1001).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
