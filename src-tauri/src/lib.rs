// SPDX-License-Identifier: GPL-3.0-or-later
// OmniLink — Tauri backend
// Per SRS §4.2: commands/, crsf/, platformio/, db/

mod commands;
mod crsf;
mod db;
mod flash;
mod logging;
mod platformio;

use commands::ai::{
    ai_clear_api_key, ai_has_api_key, ai_list_models, ai_preview_payload, ai_send_message,
    ai_set_api_key, delete_all_api_keys,
};
use commands::bridge::{fetch_bridge_context, probe_bridge, run_passthrough_check};
use commands::config::folder_sync;
use commands::config::{delete_profile, load_profiles, save_profile};
use commands::device::{connect_device, disconnect_device, list_serial_ports, DeviceManager};
use commands::flash::{
    cancel_flash, delete_all_backups, derive_uid, fetch_firmware_releases, open_backups_dir,
    start_flash, FlashManager,
};
use commands::knowledge::knowledge_read_doc;
use commands::logs::{cancel_blackbox_decode, decode_blackbox_log, LogDecodeManager};
use commands::tiles::{
    cancel_tile_pack_download, delete_tile_pack, download_tile_pack, list_tile_packs, serve_tile,
    TileManager,
};
use commands::wifi::{probe_wifi_device, start_wifi_scan, stop_wifi_scan, WifiManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // M10 (NFR-LOG-03): capture panics to the log + stderr as early as possible,
    // before the Tauri builder does any work, so even a crash during startup
    // leaves a record. The subscriber itself is installed in `.setup(...)` below,
    // once the app handle (and thus the log directory) is available.
    logging::install_panic_hook();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // M25: native file dialogs — the firmware wizard's "Select local .bin
        // file" option calls the JS `@tauri-apps/plugin-dialog` `open()`, which
        // is served by this plugin (gated by the `dialog:default` capability).
        // M71 reuses the same plugin for the folder picker (`directory: true`).
        .plugin(tauri_plugin_dialog::init())
        // M71 (folder sync, decision D37): the `.elrsp` file IO against the ONE
        // directory the user picked. Registered as an INLINED plugin (declared
        // in `build.rs`) rather than as app commands, because Tauri's ACL only
        // gates plugin commands — this is what makes each command reachable
        // only via its `folder-sync:allow-*` permission in
        // `capabilities/default.json`. The granted directory itself lives in
        // `FolderSyncState` and is replaced, never accumulated.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new(folder_sync::PLUGIN_NAME)
                .setup(|app, _api| {
                    tauri::Manager::manage(app, folder_sync::FolderSyncState::default());
                    Ok(())
                })
                .invoke_handler(tauri::generate_handler![
                    folder_sync::grant,
                    folder_sync::revoke,
                    folder_sync::list,
                    folder_sync::read,
                    folder_sync::write,
                    folder_sync::delete
                ])
                .build(),
        )
        // M12: serve offline map tiles to MapLibre from the local `.ompack`
        // store via the `omnitiles://` custom scheme. The frontend requests
        // `omnitiles://tiles/{z}/{x}/{y}.png`; the host+path is passed to
        // `serve_tile`, which resolves the tile across downloaded packs + the
        // bundled base set (or a transparent blank where coverage is missing).
        .register_uri_scheme_protocol("omnitiles", |ctx, request| {
            let app = ctx.app_handle();
            // The request URI host is `tiles`; include it so paths like
            // `omnitiles://tiles/3/4/2.png` resolve identically to the Windows
            // `http://omnitiles.localhost/tiles/3/4/2.png` form.
            let uri = request.uri();
            let lookup = format!("{}{}", uri.host().unwrap_or(""), uri.path());
            let (status, body) = serve_tile(app, &lookup);
            tauri::http::Response::builder()
                .status(status)
                .header("Content-Type", "image/png")
                .header("Access-Control-Allow-Origin", "*")
                .body(body)
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap()
                })
        });

    // In-app self-update. The updater + process plugins are desktop-only
    // (mobile has its own store-driven update path), so register them behind a
    // desktop cfg. The JS side (Settings -> "App Update") drives check ->
    // downloadAndInstall -> relaunch through these plugins.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        // M7-API: SQLite persistence for telemetry. Migrations run at build
        // time so the `telemetry` table exists before the first write.
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::TELEMETRY_DB_URL, db::migrations())
                .build(),
        )
        .manage(DeviceManager::default())
        .manage(FlashManager::default())
        .manage(TileManager::default())
        .manage(LogDecodeManager::default())
        .manage(WifiManager::default())
        // M30 (BYOK keychain): best-effort startup migration of any legacy
        // plaintext `ai_keys.json` into the OS keychain. Runs on a detached
        // thread so the blocking keychain I/O never stalls or panics setup; when
        // no secret service is reachable (headless/no-daemon) it NO-OPs and
        // leaves the 0600 file intact as the fallback. Never logs a key.
        .setup(|app| {
            // M10 (NFR-LOG-01/02): install the structured logging subscriber now
            // that the app handle can resolve the platform log directory. Writes
            // to a daily-rotating file there plus stderr; keeps its flush-thread
            // guard alive in a module static (see `logging`).
            logging::init(app.handle());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::secret_store::migrate_legacy_file_keys(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            connect_device,
            disconnect_device,
            fetch_firmware_releases,
            derive_uid,
            start_flash,
            cancel_flash,
            delete_all_backups,
            open_backups_dir,
            ai_send_message,
            ai_list_models,
            ai_set_api_key,
            ai_clear_api_key,
            ai_has_api_key,
            delete_all_api_keys,
            ai_preview_payload,
            knowledge_read_doc,
            list_tile_packs,
            download_tile_pack,
            cancel_tile_pack_download,
            delete_tile_pack,
            decode_blackbox_log,
            cancel_blackbox_decode,
            save_profile,
            load_profiles,
            delete_profile,
            start_wifi_scan,
            stop_wifi_scan,
            probe_wifi_device,
            probe_bridge,
            run_passthrough_check,
            fetch_bridge_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
