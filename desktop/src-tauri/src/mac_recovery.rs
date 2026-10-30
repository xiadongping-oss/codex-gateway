// All current managed Node writers and recovery share the persistent owner.guard
// flock. Directory-relative operations pin the data tree; no recovery kills a PID.
use crate::{process_tree::Tree, recovery::Lease};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FileId {
    dev: u64,
    ino: u64,
}
impl FileId {
    fn of(meta: &Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    root: FileId,
    runtime: FileId,
    guard: FileId,
    owner: FileId,
}

fn invalid() -> io::Error {
    io::Error::other("recovery ownership unverified")
}
fn secure(meta: &Metadata, directory: bool) -> bool {
    meta.uid() == unsafe { libc::getuid() }
        && meta.mode() & 0o022 == 0
        && if directory {
            meta.is_dir()
        } else {
            meta.is_file() && meta.nlink() == 1
        }
}
fn open_at(parent: &File, name: &std::ffi::CStr, flags: i32) -> io::Result<File> {
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn read_at(parent: &File, name: &std::ffi::CStr, limit: u64) -> io::Result<(Vec<u8>, FileId)> {
    let file = open_at(parent, name, libc::O_RDONLY | libc::O_NONBLOCK)?;
    let meta = file.metadata()?;
    if !secure(&meta, false) || meta.len() > limit {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid());
    }
    Ok((bytes, FileId::of(&meta)))
}
struct Anchor {
    root: File,
    runtime: File,
    guard: File,
}
impl Anchor {
    fn open(data: &Path, exclusive: bool) -> io::Result<Self> {
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(data)?;
        let runtime = open_at(&root, c"runtime", libc::O_RDONLY | libc::O_DIRECTORY)?;
        let guard = open_at(
            &runtime,
            c"owner.guard",
            libc::O_RDWR | libc::O_NONBLOCK | if exclusive { libc::O_EXLOCK } else { 0 },
        )?;
        if !secure(&root.metadata()?, true)
            || !secure(&runtime.metadata()?, true)
            || !secure(&guard.metadata()?, false)
            || guard.metadata()?.len() != 0
        {
            return Err(invalid());
        }
        Ok(Self {
            root,
            runtime,
            guard,
        })
    }
    fn identity(&self, owner: FileId) -> io::Result<Identity> {
        Ok(Identity {
            root: FileId::of(&self.root.metadata()?),
            runtime: FileId::of(&self.runtime.metadata()?),
            guard: FileId::of(&self.guard.metadata()?),
            owner,
        })
    }
    fn matches(&self, data: &Path, expected: &Identity) -> io::Result<bool> {
        let current = Self::open(data, false)?;
        let actual = current.identity(expected.owner.clone())?;
        let held = self.identity(expected.owner.clone())?;
        Ok(actual.root == expected.root
            && actual.runtime == expected.runtime
            && actual.guard == expected.guard
            && held.root == actual.root
            && held.runtime == actual.runtime
            && held.guard == actual.guard)
    }
    fn unlink(&self, name: &std::ffi::CStr) -> io::Result<()> {
        if unsafe { libc::unlinkat(self.runtime.as_raw_fd(), name.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    fn release(&self, data: &Path, expected: &Identity, owner: &[u8]) -> io::Result<bool> {
        if !self.matches(data, expected)? {
            return Ok(false);
        }
        let (bytes, identity) = match read_at(&self.runtime, c"owner.lock", 4096) {
            Ok(value) => value,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(e) => return Err(e),
        };
        if bytes != owner || identity != expected.owner {
            return Ok(false);
        }
        // The persistent exclusive guard serializes creation, normal release and
        // recovery. Never unlink the guard or use an unchecked absolute pathname.
        self.unlink(c"owner.lock")?;
        Ok(true)
    }
}
pub fn capture(data: &Path, owner: &[u8]) -> io::Result<Identity> {
    let anchor = Anchor::open(data, false)?;
    let (bytes, id) = read_at(&anchor.runtime, c"owner.lock", 4096)?;
    if bytes != owner {
        return Err(invalid());
    }
    let identity = anchor.identity(id)?;
    if !anchor.matches(data, &identity)? {
        return Err(invalid());
    }
    Ok(identity)
}
pub fn release(lease: &Lease) -> bool {
    let Some(data) = lease.path.parent().and_then(Path::parent) else {
        return false;
    };
    let Ok(anchor) = Anchor::open(data, true) else {
        return false;
    };
    anchor
        .release(data, &lease.identity, &lease.bytes)
        .unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: u32,
    shell: i32,
    group: i32,
    owner: Vec<u8>,
    identity: Identity,
}
pub fn save(lease: &Lease, tree: &Tree) -> io::Result<()> {
    let data = lease
        .path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(invalid)?;
    let anchor = Anchor::open(data, false)?;
    if !anchor.matches(data, &lease.identity)? {
        return Err(invalid());
    }
    let receipt = Receipt {
        schema: 1,
        shell: std::process::id() as i32,
        group: tree.group_id(),
        owner: lease.bytes.clone(),
        identity: lease.identity.clone(),
    };
    let name =
        std::ffi::CString::new(format!(".desktop-recovery-{}.tmp", uuid::Uuid::new_v4())).unwrap();
    let result = (|| {
        let mut file = open_at(
            &anchor.runtime,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        file.write_all(&serde_json::to_vec(&receipt)?)?;
        file.sync_all()?;
        if unsafe {
            libc::renameat(
                anchor.runtime.as_raw_fd(),
                name.as_ptr(),
                anchor.runtime.as_raw_fd(),
                c"desktop-recovery.json".as_ptr(),
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = anchor.unlink(&name);
    }
    result
}
fn gone(pid: i32) -> bool {
    // A reused live PID/group conservatively prevents recovery. EPERM and every
    // unknown result also fail closed; only ESRCH counts as gone. Signal 0 is a probe.
    (unsafe { libc::kill(pid, 0) == -1 })
        && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
pub fn recover(data: &Path) -> bool {
    recover_checked(data).unwrap_or(false)
}
fn recover_checked(data: &Path) -> io::Result<bool> {
    let anchor = Anchor::open(data, true)?;
    let (bytes, _) = read_at(&anchor.runtime, c"desktop-recovery.json", 16 * 1024)?;
    let r: Receipt = serde_json::from_slice(&bytes)?;
    let owner: serde_json::Value = serde_json::from_slice(&r.owner)?;
    if r.schema != 1
        || r.shell <= 1
        || r.group <= 1
        || r.shell == r.group
        || r.owner.len() > 4096
        || owner["pid"].as_i64() != Some(r.group as i64)
        || owner["ownerId"]
            .as_str()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_none()
        || !gone(r.shell)
        || !gone(-r.group)
        || !anchor.matches(data, &r.identity)?
    {
        return Ok(false);
    }
    let existed = match read_at(&anchor.runtime, c"owner.lock", 4096) {
        Ok(_) => true,
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    if !anchor.release(data, &r.identity, &r.owner)? {
        return Ok(false);
    }
    anchor.unlink(c"desktop-recovery.json")?;
    Ok(existed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("cgw-mac-recovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("runtime")).unwrap();
            fs::write(root.join("runtime/owner.guard"), "").unwrap();
            fs::write(
                root.join("runtime/owner.lock"),
                serde_json::json!({"pid":123,"ownerId":uuid::Uuid::new_v4()}).to_string(),
            )
            .unwrap();
            Self(root)
        }
        fn lease(&self) -> Lease {
            Lease::capture(&self.0, 123).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn recovery_requires_exclusive_guard_and_exact_file_identity() {
        let f = Fixture::new();
        let lease = f.lease();
        let held = Anchor::open(&f.0, true).unwrap();
        assert!(!release(&lease));
        drop(held);
        let lock = f.0.join("runtime/owner.lock");
        fs::rename(&lock, f.0.join("runtime/original.lock")).unwrap();
        fs::write(&lock, &lease.bytes).unwrap();
        assert!(
            !release(&lease),
            "same bytes in a replacement inode must not authorize deletion"
        );
        fs::remove_file(&lock).unwrap();
        fs::rename(f.0.join("runtime/original.lock"), &lock).unwrap();
        fs::write(&lock, "foreign owner").unwrap();
        assert!(!release(&lease));
        assert_eq!(fs::read_to_string(&lock).unwrap(), "foreign owner");
        fs::write(&lock, &lease.bytes).unwrap();
        assert!(release(&lease));
        assert!(f.0.join("runtime/owner.guard").exists());
    }
    #[test]
    fn links_and_replaced_directories_cannot_authorize_recovery() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let lease = f.lease();
        let lock = f.0.join("runtime/owner.lock");
        let saved = f.0.join("saved.lock");
        fs::rename(&lock, &saved).unwrap();
        symlink(&saved, &lock).unwrap();
        assert!(!release(&lease));
        fs::remove_file(&lock).unwrap();
        fs::hard_link(&saved, &lock).unwrap();
        assert!(!release(&lease));
        fs::remove_file(&lock).unwrap();
        fs::rename(&saved, &lock).unwrap();
        fs::rename(f.0.join("runtime"), f.0.join("old-runtime")).unwrap();
        fs::create_dir(f.0.join("runtime")).unwrap();
        fs::write(f.0.join("runtime/owner.guard"), "").unwrap();
        fs::write(&lock, &lease.bytes).unwrap();
        assert!(!release(&lease));
        assert_eq!(fs::read(&lock).unwrap(), lease.bytes);
    }
    #[test]
    fn cold_recovery_refuses_live_shell_group_or_unknown_receipt() {
        let f = Fixture::new();
        let lease = f.lease();
        let path = f.0.join("runtime/desktop-recovery.json");
        fs::write(&path, "unknown receipt").unwrap();
        assert!(!recover(&f.0));
        assert!(!gone(std::process::id() as i32));
        assert!(!gone(-unsafe { libc::getpgrp() }));
        let r = Receipt {
            schema: 1,
            shell: std::process::id() as i32,
            group: 123,
            owner: lease.bytes.clone(),
            identity: lease.identity.clone(),
        };
        fs::write(&path, serde_json::to_vec(&r).unwrap()).unwrap();
        assert!(!recover(&f.0));
        assert_eq!(fs::read(&lease.path).unwrap(), lease.bytes);
    }
    #[test]
    fn dead_shell_cannot_recover_until_its_group_is_gone() {
        use std::{
            os::unix::process::CommandExt,
            process::{Child, Command},
        };
        struct Owned(Child);
        impl Drop for Owned {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut retired = Command::new("/usr/bin/true").spawn().unwrap();
        let shell = retired.id() as i32;
        retired.wait().unwrap();
        let mut group = Owned(
            Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let f = Fixture::new();
        let lock = f.0.join("runtime/owner.lock");
        fs::write(
            &lock,
            serde_json::json!({"pid":group.0.id(),"ownerId":uuid::Uuid::new_v4()}).to_string(),
        )
        .unwrap();
        let lease = Lease::capture(&f.0, group.0.id()).unwrap();
        let r = Receipt {
            schema: 1,
            shell,
            group: group.0.id() as i32,
            owner: lease.bytes.clone(),
            identity: lease.identity.clone(),
        };
        let path = f.0.join("runtime/desktop-recovery.json");
        let receipt = serde_json::to_vec(&r).unwrap();
        fs::write(&path, &receipt).unwrap();
        assert!(!recover(&f.0));
        assert!(group.0.try_wait().unwrap().is_none());
        assert_eq!(fs::read(&lock).unwrap(), lease.bytes);
        assert_eq!(fs::read(&path).unwrap(), receipt);
        group.0.kill().unwrap();
        group.0.wait().unwrap();
        assert!(recover(&f.0));
        assert!(!lock.exists());
        assert!(!recover(&f.0));
        // A normal release with an informational receipt is not a crash recovery.
        fs::write(&path, receipt).unwrap();
        assert!(!recover(&f.0));
        assert!(!path.exists());
    }
    #[test]
    fn replaced_or_linked_guard_is_never_used_for_recovery() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let lease = f.lease();
        let guard = f.0.join("runtime/owner.guard");
        let original = f.0.join("original.guard");
        fs::rename(&guard, &original).unwrap();
        fs::write(&guard, "").unwrap();
        assert!(!release(&lease));
        fs::remove_file(&guard).unwrap();
        symlink(&original, &guard).unwrap();
        assert!(!release(&lease));
        assert_eq!(fs::read(&lease.path).unwrap(), lease.bytes);
    }
}
