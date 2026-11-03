use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{window::Color, Manager, Theme};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    Light,
    Dark,
    System,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Background,
    Quit,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Preferences {
    pub appearance: Appearance,
    pub close_behavior: CloseBehavior,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub appearance: Option<Appearance>,
    pub close_behavior: Option<CloseBehavior>,
}
pub struct Store {
    path: PathBuf,
    value: Mutex<Preferences>,
    pub read_error: Mutex<Option<String>>,
}
impl Store {
    pub fn load(path: PathBuf) -> Self {
        let loaded = fs::read(&path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()));
        let (value, read_error) = match loaded {
            Ok(value) => (value, None),
            Err(_) if !path.exists() => (Preferences::default(), None),
            Err(_) => (
                Preferences::default(),
                Some("偏好文件无法读取，暂用默认设置；重新选择后可保存。".into()),
            ),
        };
        Self {
            path,
            value: Mutex::new(value),
            read_error: Mutex::new(read_error),
        }
    }
    pub fn get(&self) -> Preferences {
        self.value.lock().unwrap().clone()
    }
    pub fn save(&self, patch: Patch) -> Result<Preferences, String> {
        let mut current = self.value.lock().unwrap();
        let next = Preferences {
            appearance: patch.appearance.unwrap_or(current.appearance),
            close_behavior: patch.close_behavior.unwrap_or(current.close_behavior),
        };
        let parent = self.path.parent().ok_or("偏好目录不可用")?;
        fs::create_dir_all(parent).map_err(|_| "无法保存偏好，请检查目录权限")?;
        let temp = parent.join(format!(".preferences-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&serde_json::to_vec_pretty(&next)?)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
            return Err("偏好未能保存，原设置已保留。".into());
        }
        *current = next.clone();
        *self.read_error.lock().unwrap() = None;
        Ok(next)
    }
}
fn resolved(app: &tauri::AppHandle) -> Theme {
    match app.state::<Store>().get().appearance {
        Appearance::Dark => Theme::Dark,
        Appearance::Light => Theme::Light,
        Appearance::System => app
            .get_window("main")
            .and_then(|w| w.theme().ok())
            .unwrap_or(Theme::Light),
    }
}
pub fn snapshot(app: &tauri::AppHandle) -> serde_json::Value {
    let store = app.state::<Store>();
    let mut value = serde_json::to_value(store.get()).unwrap();
    value["resolvedAppearance"] = if resolved(app) == Theme::Dark {
        "dark"
    } else {
        "light"
    }
    .into();
    value
}
pub fn initialization(app: &tauri::AppHandle) -> String {
    format!("window.__CGW_APPEARANCE__={};if(document.documentElement)document.documentElement.dataset.theme=window.__CGW_APPEARANCE__.resolvedAppearance;window.dispatchEvent(new CustomEvent('cgw:appearance',{{detail:window.__CGW_APPEARANCE__}}));", snapshot(app))
}
fn paint(app: &tauri::AppHandle, theme: Theme) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let (r, g, b) = if theme == Theme::Dark {
        (10, 11, 14)
    } else {
        (247, 247, 251)
    };
    let _ = window.set_background_color(Some(Color(r, g, b, 255)));
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        };
        let caption = u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16);
        let text: u32 = if theme == Theme::Dark {
            0x00e7e4e4
        } else {
            0x00382624
        };
        // Windows 11 supports exact caption colors. Older systems retain the
        // native light/dark caption provided by set_theme.
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_CAPTION_COLOR as u32,
                &caption as *const _ as _,
                4,
            );
            DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_TEXT_COLOR as u32,
                &text as *const _ as _,
                4,
            );
        }
    }
    let script = initialization(app);
    for view in app
        .webviews()
        .values()
        .filter(|v| v.window().label() == "main")
    {
        let _ = view.eval(&script);
    }
}
pub fn apply(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("main") {
        let theme = match app.state::<Store>().get().appearance {
            Appearance::Light => Some(Theme::Light),
            Appearance::Dark => Some(Theme::Dark),
            Appearance::System => None,
        };
        let _ = window.set_theme(theme);
        paint(app, resolved(app));
    }
}
pub fn system_changed(app: &tauri::AppHandle, theme: Theme) {
    if app.state::<Store>().get().appearance == Appearance::System {
        paint(app, theme);
    }
}
pub fn update(app: &tauri::AppHandle, patch: Patch) -> Result<serde_json::Value, String> {
    let previous = app.state::<Store>().get().appearance;
    let next = app.state::<Store>().save(patch)?;
    if next.appearance != previous {
        apply(app);
    } else {
        let script = initialization(app);
        for view in app
            .webviews()
            .values()
            .filter(|v| v.window().label() == "main")
        {
            let _ = view.eval(&script);
        }
    }
    Ok(snapshot(app))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_persist_independently_and_failed_save_preserves_previous_values() {
        let root = std::env::temp_dir().join(format!("cgw-preferences-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("preferences.json");
        let store = Store::load(path.clone());
        store
            .save(Patch {
                appearance: Some(Appearance::Dark),
                ..Default::default()
            })
            .unwrap();
        store
            .save(Patch {
                close_behavior: Some(CloseBehavior::Quit),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            Store::load(path.clone()).get(),
            Preferences {
                appearance: Appearance::Dark,
                close_behavior: CloseBehavior::Quit
            }
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store
            .save(Patch {
                appearance: Some(Appearance::Light),
                ..Default::default()
            })
            .is_err());
        assert_eq!(store.get().appearance, Appearance::Dark);
        fs::remove_dir(&path).unwrap();
        fs::remove_dir(&root).unwrap();
    }
    #[test]
    fn preference_commands_reject_unknown_values_and_properties() {
        for value in [
            r#"{"appearance":"anything"}"#,
            r#"{"closeBehavior":"kill"}"#,
            r#"{"command":"quit"}"#,
        ] {
            assert!(serde_json::from_str::<Patch>(value).is_err());
        }
    }
}
