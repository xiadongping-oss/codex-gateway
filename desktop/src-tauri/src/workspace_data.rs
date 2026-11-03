use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::Manager;

pub struct Store {
    pub root: PathBuf,
    pub webview: PathBuf,
    pub busy: AtomicBool,
}

fn collect(root: &Path) -> Result<BTreeMap<String, Value>, String> {
    fn read(root: &Path, file: &Path, files: &mut BTreeMap<String, Value>) -> Result<(), String> {
        let meta = match fs::symlink_metadata(file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("无法读取配置".into()),
        };
        if meta.file_type().is_symlink() {
            return Err("配置路径不能是链接".into());
        }
        if meta.is_dir() {
            for entry in fs::read_dir(file).map_err(|_| "无法读取配置目录")? {
                read(root, &entry.map_err(|_| "无法读取配置目录")?.path(), files)?;
            }
        } else if file.extension().is_some_and(|e| e == "json") {
            if !meta.is_file() || meta.len() > 16 * 1024 * 1024 || files.len() >= 512 {
                return Err("配置文件过大，备份未完成".into());
            }
            let bytes = fs::read(file).map_err(|_| "无法读取配置")?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "配置内容无效，备份未完成")?;
            files.insert(
                file.strip_prefix(root)
                    .map_err(|_| "配置路径无效")?
                    .to_string_lossy()
                    .replace('\\', "/"),
                value,
            );
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    for name in [
        ".gw-config.json",
        "api-providers.json",
        "api-keys.json",
        "accounts.json",
        "auth.json",
        "accounts",
        "data",
    ] {
        read(root, &root.join(name), &mut files)?;
    }
    Ok(files)
}

pub fn backup(root: &Path) -> Result<String, String> {
    // Compare two reads to reject a changing set rather than publish mixed configuration.
    let mut files = collect(root)?;
    let mut stable = false;
    for _ in 0..3 {
        let next = collect(root)?;
        if next == files {
            stable = true;
            break;
        }
        files = next;
    }
    if !stable {
        return Err("配置正在变化，请稍后重试备份".into());
    }
    if files.is_empty() {
        return Err("暂无可备份配置".into());
    }
    let directory = root.join("backups");
    fs::create_dir_all(&directory).map_err(|_| "无法创建备份目录")?;
    let id = uuid::Uuid::new_v4();
    let file = directory.join(format!("config-{id}.json"));
    let pending = directory.join(format!("config-{id}.tmp"));
    let bytes = serde_json::to_vec_pretty(&json!({"schemaVersion":1,"kind":"codex-gateway-config","createdAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),"files":files})).map_err(|_| "无法生成备份")?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(&pending).map_err(|_| "无法保存备份")?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|_| "备份写入未完成")?;
    drop(output);
    fs::rename(&pending, &file).map_err(|_| "无法提交备份文件")?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn workspace_backup(
    window: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::local(&window)?;
    let store = app.state::<Store>();
    if store.busy.swap(true, Ordering::SeqCst) {
        return Err("备份正在进行".into());
    }
    let root = store.root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || backup(&root))
        .await
        .map_err(|_| "备份未完成".to_string())
        .and_then(|r| r);
    app.state::<Store>().busy.store(false, Ordering::SeqCst);
    result
}
#[tauri::command]
pub fn workspace_backup_folder(
    window: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::local(&window)?;
    use tauri_plugin_opener::OpenerExt;
    let root = app.state::<Store>().root.join("backups");
    fs::create_dir_all(&root).map_err(|_| "无法创建备份目录")?;
    app.opener()
        .open_path(root.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| "无法打开备份目录".into())
}
#[tauri::command]
pub async fn workspace_diagnostics(
    window: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::local(&window)?;
    let path = crate::diagnostics::Log::new(&app.state::<Store>().webview)
        .directory()
        .join("desktop.log");
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = match fs::File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(_) => return Err("无法读取诊断日志".into()),
        };
        let len = file.metadata().map_err(|_| "无法读取诊断日志")?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)))
            .map_err(|_| "无法读取诊断日志")?;
        let mut bytes = Vec::new();
        file.take(64 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取诊断日志")?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|_| "无法读取诊断日志".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_preserves_config_and_skips_runtime() {
        let root = std::env::temp_dir().join(format!("cgw-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("runtime")).unwrap();
        fs::write(root.join(".gw-config.json"), r#"{"mode":"bridge"}"#).unwrap();
        fs::write(root.join("runtime/secret.json"), "{}").unwrap();
        let file = backup(&root).unwrap();
        let value: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(value["files"][".gw-config.json"]["mode"], "bridge");
        assert_eq!(value["files"].as_object().unwrap().len(), 1);
        fs::write(root.join(".gw-config.json"), "broken").unwrap();
        assert!(backup(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
