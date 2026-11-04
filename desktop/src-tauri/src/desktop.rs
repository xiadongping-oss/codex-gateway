use crate::supervisor::Controller;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    mpsc, Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub struct Desktop {
    pub background: AtomicBool,
    pub duplicates: AtomicUsize,
    pub isolated: bool,
    pub notice: Mutex<String>,
    pub page: Mutex<String>,
    pub active_view: Mutex<String>,
    // Result of the automatic legacy-workspace import attempted before the
    // gateway starts. Read by the workspace UI; never blocks starting.
    pub migration: Mutex<serde_json::Value>,
}
pub fn migration_state(app: &tauri::AppHandle) -> serde_json::Value {
    app.try_state::<Desktop>()
        .map(|state| state.migration.lock().unwrap().clone())
        .unwrap_or_else(|| serde_json::json!({"state": "none"}))
}
pub fn set_migration_state(app: &tauri::AppHandle, value: serde_json::Value) {
    if let Some(state) = app.try_state::<Desktop>() {
        *state.migration.lock().unwrap() = value;
    }
}

pub fn business_page(page: &str) -> bool {
    matches!(
        page,
        "overview"
            | "account"
            | "images"
            | "models"
            | "access"
            | "apikeys"
            | "logs"
            | "settings"
            | "runtime"
            | "lan"
    )
}

pub fn local_page(page: &str) -> bool {
    matches!(page, "service" | "data" | "desktop" | "about")
}

pub fn set_page(app: &tauri::AppHandle, page: &str) {
    if business_page(page) || local_page(page) {
        *app.state::<Desktop>().page.lock().unwrap() = page.into();
    }
}

static WINDOW_EPOCH: AtomicU64 = AtomicU64::new(0);
static VIEW_SWITCHES: AtomicU64 = AtomicU64::new(0);

// Wry executes run_on_main_thread inline when already on the native thread.
// Native callbacks and the supervisor can await this result without scheduling
// a task behind themselves. Switching and sampling share this serial domain.
fn on_native_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&tauri::AppHandle) -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(operation(&handle));
    })
    .map_err(|_| "WORKSPACE_NATIVE_DISPATCH")?;
    rx.recv().map_err(|_| "WORKSPACE_NATIVE_RESULT".into())
}

#[cfg(debug_assertions)]
#[derive(Debug, serde::Serialize)]
pub struct WindowSnapshot {
    pub epoch: u64,
    pub view_switches: u64,
    pub active_view: String,
    pub native_id: Option<usize>,
    pub windows: Vec<(String, bool)>,
}

#[cfg(debug_assertions)]
impl WindowSnapshot {
    pub fn visible_count(&self) -> usize {
        self.windows.iter().filter(|(_, visible)| *visible).count()
    }

    pub fn view_visible(&self, label: &str) -> bool {
        self.active_view == label && self.visible_count() == 1
    }
}

#[cfg(debug_assertions)]
pub fn window_snapshot(app: &tauri::AppHandle) -> Result<WindowSnapshot, String> {
    on_native_thread(app, |app| {
        let mut windows = app
            .windows()
            .into_values()
            .map(|window| {
                window
                    .is_visible()
                    .map(|visible| (window.label().to_owned(), visible))
                    .map_err(|_| "WORKSPACE_VISIBILITY_QUERY".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        windows.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(WindowSnapshot {
            epoch: WINDOW_EPOCH.load(Ordering::SeqCst),
            windows,
            view_switches: VIEW_SWITCHES.load(Ordering::SeqCst),
            active_view: app.state::<Desktop>().active_view.lock().unwrap().clone(),
            native_id: {
                #[cfg(windows)]
                {
                    app.get_window("main")
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| h.0 as usize)
                }
                #[cfg(not(windows))]
                {
                    None
                }
            },
        })
    })?
}

// Both origins keep separate WebViews and permissions inside one native frame.
// Page navigation never hides, restores, resizes or recreates that frame.
pub fn show_only(app: &tauri::AppHandle, label: &str) -> bool {
    let label = label.to_owned();
    on_native_thread(app, move |app| {
        let result = show_only_on_native_thread(app, &label);
        WINDOW_EPOCH.fetch_add(1, Ordering::SeqCst);
        result
    })
    .unwrap_or(false)
}

fn show_only_on_native_thread(app: &tauri::AppHandle, label: &str) -> bool {
    let Some(target) = app.get_webview(label) else {
        return false;
    };
    let Some(frame) = app.get_window("main") else {
        return false;
    };
    let previous = app.state::<Desktop>().active_view.lock().unwrap().clone();
    if previous != label {
        // Paint the destination before hiding the previous view. The parent
        // frame and its taskbar entry stay visible throughout the operation.
        if target.show().is_err() {
            return false;
        }
        for view in app
            .webviews()
            .values()
            .filter(|view| view.label() != label && view.window().label() == "main")
        {
            if view.hide().is_err() {
                let _ = target.hide();
                if let Some(source) = app.get_webview(&previous) {
                    let _ = source.show();
                }
                return false;
            }
        }
        *app.state::<Desktop>().active_view.lock().unwrap() = label.into();
        VIEW_SWITCHES.fetch_add(1, Ordering::SeqCst);
    }
    if frame.is_minimized().unwrap_or(false) && frame.unminimize().is_err() {
        return false;
    }
    if !frame.is_visible().unwrap_or(false) && frame.show().is_err() {
        return false;
    }
    if !frame.is_focused().unwrap_or(false) && frame.set_focus().is_err() {
        return false;
    }
    if target.set_focus().is_err() {
        return false;
    }
    app.state::<Desktop>()
        .background
        .store(false, Ordering::SeqCst);
    true
}

pub fn view_visible(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<Desktop>().active_view.lock().unwrap().as_str() == label
        && app
            .get_window("main")
            .is_some_and(|frame| frame.is_visible().unwrap_or(false))
}

pub fn open_local(app: &tauri::AppHandle, page: &str) -> bool {
    if !local_page(page) {
        return false;
    }
    let previous = app.state::<Desktop>().page.lock().unwrap().clone();
    set_page(app, page);
    if show_main(app) {
        if let Some(main) = app.get_webview("main") {
            let _ = main.eval(format!(
                "window.showWorkspacePage?.({})",
                serde_json::to_string(page).unwrap()
            ));
        }
        true
    } else {
        set_page(app, &previous);
        false
    }
}
pub struct TrayMenu(pub Menu<tauri::Wry>);

// Separate test identity prevents isolated checks from waking a real installation.
// Production identity never depends on argv, cwd or a caller-supplied data path.
pub fn test_identity(args: &[String]) -> Result<Option<String>, String> {
    if !cfg!(debug_assertions) || !args.iter().any(|s| s == "--isolated" || s == "--smoke") {
        return Ok(None);
    }
    let data = args
        .iter()
        .find_map(|s| s.strip_prefix("--data-dir="))
        .ok_or("Isolated checks require a data directory")?;
    let path = std::path::Path::new(data);
    if !path.is_absolute() {
        return Err("Test data directory must be absolute".into());
    }
    let parent = dunce::canonicalize(path.parent().ok_or("Missing test parent")?)
        .map_err(|_| "Test parent does not exist")?;
    let name = parent
        .join(path.file_name().ok_or("Missing test directory name")?)
        .to_string_lossy()
        .into_owned();
    let name = if cfg!(windows) {
        name.to_lowercase()
    } else {
        name
    };
    // macOS single-instance uses /tmp/<identifier>_si.sock (Unix path length limit).
    let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
    Ok(Some(format!(
        "com.codexgateway.desktop.test.{}",
        &digest[..32]
    )))
}

pub fn restore(app: &tauri::AppHandle) {
    app.state::<Desktop>()
        .background
        .store(false, Ordering::SeqCst);
    let local = local_page(&app.state::<Desktop>().page.lock().unwrap());
    if local {
        show_main(app);
    } else if let Some(controller) = app.try_state::<Controller>() {
        let _ = controller.action("show");
    }
}
pub fn show_main(app: &tauri::AppHandle) -> bool {
    {
        let desktop = app.state::<Desktop>();
        let mut page = desktop.page.lock().unwrap();
        if !local_page(&page) {
            *page = "service".into();
        }
    }
    show_only(app, "main")
}
pub fn hide(app: &tauri::AppHandle) {
    app.state::<Desktop>()
        .background
        .store(true, Ordering::SeqCst);
    for w in app.windows().values() {
        let _ = w.hide();
    }
}

pub fn set_autostart(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let result = crate::autostart::set(app, enabled);
    let verified = result.is_ok() && crate::autostart::enabled(app).ok() == Some(enabled);
    let notice = if verified {
        ""
    } else {
        "自启动设置未能保存，请检查系统权限后重试。"
    };
    *app.state::<Desktop>().notice.lock().unwrap() = notice.into();
    if let Some(menu) = app.try_state::<TrayMenu>() {
        if let Some(item) = menu.0.get("desktop-autostart") {
            if let Some(item) = item.as_check_menuitem() {
                let _ = item.set_checked(crate::autostart::enabled(app).unwrap_or(false));
            }
        }
    }
    if verified {
        Ok(())
    } else {
        Err(notice.into())
    }
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "desktop-open", "打开工作台", true, None::<&str>)?;
    let manage = MenuItem::with_id(app, "desktop-manage", "设置", true, None::<&str>)?;
    let enabled = crate::autostart::enabled(app);
    let autostart = CheckMenuItem::with_id(
        app,
        "desktop-autostart",
        "登录后自动启动",
        true,
        enabled.as_ref().copied().unwrap_or(false),
        None::<&str>,
    )?;
    if enabled.is_err() {
        *app.state::<Desktop>().notice.lock().unwrap() = "暂时无法读取自启动设置。".into();
    }
    let quit = MenuItem::with_id(app, "desktop-quit", "退出应用", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &manage, &autostart, &separator, &quit])?;
    app.manage(TrayMenu(menu.clone()));
    let checkbox = autostart.clone();
    TrayIconBuilder::with_id("gateway-tray")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray.png"
        ))?)
        .tooltip(if app.state::<Desktop>().isolated {
            "Codex Gateway · 隔离测试"
        } else {
            "Codex Gateway · 关闭窗口后仍在运行"
        })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "desktop-open" => restore(app),
            "desktop-manage" => {
                open_local(app, "desktop");
            }
            "desktop-autostart" => {
                // Read actual OS state, never infer success from the menu's visual toggle.
                let result = crate::autostart::enabled(app)
                    .map_err(|_| "无法读取自启动设置".to_string())
                    .and_then(|v| set_autostart(app, !v));
                let _ = checkbox.set_checked(crate::autostart::enabled(app).unwrap_or(false));
                if let Err(message) = result {
                    *app.state::<Desktop>().notice.lock().unwrap() = message;
                    show_main(app);
                }
            }
            "desktop-quit" => {
                if let Some(c) = app.try_state::<Controller>() {
                    let _ = c.action("quit");
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_identity_ignores_paths_and_test_identity_requires_explicit_root() {
        assert_eq!(
            test_identity(&["--data-dir=C:/arbitrary".into()]).unwrap(),
            None
        );
        // Distribution builds reject test identities even when the caller
        // supplies the flags and an absolute directory used by debug tests.
        if !cfg!(debug_assertions) {
            let path = std::env::temp_dir().join("cgw-desktop-identity");
            for args in [
                vec!["--isolated".into()],
                vec!["--isolated".into(), "--data-dir=relative".into()],
                vec!["--isolated".into(), format!("--data-dir={}", path.display())],
                vec!["--smoke".into(), format!("--data-dir={}", path.display())],
            ] {
                assert_eq!(test_identity(&args).unwrap(), None);
            }
            return;
        }
        assert!(test_identity(&["--isolated".into()]).is_err());
        assert!(test_identity(&["--isolated".into(), "--data-dir=relative".into()]).is_err());
        let path = std::env::temp_dir().join("cgw-desktop-identity");
        let args = vec![
            "--isolated".into(),
            format!("--data-dir={}", path.display()),
        ];
        assert_eq!(test_identity(&args).unwrap(), test_identity(&args).unwrap());
        let other = vec![
            "--isolated".into(),
            format!("--data-dir={}2", path.display()),
        ];
        assert_ne!(
            test_identity(&args).unwrap(),
            test_identity(&other).unwrap()
        );
    }
}
