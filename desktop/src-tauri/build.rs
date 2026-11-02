fn main() {
    // Icon-only updates must also rebuild the Windows executable resources.
    for icon in ["icons/icon.ico", "icons/icon.png", "icons/tray.png"] {
        println!("cargo:rerun-if-changed={icon}");
    }
    println!("cargo:rerun-if-env-changed=CGW_BUILD_RESOURCES");
    let root = std::env::var("CGW_BUILD_RESOURCES").expect("Run node desktop/build.mjs first");
    let manifest = std::path::Path::new(&root).join("DESKTOP-RESOURCES.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    std::fs::copy(
        manifest,
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("resources.json"),
    )
    .unwrap();
    tauri_build::build();
}
