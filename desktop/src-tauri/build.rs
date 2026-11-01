fn main() {
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
