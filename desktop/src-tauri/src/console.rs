use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn secret_url(url: &Url) -> bool {
    let sensitive = |s: &str| {
        s.contains("_cgw_bootstrap") || s.contains("cgwadm-") || s.contains("cgw_session")
    };
    sensitive(url.as_str())
        || url
            .query_pairs()
            .any(|(k, v)| sensitive(&k) || sensitive(&v))
}
pub fn validate_bootstrap(frame: &Value, launch_id: &str, port: u16) -> Result<Url, String> {
    if frame["kind"] != "response" || frame["type"] != "bootstrap" || frame["ok"] != true {
        return Err("IDENTITY_MISMATCH".into());
    }
    let p = &frame["payload"];
    let url = Url::parse(p["url"].as_str().ok_or("IDENTITY_MISMATCH")?)
        .map_err(|_| "IDENTITY_MISMATCH")?;
    let expires = p["expiresAt"].as_u64().ok_or("IDENTITY_MISMATCH")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    if !same_origin(&url, port)
        || url.path() != "/"
        || url.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "_cgw_bootstrap"
        || expires <= now_ms()
        || expires > now_ms() + 60_000
    {
        return Err("IDENTITY_MISMATCH".into());
    }
    let parts: Vec<_> = pairs[0].1.split('.').collect();
    let hex = |v: &str| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if parts.len() != 5
        || parts[0] != "d1"
        || parts[1] != launch_id
        || !hex(parts[2])
        || parts[3].parse::<u64>().ok() != Some(expires)
        || !hex(parts[4])
    {
        return Err("IDENTITY_MISMATCH".into());
    }
    Ok(url)
}
fn same_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}
pub struct Policy {
    pub active: AtomicBool,
    alive: Arc<AtomicBool>,
    port: u16,
    initial: Mutex<Option<String>>,
    pub external_count: AtomicUsize,
}
impl Policy {
    fn workspace_page(&self, url: &Url) -> Option<&'static str> {
        if !self.active.load(Ordering::SeqCst)
            || !self.alive.load(Ordering::SeqCst)
            || url.scheme() != "cgw-workspace"
            || url.host_str() != Some("open")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        match url.path() {
            "/service" => Some("service"),
            "/data" => Some("data"),
            "/desktop" => Some("desktop"),
            _ => None,
        }
    }
    fn new(port: u16, bootstrap: &Url, alive: Arc<AtomicBool>) -> Self {
        Self {
            active: AtomicBool::new(true),
            alive,
            port,
            initial: Mutex::new(Some(bootstrap.as_str().into())),
            external_count: AtomicUsize::new(0),
        }
    }
    fn open_workspace(self: &Arc<Self>, app: &tauri::AppHandle, label: &str, page: &'static str) {
        let Some(source) = app.get_webview_window(label) else {
            return;
        };
        let handle = app.clone();
        let policy = self.clone();
        if source
            .eval_with_callback(
                "JSON.stringify({theme:document.documentElement.dataset.theme || 'light',collapsed:localStorage.getItem('gw.sidebar.collapsed')==='1'})",
                move |raw| {
                    if !policy.active.load(Ordering::SeqCst) || !policy.alive.load(Ordering::SeqCst)
                    {
                        return;
                    }
                    let presentation = match serde_json::from_str::<Value>(&raw).ok() {
                        Some(Value::String(text)) => serde_json::from_str::<Value>(&text).ok(),
                        value => value,
                    }.unwrap_or(Value::Null);
                    let theme = if presentation["theme"] == "dark" { "dark" } else { "light" };
                    let collapsed = presentation["collapsed"] == true;
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.eval(format!("window.applyWorkspaceTheme?.('{}'); window.applyWorkspaceCollapsed?.({})", theme, collapsed));
                    }
                    crate::desktop::open_local(&handle, page);
                },
            )
            .is_err()
        {
            crate::desktop::open_local(app, page);
        }
    }
    pub fn internal(&self, url: &Url) -> bool {
        (self.active.load(Ordering::SeqCst) && self.alive.load(Ordering::SeqCst))
            && same_origin(url, self.port)
            && !secret_url(url)
    }
    fn navigate(&self, url: &Url) -> bool {
        if !(self.active.load(Ordering::SeqCst) && self.alive.load(Ordering::SeqCst)) {
            return false;
        }
        if same_origin(url, self.port) {
            let mut first = self.initial.lock().unwrap();
            if secret_url(url) {
                if first.as_deref() == Some(url.as_str()) {
                    first.take();
                    return true;
                }
                return false;
            }
            first.take();
            return true;
        }
        false
    }
    fn external(&self, url: &Url) -> bool {
        (self.active.load(Ordering::SeqCst) && self.alive.load(Ordering::SeqCst))
            && ["http", "https"].contains(&url.scheme())
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && !same_origin(url, self.port)
            && !secret_url(url)
    }
    fn open_external(self: &Arc<Self>, app: &tauri::AppHandle, url: Url, isolated: bool) {
        if !self.external(&url) {
            return;
        }
        self.external_count.fetch_add(1, Ordering::Relaxed);
        if isolated {
            return;
        } // Native smoke records dispatch without opening real OAuth/browser sessions.
        let policy = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if policy.external(&url) {
                let _ = app.opener().open_url(url.as_str(), None::<&str>);
            }
        });
    }
}
pub struct Console {
    window: WebviewWindow,
    pub policy: Arc<Policy>,
    pub evidence: Arc<Mutex<Value>>,
    pub started: Instant,
    next_probe: Instant,
    shown: bool,
    isolated: bool,
}
impl Console {
    pub fn open(
        app: &tauri::AppHandle,
        url: Url,
        launch_id: &str,
        port: u16,
        isolated: bool,
        alive: Arc<AtomicBool>,
        webview_data: &std::path::Path,
    ) -> Result<Self, String> {
        let policy = Arc::new(Policy::new(port, &url, alive));
        let nav = policy.clone();
        let popup = policy.clone();
        let loaded = policy.clone();
        let nav_app = app.clone();
        let popup_app = app.clone();
        let label = format!("console-{launch_id}-{}", uuid::Uuid::new_v4());
        let nav_label = label.clone();
        let popup_label = label.clone();
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title(if cfg!(debug_assertions) && isolated {
                "Codex Gateway · 隔离测试（非真实账号环境）"
            } else {
                "Codex Gateway · 工作台"
            })
            .inner_size(1200., 820.)
            .min_inner_size(760., 600.)
            .visible(false)
            .incognito(true)
            .data_directory(webview_data.to_path_buf())
            .initialization_script(include_str!("../scripts/session.js").replace("/*__CGW_ORIGIN__*/null",&serde_json::to_string(&format!("http://127.0.0.1:{port}")).unwrap()))
            .on_navigation(move |url| {
                if let Some(page) = nav.workspace_page(url) {
                    nav.open_workspace(&nav_app, &nav_label, page);
                    false
                } else if nav.navigate(url) {
                    true
                } else {
                    nav.open_external(&nav_app, url.clone(), isolated);
                    false
                }
            })
            .on_new_window(move |url, _| {
                if popup.internal(&url) {
                    let handle = popup_app.clone();
                    let label = popup_label.clone();
                    let policy = popup.clone();
                    let _ = popup_app.run_on_main_thread(move || {
                        if policy.internal(&url) {
                            if let Some(w) = handle.get_webview_window(&label) {
                                let _ = w.navigate(url);
                            }
                        }
                    });
                } else {
                    popup.open_external(&popup_app, url, isolated);
                }
                NewWindowResponse::Deny
            })
            .on_page_load(move |window, payload| {
                if payload.event() == PageLoadEvent::Finished && loaded.internal(payload.url()) {
                    // A redirect never stores the bootstrap in a DOM value or native status.
                    let _ = window
                        .eval("history.replaceState(null, '', location.pathname + location.search + location.hash);");
                }
            })
            .build()
            .map_err(|_| "CONSOLE_UNAVAILABLE")?;
        let active = policy.clone();
        let close_app = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if active.active.load(Ordering::SeqCst) {
                    api.prevent_close();
                    crate::desktop::hide(&close_app);
                }
            }
        });
        Ok(Self {
            window,
            policy,
            evidence: Arc::new(Mutex::new(Value::Null)),
            started: Instant::now(),
            next_probe: Instant::now(),
            shown: false,
            isolated,
        })
    }
    // Probe within the WebView's own cookie context. Only booleans/status fields leave
    // the page; never serialize cookies, bootstrap URLs, responses or account data.
    pub fn poll(&mut self, app: &tauri::AppHandle) -> Result<bool, String> {
        if Instant::now() >= self.next_probe {
            self.next_probe = Instant::now() + Duration::from_millis(500);
            let result = self.evidence.clone();
            let _ = self.window.eval_with_callback(
                "JSON.stringify(window.__cgwDesktopSession || null)",
                move |raw| {
                    if let Ok(Value::String(s)) = serde_json::from_str::<Value>(&raw) {
                        if s.len() < 2048 {
                            if let Ok(v) = serde_json::from_str(&s) {
                                *result.lock().unwrap() = v;
                            }
                        }
                    }
                },
            );
        }
        let evidence = self.evidence.lock().unwrap().clone();
        if evidence["lost"] == true {
            return Err("CONSOLE_SESSION_LOST".into());
        }
        let ready = evidence["authenticated"] == true
            && evidence["mounted"] == true
            && evidence["cleanUrl"] == true;
        if ready && !self.shown {
            self.shown = true;
            if !app
                .state::<crate::desktop::Desktop>()
                .background
                .load(Ordering::SeqCst)
                && !crate::desktop::local_page(
                    &app.state::<crate::desktop::Desktop>().page.lock().unwrap(),
                )
            {
                self.restore(app);
            }
            if self.isolated {
                let _ = self.window.eval(include_str!("../scripts/probe.js"));
            }
        }
        if !ready && self.started.elapsed() > Duration::from_secs(20) {
            return Err("CONSOLE_SESSION_LOST".into());
        }
        Ok(ready)
    }
    pub fn smoke_passed(&self) -> bool {
        let v = self.evidence.lock().unwrap();
        self.shown
            && v["nativeDenied"] == true
            && v["coreDenied"] == true
            && v["cookieHidden"] == true
            && v["historyClean"] == true
            && v["navigationSafe"] == true
            && v["workspaceDenied"] == true
            && self.policy.external_count.load(Ordering::Relaxed) >= 2
    }
    pub fn restore(&self, app: &tauri::AppHandle) -> bool {
        if !self.shown
            || !self.policy.active.load(Ordering::SeqCst)
            || !self.policy.alive.load(Ordering::SeqCst)
        {
            return false;
        }
        crate::desktop::show_only(app, self.window.label())
    }
    pub fn navigate(&self, app: &tauri::AppHandle, page: &str) -> bool {
        if !crate::desktop::business_page(page)
            || !self.shown
            || !self.policy.active.load(Ordering::SeqCst)
            || !self.policy.alive.load(Ordering::SeqCst)
        {
            return false;
        }
        let script = format!(
            "window.dispatchEvent(new CustomEvent('cgw:navigate', {{ detail: {{ page: {} }} }}))",
            serde_json::to_string(page).unwrap()
        );
        if self.window.eval(script).is_err() {
            return false;
        }
        crate::desktop::set_page(app, page);
        self.restore(app)
    }
    pub fn smoke_report(&self) -> Value {
        let v = self.evidence.lock().unwrap();
        serde_json::json!({"authenticated":v["authenticated"]==true,"mounted":v["mounted"]==true,
          "cleanUrl":v["cleanUrl"]==true,"nativeDenied":v["nativeDenied"]==true,"coreDenied":v["coreDenied"]==true,
          "cookieHidden":v["cookieHidden"]==true,"historyClean":v["historyClean"]==true,
          "navigationSafe":v["navigationSafe"]==true,"workspaceDenied":v["workspaceDenied"]==true,"externalDispatches":self.policy.external_count.load(Ordering::Relaxed)})
    }
    pub fn expire_test_session(&self) -> Result<(), String> {
        if !self.isolated {
            return Err("TEST_NOT_ISOLATED".into());
        }
        for cookie in self.window.cookies().map_err(|_| "COOKIE_TEST_FAILED")? {
            if cookie.name() == "cgw_session" {
                self.window
                    .delete_cookie(cookie)
                    .map_err(|_| "COOKIE_TEST_FAILED")?;
                return Ok(());
            }
        }
        Err("COOKIE_TEST_FAILED".into())
    }
    pub fn close(&self, app: &tauri::AppHandle) {
        self.policy.active.store(false, Ordering::SeqCst);
        self.policy.initial.lock().unwrap().take();
        let _ = self.window.destroy();
        crate::desktop::show_main(app);
    }
    pub fn suspend(&self, app: &tauri::AppHandle) {
        self.policy.active.store(false, Ordering::SeqCst);
        let _ = self.window.hide();
        crate::desktop::show_main(app);
    }
    pub fn test_close(&self) -> tauri::Result<()> {
        self.window.close()
    }
    pub fn visible(&self) -> bool {
        self.window.is_visible().unwrap_or(false)
    }
    pub fn test_menu(&self, app: &tauri::AppHandle) {
        if !app.state::<crate::desktop::Desktop>().isolated {
            return;
        }
        use tauri::menu::ContextMenu;
        let _ = app.state::<crate::desktop::TrayMenu>().0.popup_at(
            self.window.as_ref().window(),
            tauri::LogicalPosition::new(700., 400.),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_navigation_is_fixed_and_revoked_with_its_session() {
        let (frame, id) = bootstrap();
        let url = validate_bootstrap(&frame, &id, 4173).unwrap();
        let p = Policy::new(4173, &url, Arc::new(AtomicBool::new(true)));
        for page in ["service", "data", "desktop"] {
            let url: Url = format!("cgw-workspace://open/{page}").parse().unwrap();
            assert_eq!(p.workspace_page(&url), Some(page));
            assert!(!p.navigate(&url));
            assert!(!p.external(&url));
        }
        for url in [
            "cgw-workspace://open/quit",
            "cgw-workspace://open/retry",
            "cgw-workspace://open/service?x=1",
            "cgw-workspace://open/data#x",
            "cgw-workspace://user@open/data",
            "cgw-workspace://open:123/data",
            "cgw-workspace://other/data",
            "cgw-workspace://open/data/",
            "cgw-workspace://open/%64ata",
            "http://open/data",
            "cgw-workspace://open/desktop?token=cgwadm-secret",
        ] {
            assert_eq!(p.workspace_page(&url.parse().unwrap()), None, "{url}");
        }
        let url = "cgw-workspace://open/data".parse().unwrap();
        p.alive.store(false, Ordering::SeqCst);
        assert_eq!(p.workspace_page(&url), None);
        p.alive.store(true, Ordering::SeqCst);
        p.active.store(false, Ordering::SeqCst);
        assert_eq!(p.workspace_page(&url), None);
    }
    #[test]
    #[ignore = "opens the system browser; run explicitly during native desktop acceptance"]
    fn system_browser_dispatch() {
        tauri_plugin_opener::open_url("https://v2.tauri.app/plugin/opener/", None::<&str>).unwrap();
    }
    fn bootstrap() -> (Value, String) {
        let id = uuid::Uuid::new_v4().to_string();
        let expires = now_ms() + 50_000;
        (
            serde_json::json!({"kind":"response","type":"bootstrap","ok":true,"payload":{"url":format!("http://127.0.0.1:4173/?_cgw_bootstrap=d1.{id}.{}.{}.{}","a".repeat(64),expires,"b".repeat(64)),"expiresAt":expires}}),
            id,
        )
    }
    #[test]
    fn bootstrap_binds_origin_expiry_and_launch() {
        let (frame, id) = bootstrap();
        assert!(validate_bootstrap(&frame, &id, 4173).is_ok());
        assert!(validate_bootstrap(&frame, &uuid::Uuid::new_v4().to_string(), 4173).is_err());
        assert!(validate_bootstrap(&frame, &id, 4174).is_err());
        for replacement in [
            "http://localhost:4173/",
            "https://127.0.0.1:4173/",
            "http://user@127.0.0.1:4173/",
            "http://127.0.0.1:4173/other",
        ] {
            let mut bad = frame.clone();
            bad["payload"]["url"] = Value::String(
                frame["payload"]["url"]
                    .as_str()
                    .unwrap()
                    .replace("http://127.0.0.1:4173/", replacement),
            );
            assert!(validate_bootstrap(&bad, &id, 4173).is_err());
        }
        let mut bad = frame.clone();
        bad["payload"]["expiresAt"] = 0.into();
        assert!(validate_bootstrap(&bad, &id, 4173).is_err());
    }
    #[test]
    fn navigation_is_instance_scoped_and_secrets_never_leave() {
        let (frame, id) = bootstrap();
        let url = validate_bootstrap(&frame, &id, 4173).unwrap();
        let p = Policy::new(4173, &url, Arc::new(AtomicBool::new(true)));
        assert!(p.navigate(&url));
        assert!(!p.navigate(&url));
        assert!(p.navigate(&"http://127.0.0.1:4173/#settings".parse().unwrap()));
        for u in [
            "file:///C:/test",
            "javascript:alert(1)",
            "tauri://localhost/",
            "data:text/html,test",
            "https://example.com/?_cgw_bootstrap=secret",
            "https://example.com/?redirect=%3F_cgw_bootstrap%3Dsecret",
            "https://user:password@example.com/",
        ] {
            let u = u.parse().unwrap();
            assert!(!p.navigate(&u));
            assert!(!p.external(&u));
        }
        assert!(p.external(&"https://example.com/docs".parse().unwrap()));
        p.alive.store(false, Ordering::SeqCst);
        assert!(!p.navigate(&"http://127.0.0.1:4173/".parse().unwrap()));
        assert!(!p.external(&"https://example.com".parse().unwrap()));
        p.alive.store(true, Ordering::SeqCst);
        p.active.store(false, Ordering::SeqCst);
        assert!(!p.navigate(&"http://127.0.0.1:4173/".parse().unwrap()));
        assert!(!p.external(&"https://example.com".parse().unwrap()));
    }
}
