// Embeds the files to install (payload.bin, written by scripts\package.ps1) and the installer's icon and manifest.
// Without a payload the installer still builds, and says it has nothing to install.
use std::{env, fs, path::PathBuf};

fn main() {
    let here = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let payload = here.join("payload.bin");
    println!("cargo:rerun-if-changed={}", payload.display());
    println!("cargo:rerun-if-changed=setup.rc");
    println!("cargo:rerun-if-changed=setup.manifest");
    if payload.exists() {
        fs::copy(&payload, out.join("payload.bin")).unwrap();
    } else {
        fs::write(out.join("payload.bin"), b"").unwrap();
    }
    embed_resource::compile("setup.rc", embed_resource::NONE).manifest_required().unwrap();
}
