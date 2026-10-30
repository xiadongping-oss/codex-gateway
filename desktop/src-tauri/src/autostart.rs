#[cfg(windows)]
use tauri::Manager;

#[cfg(windows)]
pub struct Registration {
    pub name: String,
    pub args: Vec<String>,
}

#[cfg(windows)]
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

// Windows command-line quoting (including backslashes before a quote or terminator).
#[cfg(windows)]
fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            '\\',
            if c == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}
#[cfg(windows)]
pub fn command(app: &tauri::AppHandle) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|_| "无法定位应用")?;
    let reg = app.state::<Registration>();
    let mut parts = vec![quote(&exe.to_string_lossy())];
    parts.extend(reg.args.iter().map(|s| quote(s)));
    Ok(parts.join(" "))
}
#[cfg(windows)]
pub fn test_registered_args(app: &tauri::AppHandle) -> Result<String, String> {
    if !app.state::<crate::desktop::Desktop>().isolated {
        return Err("TEST_NOT_ISOLATED".into());
    }
    let reg = app.state::<Registration>();
    let saved = windows_registry::CURRENT_USER
        .open(RUN)
        .and_then(|k| k.get_string(&reg.name))
        .map_err(|_| "TEST_REGISTRATION_MISSING")?;
    if saved != command(app)? {
        return Err("TEST_REGISTRATION_MISMATCH".into());
    }
    let exe = std::env::current_exe().map_err(|_| "TEST_EXE_MISSING")?;
    saved
        .strip_prefix(&(quote(&exe.to_string_lossy()) + " "))
        .map(str::to_string)
        .ok_or("TEST_EXE_MISMATCH".into())
}

#[cfg(windows)]
fn remove(path: &str, name: &str) -> Result<(), String> {
    let result = windows_registry::CURRENT_USER
        .options()
        .write()
        .open(path)
        .and_then(|key| key.remove_value(name));
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.code().0 as u32 == 0x80070002 => Ok(()),
        Err(_) => Err("无法更新当前用户的自启动设置".into()),
    }
}

pub fn enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let reg = app.state::<Registration>();
        let value = windows_registry::CURRENT_USER
            .open(RUN)
            .and_then(|k| k.get_string(&reg.name));
        let value = match value {
            Ok(v) => v,
            Err(e) if e.code().0 as u32 == 0x80070002 => return Ok(false),
            Err(_) => return Err("无法读取自启动设置".into()),
        };
        if value != command(app)? {
            return Ok(false);
        }
        match windows_registry::CURRENT_USER
            .open(APPROVED)
            .and_then(|k| k.get_value(&reg.name))
        {
            Ok(bytes) => Ok(matches!(bytes.first(), Some(2 | 6))),
            Err(e) if e.code().0 as u32 == 0x80070002 => Ok(true),
            Err(_) => Err("无法读取系统自启动状态".into()),
        }
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|_| "无法读取自启动设置".into())
    }
}
pub fn set(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let name = &app.state::<Registration>().name;
        if enabled {
            let command = command(app)?;
            windows_registry::CURRENT_USER
                .create(RUN)
                .and_then(|k| k.set_string(name, command))
                .map_err(|_| "无法保存自启动设置")?;
            // Only our own value; removing an old Task Manager override restores OS default.
            remove(APPROVED, name)?;
        } else {
            remove(RUN, name)?;
            remove(APPROVED, name)?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        (if enabled {
            manager.enable()
        } else {
            manager.disable()
        })
        .map_err(|_| "无法保存自启动设置".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn quotes_install_paths_and_test_arguments() {
        assert_eq!(
            quote(r"C:\Program Files\Codex Gateway\app.exe"),
            "\"C:\\Program Files\\Codex Gateway\\app.exe\""
        );
        assert_eq!(
            quote("--data-dir=C:\\中文 & # % !\\"),
            "\"--data-dir=C:\\中文 & # % !\\\\\""
        );
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
