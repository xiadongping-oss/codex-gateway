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
    if let Some(controller) = app.try_state::<Controller>() {
        let _ = controller.action("show");
    }
}
pub fn show_main(app: &tauri::AppHandle) {
    app.state::<Desktop>()
        .background
        .store(false, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
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
    if verified {
        Ok(())
    } else {
        Err(notice.into())
    }
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "desktop-open", "打开控制台", true, None::<&str>)?;
    let manage = MenuItem::with_id(app, "desktop-manage", "桌面管理", true, None::<&str>)?;
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
            "desktop-manage" => show_main(app),
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
