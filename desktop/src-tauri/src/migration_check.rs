use crate::supervisor::{Controller, Settings};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

pub fn start(app: &tauri::AppHandle, settings: &Settings) -> Arc<AtomicBool> {
    let passed = Arc::new(AtomicBool::new(false));
    if !cfg!(debug_assertions)
        || !settings.smoke
        || !settings.isolated
        || !matches!(
            settings.smoke_case.as_str(),
            "migration" | "migration-fresh"
        )
    {
        return passed;
    }
    let app = app.clone();
    let result = passed.clone();
    let parent = settings.data.parent().unwrap();
    let fixture = serde_json::json!({"source":parent.join("legacy"),"gallery":parent.join("legacy-gallery"),"fresh":settings.smoke_case == "migration-fresh"});
    thread::spawn(move || {
        let window = app.get_webview_window("main").unwrap();
        let script = format!(
            "window.__migrationFixture = {}; {}",
            fixture,
            include_str!("../scripts/migration-check.js")
        );
        let mut injected = false;
        let end = Instant::now() + Duration::from_secs(210);
        while Instant::now() < end {
            let (tx, rx) = mpsc::sync_channel(1);
            let probe = if injected {
                "window.__migrationCheck || 'pending'"
            } else {
                "Boolean(window.migrationWizard && document.getElementById('migration-source'))"
            };
            let _ = window.eval_with_callback(probe, move |raw| {
                let _ = tx.try_send(raw);
            });
            if let Ok(raw) = rx.recv_timeout(Duration::from_millis(300)) {
                if !injected && raw == "true" {
                    let _ = window.eval(&script);
                    injected = true;
                }
                if raw == "\"passed\"" {
                    eprintln!("R03_MIGRATION_UI true");
                    result.store(true, Ordering::SeqCst);
                    return;
                }
                if raw.starts_with("\"failed:") {
                    let stage = raw
                        .trim_matches('"')
                        .strip_prefix("failed:")
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0);
                    eprintln!("R03_MIGRATION_STEP {stage}");
                    break;
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        eprintln!("R03_MIGRATION_UI false");
        let _ = app.state::<Controller>().action("quit");
    });
    passed
}
