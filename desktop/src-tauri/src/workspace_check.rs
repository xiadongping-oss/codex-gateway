// Native workspace acceptance; called only by the explicit isolated smoke case.
// Click real UI controls. Only fixed page names and booleans leave the WebViews.
use crate::{console::Console, desktop::Desktop, protocol::Session};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, Webview};

type Observation = Option<(u8, Instant, Value)>;

pub struct Check {
    stage: u8,
    started: Instant,
    next_probe: Instant,
    node_pid: Option<u32>,
    console_label: Option<String>,
    observation: Arc<Mutex<Observation>>,
    callback_error: Arc<Mutex<Option<String>>>,
    cleanup_app: Option<tauri::AppHandle>,
    previous_switches: Option<u64>,
    native_id: Option<usize>,
    #[cfg(windows)]
    normal_bounds: Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>,
}
impl Default for Check {
    fn default() -> Self {
        Self {
            stage: 0,
            started: Instant::now(),
            next_probe: Instant::now(),
            node_pid: None,
            console_label: None,
            observation: Arc::new(Mutex::new(None)),
            callback_error: Arc::new(Mutex::new(None)),
            cleanup_app: None,
            previous_switches: None,
            native_id: None,
            #[cfg(windows)]
            normal_bounds: None,
        }
    }
}

fn decode(raw: &str) -> Option<Value> {
    if raw.len() > 4096 {
        return None;
    }
    match serde_json::from_str::<Value>(raw).ok()? {
        Value::String(text) => serde_json::from_str(&text).ok(),
        value => Some(value),
    }
}

impl Check {
    fn advance(&mut self) {
        eprintln!("W01_WORKSPACE_STEP {}", self.stage);
        self.stage += 1;
        *self.observation.lock().unwrap() = None;
        self.next_probe = Instant::now();
    }

    fn click(&self, window: &Webview, selector: &str) -> Result<(), String> {
        let script = format!(
            "(() => {{ const e = document.querySelector({}); if (!e || e.disabled || !e.getClientRects().length) return false; e.click(); return true; }})()",
            serde_json::to_string(selector).unwrap()
        );
        let failure = self.callback_error.clone();
        window
            .eval_with_callback(script, move |raw| {
                if decode(&raw) != Some(Value::Bool(true)) {
                    *failure.lock().unwrap() = Some("WORKSPACE_CONTROL_UNAVAILABLE".into());
                }
            })
            .map_err(|_| "WORKSPACE_CLICK_FAILED".into())
    }

    fn probe(&mut self, window: &Webview, local: bool) -> Result<Option<Value>, String> {
        if Instant::now() >= self.next_probe {
            self.next_probe = Instant::now() + Duration::from_millis(150);
            let script = if local {
                r#"(() => {
                  window.__TAURI__.core.invoke('workspace_state').then(s => {
                    window.__workspaceNativeCheck = { page: s.page, autostart: s.autostart };
                  }).catch(() => { window.__workspaceNativeCheck = { error: true }; });
                  const pages = [...document.querySelectorAll('[data-local-page]')].filter(e => !e.hidden);
                  const toggle = document.getElementById('desktop-autostart');
                  const update = document.getElementById('updater-panel');
                  const nav = document.querySelector('.sidebar nav');
                  return JSON.stringify({ state: window.__workspaceNativeCheck || null,
                    domPage: pages.length === 1 ? pages[0].dataset.localPage : null,
                    checked: toggle?.checked, disabled: toggle?.disabled,
                    updateVisible: !!update?.getClientRects().length,
                    sidebarFits: nav.scrollHeight <= nav.clientHeight,
                    sidebarItems: nav.querySelectorAll('.nav-item').length });
                })()"#
            } else {
                r#"JSON.stringify({ domPage: document.querySelector('main[data-workspace-current]')?.dataset.workspaceCurrent || null,
                    sidebarFits: document.querySelector('.sidebar .nav').scrollHeight <= document.querySelector('.sidebar .nav').clientHeight,
                    sidebarItems: document.querySelectorAll('.sidebar .nav-item').length,
                    cleanOrigin: location.protocol === 'http:' && location.hostname === '127.0.0.1',
                    sessionReady: window.__cgwDesktopSession?.authenticated === true && window.__cgwDesktopSession?.mounted === true })"#
            };
            let result = self.observation.clone();
            let stage = self.stage;
            window
                .eval_with_callback(script, move |raw| {
                    if let Some(value) = decode(&raw).filter(Value::is_object) {
                        *result.lock().unwrap() = Some((stage, Instant::now(), value));
                    }
                })
                .map_err(|_| "WORKSPACE_PROBE_FAILED")?;
        }
        let observation = self.observation.lock().unwrap();
        Ok(observation.as_ref().and_then(|(stage, at, value)| {
            (*stage == self.stage && at.elapsed() < Duration::from_secs(2)).then(|| value.clone())
        }))
    }

    fn autostart_matches(app: &tauri::AppHandle, expected: bool) -> Result<bool, String> {
        let actual = crate::autostart::enabled(app).map_err(|_| "WORKSPACE_AUTOSTART_QUERY")?;
        let menu = app.state::<crate::desktop::TrayMenu>();
        let item = menu
            .0
            .get("desktop-autostart")
            .ok_or("WORKSPACE_AUTOSTART_MENU")?;
        let checked = item
            .as_check_menuitem()
            .ok_or("WORKSPACE_AUTOSTART_MENU")?
            .is_checked()
            .map_err(|_| "WORKSPACE_AUTOSTART_MENU")?;
        Ok(actual == expected && checked == expected)
    }

    pub fn tick(
        &mut self,
        app: &tauri::AppHandle,
        console: Option<&Console>,
        session: Option<&mut Session>,
    ) -> Result<bool, String> {
        if !cfg!(debug_assertions) || !app.state::<Desktop>().isolated {
            return Err("WORKSPACE_CHECK_NOT_ISOLATED".into());
        }
        if self.started.elapsed() > Duration::from_secs(90) {
            return Err(format!("WORKSPACE_CHECK_TIMEOUT_STAGE_{}", self.stage));
        }
        if let Some(error) = self.callback_error.lock().unwrap().clone() {
            return Err(error);
        }
        let snapshot = crate::desktop::window_snapshot(app)?;
        let visible = snapshot.visible_count();
        if visible > 1
            || snapshot.windows.len() != 1
            || self
                .native_id
                .is_some_and(|id| snapshot.native_id != Some(id))
        {
            eprintln!(
                "W01_VISIBILITY_FAILURE {}",
                serde_json::to_string(&snapshot).unwrap()
            );
            return Err("WORKSPACE_MULTIPLE_VISIBLE_WINDOWS".into());
        }
        let Some(session) = session else {
            return if self.node_pid.is_some() {
                Err("WORKSPACE_SESSION_REPLACED".into())
            } else {
                Ok(false)
            };
        };
        if session
            .child
            .try_wait()
            .map_err(|_| "WORKSPACE_NODE_QUERY")?
            .is_some()
            || self.node_pid.is_some_and(|pid| pid != session.child.id())
        {
            return Err("WORKSPACE_NODE_CHANGED".into());
        }
        let Some(console) = console else {
            return if self.node_pid.is_some() {
                Err("WORKSPACE_CONSOLE_REPLACED".into())
            } else {
                Ok(false)
            };
        };
        let main = app.get_webview("main").ok_or("WORKSPACE_MAIN_MISSING")?;
        let frame = app.get_window("main").ok_or("WORKSPACE_FRAME_MISSING")?;
        if self.stage == 0 {
            if !console.smoke_passed() || visible != 1 {
                return Ok(false);
            }
            let window = console.webview();
            self.native_id = snapshot.native_id;
            #[cfg(windows)]
            {
                if self.normal_bounds.is_none() {
                    self.normal_bounds = Some((
                        frame
                            .outer_position()
                            .map_err(|_| "WORKSPACE_BOUNDS_QUERY")?,
                        frame.inner_size().map_err(|_| "WORKSPACE_BOUNDS_QUERY")?,
                    ));
                    frame.maximize().map_err(|_| "WORKSPACE_MAXIMIZE_FAILED")?;
                    return Ok(false);
                }
                if !frame.is_maximized().unwrap_or(false) {
                    return Ok(false);
                }
            }
            self.node_pid = Some(session.child.id());
            self.console_label = Some(window.label().into());
            self.cleanup_app = Some(app.clone());
            eprintln!(
                "W01_VISIBILITY {}",
                serde_json::to_string(&snapshot).unwrap()
            );
            if !Self::autostart_matches(app, false)? {
                return Err("WORKSPACE_TEST_AUTOSTART_ALREADY_ENABLED".into());
            }
            self.click(&window, "button[data-workspace-page='desktop']")?;
            self.previous_switches = Some(snapshot.view_switches);
            self.advance();
            return Ok(false);
        }
        let remote = app
            .get_webview(self.console_label.as_deref().unwrap())
            .ok_or("WORKSPACE_CONSOLE_REPLACED")?;
        let local = matches!(self.stage, 1..=6 | 8 | 17..=19);
        let Some(value) = self.probe(if local { &main } else { &remote }, local)? else {
            return Ok(false);
        };
        if value["state"]["error"] == true {
            return Err("WORKSPACE_LOCAL_IPC_DENIED".into());
        }
        if value["sidebarFits"] != true || value["sidebarItems"] != 6 {
            return Err("WORKSPACE_SIDEBAR_OVERFLOW_OR_DUPLICATES".into());
        }
        let page = app.state::<Desktop>().page.lock().unwrap().clone();
        let expected = match self.stage {
            1 | 4..=6 | 8 | 17 => "desktop",
            2 => "service",
            3 | 19 => "data",
            7 => "account",
            9 | 20 | 21 => "overview",
            10 => "runtime",
            11 => "access",
            12 => "lan",
            13 => "apikeys",
            14 => "models",
            15 => "settings",
            16 => "logs",
            18 => "about",
            _ => return Err("WORKSPACE_STAGE_INVALID".into()),
        };
        if visible != 1
            || snapshot.view_visible("main") != local
            || snapshot.view_visible(remote.label()) == local
            || (local && page != expected)
            || (!local && !crate::desktop::business_page(&page))
            || value["domPage"] != expected
            || (local && value["state"]["page"] != expected)
        {
            return Ok(false);
        }
        if local && value["updateVisible"] != (expected == "about") {
            return Err("WORKSPACE_UPDATE_PANEL_ON_WRONG_PAGE".into());
        }
        // Both views fill the same client area after maximize, resize and return.
        if (if local { &main } else { &remote }).size().ok() != frame.inner_size().ok() {
            return Ok(false);
        }
        if matches!(self.stage, 2..=6 | 10..=16 | 18 | 19)
            && self.previous_switches != Some(snapshot.view_switches)
        {
            return Err("WORKSPACE_REDUNDANT_WINDOW_TRANSFER".into());
        }
        #[cfg(windows)]
        if self.stage < 21 && !frame.is_maximized().unwrap_or(false) {
            return Ok(false);
        }
        match self.stage {
            1 => self.click(&main, ".workspace-sections button[data-page='service']")?,
            2 => self.click(&main, ".workspace-sections button[data-page='data']")?,
            3 => self.click(&main, ".workspace-sections button[data-page='desktop']")?,
            4..=6 => {
                let enabled = self.stage == 5;
                if value["state"]["autostart"] != enabled
                    || value["checked"] != enabled
                    || value["disabled"] != false
                    || !Self::autostart_matches(app, enabled)?
                {
                    return Ok(false);
                }
                self.click(
                    &main,
                    if self.stage == 6 {
                        "button.nav-item[data-page='account']"
                    } else {
                        "#desktop-autostart"
                    },
                )?;
            }
            7 | 9..=21 => {
                if (!local && (value["cleanOrigin"] != true || value["sessionReady"] != true))
                    || !console.smoke_passed()
                {
                    return Err("WORKSPACE_REMOTE_SESSION_CHANGED".into());
                }
                if self.stage == 21 {
                    if !Self::autostart_matches(app, false)? {
                        return Err("WORKSPACE_AUTOSTART_NOT_CLEARED".into());
                    }
                    #[cfg(windows)]
                    {
                        let (position, size) =
                            self.normal_bounds.ok_or("WORKSPACE_BOUNDS_MISSING")?;
                        if frame.is_maximized().unwrap_or(true)
                            || frame.outer_position().ok() != Some(position)
                            || frame.inner_size().ok() != Some(size)
                        {
                            return Ok(false);
                        }
                        if snapshot.view_switches < 6 {
                            return Err("WORKSPACE_VIEW_SWITCH_NOT_EXERCISED".into());
                        }
                    }
                    eprintln!(
                        "W01_VISIBILITY {}",
                        serde_json::to_string(&snapshot).unwrap()
                    );
                    eprintln!("W01_WORKSPACE true");
                    return Ok(true);
                }
                let selector = match self.stage {
                    7 | 16 => "button[data-workspace-page='desktop']",
                    9 => "button[data-workspace-page='runtime']",
                    10 => "button.nav-item[data-workspace-page='access']",
                    11 => "button[data-workspace-page='lan']",
                    12 => "button[data-workspace-page='apikeys']",
                    13 => "button[data-workspace-page='models']",
                    14 => "button[data-workspace-page='settings']",
                    15 => "button[data-workspace-page='logs']",
                    17 => ".workspace-sections button[data-page='about']",
                    18 => ".workspace-sections button[data-page='data']",
                    19 => "button.nav-item[data-page='overview']",
                    20 => {
                        #[cfg(windows)]
                        frame
                            .unmaximize()
                            .map_err(|_| "WORKSPACE_UNMAXIMIZE_FAILED")?;
                        self.previous_switches = Some(snapshot.view_switches);
                        self.advance();
                        return Ok(false);
                    }
                    _ => unreachable!(),
                };
                self.click(if local { &main } else { &remote }, selector)?;
            }
            8 => self.click(&main, "button.nav-item[data-page='overview']")?,
            _ => unreachable!(),
        }
        self.previous_switches = Some(snapshot.view_switches);
        eprintln!(
            "W01_VISIBILITY {}",
            serde_json::to_string(&snapshot).unwrap()
        );
        self.advance();
        Ok(false)
    }
}

impl Drop for Check {
    fn drop(&mut self) {
        // The unique isolated registration must not remain after a failed check.
        if let Some(app) = &self.cleanup_app {
            let _ = crate::autostart::set(app, false);
        }
    }
}
