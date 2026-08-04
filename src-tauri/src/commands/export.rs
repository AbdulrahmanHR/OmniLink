//! v3.0.3 defect 1: saving an export to a file the **user** picked.
//!
//! Three surfaces export a document — Settings → "Export my data", a recorded
//! session's CSV, and a profile's `.elrsp`. All three were written with the
//! browser idiom: build a `Blob`, mint an object URL, click a synthetic
//! `<a download>`. Chromium routes that through its download manager. **The
//! shipped webview does not.** On WebKitGTK 2.52.3 the packaged AppImage wrote
//! the bundle straight into the process's current working directory — no save
//! dialog, no confirmation, no reveal-in-folder. On a normally installed app
//! that cwd is `/` or `$HOME`, so the file was, from the user's side, gone; on
//! an unwritable cwd it would have failed with nothing said.
//!
//! ## Why the dialog is opened HERE and not in the frontend
//!
//! `@tauri-apps/plugin-dialog` exposes `save()` to JS, so the obvious shape is
//! "pick the path in TS, then hand it to a Rust `write_file(path, contents)`".
//! That shape would give the webview a command that writes **any** path it
//! names, which is exactly the reach `capabilities/default.json` argues this
//! application does not have: the six `folder-sync:allow-*` permissions are its
//! only filesystem grant, `tauri-plugin-fs` is deliberately not registered, and
//! app-level commands (unlike plugin commands) are not ACL-gated at all — so
//! such a command would be a filesystem hole opened *outside* the ACL that
//! documents the app's reach.
//!
//! Opening the dialog inside the same command closes that: the only path this
//! command can ever write is one the user chose in a native dialog during this
//! very call. The frontend supplies the bytes and the (localized) dialog copy,
//! never a destination. It also removes the gap between "path picked" and "path
//! written" in which the target could change.
//!
//! Cancel is `Ok(None)` — a normal outcome, not an error. A genuine write
//! failure is `Err(detail)`, which the UI shows verbatim under a localized
//! heading (mirroring how folder-sync surfaces its own IO detail).

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// One export request. Field names arrive camelCased from `src/lib/tauri.ts`.
///
/// Every user-facing string (`title`, `filter_name`, `default_name`) comes from
/// the frontend, because that is where i18n lives — the backend holds no copy.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileRequest {
    /// Native dialog title, already localized.
    pub title: String,
    /// Suggested file name, already localized and stamped.
    pub default_name: String,
    /// Localized name of the file-type filter (e.g. "JSON file").
    pub filter_name: String,
    /// Extensions for that filter, without dots (e.g. `["json"]`).
    pub extensions: Vec<String>,
    /// The document to write, UTF-8.
    pub contents: String,
}

/// Reduce a suggested file name to a bare, single-segment name.
///
/// The suggestion is interpolated from user-controlled text — a profile is
/// named by its owner and `profiles.export.filename` is `{{name}}.elrsp` — so a
/// name containing `/` (or a NUL) would otherwise reach the dialog as a *path*,
/// quietly relocating the default destination. Directory separators and control
/// characters become `_`; a name with nothing usable left falls back to
/// `fallback`.
///
/// This is a suggestion-hygiene measure, not a security boundary: the user
/// still confirms the real destination in the dialog.
fn sanitize_file_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Show a native save dialog, then write `contents` to the chosen file.
///
/// * `Ok(Some(path))` — written; `path` is what the UI reports back to the user.
/// * `Ok(None)` — the user dismissed the dialog. Nothing was written.
/// * `Err(detail)` — the write (or the path conversion) failed.
///
/// `async` on purpose: Tauri runs `async` commands off the main thread, which is
/// the documented requirement for `blocking_save_file` (the non-blocking form
/// would need a callback the IPC reply cannot wait on).
#[tauri::command]
pub async fn save_export_file(
    app: AppHandle,
    request: ExportFileRequest,
) -> Result<Option<String>, String> {
    let ExportFileRequest {
        title,
        default_name,
        filter_name,
        extensions,
        contents,
    } = request;

    let file_name = sanitize_file_name(&default_name, "omnilink-export");
    let mut dialog = app
        .dialog()
        .file()
        .set_title(&title)
        .set_file_name(&file_name);

    // Filters are advisory; an empty list is valid (no type restriction).
    let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
    if !exts.is_empty() {
        dialog = dialog.add_filter(&filter_name, &exts);
    }

    // Start somewhere the user expects rather than wherever the process happens
    // to be — the cwd being an arbitrary directory is what made this defect
    // invisible in the first place.
    if let Ok(dir) = app.path().download_dir() {
        dialog = dialog.set_directory(dir);
    } else if let Ok(dir) = app.path().home_dir() {
        dialog = dialog.set_directory(dir);
    }

    // Parent the dialog to the main window so it is modal to the app and cannot
    // be lost behind it.
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };

    let path = picked
        .into_path()
        .map_err(|e| format!("could not resolve the chosen path: {e}"))?;
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::sanitize_file_name;

    #[test]
    fn keeps_an_ordinary_name_intact() {
        assert_eq!(
            sanitize_file_name("omnilink-data-export-2026-08-04_12-00-00.json", "fb"),
            "omnilink-data-export-2026-08-04_12-00-00.json"
        );
        assert_eq!(sanitize_file_name("Race 250.elrsp", "fb"), "Race 250.elrsp");
    }

    #[test]
    fn flattens_separators_so_a_suggestion_is_never_a_path() {
        assert_eq!(
            sanitize_file_name("../../etc/passwd.elrsp", "fb"),
            ".._.._etc_passwd.elrsp"
        );
        assert_eq!(
            sanitize_file_name("C:\\Windows\\evil.elrsp", "fb"),
            "C__Windows_evil.elrsp"
        );
    }

    #[test]
    fn strips_control_characters() {
        assert_eq!(sanitize_file_name("na\u{0}me\n.json", "fb"), "na_me_.json");
    }

    #[test]
    fn falls_back_when_nothing_usable_remains() {
        assert_eq!(sanitize_file_name("", "omnilink-export"), "omnilink-export");
        assert_eq!(
            sanitize_file_name("   ", "omnilink-export"),
            "omnilink-export"
        );
        assert_eq!(
            sanitize_file_name("...", "omnilink-export"),
            "omnilink-export"
        );
    }
}
