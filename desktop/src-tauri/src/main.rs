#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod autostart;
#[cfg(windows)]
mod cold_recovery;
mod console;
mod desktop;
mod desktop_check;
mod diagnostics;
#[cfg(target_os = "macos")]
mod mac_recovery;
mod migration;
mod migration_check;
mod process_tree;
mod protocol;
mod recovery;
mod resources;
#[cfg(debug_assertions)]
mod soak_check;
mod supervisor;
#[cfg(debug_assertions)]
mod workspace_check;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use supervisor::{Controller, Settings, ViewState};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn startup_origin(url: &tauri::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
}

fn local(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "窗口不可用")?;
    if window.label() == "main" && startup_origin(&url) {
        Ok(())
    } else {
        Err("此页面没有桌面管理权限".into())
    }
}
#[tauri::command]
fn gateway_status(
    window: WebviewWindow,
    state: tauri::State<Controller>,
) -> Result<ViewState, String> {
    local(&window)?;
    Ok(state.view.lock().unwrap().clone())
}
#[tauri::command]
fn gateway_action(
    window: WebviewWindow,
    state: tauri::State<Controller>,
    action: String,
) -> Result<(), String> {
    local(&window)?;
    state.action(&action)
}
#[tauri::command]
fn ui_rendered(window: WebviewWindow, state: tauri::State<Controller>) -> Result<(), String> {
    local(&window)?;
    state.rendered.store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
fn desktop_notice(
    window: WebviewWindow,
    state: tauri::State<desktop::Desktop>,
) -> Result<String, String> {
    local(&window)?;
    Ok(state.notice.lock().unwrap().clone())
}

#[tauri::command]
fn workspace_state(
    window: WebviewWindow,
    state: tauri::State<desktop::Desktop>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    local(&window)?;
    Ok(
        serde_json::json!({ "page": state.page.lock().unwrap().clone(), "autostart": autostart::enabled(&app).ok(), "notice": state.notice.lock().unwrap().clone() }),
    )
}

#[tauri::command]
fn workspace_navigate(
    window: WebviewWindow,
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
    window: WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    local(&window)?;
    desktop::set_autostart(&app, enabled)
}
#[tauri::command]
async fn migration_request(
    window: WebviewWindow,
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
        .manage(desktop::Desktop {
            background: AtomicBool::new(args.iter().any(|s| s == "--from-autostart")),
            duplicates: std::sync::atomic::AtomicUsize::new(0),
            isolated,
            notice: std::sync::Mutex::new(String::new()),
            page: std::sync::Mutex::new("overview".into()),
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
            gateway_status,
            gateway_action,
            ui_rendered,
            desktop_notice,
            workspace_state,
            workspace_navigate,
            workspace_autostart,
            migration_request
        ])
        .setup(|app| {
            let settings = Settings::resolve(app.handle())?;
            std::fs::create_dir_all(&settings.webview_data)?;
            let quitting = Arc::new(AtomicBool::new(false));
            desktop::install(app.handle())?;
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(if cfg!(debug_assertions) && settings.isolated {
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
                    .build()?;
            let controller = Controller::start(app.handle().clone(), settings, quitting.clone());
            app.manage(controller);
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !quitting.load(Ordering::Relaxed) {
                        api.prevent_close();
                        desktop::hide(&handle);
                    }
                }
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
