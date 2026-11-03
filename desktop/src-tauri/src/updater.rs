use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const RELEASES: &str = "https://github.com/xiadongping-oss/codex-gateway/releases";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    ready_to_install: bool,
    current_version: String,
    phase: String,
    version: Option<String>,
    notes: String,
    downloaded: u64,
    total: Option<u64>,
    checked_at: Option<u64>,
    error: String,
}
pub struct Store {
    snapshot: Mutex<Snapshot>,
    busy: AtomicBool,
    available: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}
impl Store {
    pub fn new(version: String) -> Self {
        Self {
            snapshot: Mutex::new(Snapshot {
                ready_to_install: false,
                current_version: version,
                phase: "idle".into(),
                version: None,
                notes: String::new(),
                downloaded: 0,
                total: None,
                checked_at: None,
                error: String::new(),
            }),
            busy: AtomicBool::new(false),
            available: Mutex::new(None),
            bytes: Mutex::new(None),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut value = self.snapshot.lock().unwrap().clone();
        value.ready_to_install = self.bytes.lock().unwrap().is_some();
        value
    }
    fn phase(&self, phase: &str) {
        let mut s = self.snapshot.lock().unwrap();
        s.phase = phase.into();
        s.error.clear();
    }
    fn fail(&self, message: &str) {
        let mut s = self.snapshot.lock().unwrap();
        s.phase = "error".into();
        s.error = message.into();
    }
}
struct Reservation<'a>(&'a AtomicBool);
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
fn reserve(flag: &AtomicBool) -> Result<Reservation<'_>, String> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "正在处理更新，请稍候。".to_string())?;
    Ok(Reservation(flag))
}
fn trusted_download(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .path()
            .starts_with("/xiadongping-oss/codex-gateway/releases/download/")
}
fn check_error(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error::*;
    match error {
        ReleaseNotFound => {
            "在线更新通道暂不可用，可能尚未发布更新清单。可打开 GitHub 版本页手动下载，或稍后重试。"
        }
        TargetNotFound(_) | TargetsNotFound(_) => {
            "此平台暂未发布在线更新包，可到 GitHub 版本页查看。"
        }
        _ => "检查更新失败，请检查网络连接或系统代理后重试；当前版本可以继续使用。",
    }
}

pub async fn action(app: tauri::AppHandle, action: &str) -> Result<Snapshot, String> {
    let store = app.state::<Store>();
    if action == "release" {
        app.opener()
            .open_url(RELEASES, None::<&str>)
            .map_err(|_| "无法打开浏览器，请稍后重试。")?;
        return Ok(store.snapshot());
    }
    if !["check", "download", "install"].contains(&action) {
        return Err("无效的更新操作。".into());
    }
    if app.state::<crate::desktop::Desktop>().isolated {
        return Err("隔离测试窗口不执行正式版本更新。".into());
    }
    let _busy = reserve(&store.busy)?;
    match action {
        "check" => {
            // A failed check cannot leave a stale installer eligible for install.
            store.available.lock().unwrap().take();
            store.bytes.lock().unwrap().take();
            {
                let mut s = store.snapshot.lock().unwrap();
                s.version = None;
                s.notes.clear();
                s.downloaded = 0;
                s.total = None;
            }
            store.phase("checking");
            let updater = app
                .updater_builder()
                .timeout(Duration::from_secs(25))
                .build()
                .map_err(|_| "更新配置不可用，请重新安装当前版本。".to_string());
            let result = match updater {
                Ok(updater) => updater
                    .check()
                    .await
                    .map_err(|e| check_error(&e).to_string()),
                Err(e) => Err(e),
            };
            store.snapshot.lock().unwrap().checked_at = Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            );
            match result {
                Ok(Some(mut update)) if trusted_download(&update.download_url) => {
                    update.timeout = Some(Duration::from_secs(600));
                    {
                        let mut s = store.snapshot.lock().unwrap();
                        s.version = Some(update.version.clone());
                        s.notes = update
                            .body
                            .clone()
                            .unwrap_or_default()
                            .chars()
                            .take(16000)
                            .collect();
                    }
                    *store.available.lock().unwrap() = Some(update);
                    store.phase("available");
                }
                Ok(Some(_)) => store.fail("更新包地址不属于本项目的 GitHub 发布，已拒绝下载。"),
                Ok(None) => store.phase("current"),
                Err(message) => store.fail(&message),
            }
        }
        "download" => {
            let update = store
                .available
                .lock()
                .unwrap()
                .clone()
                .ok_or("请先检查更新。")?;
            store.bytes.lock().unwrap().take();
            {
                let mut s = store.snapshot.lock().unwrap();
                s.downloaded = 0;
                s.total = None;
            }
            store.phase("downloading");
            match update
                .download(
                    |chunk, total| {
                        let mut s = store.snapshot.lock().unwrap();
                        s.downloaded += chunk as u64;
                        s.total = total;
                    },
                    || {},
                )
                .await
            {
                Ok(bytes) => {
                    *store.bytes.lock().unwrap() = Some(bytes);
                    store.phase("downloaded");
                }
                Err(_) => store.fail("下载或更新签名校验失败，未安装任何文件。请检查网络后重试。"),
            }
        }
        "install" => {
            let update = store
                .available
                .lock()
                .unwrap()
                .clone()
                .ok_or("请先检查并下载更新。")?;
            if store.bytes.lock().unwrap().is_none() {
                return Err("请先下载并验证更新包。".into());
            }
            let controller = app.state::<crate::supervisor::Controller>();
            let _reservation = reserve(&controller.update_reserved)?;
            let was_running = controller.view.lock().unwrap().phase == "ready";
            store.phase("waiting");
            if let Err(e) = controller.action("update-stop") {
                store.fail(&e);
                return Ok(store.snapshot());
            }
            let handle = app.clone();
            let drained = tauri::async_runtime::spawn_blocking(move || {
                let end = Instant::now() + Duration::from_secs(95);
                loop {
                    let c = handle.state::<crate::supervisor::Controller>();
                    let v = c.view.lock().unwrap().clone();
                    if v.phase == "maintenance" {
                        return true;
                    }
                    if v.waiting
                        || v.phase == "failed"
                        || v.phase == "unresponsive"
                        || Instant::now() >= end
                    {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            })
            .await
            .unwrap_or(false);
            if !drained {
                store.fail("任务尚未结束或数据尚未保存，已暂停安装。请在服务与诊断中处理后，再点击安装更新。" );
                return Ok(store.snapshot());
            }
            store.phase("installing");
            let bytes = store.bytes.lock().unwrap().take().unwrap();
            let install = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
            // Windows launches the verified installer and exits here; this path
            // handles launch failure, or platforms whose installer returns.
            match install {
                Ok(Ok(())) => {
                    controller.quitting.store(true, Ordering::SeqCst);
                    app.restart();
                }
                _ => {
                    store.fail("安装器未能启动，请重新下载后重试，或到 GitHub 版本页手动安装。");
                    drop(_reservation);
                    if was_running {
                        let _ = controller.action("retry");
                    }
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(store.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Live network diagnostic; no install or user data access"]
    fn stable_update_feed_network() {
        // The plugin installs this provider in check(); the transport-only
        // diagnostic deliberately does not instantiate a desktop application.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let response = tauri::async_runtime::block_on(async {
            reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap()
                .get(format!("{RELEASES}/latest/download/latest.json")).send().await
        }).expect("Native update transport could not reach GitHub through system proxy");
        eprintln!("UPDATER_FEED_HTTP {}",response.status().as_u16());
        assert!(response.status().is_success() || response.status().as_u16()==404);
    }
    #[test]
    fn only_project_https_artifacts_are_accepted() {
        assert!(trusted_download(
            &format!("{RELEASES}/download/v1.14.0/Setup.exe")
                .parse()
                .unwrap()
        ));
        for url in [
            "http://github.com/xiadongping-oss/codex-gateway/releases/download/v2/a.exe",
            "https://github.com/another/project/releases/download/v2/a.exe",
            "https://github.com.evil.test/xiadongping-oss/codex-gateway/releases/download/a.exe",
            "https://user:secret@github.com/xiadongping-oss/codex-gateway/releases/download/a.exe",
        ] {
            assert!(!trusted_download(&url.parse().unwrap()));
        }
    }
    #[test]
    fn operation_reservation_releases_on_failure_and_blocks_overlap() {
        let flag = AtomicBool::new(false);
        {
            let _first = reserve(&flag).unwrap();
            assert!(reserve(&flag).is_err());
        }
        assert!(reserve(&flag).is_ok());
    }
    #[test]
    fn failed_check_is_distinct_from_latest_and_does_not_erase_current_version() {
        let store = Store::new("1.13.1".into());
        store.fail(check_error(&tauri_plugin_updater::Error::ReleaseNotFound));
        let s = store.snapshot();
        assert_eq!(s.phase, "error");
        assert_eq!(s.current_version, "1.13.1");
        assert!(!s.error.is_empty());
    }
}
