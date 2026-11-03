#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod asset_drag;
mod autostart;
#[cfg(windows)]
mod cold_recovery;
mod console;
mod desktop;
mod desktop_check;
mod diagnostics;
mod workspace_data;
#[cfg(target_os = "macos")]
mod mac_recovery;
mod migration;
mod migration_check;
mod preferences;
mod process_tree;
mod protocol;
mod recovery;
mod resources;
#[cfg(debug_assertions)]
mod soak_check;
mod supervisor;
mod updater;
#[cfg(debug_assertions)]
mod workspace_check;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use supervisor::{Controller, Settings, ViewState};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};

fn startup_origin(url: &tauri::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
}

fn local(window: &Webview) -> Result<(), String> {
    let url = window.url().map_err(|_| "窗口不可用")?;
    if window.label() == "main" && startup_origin(&url) {
        Ok(())
    } else {
        Err("此页面没有桌面管理权限".into())
    }
}
#[tauri::command]
fn gateway_status(window: Webview, state: tauri::State<Controller>) -> Result<ViewState, String> {
    local(&window)?;
    Ok(state.view.lock().unwrap().clone())
}
#[tauri::command]
fn gateway_action(
    window: Webview,
    state: tauri::State<Controller>,
    action: String,
) -> Result<(), String> {
    local(&window)?;
    state.action(&action)
}
#[tauri::command]
fn ui_rendered(window: Webview, state: tauri::State<Controller>) -> Result<(), String> {
    local(&window)?;
    state.rendered.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn desktop_notice(
    window: Webview,
    state: tauri::State<desktop::Desktop>,
) -> Result<String, String> {
    local(&window)?;
    Ok(state.notice.lock().unwrap().clone())
}

#[tauri::command]
fn workspace_state(
    window: Webview,
    state: tauri::State<desktop::Desktop>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    local(&window)?;
    Ok(
        serde_json::json!({ "page": state.page.lock().unwrap().clone(), "autostart": autostart::enabled(&app).ok(), "notice": state.notice.lock().unwrap().clone(), "migration": desktop::migration_state(&app), "legacyMigration": state.isolated, "preferences": preferences::snapshot(&app), "preferencesError": app.state::<preferences::Store>().read_error.lock().unwrap().clone(), "updater": app.state::<updater::Store>().snapshot() }),
    )
}

#[tauri::command]
fn workspace_preferences(
    window: Webview,
    app: tauri::AppHandle,
    patch: preferences::Patch,
) -> Result<serde_json::Value, String> {
    local(&window)?;
    preferences::update(&app, patch)
}
#[tauri::command]
async fn workspace_update(window: Webview, app: tauri::AppHandle, action: String) -> Result<updater::Snapshot, String> {
    local(&window)?;
    updater::action(app, &action).await
}
#[tauri::command]
fn workspace_navigate(
    window: Webview,
    app: tauri::AppHandle,
    state: tauri::State<Controller>,
    page: String,
) -> Result<(), String> {
    local(&window)?;
    if desktop::local_page(&page) {
        if desktop::open_local(&app, &page) {
            Ok(())
        } else {
            Err("暂时无法打开此页面，请重试".into())
        }
    } else {
        state.navigate(&page)
    }
}

#[tauri::command]
fn workspace_autostart(
    window: Webview,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    local(&window)?;
    desktop::set_autostart(&app, enabled)
}
#[tauri::command]
async fn migration_request(
    window: Webview,
    state: tauri::State<'_, Controller>,
    request: migration::Request,
) -> Result<serde_json::Value, String> {
    local(&window)?;
    let response = state.migration(request)?;
    tauri::async_runtime::spawn_blocking(move || {
        response
            .recv()
            .map_err(|_| "MIGRATION_UNAVAILABLE".to_string())?
    })
    .await
    .map_err(|_| "MIGRATION_UNAVAILABLE".to_string())?
}
fn main() {
    process_tree::guardian_entry();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let identity = desktop::test_identity(&args).expect("Invalid isolated desktop options");
    let isolated = identity.is_some();
    let mut context = tauri::generate_context!();
    if let Some(id) = &identity {
        context.config_mut().identifier = id.clone();
    }
    let autostart_name = identity.unwrap_or_else(|| "Codex Gateway Desktop".into());
    let mut autostart_args = vec!["--from-autostart".to_string()];
    if isolated {
        autostart_args.extend(
            args.iter()
                .filter(|s| {
                    s.starts_with("--data-dir=")
                        || s.starts_with("--resources=")
                        || s.starts_with("--port=")
                        || s.starts_with("--bridge-port=")
                        || s.as_str() == "--isolated"
                })
                .cloned(),
        );
    }
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.manage(autostart::Registration {
        name: autostart_name.clone(),
        args: autostart_args.clone(),
    });
    let builder = builder
        .manage(updater::Store::new(env!("CARGO_PKG_VERSION").into()))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(desktop::Desktop {
            background: AtomicBool::new(args.iter().any(|s| s == "--from-autostart")),
            duplicates: std::sync::atomic::AtomicUsize::new(0),
            isolated,
            notice: std::sync::Mutex::new(String::new()),
            page: std::sync::Mutex::new("overview".into()),
            active_view: std::sync::Mutex::new("main".into()),
            migration: std::sync::Mutex::new(serde_json::json!({"state": "none"})),
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Only restore the existing instance; never execute forwarded args or URLs.
            app.state::<desktop::Desktop>()
                .duplicates
                .fetch_add(1, Ordering::SeqCst);
            desktop::restore(app);
        }));
    #[cfg(not(windows))]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name(autostart_name)
            .args(autostart_args)
            .build(),
    );
    builder
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            workspace_data::workspace_backup,
            workspace_data::workspace_backup_folder,
            workspace_data::workspace_diagnostics,
            gateway_status,
            gateway_action,
            ui_rendered,
            desktop_notice,
            workspace_state,
            workspace_navigate,
            workspace_autostart,
            workspace_preferences,
            workspace_update,
            migration_request
        ])
        .setup(|app| {
            let settings = Settings::resolve(app.handle())?;
            std::fs::create_dir_all(&settings.webview_data)?;
            app.manage(workspace_data::Store { root:settings.data.clone(), webview:settings.webview_data.clone(), busy:AtomicBool::new(false) });
            app.manage(preferences::Store::load(settings.webview_data.parent().ok_or("Missing preferences parent")?.join("preferences.json")));
            let quitting = Arc::new(AtomicBool::new(false));
            desktop::install(app.handle())?;
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .icon(tauri::image::Image::from_bytes(include_bytes!(
                        "../icons/icon.png"
                    ))?)?
                    .title(if cfg!(debug_assertions) && settings.account_validation {
                        "Codex Gateway · 账号验收（独立工作空间）"
                    } else if cfg!(debug_assertions) && settings.isolated {
                        "Codex Gateway · 隔离测试（非真实账号环境）"
                    } else {
                        "Codex Gateway · 工作台"
                    })
                    .inner_size(1200., 820.)
                    .min_inner_size(760., 600.)
                    .visible(
                        !app.state::<desktop::Desktop>()
                            .background
                            .load(Ordering::SeqCst),
                    )
                    .data_directory(settings.webview_data.clone())
                    .on_navigation(startup_origin)
                    .initialization_script("window.addEventListener('cgw:appearance',event=>window.applyWorkspaceTheme?.(event.detail.resolvedAppearance));")
                    .build()?;
            preferences::apply(app.handle());
            let controller = Controller::start(app.handle().clone(), settings, quitting.clone());
            app.manage(controller);
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !quitting.load(Ordering::Relaxed) {
                        api.prevent_close();
                        if handle.state::<preferences::Store>().get().close_behavior == preferences::CloseBehavior::Quit {
                            let _ = handle.state::<Controller>().action("quit");
                        } else { desktop::hide(&handle); }
                    }
                }
                if let tauri::WindowEvent::ThemeChanged(theme) = event { preferences::system_changed(&handle,*theme); }
            });
            Ok(())
        })
        .build(context)
        .expect("桌面窗口启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if app.state::<desktop::Desktop>().isolated {
                    let _ = autostart::set(app, false);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                desktop::restore(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<Controller>();
                if !state.quitting.load(Ordering::Relaxed) {
                    api.prevent_exit();
                    let _ = state.action("quit");
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bundled_startup_origins_can_navigate_or_invoke() {
        for url in ["http://tauri.localhost/", "tauri://localhost/index.html"] {
            assert!(startup_origin(&url.parse().unwrap()));
        }
        for url in [
            "http://127.0.0.1:4173/",
            "https://example.org/",
            "http://tauri.localhost:4173/",
            "http://user@tauri.localhost/",
            "tauri://untrusted/",
            "file:///etc/passwd",
        ] {
            assert!(!startup_origin(&url.parse().unwrap()), "{url}");
        }
    }
}
