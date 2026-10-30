use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Budget(VecDeque<Instant>);
impl Budget {
    pub fn reserve(&mut self, now: Instant) -> Option<Duration> {
        while self
            .0
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(300))
        {
            self.0.pop_front();
        }
        if self.0.len() >= 3 {
            return None;
        }
        let delay = Duration::from_secs(1 << self.0.len());
        self.0.push_back(now);
        Some(delay)
    }
}

// A receipt is kept only for this successfully authenticated launch. It grants no
// authority over a previous application run or an arbitrary PID from disk.
pub struct Lease {
    pub(super) path: PathBuf,
    pub(super) bytes: Vec<u8>,
    #[cfg(target_os = "macos")]
    pub(super) identity: crate::mac_recovery::Identity,
}
impl Lease {
    pub fn capture(data: &Path, pid: u32) -> Result<Self, String> {
        let path = data.join("runtime/owner.lock");
        let meta = fs::symlink_metadata(&path).map_err(|_| "LEASE_UNVERIFIED")?;
        if !meta.is_file() || meta.len() > 4096 {
            return Err("LEASE_UNVERIFIED".into());
        }
        let bytes = fs::read(&path).map_err(|_| "LEASE_UNVERIFIED")?;
        let v: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "LEASE_UNVERIFIED")?;
        if v["pid"].as_u64() != Some(pid as u64)
            || v["ownerId"]
                .as_str()
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
                .is_none()
        {
            return Err("LEASE_UNVERIFIED".into());
        }
        #[cfg(target_os = "macos")]
        let identity =
            crate::mac_recovery::capture(data, &bytes).map_err(|_| "LEASE_UNVERIFIED")?;
        Ok(Self {
            path,
            bytes,
            #[cfg(target_os = "macos")]
            identity,
        })
    }
    // Call only after Child::try_wait and owned-tree termination both succeeded.
    pub fn release_after_tree_exit(&self) -> bool {
        #[cfg(windows)]
        {
            use std::{
                io::Read,
                os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
            };
            use windows_sys::Win32::Storage::FileSystem::*;
            let file = fs::OpenOptions::new()
                .access_mode(0x80000000 | 0x00010000)
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&self.path);
            let mut file = match file {
                Ok(f) => f,
                Err(e) => return e.kind() == std::io::ErrorKind::NotFound,
            };
            let Ok(meta) = file.metadata() else {
                return false;
            };
            if !meta.is_file() || meta.len() > 4096 {
                return false;
            }
            let mut bytes = Vec::new();
            if file.read_to_end(&mut bytes).is_err() || bytes != self.bytes {
                return false;
            }
            // Delete the verified open file, never a newly substituted pathname.
            let info = FILE_DISPOSITION_INFO { DeleteFile: true };
            unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    &info as *const _ as _,
                    std::mem::size_of_val(&info) as u32,
                ) != 0
            }
        }
        #[cfg(target_os = "macos")]
        {
            crate::mac_recovery::release(self)
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            // Do not clear a stale lock until handle-based recovery has been
            // implemented and verified on the supported macOS builds.
            !self.bytes.is_empty()
                && matches!(fs::symlink_metadata(&self.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_budget_is_rolling_and_bounded() {
        let now = Instant::now();
        let mut budget = Budget::default();
        for delay in [1, 2, 4] {
            assert_eq!(budget.reserve(now), Some(Duration::from_secs(delay)));
        }
        assert_eq!(budget.reserve(now + Duration::from_secs(299)), None);
        assert_eq!(
            budget.reserve(now + Duration::from_secs(300)),
            Some(Duration::from_secs(1))
        );
    }
    #[test]
    #[cfg(windows)]
    fn recovery_refuses_replaced_or_open_lock() {
        let root = std::env::temp_dir().join(format!("cgw-lease-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("runtime")).unwrap();
        let path = root.join("runtime/owner.lock");
        let original = serde_json::json!({"pid":123,"ownerId":uuid::Uuid::new_v4()}).to_string();
        fs::write(&path, &original).unwrap();
        let lease = Lease::capture(&root, 123).unwrap();
        assert!(Lease::capture(&root, 124).is_err());
        let open = fs::File::open(&path).unwrap();
        assert!(!lease.release_after_tree_exit());
        drop(open);
        fs::write(&path, "foreign owner").unwrap();
        assert!(!lease.release_after_tree_exit());
        assert_eq!(fs::read_to_string(&path).unwrap(), "foreign owner");
        fs::write(&path, original).unwrap();
        assert!(lease.release_after_tree_exit());
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_normally_released_lease_can_restart_on_any_supported_host() {
        let root = std::env::temp_dir().join(format!("cgw-lease-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("runtime")).unwrap();
        let lock = root.join("runtime/owner.lock");
        #[cfg(target_os = "macos")]
        fs::write(root.join("runtime/owner.guard"), "").unwrap();
        fs::write(
            &lock,
            serde_json::json!({"pid":123,"ownerId":uuid::Uuid::new_v4()}).to_string(),
        )
        .unwrap();
        let lease = Lease::capture(&root, 123).unwrap();
        #[cfg(not(any(windows, target_os = "macos")))]
        assert!(!lease.release_after_tree_exit()); // Unknown stale files remain intact.
        fs::remove_file(&lock).unwrap();
        assert!(lease.release_after_tree_exit());
        let actual = dunce::canonicalize(&root).unwrap();
        assert_eq!(
            actual.parent(),
            Some(dunce::canonicalize(std::env::temp_dir()).unwrap().as_path())
        );
        fs::remove_dir_all(actual).unwrap();
    }
}
