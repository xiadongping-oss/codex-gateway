use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
#[derive(Clone, Copy)]
pub enum Event {
    Starting,
    Ready,
    DiagnosticsOpened,
    TreeStopped,
    TreeStopFailed,
    RecoveryScheduled,
    RecoveryBlocked,
    Stopped,
    Unresponsive,
}
impl Event {
    fn code(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::DiagnosticsOpened => "diagnostics_opened",
            Self::TreeStopped => "tree_stopped",
            Self::TreeStopFailed => "tree_stop_failed",
            Self::RecoveryScheduled => "recovery_scheduled",
            Self::RecoveryBlocked => "recovery_blocked",
            Self::Stopped => "stopped",
            Self::Unresponsive => "unresponsive",
        }
    }
}
pub struct Log {
    directory: PathBuf,
}
impl Log {
    pub fn new(webview: &Path) -> Self {
        Self {
            directory: webview.parent().unwrap_or(webview).join("logs"),
        }
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    // Typed events only. No stderr, URLs, request/response bodies, paths or credentials.
    pub fn record(&self, event: Event) -> std::io::Result<()> {
        self.write_code(event.code())
    }
    pub fn fault(&self, code: &str) -> std::io::Result<()> {
        self.write_code(match code {
            "PORT_IN_USE" => "port_in_use",
            "DATA_IN_USE" => "data_in_use",
            "DATA_MIGRATION_REQUIRED" | "DATA_VERSION_UNSUPPORTED" => "data_version_error",
            "DATA_DIR_INVALID" | "DATA_DIR_UNWRITABLE" => "data_directory_error",
            "RESOURCES_MISSING" | "RESOURCES_INVALID" | "BRIDGE_PATCH_INVALID" => {
                "resources_invalid"
            }
            "IDENTITY_MISMATCH" | "FRAME_INVALID" => "protocol_invalid",
            "CONTROL_CHANNEL_LOST" => "control_channel_lost",
            "PROCESS_TREE_UNAVAILABLE" => "process_tree_unavailable",
            "LEASE_UNVERIFIED" | "RECOVERY_RECEIPT_FAILED" => "recovery_receipt_failed",
            "CANCELLED" => "cancelled",
            _ => "internal_error",
        })
    }
    fn write_code(&self, code: &'static str) -> std::io::Result<()> {
        fs::create_dir_all(&self.directory)?;
        let path = self.directory.join("desktop.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() >= 256 * 1024) {
            let oldest = self.directory.join("desktop.3.log");
            if oldest.exists() {
                fs::remove_file(oldest)?;
            }
            for n in (1..3).rev() {
                let from = self.directory.join(format!("desktop.{n}.log"));
                if from.exists() {
                    fs::rename(from, self.directory.join(format!("desktop.{}.log", n + 1)))?;
                }
            }
            fs::rename(&path, self.directory.join("desktop.1.log"))?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(
            file,
            "{} {}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            code
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_rotation_is_bounded() {
        let root = std::env::temp_dir().join(format!("cgw-log-{}", uuid::Uuid::new_v4()));
        let log = Log::new(&root.join("webview"));
        for _ in 0..6 {
            log.record(Event::Ready).unwrap();
            fs::write(log.directory.join("desktop.log"), vec![b'x'; 256 * 1024]).unwrap();
        }
        log.record(Event::Stopped).unwrap();
        assert_eq!(fs::read_dir(log.directory()).unwrap().count(), 4);
        let text = fs::read_to_string(log.directory.join("desktop.log")).unwrap();
        assert_eq!(text.split_whitespace().nth(1), Some("stopped"));
        log.fault("Bearer secret-canary https://example.test/?ticket=private")
            .unwrap();
        let text = fs::read_to_string(log.directory.join("desktop.log")).unwrap();
        assert!(text.contains("internal_error"));
        assert!(!text.contains("secret-canary") && !text.contains("ticket"));
        fs::remove_dir_all(root).unwrap();
    }
}
