// Windows recovery receipt: no account data, tokens or arbitrary cleanup targets.
// The previous shell must be gone, its named job empty/gone and the exact locked
// ownership record deletable through an exclusive file handle. Never kill by PID.
use crate::{process_tree::Tree, recovery::Lease};
use std::{
    fs,
    io::Write,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
};
use windows_sys::Win32::{
    Foundation::*,
    System::{JobObjects::*, Threading::*},
};
#[derive(serde::Serialize, serde::Deserialize)]
struct Receipt {
    shell: u32,
    created: u64,
    job: String,
    owner: Vec<u8>,
}
fn creation(handle: HANDLE) -> Option<u64> {
    let mut times = [FILETIME::default(); 4];
    if unsafe {
        GetProcessTimes(
            handle,
            &mut times[0],
            &mut times[1],
            &mut times[2],
            &mut times[3],
        )
    } == 0
    {
        return None;
    }
    Some((times[0].dwHighDateTime as u64) << 32 | times[0].dwLowDateTime as u64)
}
pub fn save(lease: &Lease, tree: &Tree) -> std::io::Result<()> {
    let parent = lease.path.parent().unwrap();
    let receipt = Receipt {
        shell: std::process::id(),
        created: creation(unsafe { GetCurrentProcess() })
            .ok_or_else(|| std::io::Error::other("process identity unavailable"))?,
        job: tree.1.clone(),
        owner: lease.bytes.clone(),
    };
    let temp = parent.join(format!(".desktop-recovery-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&serde_json::to_vec(&receipt)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, parent.join("desktop-recovery.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn previous_shell_gone(r: &Receipt) -> bool {
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            r.shell,
        )
    };
    if raw.is_null() {
        return unsafe { GetLastError() } == ERROR_INVALID_PARAMETER;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    (unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_OBJECT_0 })
        || creation(handle.as_raw_handle()).is_some_and(|created| created != r.created)
}
fn previous_job_empty(name: &str) -> bool {
    let Some(id) = name.strip_prefix("Local\\CodexGateway.") else {
        return false;
    };
    if uuid::Uuid::parse_str(id).is_err() {
        return false;
    }
    let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
    let raw = unsafe {
        OpenJobObjectW(0x0004 /* JOB_OBJECT_QUERY */, 0, wide.as_ptr())
    };
    if raw.is_null() {
        return unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe {
        QueryInformationJobObject(
            handle.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            &mut info as *mut _ as _,
            std::mem::size_of_val(&info) as u32,
            std::ptr::null_mut(),
        ) != 0
            && info.ActiveProcesses == 0
    }
}
pub fn recover(data: &Path) -> bool {
    let path = data.join("runtime/desktop-recovery.json");
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > 16 * 1024 {
        return false;
    }
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    let Ok(r) = serde_json::from_slice::<Receipt>(&bytes) else {
        return false;
    };
    if r.shell <= 1
        || r.owner.len() > 4096
        || !previous_shell_gone(&r)
        || !previous_job_empty(&r.job)
    {
        return false;
    }
    let lease = Lease {
        path: data.join("runtime/owner.lock"),
        bytes: r.owner,
    };
    if matches!(fs::symlink_metadata(&lease.path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        // A normal previous shutdown already released ownership; do not report it
        // as crash recovery just because its informational receipt remains.
        let _ = fs::remove_file(path);
        return false;
    }
    if !lease.release_after_tree_exit() {
        return false;
    }
    let _ = fs::remove_file(path);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_live_shell_or_foreign_job_never_authorizes_recovery() {
        let r = Receipt {
            shell: std::process::id(),
            created: creation(unsafe { GetCurrentProcess() }).unwrap(),
            job: String::new(),
            owner: vec![],
        };
        assert!(!previous_shell_gone(&r));
        assert!(!previous_job_empty("arbitrary job"));
        assert!(previous_job_empty(&format!(
            "Local\\CodexGateway.{}",
            uuid::Uuid::new_v4()
        )));
    }
    #[test]
    fn a_receipt_without_a_lock_is_not_a_crash_recovery() {
        let data = std::env::temp_dir().join(format!("cgw-cold-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(data.join("runtime")).unwrap();
        let r = Receipt {
            shell: std::process::id(),
            created: 0,
            job: format!("Local\\CodexGateway.{}", uuid::Uuid::new_v4()),
            owner: vec![],
        };
        let path = data.join("runtime/desktop-recovery.json");
        fs::write(&path, serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(!recover(&data));
        assert!(!path.exists());
        fs::remove_dir_all(data).unwrap();
    }
}
