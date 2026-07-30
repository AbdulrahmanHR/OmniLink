fn main() {
    // M71 (folder sync, decision D37): `folder-sync` is an INLINED plugin — its
    // commands live in `src/commands/config.rs` and are registered from
    // `src/lib.rs`, but declaring them here is what puts them under Tauri's
    // access-control list. Tauri only ACL-checks plugin commands (and core
    // commands) unless an app opts its ENTIRE command surface into an app
    // manifest, so this is how the six filesystem commands become reachable
    // only because `capabilities/default.json` names them, one permission at a
    // time. `commands(...)` autogenerates the `allow-<command>` /
    // `deny-<command>` permissions into OUT_DIR (nothing lands in the source
    // tree), and tauri-build fails the build when a capability names a
    // permission that does not exist.
    //
    // Keep this list in sync with `folder_sync::COMMANDS` — a test asserts it.
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "folder-sync",
            tauri_build::InlinedPlugin::new()
                .commands(&["grant", "revoke", "list", "read", "write", "delete"]),
        ),
    )
    .expect("failed to run tauri-build");
}
