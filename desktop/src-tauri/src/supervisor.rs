use crate::diagnostics::{Event, Log};
use crate::{
    console::{validate_bootstrap, Console},
    protocol::{read_frame, Session},
    resources::Resources,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufReader, Read},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

pub struct Settings {
    pub resources: PathBuf,
    pub data: PathBuf,
    pub webview_data: PathBuf,
    pub port: u16,
    pub bridge_port: Option<u16>,
    pub smoke: bool,
    pub isolated: bool,
    pub smoke_case: String,
}
impl Settings {
    pub fn resolve(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let mut data = if cfg!(target_os = "macos") {
            app.path().data_dir()?
        } else {
            app.path().local_data_dir()?
        }
        .join("CodexGateway");
        let mut resources = app.path().resource_dir()?.join("gateway-resources");
        let mut port = 4173;
        let mut bridge_port = None;
        let mut smoke = false;
        let mut isolated = false;
        let mut smoke_case = String::from("normal");
        if cfg!(debug_assertions) {
            for arg in std::env::args().skip(1) {
                if let Some(v) = arg.strip_prefix("--data-dir=") {
                    data = PathBuf::from(v);
                } else if let Some(v) = arg.strip_prefix("--resources=") {
                    resources = PathBuf::from(v);
                } else if let Some(v) = arg.strip_prefix("--port=") {
                    port = v.parse::<u16>()?;
                } else if let Some(v) = arg.strip_prefix("--bridge-port=") {
                    bridge_port = Some(v.parse::<u16>()?);
                } else if let Some(v) = arg.strip_prefix("--smoke-case=") {
                    smoke_case = v.into();
                } else if arg == "--smoke" {
                    smoke = true;
                } else if arg == "--isolated" {
                    isolated = true;
                } else if arg == "--from-autostart" {
                    // Visibility is handled by the native desktop state, in all builds.
                } else {
                    return Err("Unknown desktop development option".into());
                }
            }
        }
        if !data.is_absolute() || !resources.is_absolute() || port == 0 {
            return Err("Absolute paths and valid port required".into());
        }
        let webview_data = data
            .parent()
            .ok_or("Missing data parent")?
            .join("CodexGatewayDesktop/webview");
        if (smoke || isolated) && !std::env::args().any(|a| a.starts_with("--data-dir=")) {
            return Err("Isolated checks require an explicit test data directory".into());
        }
        validate_bridge_port(bridge_port, smoke || isolated)?;
        if ![
            "normal",
            "session-loss",
            "unresponsive",
            "channel-loss",
            "desktop",
            "tray-menu",
            "node-crash",
            "crash-loop",
            "shell-crash",
            "migration",
            "migration-fresh",
            "soak",
            "workspace",
        ]
        .contains(&smoke_case.as_str())
            || (smoke_case != "normal"
                && !smoke
                && !(matches!(smoke_case.as_str(), "tray-menu" | "migration") && isolated))
        {
            return Err("Invalid smoke scenario".into());
        }
        if smoke_case == "soak" && !(isolated && smoke) {
            return Err("Soak checks require explicit debug isolation".into());
        }
        Ok(Self {
            resources,
            data,
            webview_data,
            port,
            bridge_port,
            smoke,
            isolated,
            smoke_case,
        })
    }
}
fn validate_bridge_port(port: Option<u16>, isolated: bool) -> Result<(), &'static str> {
    // The pool reserves up to six adjacent ports; only explicit debug isolation
    // may override its base. Never accept inherited BRIDGE_* environment values.
    if port.is_some_and(|p| !isolated || p == 0 || p > u16::MAX - 5) {
        return Err("Bridge port override requires isolation and a valid six-port range");
    }
    Ok(())
}
#[derive(Clone, Serialize)]
pub struct ViewState {
    pub phase: String,
    pub title: String,
    pub message: String,
    pub badge: String,
    pub port: u16,
    pub active: u64,
    pub background: u64,
    pub waiting: bool,
    pub code: String,
}
impl ViewState {
    fn new(phase: &str, title: &str, message: &str, badge: &str, port: u16) -> Self {
        Self {
            phase: phase.into(),
            title: title.into(),
            message: message.into(),
            badge: badge.into(),
            port,
            active: 0,
            background: 0,
            waiting: false,
            code: String::new(),
        }
    }
}
fn backup_view(port: u16) -> ViewState {
    ViewState::new(
        "maintenance",
        "网关已停止",
        "本机服务已停止。",
        "已停止",
        port,
    )
}
fn failure(code: &str, port: u16) -> ViewState {
    let message = match code {
        "PORT_IN_USE" => "服务端口已被其他程序占用。请从原入口停止已有服务，再重新启动。",
        "DATA_IN_USE" => {
            "数据目录已有使用记录。请先退出原实例；异常退出后的记录需要确认恢复，应用不会自动删除。"
        }
        "DATA_MIGRATION_REQUIRED" => {
            "检测到旧版数据。请完成数据迁移后再启动桌面版，原有数据已保留。"
        }
        "DATA_MIGRATION_PENDING" => {
            "数据迁移尚未完成。请先恢复或取消迁移，再启动桌面版；迁移备份已保留。"
        }
        "DATA_VERSION_UNSUPPORTED" => "数据版本不兼容，请使用匹配版本的应用。",
        "DATA_DIR_INVALID" | "DATA_DIR_UNWRITABLE" => {
            "数据目录不可用，请检查目录位置和写入权限后重试。"
        }
        "RESOURCES_MISSING" | "RESOURCES_INVALID" | "BRIDGE_PATCH_INVALID" => {
            "应用文件缺失或校验失败，请重新准备完整应用后重试。"
        }
        "IDENTITY_MISMATCH" | "FRAME_INVALID" => {
            "无法确认网关身份，已停止本次连接。请重新启动应用。"
        }
        "RECOVERY_LIMIT" => {
            "网关在 5 分钟内已自动恢复 3 次。为避免反复启动，已暂停恢复；请查看诊断日志后再重试。"
        }
        "PROCESS_TREE_UNAVAILABLE" => "无法建立网关进程管理，已取消启动。请检查系统环境后重试。",
        "TREE_STOP_FAILED" => "仍有本次启动的进程未确认退出。已阻止重新启动，请退出应用后检查。",
        _ => "网关连接已中断，本次服务已停止。请检查应用与数据目录后重试。",
    };
    let mut view = ViewState::new("failed", "网关未能运行", message, "需要处理", port);
    view.code = code.into();
    view
}
type MigrationReply = Result<Value, String>;
enum Work {
    Action(String),
    Navigate(String),
    Migration(crate::migration::Request, SyncSender<MigrationReply>),
}
pub struct Controller {
    pub view: Arc<Mutex<ViewState>>,
    pub quitting: Arc<AtomicBool>,
    pub rendered: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    sender: SyncSender<Work>,
}
impl Controller {
    pub fn navigate(&self, page: &str) -> Result<(), String> {
        if !crate::desktop::business_page(page) {
            return Err("页面不可用".into());
        }
        self.sender
            .try_send(Work::Navigate(page.into()))
            .map_err(|_| "正在处理，请稍后重试".into())
    }
    pub fn action(&self, action: &str) -> Result<(), String> {
        if ![
            "retry",
            "reopen",
            "show",
            "quit",
            "continue",
            "force",
            "logs",
            "restart",
            "fresh-start",
            "maintenance",
            "stop",
        ]
        .contains(&action)
        {
            return Err("操作无效".into());
        }
        if action == "quit" {
            self.cancel.store(true, Ordering::Relaxed);
        }
        self.sender
            .try_send(Work::Action(action.into()))
            .map_err(|_| "正在处理，请稍后重试".into())
    }
    pub fn migration(
        &self,
        request: crate::migration::Request,
    ) -> Result<Receiver<MigrationReply>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Work::Migration(request, sender))
            .map_err(|_| "MIGRATION_BUSY")?;
        Ok(receiver)
    }
    pub fn start(app: tauri::AppHandle, settings: Settings, quitting: Arc<AtomicBool>) -> Self {
        let view = Arc::new(Mutex::new(ViewState::new(
            "starting",
            "正在启动网关",
            "正在校验应用文件并准备本机服务。",
            "正在准备",
            settings.port,
        )));
        let rendered = Arc::new(AtomicBool::new(false));
        let cancel = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(8);
        let first_run = ((!settings.smoke && !settings.isolated)
            || matches!(
                settings.smoke_case.as_str(),
                "migration" | "migration-fresh"
            ))
            && crate::migration::new_install(&settings);
        if first_run {
            crate::desktop::set_page(&app, "data");
            *view.lock().unwrap() = ViewState::new(
                "setup",
                "准备你的工作空间",
                "可以导入旧版账号、配置和图库，也可以建立全新的本机工作空间。",
                "首次使用",
                settings.port,
            );
        } else {
            sender.send(Work::Action("retry".into())).unwrap();
        }
        let (v, q, r, c) = (
            view.clone(),
            quitting.clone(),
            rendered.clone(),
            cancel.clone(),
        );
        thread::spawn(move || run(app, settings, receiver, v, q, r, c));
        Self {
            view,
            quitting,
            rendered,
            cancel,
            sender,
        }
    }
}
fn official_login_env_allowed(key: &str, isolated: bool) -> bool {
    // Official login/import reads the user's selected profile; bridge credentials
    // remain separately fixed by the managed storage policy. Tests inherit neither.
    !isolated && matches!(key, "CODEX_HOME" | "CODEX_CLIENT_PATH")
}
fn launch(settings: &Settings, cancel: &AtomicBool) -> Result<Session, String> {
    let resources = Resources::load(&settings.resources)?;
    if cancel.load(Ordering::Relaxed) {
        return Err("CANCELLED".into());
    }
    #[cfg(windows)]
    if crate::cold_recovery::recover(&settings.data) {
        let _ = Log::new(&settings.webview_data).record(Event::RecoveryScheduled);
    }
    #[cfg(target_os = "macos")]
    if crate::mac_recovery::recover(&settings.data) {
        let _ = Log::new(&settings.webview_data).record(Event::RecoveryScheduled);
    }
    let mut command = Command::new(&resources.node);
    command
        .arg(&resources.entry)
        .current_dir(&resources.root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if [
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "LANG",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ]
        .contains(&upper.as_str())
            || official_login_env_allowed(&upper, settings.smoke || settings.isolated)
        {
            command.env(key, value);
        }
    }
    command
        .env("CGW_DATA_DIR", &settings.data)
        .env("LAUNCHER_PORT", settings.port.to_string());
    if settings.smoke || settings.isolated {
        let home = settings
            .data
            .parent()
            .ok_or("DATA_DIR_INVALID")?
            .join("isolated-home");
        fs::create_dir_all(&home).map_err(|_| "DATA_DIR_UNWRITABLE")?;
        for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            command.env(key, &home);
        }
        command.env("DISABLE_AUTOSTART", "1");
        if let Some(port) = settings.bridge_port {
            command.env("BRIDGE_PORT", port.to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let (mut child, tree) = crate::process_tree::Tree::spawn(&mut command)?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (sender, receiver) = mpsc::sync_channel(16);
    let mut session = Session::new(child, receiver);
    session.tree = Some(tree);
    let alive = session.alive.clone();
    thread::spawn(move || {
        let mut input = BufReader::new(stdout);
        loop {
            let frame = read_frame(&mut input);
            let failed = frame.is_err();
            if failed {
                alive.store(false, Ordering::SeqCst);
            }
            if sender.try_send(frame).is_err() || failed {
                alive.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
    // Always drain stderr, including during startup. No raw protocol or credential
    // payload is copied to UI or lifecycle diagnostics.
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    session.send("initialize", json!({"challenge":session.challenge}))?;
    let initialized = wait_frame(&mut session, Duration::from_secs(5), cancel, |v| {
        v["type"] == "initialize"
    })?;
    session.verify_identity(&initialized, &resources.root, &resources.version)?;
    session.send("start", json!({}))?;
    let ready = wait_frame(&mut session, Duration::from_secs(30), cancel, |v| {
        v["type"] == "ready"
    })?;
    verify_ready(&ready, settings)?;
    session.lease = Some(crate::recovery::Lease::capture(
        &settings.data,
        session.child.id(),
    )?);
    #[cfg(windows)]
    crate::cold_recovery::save(
        session.lease.as_ref().unwrap(),
        session.tree.as_ref().unwrap(),
    )
    .map_err(|_| "RECOVERY_RECEIPT_FAILED")?;
    #[cfg(target_os = "macos")]
    crate::mac_recovery::save(
        session.lease.as_ref().unwrap(),
        session.tree.as_ref().unwrap(),
    )
    .map_err(|_| "RECOVERY_RECEIPT_FAILED")?;
    Ok(session)
}
fn wait_frame(
    session: &mut Session,
    duration: Duration,
    cancel: &AtomicBool,
    wanted: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        if cancel.load(Ordering::Relaxed) {
            return Err("CANCELLED".into());
        }
        if let Some(frame) = session.next(Duration::from_millis(50))? {
            check_fault(&frame)?;
            if wanted(&frame) {
                return Ok(frame);
            }
        }
    }
    Err("CONTROL_CHANNEL_LOST".into())
}
fn check_fault(v: &Value) -> Result<(), String> {
    if v["type"] == "fatal" {
        return Err(v["payload"]["code"]
            .as_str()
            .unwrap_or("INTERNAL_ERROR")
            .into());
    }
    if v["kind"] == "response" && v["ok"] != true {
        return Err(v["error"]["code"]
            .as_str()
            .unwrap_or("INTERNAL_ERROR")
            .into());
    }
    Ok(())
}
fn verify_ready(value: &Value, settings: &Settings) -> Result<(), String> {
    let p = &value["payload"];
    let data = p["dataRoot"]
        .as_str()
        .and_then(|s| dunce::canonicalize(s).ok());
    if value["kind"] != "event"
        || p["state"] != "ready"
        || p["port"].as_u64() != Some(settings.port as u64)
        || p["origin"] != format!("http://127.0.0.1:{}", settings.port)
        || p["bindHost"] != "127.0.0.1"
        || p["storageVersion"] != 1
        || data != dunce::canonicalize(&settings.data).ok()
        || data.is_none()
    {
        return Err("IDENTITY_MISMATCH".into());
    }
    Ok(())
}
fn open_console(
    app: &tauri::AppHandle,
    settings: &Settings,
    session: &mut Session,
    cancel: &AtomicBool,
) -> Result<Console, String> {
    session.send("bootstrap", json!({}))?;
    let response = wait_frame(session, Duration::from_secs(5), cancel, |v| {
        v["type"] == "bootstrap"
    })?;
    let url = validate_bootstrap(&response, &session.launch_id, settings.port)?;
    Console::open(
        app,
        url,
        &session.launch_id,
        settings.port,
        settings.isolated || settings.smoke,
        session.alive.clone(),
        &settings.webview_data,
    )
}

fn verify_startup_page(app: &tauri::AppHandle, title: &str) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        let (tx, rx) = mpsc::sync_channel(1);
        let script = format!(
            "document.getElementById('title')?.textContent === {}",
            serde_json::to_string(title).unwrap()
        );
        if window
            .eval_with_callback(script, move |raw| {
                let _ = tx.try_send(raw == "true");
            })
            .is_err()
        {
            return false;
        }
        if rx.recv_timeout(Duration::from_millis(300)).unwrap_or(false) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn run(
    app: tauri::AppHandle,
    settings: Settings,
    commands: Receiver<Work>,
    view: Arc<Mutex<ViewState>>,
    quitting: Arc<AtomicBool>,
    rendered: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) {
    let mut session: Option<Session> = None;
    let mut console: Option<Console> = None;
    let mut exit_requested = false;
    let mut stay_for_backups = false;
    let mut stop_deadline = None;
    let mut last_status = Instant::now();
    let mut smoke_stage = 0;
    let mut desktop_check = crate::desktop_check::Check::default();
    let mut desktop_passed = false;
    #[cfg(debug_assertions)]
    let mut workspace_check = crate::workspace_check::Check::default();
    #[cfg(debug_assertions)]
    let mut workspace_passed = false;
    #[cfg(not(debug_assertions))]
    let workspace_passed = false;
    let log = Log::new(&settings.webview_data);
    let mut budget = crate::recovery::Budget::default();
    let mut retry_at = None;
    let mut tree_blocked = false;
    let mut last_reply = Instant::now();
    let mut last_tick = Instant::now();
    let mut unresponsive = false;
    let mut crash_count = 0;
    let mut migration = crate::migration::Wizard::default();
    let mut pending_navigation: Option<String> = None;
    let migration_passed = crate::migration_check::start(&app, &settings);
    #[cfg(debug_assertions)]
    let mut soak = crate::soak_check::Check::new(&settings);
    loop {
        let mut action = match commands.try_recv().ok() {
            Some(Work::Action(action)) => Some(action),
            Some(Work::Navigate(page)) => {
                crate::desktop::set_page(&app, &page);
                pending_navigation = Some(page);
                Some("show".into())
            }
            Some(Work::Migration(request, reply)) => {
                if settings.smoke_case == "migration" {
                    eprintln!("R03_REQUEST_RECEIVED");
                }
                if session.is_some()
                    || exit_requested
                    || tree_blocked
                    || retry_at.is_some()
                    || cancel.load(Ordering::Relaxed)
                {
                    let _ = reply.send(Err("MIGRATION_GATEWAY_ACTIVE".into()));
                } else {
                    let previous = view.lock().unwrap().clone();
                    if !request.is_context() {
                        *view.lock().unwrap() = ViewState::new("migrating", "正在处理迁移", "正在核对文件并保留备份，请等待完成。退出会中断本次操作，恢复记录将保留。", "处理中", settings.port);
                    }
                    let result = migration.execute(request, &settings, &cancel);
                    if settings.smoke_case == "migration" {
                        eprintln!("R03_REQUEST_FINISHED {}", result.is_ok());
                    }
                    *view.lock().unwrap() =
                        if result.as_ref().is_ok_and(|r| r["phase"] == "committed") {
                            ViewState::new(
                                "migration_complete",
                                "旧数据已迁移",
                                "备份已保留。可以启动网关；启动写入新数据后，将不能直接回退覆盖。",
                                "迁移完成",
                                settings.port,
                            )
                        } else if result.as_ref().is_ok_and(|r| r["phase"] == "aborted") {
                            if crate::migration::new_install(&settings) {
                                ViewState::new(
                                    "setup",
                                    "迁移已取消",
                                    "原数据与备份均已保留，可重新检查或建立新的工作空间。",
                                    "已恢复",
                                    settings.port,
                                )
                            } else {
                                failure("DATA_MIGRATION_REQUIRED", settings.port)
                            }
                        } else if std::fs::symlink_metadata(crate::migration::guard(&settings.data))
                            .is_ok()
                        {
                            failure("DATA_MIGRATION_PENDING", settings.port)
                        } else {
                            previous
                        };
                    if result
                        .as_ref()
                        .is_err_and(|e| e == "MIGRATION_WORKER_UNCONFIRMED")
                    {
                        tree_blocked = true;
                    }
                    let _ = reply.send(result);
                }
                None
            }
            None => None,
        };
        if action.as_deref() == Some("quit") {
            stay_for_backups = false;
        }
        if matches!(action.as_deref(), Some("maintenance" | "stop"))
            && !exit_requested
            && !tree_blocked
        {
            crate::desktop::set_page(
                &app,
                if action.as_deref() == Some("stop") {
                    "service"
                } else {
                    "data"
                },
            );
            retry_at = None;
            if session.is_some() {
                stay_for_backups = true;
                action = Some("quit".into());
            } else {
                *view.lock().unwrap() = backup_view(settings.port);
                crate::desktop::show_main(&app);
                action = None;
            }
        }
        if action.as_deref() == Some("fresh-start") {
            action = if session.is_none() && crate::migration::new_install(&settings) {
                Some("retry".into())
            } else {
                None
            };
        }
        if last_tick.elapsed() > Duration::from_secs(5) {
            last_reply = Instant::now();
        }
        last_tick = Instant::now();
        if action.as_deref() == Some("logs") && log.record(Event::DiagnosticsOpened).is_ok() {
            let _ = app
                .opener()
                .open_path(log.directory().to_string_lossy(), None::<&str>);
        }
        if action.is_none()
            && retry_at.is_some_and(|t| Instant::now() >= t)
            && !cancel.load(Ordering::Relaxed)
        {
            retry_at = None;
            action = Some("retry".into());
        }
        if action.as_deref() == Some("restart") && unresponsive && !exit_requested {
            if let Some(c) = console.take() {
                c.close(&app);
            }
            if let Some(mut s) = session.take() {
                tree_blocked = !s.cleanup();
                if !tree_blocked
                    && s.lease
                        .as_ref()
                        .is_some_and(|lease| lease.release_after_tree_exit())
                {
                    retry_at = Some(Instant::now());
                } else {
                    *view.lock().unwrap() = failure("TREE_STOP_FAILED", settings.port);
                }
            }
        }
        if settings.smoke_case == "tray-menu"
            && smoke_stage == 0
            && console.as_ref().is_some_and(|c| c.smoke_passed())
        {
            console.as_ref().unwrap().test_menu(&app);
            smoke_stage = 1;
        }
        if action.as_deref() == Some("show") || action.as_deref() == Some("reopen") {
            if !exit_requested {
                if let Some(c) = console.as_ref() {
                    if !c.restore(&app) {
                        crate::desktop::show_main(&app);
                    }
                } else {
                    crate::desktop::show_main(&app);
                    action = Some("reopen".into());
                }
            } else {
                crate::desktop::show_main(&app);
            }
        }
        if settings.smoke
            && settings.smoke_case == "session-loss"
            && smoke_stage == 1
            && console.is_none()
        {
            let observed = verify_startup_page(&app, "请重新打开控制台");
            eprintln!("D02_SESSION_RETURN {observed}");
            if !observed {
                if let Some(mut s) = session.take() {
                    s.cleanup();
                }
                quitting.store(true, Ordering::Relaxed);
                app.exit(1);
                return;
            }
            smoke_stage = 2;
            action = Some("reopen".into());
        }
        if settings.smoke
            && settings.smoke_case == "unresponsive"
            && smoke_stage == 1
            && !unresponsive
            && console.is_none()
        {
            let observed = verify_startup_page(&app, "网关已恢复响应");
            eprintln!("D05_RESPONSE_RETURN {observed}");
            if !observed {
                if let Some(mut s) = session.take() {
                    s.cleanup();
                }
                quitting.store(true, Ordering::Relaxed);
                app.exit(1);
                return;
            }
            smoke_stage = 2;
            action = Some("reopen".into());
        }
        if action.as_deref() == Some("retry")
            && session.is_none()
            && !exit_requested
            && !tree_blocked
        {
            crate::desktop::set_page(&app, pending_navigation.as_deref().unwrap_or("overview"));
            retry_at = None;
            let _ = log.record(Event::Starting);
            cancel.store(false, Ordering::Relaxed);
            *view.lock().unwrap() = ViewState::new(
                "starting",
                "正在启动网关",
                "正在校验应用文件并准备本机服务。",
                "正在准备",
                settings.port,
            );
            let connected = launch(&settings, &cancel).and_then(|mut s| {
                let c = open_console(&app, &settings, &mut s, &cancel)?;
                Ok((s, c))
            });
            match connected {
                Ok((s, c)) => {
                    if crash_count > 0 {
                        smoke_stage = 2;
                    }
                    let _ = log.record(Event::Ready);
                    last_reply = Instant::now();
                    unresponsive = false;
                    session = Some(s);
                    console = Some(c);
                    *view.lock().unwrap() = ViewState::new(
                        "ready",
                        "网关已就绪",
                        "本机服务已启动，可以连接支持 OpenAI API 的应用。",
                        "运行中",
                        settings.port,
                    );
                }
                Err(code) => {
                    let _ = log.fault(&code);
                    *view.lock().unwrap() = failure(&code, settings.port);
                    crate::desktop::show_main(&app);
                    if settings.smoke {
                        quitting.store(true, Ordering::Relaxed);
                        app.exit(1);
                        return;
                    }
                }
            }
        }
        if action.as_deref() == Some("reopen") && console.is_none() && !exit_requested {
            if let Some(s) = session.as_mut() {
                match open_console(&app, &settings, s, &cancel) {
                    Ok(c) => {
                        console = Some(c);
                    }
                    Err(_) => {
                        view.lock().unwrap().message = "暂时无法打开控制台，请稍后重试。".into();
                    }
                }
            }
        }
        if settings.smoke && smoke_stage == 0 && console.as_ref().is_some_and(|c| c.smoke_passed())
        {
            match settings.smoke_case.as_str() {
                "shell-crash" => {
                    eprintln!("D02_CHECK {}", console.as_ref().unwrap().smoke_report());
                    eprintln!("D04_SHELL_READY");
                    smoke_stage = 1;
                }
                "session-loss" => {
                    console
                        .as_ref()
                        .unwrap()
                        .expire_test_session()
                        .expect("isolated cookie test");
                    smoke_stage = 1;
                }
                "unresponsive" => {
                    // Exercise the real watchdog and fresh WebView path without
                    // hanging a user's process or depending on scheduler timing.
                    last_reply = Instant::now() - Duration::from_secs(6);
                    smoke_stage = 1;
                }
                "channel-loss" => {
                    eprintln!("D02_CHECK {}", console.as_ref().unwrap().smoke_report());
                    session.as_mut().unwrap().input.take();
                    smoke_stage = 1;
                }
                _ => {}
            }
        }
        if settings.smoke
            && console.as_ref().is_some_and(|c| c.smoke_passed())
            && ((settings.smoke_case == "node-crash" && crash_count == 0)
                || (settings.smoke_case == "crash-loop" && crash_count < 4))
        {
            eprintln!("D02_CHECK {}", console.as_ref().unwrap().smoke_report());
            let s = session.as_mut().unwrap();
            let _ = s.child.kill();
            let _ = s.child.wait();
            crash_count += 1;
            eprintln!("D04_NODE_CRASH {crash_count}");
        }
        if settings.smoke
            && settings.smoke_case == "desktop"
            && console.as_ref().is_some_and(|c| c.smoke_passed())
        {
            match desktop_check.tick(&app, console.as_ref().unwrap(), session.as_mut().unwrap()) {
                Ok(passed) => desktop_passed = passed,
                Err(code) => {
                    eprintln!("D03_FAILED {code}");
                    if let Some(c) = console.take() {
                        c.close(&app);
                    }
                    if let Some(mut s) = session.take() {
                        s.cleanup();
                    }
                    quitting.store(true, Ordering::Relaxed);
                    app.exit(1);
                    return;
                }
            }
        }
        #[cfg(debug_assertions)]
        if settings.smoke
            && settings.smoke_case == "workspace"
            && !workspace_passed
            && !exit_requested
        {
            match workspace_check.tick(&app, console.as_ref(), session.as_mut()) {
                Ok(passed) => workspace_passed = passed,
                Err(code) => {
                    eprintln!("W01_FAILED {code}");
                    if let Some(c) = console.take() {
                        c.close(&app);
                    }
                    if let Some(mut s) = session.take() {
                        s.cleanup();
                    }
                    quitting.store(true, Ordering::Relaxed);
                    app.exit(1);
                    return;
                }
            }
        }
        #[cfg(debug_assertions)]
        if settings.smoke_case == "soak" {
            if let Some(check) = soak.as_mut() {
                if check.tick(
                    &view.lock().unwrap().phase,
                    session.as_ref().map(|s| s.child.id()),
                    console.as_ref(),
                ) {
                    action = Some("quit".into());
                }
            } else {
                action = Some("quit".into());
            }
        }
        let auto_quit = settings.smoke
            && rendered.load(Ordering::Relaxed)
            && console.as_ref().is_some_and(|c| c.smoke_passed())
            && (settings.smoke_case == "normal"
                || (matches!(
                    settings.smoke_case.as_str(),
                    "migration" | "migration-fresh"
                ) && migration_passed.load(Ordering::SeqCst))
                || (settings.smoke_case == "node-crash" && crash_count == 1 && smoke_stage == 2)
                || desktop_passed
                || workspace_passed
                || (settings.smoke_case == "unresponsive" && smoke_stage == 2)
                || (settings.smoke_case == "session-loss" && smoke_stage == 2));
        if (action.as_deref() == Some("quit") || auto_quit) && !exit_requested {
            retry_at = None;
            exit_requested = true;
            if settings.smoke {
                if let Some(c) = console.as_ref() {
                    eprintln!("D02_CHECK {}", c.smoke_report());
                }
            }
            if let Some(c) = console.as_ref() {
                c.suspend(&app);
            }
            if let Some(s) = session.as_mut() {
                let _ = s.send("shutdown", json!({"reason":"user_exit"}));
                stop_deadline = Some(Instant::now() + Duration::from_secs(38));
                *view.lock().unwrap() = ViewState::new(
                    "stopping",
                    "正在安全退出",
                    "正在等待当前任务完成并保存数据。",
                    "正在退出",
                    settings.port,
                );
            }
        }
        if view.lock().unwrap().waiting {
            if let Some(action @ ("continue" | "force")) = action.as_deref() {
                if let Some(s) = session.as_mut() {
                    let payload = if action == "continue" {
                        json!({"waitMs":30000})
                    } else {
                        json!({})
                    };
                    let _ = s.send(&format!("shutdown.{action}"), payload);
                    view.lock().unwrap().waiting = false;
                    stop_deadline = Some(
                        Instant::now()
                            + Duration::from_secs(if action == "continue" { 38 } else { 8 }),
                    );
                }
            }
        }
        if session.is_none() {
            if exit_requested {
                quitting.store(true, Ordering::Relaxed);
                app.exit(0);
                return;
            }
            thread::sleep(Duration::from_millis(50));
            continue;
        }
        let mut failed = None;
        if !exit_requested
            && last_status.elapsed() > Duration::from_secs(1)
            && !session.as_ref().unwrap().pending("status")
        {
            if let Err(e) = session.as_mut().unwrap().send("status", json!({})) {
                failed = Some(e);
            }
            last_status = Instant::now();
        }
        if !exit_requested && !unresponsive && last_reply.elapsed() > Duration::from_secs(5) {
            unresponsive = true;
            let _ = log.record(Event::Unresponsive);
            // A suspended console has a permanently revoked navigation policy.
            // Drop it so reopening obtains a fresh bootstrap and WebView.
            if let Some(c) = console.take() {
                c.close(&app);
            }
            *view.lock().unwrap() = ViewState::new(
                "unresponsive",
                "网关暂时没有响应",
                "可以继续等待；结束并重启可能中断当前任务和未保存的数据。",
                "等待响应",
                settings.port,
            );
            crate::desktop::show_main(&app);
        }
        let result = session.as_mut().unwrap().next(Duration::from_millis(50));
        match result {
            Ok(Some(frame)) => {
                if let Err(e) = check_fault(&frame) {
                    failed = Some(e)
                }
                match frame["type"].as_str() {
                    Some("status") => {
                        last_reply = Instant::now();
                        if unresponsive {
                            unresponsive = false;
                            *view.lock().unwrap() = ViewState::new(
                                "ready",
                                "网关已恢复响应",
                                "可以重新打开控制台。",
                                "运行中",
                                settings.port,
                            );
                        }
                        let mut v = view.lock().unwrap();
                        let p = &frame["payload"];
                        v.active = p["activeRequests"].as_u64().unwrap_or(0);
                        v.background = p["backgroundTasks"].as_u64().unwrap_or(0);
                    }
                    Some("shutdown.progress" | "shutdown.waiting") => {
                        let p = &frame["payload"];
                        let mut v = view.lock().unwrap();
                        v.active = p["activeRequests"].as_u64().unwrap_or(0);
                        v.background = p["backgroundTasks"].as_u64().unwrap_or(0);
                        if frame["type"] == "shutdown.waiting" {
                            v.waiting = true;
                            stop_deadline = None;
                            v.title = "还有任务需要处理".into();
                            v.message = if p["reason"] == "FLUSH_FAILED" {
                                "数据保存未完成。修复写入问题后可继续等待，或结束并退出。"
                            } else {
                                "当前任务仍在运行。可以继续等待，也可以结束任务后退出。"
                            }
                            .into();
                        }
                    }
                    Some("stopped") => {
                        let p = &frame["payload"];
                        let mut s = session.take().unwrap();
                        let end = Instant::now() + Duration::from_secs(2);
                        let mut actual = None;
                        while Instant::now() < end {
                            if let Ok(Some(code)) = s.child.try_wait() {
                                actual = Some(code);
                                break;
                            }
                            thread::sleep(Duration::from_millis(20));
                        }
                        let clean = p["outcome"] == "graceful"
                            && p["persisted"] == true
                            && p["childrenExited"] == true
                            && p["exitCode"] == 0
                            && actual.is_some_and(|c| c.success());
                        #[cfg(windows)]
                        let clean = clean && s.tree.as_mut().is_none_or(|t| t.empty());
                        if let Some(c) = console.take() {
                            c.close(&app);
                        }
                        let tree_clean = s.cleanup();
                        let _ = log.record(Event::Stopped);
                        if stay_for_backups
                            && !cancel.load(Ordering::Relaxed)
                            && clean
                            && tree_clean
                        {
                            stay_for_backups = false;
                            exit_requested = false;
                            stop_deadline = None;
                            *view.lock().unwrap() = backup_view(settings.port);
                            crate::desktop::show_main(&app);
                            continue;
                        }
                        if exit_requested {
                            quitting.store(true, Ordering::Relaxed);
                            app.exit(if clean && tree_clean { 0 } else { 1 });
                            return;
                        }
                        failed = Some("CONTROL_CHANNEL_LOST".into());
                    }
                    _ => {}
                }
            }
            Err(e) => failed = Some(e),
            _ => {}
        }
        if !exit_requested {
            if failed.is_none()
                && session
                    .as_mut()
                    .is_some_and(|s| matches!(s.child.try_wait(), Ok(Some(_))))
            {
                failed = Some("CONTROL_CHANNEL_LOST".into());
            }
            if let Some(c) = console.as_mut() {
                if c.poll(&app).is_err() {
                    if settings.smoke {
                        eprintln!("D02_CHECK {}", c.smoke_report());
                    }
                    if let Some(c) = console.take() {
                        c.close(&app);
                    }
                    if settings.smoke
                        && failed.is_none()
                        && !(settings.smoke_case == "session-loss" && smoke_stage == 1)
                    {
                        failed = Some("CONSOLE_SESSION_LOST".into());
                    } else {
                        let mut v = view.lock().unwrap();
                        v.title = "请重新打开控制台".into();
                        v.message =
                            "控制台会话已失效，网关仍在运行。重新打开即可建立新会话。".into();
                    }
                } else if settings.smoke
                    && c.started.elapsed() > Duration::from_secs(35)
                    && !c.smoke_passed()
                {
                    eprintln!("D02_CHECK {}", c.smoke_report());
                    failed = Some("CONSOLE_TEST_FAILED".into());
                }
            }
            if let (Some(c), Some(page)) = (console.as_ref(), pending_navigation.as_deref()) {
                if c.navigate(&app, page) {
                    pending_navigation = None;
                }
            }
        }
        if stop_deadline.is_some_and(|d| Instant::now() > d) {
            failed = Some("CONTROL_CHANNEL_LOST".into())
        }
        if let Some(code) = failed {
            let _ = log.fault(&code);
            if let Some(c) = console.take() {
                c.close(&app);
            }
            let mut can_recover = false;
            if let Some(mut s) = session.take() {
                // A missing pipe alone is not evidence of a dead process. Only an
                // already-exited owned Child qualifies for automatic recovery.
                let dead = matches!(s.child.try_wait(), Ok(Some(_)));
                tree_blocked = !s.cleanup();
                let _ = log.record(if tree_blocked {
                    Event::TreeStopFailed
                } else {
                    Event::TreeStopped
                });
                let ownership_released = !tree_blocked
                    && s.lease
                        .as_ref()
                        .is_some_and(|lease| lease.release_after_tree_exit());
                can_recover = dead && code == "CONTROL_CHANNEL_LOST" && ownership_released;
            }
            *view.lock().unwrap() = failure(&code, settings.port);
            crate::desktop::show_main(&app);
            if can_recover
                && !exit_requested
                && settings.smoke_case != "channel-loss"
                && !cancel.load(Ordering::Relaxed)
            {
                if let Some(delay) = budget.reserve(Instant::now()) {
                    retry_at = Some(Instant::now() + delay);
                    *view.lock().unwrap() = ViewState::new(
                        "recovering",
                        "正在恢复网关",
                        "已确认旧进程退出，稍后将重新启动并建立新的控制台会话。",
                        "自动恢复",
                        settings.port,
                    );
                    let _ = log.record(Event::RecoveryScheduled);
                    if settings.smoke {
                        eprintln!("D04_RECOVERY_SCHEDULED");
                    }
                    continue;
                }
                *view.lock().unwrap() = failure("RECOVERY_LIMIT", settings.port);
                let _ = log.record(Event::RecoveryBlocked);
                if settings.smoke && settings.smoke_case == "crash-loop" {
                    let observed = verify_startup_page(&app, "网关未能运行")
                        && crash_count == 4
                        && !settings.data.join("runtime/owner.lock").exists();
                    eprintln!("D04_RECOVERY_LIMIT {observed}");
                    quitting.store(true, Ordering::Relaxed);
                    app.exit(if observed { 0 } else { 1 });
                    return;
                }
            }
            if settings.smoke && settings.smoke_case == "channel-loss" && smoke_stage == 1 {
                let observed = verify_startup_page(&app, "网关未能运行")
                    && !app
                        .webview_windows()
                        .keys()
                        .any(|s| s.starts_with("console-"));
                eprintln!("D02_CHANNEL_RETURN {observed}");
                quitting.store(true, Ordering::Relaxed);
                app.exit(if observed { 0 } else { 1 });
                return;
            }
            if exit_requested || settings.smoke {
                quitting.store(true, Ordering::Relaxed);
                app.exit(1);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn official_login_custom_paths_are_preserved_only_outside_isolation() {
        for key in ["CODEX_HOME", "CODEX_CLIENT_PATH"] {
            assert!(super::official_login_env_allowed(key, false));
            assert!(!super::official_login_env_allowed(key, true));
        }
        for key in [
            "NODE_OPTIONS",
            "NODE_PATH",
            "CGW_ADMIN_TOKEN",
            "BRIDGE_AUTH_FILE",
        ] {
            assert!(!super::official_login_env_allowed(key, false));
        }
    }
    use super::*;
    #[test]
    fn bridge_port_override_requires_isolation_and_pool_capacity() {
        assert!(validate_bridge_port(None, false).is_ok());
        assert!(validate_bridge_port(Some(50000), true).is_ok());
        assert!(validate_bridge_port(Some(50000), false).is_err());
        assert!(validate_bridge_port(Some(0), true).is_err());
        assert!(validate_bridge_port(Some(65531), true).is_err());
        assert!(validate_bridge_port(Some(65530), true).is_ok());
    }
    #[cfg(target_os = "macos")]
    fn cold_settings(data: std::path::PathBuf) -> Settings {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        Settings {
            resources: std::env::var("CGW_BUILD_RESOURCES").unwrap().into(),
            webview_data: data.parent().unwrap().join("webview"),
            data,
            port,
            bridge_port: None,
            smoke: true,
            isolated: true,
            smoke_case: "normal".into(),
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "cold recovery owner subprocess, invoked by parent test"]
    fn cold_owner_fixture() {
        use std::io::Write;
        let settings = cold_settings(std::env::var("CGW_COLD_DATA").unwrap().into());
        let mut session = launch(&settings, &AtomicBool::new(false)).unwrap();
        if std::env::var("CGW_COLD_STALE").as_deref() == Ok("1") {
            // Make stale ownership deterministic before killing the owner shell.
            // A shell-only crash may instead let Node release normally on pipe EOF.
            session.child.kill().unwrap();
            session.child.wait().unwrap();
        }
        println!("MAC_COLD_READY");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn mac_shell_crash_recovers_only_owned_lock_and_restarts_gateway() {
        for stale in [false, true] {
            cold_crash_case(stale);
        }
    }
    #[cfg(target_os = "macos")]
    fn cold_crash_case(stale: bool) {
        use std::io::{BufRead, BufReader};
        let root = std::env::temp_dir().join(format!("cgw-cold-shell-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let data = root.join("data");
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "supervisor::tests::cold_owner_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CGW_COLD_DATA", &data)
            .env("CGW_COLD_STALE", if stale { "1" } else { "0" })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let output = owner.stdout.take().unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if line == "MAC_COLD_READY" {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        let ready = rx.recv_timeout(Duration::from_secs(40)).is_ok();
        let live_refused = !crate::mac_recovery::recover(&data);
        let _ = owner.kill();
        owner.wait().unwrap();
        assert!(ready, "owner fixture failed to start");
        assert!(live_refused);
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut recovered = false;
        while Instant::now() < deadline {
            if crate::mac_recovery::recover(&data) {
                recovered = true;
                break;
            }
            if !data.join("runtime/owner.lock").exists()
                && !data.join("runtime/desktop-recovery.json").exists()
            {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !stale || recovered,
            "dead shell and empty group must allow exact owned lock recovery"
        );
        assert!(!data.join("runtime/owner.lock").exists());
        assert!(!data.join("runtime/desktop-recovery.json").exists());
        let mut session = launch(&cold_settings(data), &AtomicBool::new(false)).unwrap();
        session
            .send("shutdown", json!({"reason":"user_exit"}))
            .unwrap();
        wait_frame(
            &mut session,
            Duration::from_secs(8),
            &AtomicBool::new(false),
            |v| v["type"] == "stopped",
        )
        .unwrap();
        assert!(session.cleanup());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(any(windows, target_os = "macos"))]
    fn recovered_gateway_rejects_old_ticket_and_preserves_unknown_lock() {
        use std::io::{Read, Write};
        let root = std::env::temp_dir().join(format!("cgw-d04-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let settings = Settings {
            resources: std::env::var("CGW_BUILD_RESOURCES").unwrap().into(),
            data: root.join("data"),
            webview_data: root.join("webview"),
            port,
            bridge_port: None,
            smoke: true,
            isolated: true,
            smoke_case: "normal".into(),
        };
        let cancel = AtomicBool::new(false);
        let mut first = launch(&settings, &cancel).unwrap();
        #[cfg(target_os = "macos")]
        assert!(!first.lease.as_ref().unwrap().release_after_tree_exit());
        first.send("bootstrap", json!({})).unwrap();
        let frame = wait_frame(&mut first, Duration::from_secs(5), &cancel, |v| {
            v["type"] == "bootstrap"
        })
        .unwrap();
        let old = validate_bootstrap(&frame, &first.launch_id, port).unwrap();
        first.child.kill().unwrap();
        first.child.wait().unwrap();
        assert!(first.cleanup());
        assert!(first.lease.as_ref().unwrap().release_after_tree_exit());
        let mut second = launch(&settings, &cancel).unwrap();
        assert_ne!(first.launch_id, second.launch_id);
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            stream,
            "GET /?{} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n",
            old.query().unwrap()
        )
        .unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert!(reply.starts_with("HTTP/1.1 403"));
        second
            .send("shutdown", json!({"reason":"user_exit"}))
            .unwrap();
        wait_frame(&mut second, Duration::from_secs(8), &cancel, |v| {
            v["type"] == "stopped"
        })
        .unwrap();
        assert!(second.cleanup());
        fs::write(settings.data.join("runtime/owner.lock"), "unknown owner").unwrap();
        assert!(matches!(launch(&settings, &cancel), Err(code) if code == "DATA_IN_USE"));
        assert_eq!(
            fs::read_to_string(settings.data.join("runtime/owner.lock")).unwrap(),
            "unknown owner"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bundled_node_handshake_and_clean_exit() {
        let root = std::env::temp_dir().join(format!("cgw-d01-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let settings = Settings {
            resources: std::env::var("CGW_BUILD_RESOURCES").unwrap().into(),
            data: root.join("数据 & #"),
            webview_data: root.join("webview"),
            port,
            bridge_port: None,
            smoke: true,
            isolated: true,
            smoke_case: "normal".into(),
        };
        let mut session = launch(&settings, &AtomicBool::new(false)).unwrap();
        fn http(port: u16, path: &str, cookie: &str) -> String {
            use std::io::{Read, Write};
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(4)))
                .unwrap();
            write!(stream,"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        }
        fn ticket(s: &mut Session, port: u16) -> tauri::Url {
            s.send("bootstrap", json!({})).unwrap();
            let frame = wait_frame(s, Duration::from_secs(5), &AtomicBool::new(false), |v| {
                v["type"] == "bootstrap"
            })
            .unwrap();
            validate_bootstrap(&frame, &s.launch_id, port).unwrap()
        }
        let first = ticket(&mut session, port);
        let second = ticket(&mut session, port);
        let first_path = format!("/?{}", first.query().unwrap());
        let second_path = format!("/?{}", second.query().unwrap());
        assert!(http(port, &first_path, "").starts_with("HTTP/1.1 403"));
        let exchange = http(port, &second_path, "");
        assert!(exchange.starts_with("HTTP/1.1 302"));
        let headers = exchange.to_ascii_lowercase();
        assert!(headers.contains("httponly"));
        assert!(headers.contains("referrer-policy: no-referrer"));
        assert!(headers.contains("location: /\r\n"));
        assert!(http(port, &second_path, "").starts_with("HTTP/1.1 403"));
        let cookie = exchange
            .lines()
            .find_map(|l| l.strip_prefix("Set-Cookie: "))
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let authenticated = http(port, "/__gw/admin/session", cookie);
        assert!(authenticated.contains("\"authenticated\":true"));
        session
            .send("shutdown", json!({"reason":"user_exit"}))
            .unwrap();
        let stopped = wait_frame(
            &mut session,
            Duration::from_secs(8),
            &AtomicBool::new(false),
            |v| v["type"] == "stopped",
        )
        .unwrap();
        assert_eq!(stopped["payload"]["outcome"], "graceful");
        assert!(session.child.wait().unwrap().success());
        assert!(!settings.data.join("runtime/owner.lock").exists());
        assert!(dunce::canonicalize(&root)
            .unwrap()
            .starts_with(dunce::canonicalize(std::env::temp_dir()).unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ready_rejects_foreign_origin_and_port() {
        let settings = Settings {
            resources: PathBuf::new(),
            data: std::env::temp_dir(),
            webview_data: PathBuf::new(),
            port: 4173,
            bridge_port: None,
            smoke: true,
            isolated: true,
            smoke_case: "normal".into(),
        };
        for origin in [
            "http://localhost:4173",
            "http://127.0.0.1:4174",
            "https://example.org",
        ] {
            let value = json!({"kind":"event","payload":{"state":"ready","origin":origin,"port":4173,"bindHost":"127.0.0.1","dataRoot":settings.data,"storageVersion":1}});
            assert!(verify_ready(&value, &settings).is_err());
        }
    }
}
