// Native acceptance checks, reached only through explicit isolated --smoke runs.
use crate::{
    console::Console,
    desktop::{self, Desktop},
    protocol::Session,
};
use std::{
    process::{Child, Command, Stdio},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::Manager;

pub struct Check {
    stage: u8,
    started: Instant,
    duplicate: Option<Child>,
    node_pid: u32,
    #[cfg(windows)]
    registered_args: String,
}
impl Default for Check {
    fn default() -> Self {
        Self {
            stage: 0,
            started: Instant::now(),
            duplicate: None,
            node_pid: 0,
            #[cfg(windows)]
            registered_args: String::new(),
        }
    }
}
impl Check {
    pub fn tick(
        &mut self,
        app: &tauri::AppHandle,
        console: &Console,
        session: &mut Session,
    ) -> Result<bool, String> {
        if !app.state::<Desktop>().isolated {
            return Err("CHECK_NOT_ISOLATED".into());
        }
        if self.stage == 0 {
            self.started = Instant::now();
        }
        if self.started.elapsed() > Duration::from_secs(20) {
            return Err("DESKTOP_CHECK_TIMEOUT".into());
        }
        let main_hidden = !app
            .get_webview_window("main")
            .ok_or("MAIN_MISSING")?
            .is_visible()
            .map_err(|_| "MAIN_MISSING")?;
        match self.stage {
            0 => {
                if console.visible() || !main_hidden || app.tray_by_id("gateway-tray").is_none() {
                    return Err("AUTOSTART_NOT_HIDDEN".into());
                }
                self.node_pid = session.child.id();
                if crate::autostart::enabled(app).map_err(|_| "AUTOSTART_QUERY_FAILED")? {
                    return Err("TEST_AUTOSTART_ALREADY_ENABLED".into());
                }
                // Always remove the unique test registration, even if verification fails.
                let enabled = desktop::set_autostart(app, true);
                #[cfg(windows)]
                let saved = crate::autostart::test_registered_args(app);
                let disabled = desktop::set_autostart(app, false);
                enabled.and(disabled)?;
                #[cfg(windows)]
                {
                    self.registered_args = saved?;
                }
                eprintln!("D03_AUTOSTART true");
                desktop::restore(app);
                self.stage = 1;
            }
            1 if console.visible() => {
                console.test_close().map_err(|_| "CLOSE_CHECK_FAILED")?;
                self.stage = 2;
            }
            2 if !console.visible() && main_hidden => {
                if session
                    .child
                    .try_wait()
                    .map_err(|_| "NODE_CHECK_FAILED")?
                    .is_some()
                {
                    return Err("CLOSE_STOPPED_NODE".into());
                }
                eprintln!("D03_RESIDENT true");
                let mut command = Command::new(std::env::current_exe().map_err(|_| "EXE_MISSING")?);
                command
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                    command.raw_arg(&self.registered_args);
                }
                #[cfg(not(windows))]
                command.args(std::env::args().skip(1));
                self.duplicate = Some(command.spawn().map_err(|_| "DUPLICATE_LAUNCH_FAILED")?);
                self.stage = 3;
            }
            3 => {
                let exited = self
                    .duplicate
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .map_err(|_| "DUPLICATE_WAIT_FAILED")?;
                if let Some(status) = exited {
                    if !status.success() {
                        return Err("DUPLICATE_EXIT_FAILED".into());
                    }
                    if app.state::<Desktop>().duplicates.load(Ordering::SeqCst) > 0
                        && console.visible()
                        && main_hidden
                    {
                        if self.node_pid != session.child.id()
                            || session
                                .child
                                .try_wait()
                                .map_err(|_| "NODE_CHECK_FAILED")?
                                .is_some()
                        {
                            return Err("INSTANCE_REPLACED_NODE".into());
                        }
                        eprintln!("D03_SINGLE_INSTANCE true");
                        return Ok(true);
                    }
                }
            }
            _ => {}
        }
        Ok(false)
    }
}
impl Drop for Check {
    fn drop(&mut self) {
        if let Some(child) = self.duplicate.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
