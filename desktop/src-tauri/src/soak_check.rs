// Compiled only in debug builds; the fixed control files live in an explicitly
// owned isolated test root. No general command listener is added to release.
use crate::{console::Console, supervisor::Settings};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

pub struct Check {
    root: PathBuf,
    started: Instant,
    next: Instant,
    deadline: Duration,
}
impl Check {
    pub fn new(settings: &Settings) -> Option<Self> {
        if !settings.isolated || !settings.smoke || settings.smoke_case != "soak" {
            return None;
        }
        let root = settings.data.parent()?;
        let actual = dunce::canonicalize(root).ok()?;
        if actual != root || !actual.file_name()?.to_str()?.starts_with("cgw-soak-") {
            return None;
        }
        let config = actual.join("soak-config.json");
        let metadata = fs::symlink_metadata(&config).ok()?;
        if !metadata.is_file() || metadata.len() > 1024 {
            return None;
        }
        let config: serde_json::Value = serde_json::from_slice(&fs::read(config).ok()?).ok()?;
        let ms = config["durationMs"].as_u64()?;
        if config["schemaVersion"] != 1 || !(5_000..=28_800_000).contains(&ms) {
            return None;
        }
        Some(Self {
            root: actual,
            started: Instant::now(),
            next: Instant::now(),
            deadline: Duration::from_millis(ms) + Duration::from_secs(180),
        })
    }
    pub fn tick(&mut self, phase: &str, node: Option<u32>, console: Option<&Console>) -> bool {
        let stop = self.root.join("soak-stop");
        let requested = fs::symlink_metadata(stop).is_ok_and(|m| m.is_file());
        let watchdog = self.started.elapsed() >= self.deadline;
        if Instant::now() >= self.next || requested || watchdog {
            self.next = Instant::now() + Duration::from_secs(5);
            let record = json!({"schemaVersion":1,"elapsedMs":self.started.elapsed().as_millis(),"phase":phase,"nodePid":node,"console":console.map(Console::smoke_report),"stopRequested":requested,"watchdogExpired":watchdog});
            // Refuse linked control output; a failed write ends this test through
            // the normal supervisor shutdown rather than leaving it unattended.
            let output = self.root.join("soak-native.json");
            let next = self.root.join("soak-native.next.json");
            if fs::symlink_metadata(&output).is_ok_and(|m| !m.is_file())
                || fs::symlink_metadata(&next).is_ok_and(|m| !m.is_file())
                || fs::write(&next, record.to_string()).is_err()
                || fs::rename(next, output).is_err()
            {
                return true;
            }
        }
        requested || watchdog
    }
}
