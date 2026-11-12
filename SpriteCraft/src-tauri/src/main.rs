// SpriteCraft desktop app: a native Windows window (WebView2) showing the SpriteCraft UI, with the project/file API served
// in-process on the private `craft://` scheme by the shared Rust backend. No browser, no network port.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use craft_backend::Config;
use std::path::PathBuf;

fn main() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)).unwrap_or_default();
    // Sprites live in %LOCALAPPDATA%\CraftApps\SpriteCraft; the exchange folder is the one the other Craft apps share.
    let data = dirs::data_local_dir().unwrap_or_else(|| exe_dir.clone()).join("CraftApps");
    let cfg = Config {
        projects_dir: data.join("SpriteCraft").join("projects"),
        exchange_dir: data.join("exchange"),
        libraries: vec![],
        extensions_dir: None,
    };
    cfg.ensure_dirs();

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("craft", move |_ctx, request, responder| {
            let cfg = cfg.clone();
            std::thread::spawn(move || responder.respond(craft_backend::handle(&cfg, &request)));
        })
        .run(tauri::generate_context!())
        .expect("SpriteCraft failed to start");
}
