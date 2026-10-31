use crate::{resources::Resources, supervisor::Settings};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Context {},
    History {},
    BackupReview {
        #[serde(rename = "archiveId")]
        archive_id: String,
    },
    BackupRestore {
        #[serde(rename = "sourceStopped")]
        source_stopped: bool,
    },
    Plan {
        selection: Value,
    },
    Apply {
        fingerprint: String,
        #[serde(rename = "sourceStopped")]
        source_stopped: bool,
    },
    Resume {
        #[serde(rename = "sourceStopped")]
        source_stopped: bool,
    },
    Abort {
        #[serde(rename = "sourceStopped")]
        source_stopped: bool,
    },
    Rollback {
        #[serde(rename = "sourceStopped")]
        source_stopped: bool,
    },
}
impl Request {
    pub fn is_context(&self) -> bool {
        matches!(
            self,
            Self::Context {} | Self::History {} | Self::BackupReview { .. }
        )
    }
}

pub fn guard(data: &Path) -> PathBuf {
    data.with_file_name(format!(
        ".{}.migration",
        data.file_name().unwrap_or_default().to_string_lossy()
    ))
}
pub fn new_install(settings: &Settings) -> bool {
    // An unreadable path or a dangling link is never interpreted as absent.
    matches!(std::fs::symlink_metadata(&settings.data), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        && matches!(std::fs::symlink_metadata(guard(&settings.data)), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

#[derive(Default)]
pub struct Wizard {
    reviewed: Option<(Value, String)>,
    archive: Option<String>,
    backup: Option<(String, String)>,
}
impl Wizard {
    pub fn execute(
        &mut self,
        request: Request,
        settings: &Settings,
        cancel: &AtomicBool,
    ) -> Result<Value, String> {
        let payload = match request {
            Request::Context {} => json!({"operation":"context"}),
            Request::History {} => json!({"operation":"history"}),
            Request::BackupReview { archive_id } => {
                self.backup = None;
                let result = invoke(
                    settings,
                    &json!({"operation":"backup_review", "archiveId":archive_id}),
                    cancel,
                )?;
                if result["canRollback"] == true {
                    self.backup = Some((
                        archive_id,
                        result["fingerprint"]
                            .as_str()
                            .ok_or("MIGRATION_INVALID_REPLY")?
                            .into(),
                    ));
                }
                return Ok(result);
            }
            Request::BackupRestore { source_stopped } => {
                let (id, fingerprint) = self
                    .backup
                    .take()
                    .ok_or("MIGRATION_BACKUP_REVIEW_REQUIRED")?;
                json!({"operation":"backup_restore", "archiveId":id, "fingerprint":fingerprint, "sourceStopped":source_stopped})
            }
            Request::Plan { selection } => {
                self.reviewed = None;
                let result = invoke(
                    settings,
                    &json!({"operation":"plan", "selection":selection}),
                    cancel,
                )?;
                let fingerprint = result["fingerprint"]
                    .as_str()
                    .ok_or("MIGRATION_INVALID_REPLY")?;
                self.reviewed = Some((selection, fingerprint.into()));
                return Ok(result);
            }
            Request::Apply {
                fingerprint,
                source_stopped,
            } => {
                let (selection, expected) =
                    self.reviewed.take().ok_or("MIGRATION_PLAN_REQUIRED")?;
                if fingerprint != expected {
                    return Err("MIGRATION_PLAN_CHANGED".into());
                }
                json!({"operation":"apply", "selection":selection, "fingerprint":expected, "sourceStopped":source_stopped})
            }
            Request::Resume { source_stopped } => {
                json!({"operation":"resume", "sourceStopped":source_stopped})
            }
            Request::Abort { source_stopped } => {
                json!({"operation":"abort", "sourceStopped":source_stopped})
            }
            Request::Rollback { source_stopped } => {
                json!({"operation":"rollback", "archive":self.archive.as_ref().ok_or("MIGRATION_ARCHIVE_REQUIRED")?, "sourceStopped":source_stopped})
            }
        };
        let result = invoke(settings, &payload, cancel)?;
        if result["phase"] == "committed" {
            self.archive = result["archive"].as_str().map(str::to_owned);
        } else if result["phase"] == "aborted" {
            self.archive = None;
        }
        Ok(result)
    }
}

fn invoke(settings: &Settings, payload: &Value, cancel: &AtomicBool) -> Result<Value, String> {
    let input = serde_json::to_vec(payload).map_err(|_| "MIGRATION_INVALID_ARGUMENT")?;
    if input.len() > 65536 {
        return Err("MIGRATION_INVALID_ARGUMENT".into());
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("MIGRATION_INTERRUPTED".into());
    }
    let resources = Resources::load(&settings.resources)?;
    let mut command = Command::new(&resources.node);
    command
        .arg(&resources.migration)
        .arg(&settings.data)
        .arg(&resources.root)
        .current_dir(&resources.root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in std::env::vars_os() {
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
        ]
        .contains(&key.to_string_lossy().to_ascii_uppercase().as_str())
        {
            command.env(key, value);
        }
    }
    if settings.isolated || settings.smoke {
        let home = settings
            .data
            .parent()
            .ok_or("DATA_DIR_INVALID")?
            .join("isolated-home");
        std::fs::create_dir_all(&home).map_err(|_| "DATA_DIR_UNWRITABLE")?;
        for key in ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] {
            command.env(key, &home);
        }
    }
    let (mut child, mut tree) = crate::process_tree::Tree::spawn(&mut command)?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let errors = thread::spawn(move || {
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
    });
    // No work can begin until ownership of the process tree has been established.
    let written = child.stdin.take().unwrap().write_all(&input).is_ok();
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut interrupted = !written;
    let exit = loop {
        if interrupted || cancel.load(Ordering::Relaxed) || Instant::now() >= deadline {
            interrupted = true;
            break None;
        }
        match child.try_wait() {
            Ok(Some(exit)) => break Some(exit),
            Ok(None) => thread::sleep(Duration::from_millis(30)),
            Err(_) => {
                interrupted = true;
                break None;
            }
        }
    };
    if !tree.terminate(&mut child) {
        return Err("MIGRATION_WORKER_UNCONFIRMED".into());
    }
    let bytes = output
        .join()
        .map_err(|_| "MIGRATION_INVALID_REPLY")?
        .map_err(|_| "MIGRATION_INVALID_REPLY")?;
    let _ = errors.join();
    if interrupted {
        return Err("MIGRATION_INTERRUPTED".into());
    }
    if bytes.len() > 65536 {
        return Err("MIGRATION_INVALID_REPLY".into());
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| "MIGRATION_INVALID_REPLY")?;
    if result["ok"] != true || !exit.is_some_and(|e| e.success()) {
        let code = result["code"].as_str().unwrap_or("MIGRATION_FAILED");
        return Err(
            if code.len() < 80
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
            {
                code.into()
            } else {
                "MIGRATION_FAILED".into()
            },
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_requests_cannot_supply_destinations_commands_or_unreviewed_inputs() {
        for value in [
            json!({"operation":"exec","command":"anything"}),
            json!({"operation":"context","targetRoot":"elsewhere"}),
            json!({"operation":"apply","fingerprint":"x","sourceStopped":true,"selection":{}}),
            json!({"operation":"rollback","sourceStopped":true,"archive":"elsewhere"}),
            json!({"operation":"history","targetRoot":"elsewhere"}),
            json!({"operation":"backup_restore","archiveId":"unreviewed","sourceStopped":true}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
    }

    #[test]
    fn bundled_worker_requires_review_and_stop_then_migrates_and_preserves_changed_data() {
        let parent = dunce::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!("cgw-migration-rust-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("旧 数据");
        std::fs::create_dir(&source).unwrap();
        let accounts = r#"{"activeId":null,"accounts":[]}"#;
        std::fs::write(source.join("accounts.json"), accounts).unwrap();
        let settings = Settings {
            resources: std::env::var("CGW_BUILD_RESOURCES").unwrap().into(),
            data: root.join("新 数据"),
            webview_data: root.join("webview"),
            port: 54321,
            bridge_port: None,
            smoke: false,
            isolated: true,
            smoke_case: "normal".into(),
            account_validation: false,
        };
        let cancel = AtomicBool::new(false);
        let mut wizard = Wizard::default();
        assert!(new_install(&settings));
        assert_eq!(
            wizard
                .execute(
                    Request::Apply {
                        fingerprint: "unknown".into(),
                        source_stopped: true
                    },
                    &settings,
                    &cancel
                )
                .unwrap_err(),
            "MIGRATION_PLAN_REQUIRED"
        );
        let selection = json!({"sourceRoot":source,"sourceKind":"data","galleryRoot":null});
        let plan = wizard
            .execute(
                Request::Plan {
                    selection: selection.clone(),
                },
                &settings,
                &cancel,
            )
            .unwrap();
        assert_eq!(
            wizard
                .execute(
                    Request::Apply {
                        fingerprint: plan["fingerprint"].as_str().unwrap().into(),
                        source_stopped: false
                    },
                    &settings,
                    &cancel
                )
                .unwrap_err(),
            "MIGRATION_STOP_CONFIRMATION_REQUIRED"
        );
        assert!(!settings.data.exists());
        let plan = wizard
            .execute(
                Request::Plan {
                    selection: selection.clone(),
                },
                &settings,
                &cancel,
            )
            .unwrap();
        let migrated = wizard
            .execute(
                Request::Apply {
                    fingerprint: plan["fingerprint"].as_str().unwrap().into(),
                    source_stopped: true,
                },
                &settings,
                &cancel,
            )
            .unwrap();
        assert_eq!(migrated["phase"], "committed");
        assert_eq!(
            std::fs::read_to_string(settings.data.join("accounts.json")).unwrap(),
            accounts
        );
        assert_eq!(
            std::fs::read_to_string(source.join("accounts.json")).unwrap(),
            accounts
        );
        // A new native owner models reopening the app: no remembered archive path.
        wizard = Wizard::default();
        assert_eq!(
            wizard
                .execute(
                    Request::BackupRestore {
                        source_stopped: true
                    },
                    &settings,
                    &cancel
                )
                .unwrap_err(),
            "MIGRATION_BACKUP_REVIEW_REQUIRED"
        );
        let history = wizard
            .execute(Request::History {}, &settings, &cancel)
            .unwrap();
        let id = history["backups"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(
            wizard
                .execute(Request::BackupReview { archive_id: id }, &settings, &cancel)
                .unwrap()["canRollback"],
            true
        );
        assert_eq!(
            wizard
                .execute(
                    Request::BackupRestore {
                        source_stopped: true
                    },
                    &settings,
                    &cancel
                )
                .unwrap()["phase"],
            "aborted"
        );
        assert!(!settings.data.exists());
        let plan = wizard
            .execute(Request::Plan { selection }, &settings, &cancel)
            .unwrap();
        wizard
            .execute(
                Request::Apply {
                    fingerprint: plan["fingerprint"].as_str().unwrap().into(),
                    source_stopped: true,
                },
                &settings,
                &cancel,
            )
            .unwrap();
        std::fs::write(settings.data.join("new-data"), "must keep").unwrap();
        assert_eq!(
            wizard
                .execute(
                    Request::Rollback {
                        source_stopped: true
                    },
                    &settings,
                    &cancel
                )
                .unwrap_err(),
            "MIGRATION_CONTENT_CHANGED"
        );
        assert_eq!(
            std::fs::read_to_string(settings.data.join("new-data")).unwrap(),
            "must keep"
        );
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            wizard
                .execute(Request::Context {}, &settings, &cancel)
                .unwrap_err(),
            "MIGRATION_INTERRUPTED"
        );
        let actual = dunce::canonicalize(&root).unwrap();
        assert_eq!(actual, root);
        assert_eq!(actual.parent(), Some(parent.as_path()));
        assert!(actual
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("cgw-migration-rust-"));
        std::fs::remove_dir_all(actual).unwrap();
    }
}
