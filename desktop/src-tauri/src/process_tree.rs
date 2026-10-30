use std::{
    process::{Child, Command},
    time::{Duration, Instant},
};

#[cfg(windows)]
pub struct Tree(std::os::windows::io::OwnedHandle, pub String);
#[cfg(unix)]
pub struct Tree {
    guardian: Child,
    group: i32,
}

impl Tree {
    pub fn spawn(command: &mut Command) -> Result<(Child, Self), String> {
        #[cfg(windows)]
        {
            use std::os::windows::{
                io::{AsRawHandle, FromRawHandle, OwnedHandle},
                process::CommandExt,
            };
            use windows_sys::Win32::System::JobObjects::*;
            // Non-inheritable. The random name permits read-only recovery checks
            // after a shell crash; it is never used to terminate an existing job.
            let name = format!("Local\\CodexGateway.{}", uuid::Uuid::new_v4());
            let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) };
            if raw.is_null() {
                return Err("PROCESS_TREE_UNAVAILABLE".into());
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            if unsafe { windows_sys::Win32::Foundation::GetLastError() }
                == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS
            {
                return Err("PROCESS_TREE_UNAVAILABLE".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err("PROCESS_TREE_UNAVAILABLE".into());
            }
            command.creation_flags(0x08000000);
            let mut child = command.spawn().map_err(|_| "NODE_START_FAILED")?;
            // The verified Node entry cannot load business code or spawn children before
            // initialize/start. Assignment is complete before any control input is sent.
            if unsafe { AssignProcessToJobObject(raw, child.as_raw_handle()) } == 0 {
                let _ = child.kill();
                let _ = child.wait();
                return Err("PROCESS_TREE_UNAVAILABLE".into());
            }
            Ok((child, Self(handle, name)))
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            use std::process::Stdio;
            command.process_group(0);
            let mut child = command.spawn().map_err(|_| "NODE_START_FAILED")?;
            // A live guardian pins the process group identity. It kills its own group
            // on owner-pipe EOF, including when the GUI is forcibly terminated.
            let exe = match std::env::current_exe() {
                Ok(exe) => exe,
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PROCESS_TREE_UNAVAILABLE".into());
                }
            };
            let mut guardian_command = Command::new(exe);
            #[cfg(not(test))]
            guardian_command.args([
                "--process-group-guardian",
                &child.id().to_string(),
                &std::process::id().to_string(),
            ]);
            #[cfg(test)]
            guardian_command
                .args([
                    "--exact",
                    "process_tree::unix_tests::guardian_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env("CGW_GUARDIAN_GROUP", child.id().to_string())
                .env("CGW_GUARDIAN_PARENT", std::process::id().to_string());
            let guardian = guardian_command
                .process_group(child.id() as i32)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn();
            match guardian {
                Ok(mut guardian) => {
                    use std::io::Read;
                    let mut output = guardian.stdout.take().unwrap();
                    let (tx, rx) = std::sync::mpsc::sync_channel(1);
                    std::thread::spawn(move || {
                        // The test runner may precede the fixed handshake byte with
                        // its banner. Read a bounded prefix, never arbitrary output.
                        let mut ready = [0u8; 1];
                        let matched = (0..4096)
                            .any(|_| output.read_exact(&mut ready).is_ok() && ready == [1]);
                        let _ = tx.send(matched);
                    });
                    let tree = Self {
                        guardian,
                        group: child.id() as i32,
                    };
                    if rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false) {
                        Ok((child, tree))
                    } else {
                        drop(tree);
                        let _ = child.kill();
                        let _ = child.wait();
                        Err("PROCESS_TREE_UNAVAILABLE".into())
                    }
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    Err("PROCESS_TREE_UNAVAILABLE".into())
                }
            }
        }
    }
    pub fn empty(&mut self) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) != 0
                    && info.ActiveProcesses == 0
            }
        }
        #[cfg(unix)]
        {
            if !matches!(self.guardian.try_wait(), Ok(Some(_))) {
                return false;
            }
            // Guardian death alone is not proof of cleanup. Signal 0 only probes
            // the group; even a reused group ID can only delay recovery, never
            // authorize killing an unrelated process. All non-ESRCH errors fail closed.
            self.group > 1
                && unsafe { libc::kill(-self.group, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
    pub fn terminate(&mut self) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.0.as_raw_handle(),
                    1,
                );
            }
        }
        #[cfg(unix)]
        {
            self.guardian.stdin.take();
        }
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if self.empty() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

pub fn guardian_entry() {
    #[cfg(unix)]
    {
        let args: Vec<_> = std::env::args().collect();
        if args.get(1).map(String::as_str) != Some("--process-group-guardian") {
            return;
        }
        let group = args.get(2).and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
        let parent = args.get(3).and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
        guardian_run(group, parent);
    }
}

#[cfg(unix)]
fn guardian_run(group: i32, parent: i32) -> ! {
    use std::io::{Read, Write};
    if group <= 1
        || parent <= 1
        || unsafe {
            libc::getpgrp() != group || libc::getppid() != parent || libc::getpgid(parent) == group
        }
    {
        std::process::exit(2);
    }
    if std::io::stdout()
        .write_all(&[1])
        .and_then(|_| std::io::stdout().flush())
        .is_err()
    {
        unsafe {
            libc::kill(0, libc::SIGKILL);
        }
        std::process::exit(2);
    }
    let mut byte = [0u8; 1];
    while matches!(std::io::stdin().read(&mut byte), Ok(1)) {}
    unsafe {
        libc::kill(0, libc::SIGKILL);
    }
    std::process::exit(1);
}

#[cfg(all(test, unix))]
mod unix_tests {
    #[test]
    fn guardian_exit_does_not_mean_its_live_group_is_empty() {
        use std::process::{Command, Stdio};
        let resources = std::env::var("CGW_BUILD_RESOURCES").unwrap();
        let mut command = Command::new(std::path::Path::new(&resources).join("runtime/node"));
        command
            .args(["-e", "setInterval(()=>{},1000)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut root, mut tree) = super::Tree::spawn(&mut command).unwrap();
        tree.guardian.kill().unwrap();
        tree.guardian.wait().unwrap();
        let root_alive = root.try_wait().unwrap().is_none();
        let prematurely_empty = tree.empty();
        // Terminate only the Child held by this test; no descendants were spawned.
        root.kill().unwrap();
        root.wait().unwrap();
        let finally_empty = tree.terminate();
        assert!(root_alive);
        assert!(!prematurely_empty);
        assert!(finally_empty);
    }
    #[test]
    #[ignore = "process group guardian subprocess fixture"]
    fn guardian_fixture() {
        let group = std::env::var("CGW_GUARDIAN_GROUP")
            .unwrap()
            .parse()
            .unwrap();
        let parent = std::env::var("CGW_GUARDIAN_PARENT")
            .unwrap()
            .parse()
            .unwrap();
        super::guardian_run(group, parent);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        os::windows::{
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
            process::CommandExt,
        },
        process::Stdio,
        sync::mpsc,
    };
    use windows_sys::Win32::System::Threading::*;
    fn node() -> Command {
        let root = std::env::var("CGW_BUILD_RESOURCES").unwrap();
        let mut cmd = Command::new(std::path::Path::new(&root).join("runtime/node.exe"));
        cmd.creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        cmd
    }
    fn fixture() -> (Child, Tree) {
        let leaf = "console.log('OWNED '+process.pid);setInterval(()=>{},1000)";
        let branch = format!("const c=require('child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore','inherit','ignore']}});console.log('OWNED '+process.pid);setInterval(()=>{{}},1000)", serde_json::to_string(leaf).unwrap());
        let root = format!("process.stdin.once('data',()=>{{require('child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore','inherit','ignore']}});console.log('OWNED '+process.pid);setInterval(()=>{{}},1000)}})", serde_json::to_string(&branch).unwrap());
        let (mut child, tree) = Tree::spawn(node().args(["-e", &root])).unwrap();
        child.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
        (child, tree)
    }
    fn owned_handles(output: impl std::io::Read + Send + 'static) -> Vec<OwnedHandle> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Some(pid) = line
                    .strip_prefix("OWNED ")
                    .and_then(|s| s.parse::<u32>().ok())
                {
                    let _ = tx.send(pid);
                }
            }
        });
        (0..3)
            .map(|_| {
                let pid = rx.recv_timeout(Duration::from_secs(10)).unwrap();
                let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                assert!(!raw.is_null());
                unsafe { OwnedHandle::from_raw_handle(raw) }
            })
            .collect()
    }
    fn exited(handles: &[OwnedHandle]) {
        for handle in handles {
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 5000) },
                0
            );
        }
    }
    #[test]
    fn owned_tree_termination_includes_grandchild_and_preserves_canary() {
        let mut canary = node()
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap();
        let (mut child, mut tree) = fixture();
        let handles = owned_handles(child.stdout.take().unwrap());
        assert!(!tree.empty());
        assert!(tree.terminate());
        child.wait().unwrap();
        exited(&handles);
        assert!(canary.try_wait().unwrap().is_none());
        canary.kill().unwrap();
        canary.wait().unwrap();
    }
    #[test]
    #[ignore = "subprocess fixture, invoked by owner crash test"]
    fn job_owner_fixture() {
        assert_eq!(std::env::var("CGW_JOB_FIXTURE").as_deref(), Ok("1"));
        let (mut child, _tree) = fixture();
        std::io::copy(&mut child.stdout.take().unwrap(), &mut std::io::stdout()).unwrap();
        child.wait().unwrap();
    }
    #[test]
    fn owner_abrupt_exit_kills_descendants_and_preserves_canary() {
        let mut canary = node()
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .unwrap();
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_tree::tests::job_owner_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CGW_JOB_FIXTURE", "1")
            .creation_flags(0x08000000)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let handles = owned_handles(owner.stdout.take().unwrap());
        owner.kill().unwrap();
        owner.wait().unwrap();
        exited(&handles);
        assert!(canary.try_wait().unwrap().is_none());
        canary.kill().unwrap();
        canary.wait().unwrap();
    }
}

// Shared fixtures also run on macOS CI. The inherited stdout pipe remains open
// in every descendant; EOF demonstrates that all fixture writers have exited,
// without probing or killing a PID that may have been reused.
#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::Stdio,
        sync::mpsc,
    };
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn node() -> Command {
        let root = std::env::var("CGW_BUILD_RESOURCES").unwrap();
        let mut command = Command::new(std::path::Path::new(&root).join(if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        }));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }
    fn fixture(inherit: bool) -> (OwnedChild, Tree) {
        let leaf = "console.log('OWNED');setInterval(()=>{},1000)";
        let branch = format!("require('child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore','inherit','ignore']}});console.log('OWNED');setInterval(()=>{{}},1000)", serde_json::to_string(leaf).unwrap());
        let script = format!("process.stdin.once('data',()=>{{require('child_process').spawn(process.execPath,['-e',{}],{{stdio:['ignore','inherit','ignore']}});console.log('OWNED');setInterval(()=>{{}},1000)}})", serde_json::to_string(&branch).unwrap());
        let mut command = node();
        command.args(["-e", &script]);
        if inherit {
            command.stdout(Stdio::inherit());
        }
        let (mut child, tree) = Tree::spawn(&mut command).unwrap();
        child.stdin.as_mut().unwrap().write_all(b"go\n").unwrap();
        (OwnedChild(child), tree)
    }
    fn events(output: impl std::io::Read + Send + 'static) -> mpsc::Receiver<bool> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if line.trim() == "OWNED" {
                    let _ = tx.send(true);
                }
            }
            let _ = tx.send(false);
        });
        for _ in 0..3 {
            assert!(rx.recv_timeout(Duration::from_secs(10)).unwrap());
        }
        rx
    }
    #[test]
    fn tree_cleanup_closes_every_descendant_pipe_and_keeps_unrelated_child() {
        let mut canary = OwnedChild(
            node()
                .args(["-e", "setInterval(()=>{},1000)"])
                .spawn()
                .unwrap(),
        );
        let (mut root, mut tree) = fixture(false);
        let rx = events(root.0.stdout.take().unwrap());
        assert!(tree.terminate());
        assert!(!rx.recv_timeout(Duration::from_secs(5)).unwrap());
        root.0.wait().unwrap();
        assert!(canary.0.try_wait().unwrap().is_none());
    }
    #[test]
    #[ignore = "owned process-tree crash fixture, invoked by its parent test"]
    fn owner_fixture() {
        assert_eq!(std::env::var("CGW_TREE_FIXTURE").as_deref(), Ok("1"));
        let (mut root, _tree) = fixture(true);
        root.0.wait().unwrap();
    }
    #[test]
    fn owner_crash_closes_every_descendant_pipe_and_keeps_unrelated_child() {
        let mut canary = OwnedChild(
            node()
                .args(["-e", "setInterval(()=>{},1000)"])
                .spawn()
                .unwrap(),
        );
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process_tree::portable_tests::owner_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CGW_TREE_FIXTURE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut owner = OwnedChild(command.spawn().unwrap());
        let rx = events(owner.0.stdout.take().unwrap());
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        assert!(!rx.recv_timeout(Duration::from_secs(5)).unwrap());
        assert!(canary.0.try_wait().unwrap().is_none());
    }
}
