use crate::supervisor::Controller;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
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
}

pub fn business_page(page: &str) -> bool {
    matches!(
        page,
        "overview" | "account" | "images" | "models" | "apikeys" | "logs" | "settings"
    )
}

pub fn local_page(page: &str) -> bool {
    matches!(page, "service" | "data" | "desktop")
}

pub fn set_page(app: &tauri::AppHandle, page: &str) {
    if business_page(page) || local_page(page) {
        *app.state::<Desktop>().page.lock().unwrap() = page.into();
    }
}

// Both origins keep their existing permissions. Switching pages transfers the
// visible workspace instead of displaying two independent application windows.
pub fn show_only(app: &tauri::AppHandle, label: &str) -> bool {
    let Some(target) = app.get_webview_window(label) else {
        return false;
    };
    let windows = app.webview_windows();
    let previous = windows
        .values()
        .find(|w| w.label() != label && w.is_visible().unwrap_or(false));
    if let Some(previous) = previous {
        if !previous.is_minimized().unwrap_or(false) {
            if let Ok(position) = previous.outer_position() {
                let _ = target.set_position(position);
            }
            if let Ok(size) = previous.inner_size() {
                let _ = target.set_size(size);
            }
        }
    }
    for window in windows.values().filter(|w| w.label() != label) {
        if window.hide().is_err() {
            return false;
        }
    }
    if target
        .unminimize()
        .and_then(|_| target.show())
        .and_then(|_| target.set_focus())
        .is_err()
    {
        if let Some(previous) = previous {
            let _ = previous.show();
        }
        return false;
    }
    app.state::<Desktop>()
        .background
        .store(false, Ordering::SeqCst);
    true
}

pub fn open_local(app: &tauri::AppHandle, page: &str) -> bool {
    if !local_page(page) {
        return false;
    }
    let previous = app.state::<Desktop>().page.lock().unwrap().clone();
    set_page(app, page);
    if show_main(app) {
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
    for w in app.webview_windows().values() {
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
            "../icons/icon.png"
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
