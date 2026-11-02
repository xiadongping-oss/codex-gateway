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
    // In isolated mode the migration worker sees this directory as HOME / LOCALAPPDATA,
    // so discovery only ever finds fixtures planted inside it. Anything planted
    // elsewhere is invisible to the real code path and would test nothing.
    let home = parent.join("isolated-home");
    let fixture = serde_json::json!({
        "source": home.join("CodexGateway"),
        "gallery": parent.join("legacy-gallery"),
        // A credential reference outside the workspace: the automatic pass must
        // refuse it and hand the decision to the user, which is the whole point
        // of this scenario.
        "auth": home.join("auth-external.json"),
        "fresh": settings.smoke_case == "migration-fresh"
    });
    thread::spawn(move || {
        let window = app.get_webview("main").unwrap();
        let script = format!(
            "window.__migrationFixture = {}; {}",
            fixture,
            include_str!("../scripts/migration-check.js")
        );
        let mut injected = false;
        // This scenario runs many independently bounded worker operations plus
        // two gateway starts. Keep its cumulative budget separate from each
        // UI wait and the unchanged production worker deadline.
        let started = Instant::now();
        let end = started + Duration::from_secs(360);
        let mut last_stage = String::new();
        while Instant::now() < end {
            let (tx, rx) = mpsc::sync_channel(1);
            let probe = if injected {
                "window.__migrationCheck || ('stage:' + (window.__migrationStage || 0))"
            } else {
                "Boolean(window.migrationWizard && document.getElementById('migration-source'))"
            };
            let _ = window.eval_with_callback(probe, move |raw| {
                let _ = tx.try_send(raw);
            });
            if let Ok(raw) = rx.recv_timeout(Duration::from_millis(300)) {
                if raw.starts_with("\"stage:") && raw != last_stage {
                    eprintln!(
                        "R03_MIGRATION_PROGRESS {} {}ms",
                        raw,
                        started.elapsed().as_millis()
                    );
                    last_stage = raw.clone();
                }
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
                    let detail = raw.trim_matches('"').strip_prefix("failed:").unwrap_or("");
                    let (stage, reason) = match detail.split_once('|') {
                        Some((stage, reason)) => (stage, Some(reason)),
                        None => (detail, None),
                    };
                    let stage = stage.parse::<u8>().unwrap_or(0);
                    eprintln!("R03_MIGRATION_STEP {stage}");
                    // 步骤编号只能说明停在哪，原因才是排查的入口。
                    if let Some(reason) = reason {
                        eprintln!("R03_MIGRATION_REASON {reason}");
                    }
                    break;
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        eprintln!(
            "R03_MIGRATION_END {}ms last={}",
            started.elapsed().as_millis(),
            last_stage
        );
        eprintln!("R03_MIGRATION_UI false");
        let _ = app.state::<Controller>().action("quit");
    });
    passed
}
