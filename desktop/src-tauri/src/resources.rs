use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    target: String,
    app_version: String,
    entry: String,
    node: String,
    files: BTreeMap<String, Fingerprint>,
}
#[derive(Deserialize)]
struct Fingerprint {
    bytes: u64,
    sha256: String,
}
pub struct Resources {
    pub root: PathBuf,
    pub node: PathBuf,
    pub entry: PathBuf,
    pub version: String,
}
pub fn target() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else {
        "unsupported"
    }
}
impl Resources {
    pub fn load(root: &Path) -> Result<Self, String> {
        let expected = include_bytes!(concat!(env!("OUT_DIR"), "/resources.json"));
        let actual =
            fs::read(root.join("DESKTOP-RESOURCES.json")).map_err(|_| "RESOURCES_MISSING")?;
        if actual != expected {
            return Err("RESOURCES_INVALID".into());
        }
        let manifest: Manifest =
            serde_json::from_slice(expected).map_err(|_| "RESOURCES_INVALID")?;
        let node = if cfg!(windows) {
            "runtime/node.exe"
        } else {
            "runtime/node"
        };
        if manifest.schema_version != 1
            || manifest.target != target()
            || manifest.app_version != env!("CARGO_PKG_VERSION")
            || manifest.entry != "gateway/desktop-entry.mjs"
            || manifest.node != node
        {
            return Err("RESOURCES_INVALID".into());
        }
        let root = dunce::canonicalize(root).map_err(|_| "RESOURCES_MISSING")?;
        for (name, expected) in &manifest.files {
            let relative = Path::new(name);
            if !relative
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
            {
                return Err("RESOURCES_INVALID".into());
            }
            let file = root.join(relative);
            if !dunce::canonicalize(&file)
                .map_err(|_| "RESOURCES_INVALID")?
                .starts_with(&root)
            {
                return Err("RESOURCES_INVALID".into());
            }
            let bytes = fs::read(file).map_err(|_| "RESOURCES_INVALID")?;
            if bytes.len() as u64 != expected.bytes
                || format!("{:x}", Sha256::digest(&bytes)) != expected.sha256
            {
                return Err("RESOURCES_INVALID".into());
            }
        }
        Ok(Self {
            node: root.join(node),
            entry: root.join(&manifest.entry),
            version: manifest.app_version,
            root,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiled_resources_are_complete_and_targeted() {
        let root = std::env::var("CGW_BUILD_RESOURCES").unwrap();
        let resources = Resources::load(Path::new(&root)).unwrap();
        assert!(resources.node.is_absolute());
        assert!(resources.entry.is_absolute());
        assert_eq!(resources.version, env!("CARGO_PKG_VERSION"));
    }
    #[test]
    fn missing_resources_fail_closed() {
        assert!(Resources::load(Path::new("/missing-cgw-resources")).is_err());
    }
}
