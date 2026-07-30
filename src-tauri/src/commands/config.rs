//! Configuration profile commands (FR-CFG-01 → 07).
//!
//! Real local profile persistence (FR-CFG-02): each user profile is stored as a
//! **human-readable** (pretty-printed) JSON file, one file per profile, under
//! the app config directory:
//!
//! ```text
//!   <app_config_dir>/profiles/<id>.json
//! ```
//!
//! Pretty-printing (2-space indent, stable key order from struct field order)
//! keeps the files diffable and hand-editable. A corrupt/unparseable file is
//! skipped on load — never deleted — so a single bad file can't wipe the rest
//! of the user's profiles.
//!
//! The `#[tauri::command]` wrappers only resolve the on-disk directory via the
//! `AppHandle`; all IO logic lives in free `*_to_dir` / `*_from_dir` functions
//! that take a `&Path`, so it can be unit-tested without a real `AppHandle`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// DTOs (camelCase over the wire, mirroring the TS side).
// ---------------------------------------------------------------------------

/// Radio/link settings persisted for a profile. Mirrors `ProfileSettings` in
/// `src/lib/profileSettings.ts` (10 fields). Types are intentionally loose
/// (plain scalars/strings) so any value round-trips without enforcing enums.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSettings {
    pub packet_rate: i64,
    pub telemetry_ratio: String,
    pub switch_mode: String,
    pub tx_power: i64,
    pub dynamic_power: bool,
    pub model_match: bool,
    pub model_id: i64,
    pub binding_phrase: String,
    pub antenna_mode: String,
    pub fan_threshold: i64,
}

/// Persistent shape of a `ConfigProfile`. Only the durable fields are stored;
/// transient UI state lives on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfileDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub settings: ProfileSettings,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

/// Directory holding stored profiles (`<app_config_dir>/profiles`), created if
/// absent.
fn profiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?
        .join("profiles");
    fs::create_dir_all(&dir).map_err(|e| format!("create profiles dir: {e}"))?;
    Ok(dir)
}

/// Validate a profile id and resolve it to a path inside `dir`. Rejects ids
/// that are empty or could escape the profiles directory (path separators or
/// `..`), so a malicious id can never write/read/delete outside the store.
fn profile_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() {
        return Err("profile id must not be empty".to_string());
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("invalid profile id '{id}'"));
    }
    Ok(dir.join(format!("{id}.json")))
}

// ---------------------------------------------------------------------------
// IO logic (free functions over a `&Path` dir, so they are unit-testable).
// ---------------------------------------------------------------------------

/// Write one profile as pretty-printed JSON to `<dir>/<id>.json`, overwriting
/// any existing file.
fn save_to_dir(dir: &Path, dto: &StoredProfileDto) -> Result<(), String> {
    let path = profile_path(dir, &dto.id)?;
    let json = serde_json::to_string_pretty(dto).map_err(|e| format!("serialize profile: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write {path:?}: {e}"))?;
    Ok(())
}

/// Read every `*.json` profile in `dir`. A missing directory yields an empty
/// vec; a corrupt/unparseable file is logged and skipped (never deleted) so it
/// can't fail the whole load.
fn load_from_dir(dir: &Path) -> Result<Vec<StoredProfileDto>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("read profiles dir {dir:?}: {e}"))?;
    let mut profiles: Vec<StoredProfileDto> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                tracing::warn!(target: "config", "skipping unreadable profile {path:?}: {e}");
                continue;
            }
        };
        match serde_json::from_str::<StoredProfileDto>(&raw) {
            Ok(dto) => profiles.push(dto),
            Err(e) => tracing::warn!(target: "config", "skipping corrupt profile {path:?}: {e}"),
        }
    }
    // Stable order (frontend re-sorts, but deterministic output is nicer).
    profiles.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(profiles)
}

/// Delete `<dir>/<id>.json`. Absent file is not an error (idempotent).
fn delete_from_dir(dir: &Path, id: &str) -> Result<(), String> {
    let path = profile_path(dir, id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete {path:?}: {e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands (resolve the dir, then delegate to the IO functions above).
// ---------------------------------------------------------------------------

/// Persist a profile to `<app_config_dir>/profiles/<id>.json`.
#[tauri::command]
pub fn save_profile(app: AppHandle, profile: StoredProfileDto) -> Result<(), String> {
    let dir = profiles_dir(&app)?;
    save_to_dir(&dir, &profile)
}

/// Load all stored profiles (empty vec if the profiles dir doesn't exist yet).
#[tauri::command]
pub fn load_profiles(app: AppHandle) -> Result<Vec<StoredProfileDto>, String> {
    let dir = profiles_dir(&app)?;
    load_from_dir(&dir)
}

/// Delete a stored profile by id (Ok if it was already absent).
#[tauri::command]
pub fn delete_profile(app: AppHandle, id: String) -> Result<(), String> {
    let dir = profiles_dir(&app)?;
    delete_from_dir(&dir, &id)
}

// ---------------------------------------------------------------------------
// M71 — user-owned folder sync (decision D37).
// ---------------------------------------------------------------------------

/// Folder sync: `.elrsp` file IO against ONE directory the user picked.
///
/// This is the zero-infrastructure replacement for the cloud sync deleted at
/// `3.0.0`. There is no server, no index, no manifest and no database: the
/// directory holds plain, pretty-printed `.elrsp` files whose names are the
/// profile names, so the user can open it in a file manager and understand it.
/// If the directory happens to live in Dropbox / Drive / OneDrive / Syncthing /
/// a git checkout, that tool — not OmniLink — does the syncing.
///
/// **These commands are an inlined Tauri plugin** (`folder-sync`), not app
/// commands, and that is deliberate: Tauri's ACL only gates plugin commands
/// unless the app opts its *entire* command surface into an app manifest, so
/// making these six commands plugin commands is what puts them under
/// `src-tauri/capabilities/default.json`. Nothing in this app can touch the
/// filesystem through the ACL except what that capability lists — there is no
/// `tauri-plugin-fs` in the dependency tree at all.
///
/// **The directory scope is a single runtime grant.** [`grant`] canonicalises
/// the picked directory and *replaces* the stored root; every other command
/// resolves its target inside that one root through [`resolve_in_root`], which
/// rejects separators, `..`, colons/drive prefixes, absolute paths, reserved
/// Windows device names, non-`.elrsp` names and symlinks, then re-checks
/// containment against the canonicalised root. No path ever arrives from the
/// frontend — only a bare file name.
pub mod folder_sync {
    use std::fs;
    use std::io;
    use std::path::{Component, Path, PathBuf};
    use std::sync::Mutex;
    use std::time::UNIX_EPOCH;

    use serde::Serialize;
    use tauri::State;

    /// Inlined-plugin name. Mirrored by `FOLDER_SYNC_PLUGIN` in
    /// `src/lib/tauri.ts` (the JS side invokes `plugin:folder-sync|<command>`)
    /// and by the `folder-sync:allow-*` permissions in
    /// `src-tauri/capabilities/default.json`.
    pub const PLUGIN_NAME: &str = "folder-sync";

    /// The command names this plugin exposes, in permission order. The
    /// declarations that must agree with it live in three other places —
    /// `build.rs`, `capabilities/default.json` and the `generate_handler!` list
    /// in `lib.rs` — so it exists to be asserted against them by a test rather
    /// than to be called (hence the `allow`).
    #[allow(dead_code)]
    pub const COMMANDS: [&str; 6] = ["grant", "revoke", "list", "read", "write", "delete"];

    /// The ONE file extension folder sync will ever read, write or delete.
    pub const PROFILE_EXT: &str = "elrsp";

    /// Hard cap on one profile file. A real `.elrsp` is ~1 KB; this only exists
    /// so a hostile/corrupt file in a synced folder can't be read into memory
    /// unbounded.
    pub const MAX_FILE_BYTES: u64 = 256 * 1024;

    /// Max file-name length in bytes (well under every filesystem's limit).
    const MAX_NAME_BYTES: usize = 128;

    /// Characters that can never appear in a profile file name. Rejected on
    /// EVERY platform, not just the one that would misinterpret them: `\` and
    /// `:` are inert on Linux but turn `..\x.elrsp` and `C:x.elrsp` into paths
    /// outside the root on Windows, and a folder is synced *between* machines.
    const FORBIDDEN_CHARS: [char; 9] = ['/', '\\', ':', '<', '>', '"', '|', '?', '*'];

    /// Windows reserved device names. `CON.elrsp` resolves to a device, not a
    /// file in the directory, so it never names a profile.
    const RESERVED_STEMS: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];

    // -----------------------------------------------------------------------
    // Errors — a stable code plus a detail, so the frontend can localise the
    // code (`folderSync.errors.<code>`) and still show the detail verbatim.
    // -----------------------------------------------------------------------

    #[derive(Debug, PartialEq, Eq)]
    pub enum FolderSyncError {
        /// No directory has been granted in this session.
        NotGranted,
        /// The granted path is missing, or is not a directory.
        NotADirectory(String),
        /// The file name could never name a profile in the granted directory.
        InvalidName(String),
        /// The name resolved outside the granted directory (traversal/symlink).
        OutsideRoot(String),
        /// The file is larger than [`MAX_FILE_BYTES`].
        TooLarge(u64),
        /// The path exists but is not a regular file.
        NotAFile(String),
        /// The file is not valid UTF-8 text.
        NotUtf8(String),
        /// Anything the filesystem refused.
        Io(String),
    }

    impl FolderSyncError {
        /// Stable, localisable code. Mirrored by `folderSync.errors.*`.
        pub fn code(&self) -> &'static str {
            match self {
                Self::NotGranted => "not-granted",
                Self::NotADirectory(_) => "not-a-directory",
                Self::InvalidName(_) => "invalid-name",
                Self::OutsideRoot(_) => "outside-root",
                Self::TooLarge(_) => "too-large",
                Self::NotAFile(_) => "not-a-file",
                Self::NotUtf8(_) => "not-utf8",
                Self::Io(_) => "io",
            }
        }
    }

    impl std::fmt::Display for FolderSyncError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            let detail = match self {
                Self::NotGranted => "no folder has been granted".to_string(),
                Self::NotADirectory(d)
                | Self::InvalidName(d)
                | Self::OutsideRoot(d)
                | Self::NotAFile(d)
                | Self::NotUtf8(d)
                | Self::Io(d) => d.clone(),
                Self::TooLarge(n) => format!("{n} bytes exceeds the {MAX_FILE_BYTES} byte cap"),
            };
            write!(f, "{}: {detail}", self.code())
        }
    }

    type Result<T> = std::result::Result<T, FolderSyncError>;

    fn io_err(what: &str, e: &io::Error) -> FolderSyncError {
        FolderSyncError::Io(format!("{what}: {e}"))
    }

    // -----------------------------------------------------------------------
    // DTOs (camelCase over the wire, mirroring `src/lib/tauri.ts`).
    // -----------------------------------------------------------------------

    /// The result of granting a directory: the canonical path plus how many
    /// `.elrsp` files are already in it.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FolderGrantDto {
        pub path: String,
        pub file_count: usize,
    }

    /// One `.elrsp` file in the granted directory. No id, no checksum, no
    /// manifest — the file name IS the identity.
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FolderFileDto {
        pub name: String,
        /// Last-modified time (ms since epoch), or 0 when the OS won't say.
        pub modified_at: i64,
        pub size: u64,
    }

    // -----------------------------------------------------------------------
    // The grant — exactly one directory, replaced rather than accumulated.
    // -----------------------------------------------------------------------

    /// The single user-granted directory for this session. Managed state, set
    /// only by [`grant`] (from the native directory picker's answer) and
    /// cleared by [`revoke`]. Re-granting REPLACES it, so "the granted
    /// directory" is never a growing list.
    #[derive(Default)]
    pub struct FolderSyncState {
        root: Mutex<Option<PathBuf>>,
    }

    impl FolderSyncState {
        fn root(&self) -> Result<PathBuf> {
            let guard = self
                .root
                .lock()
                .map_err(|_| FolderSyncError::Io("folder grant lock poisoned".to_string()))?;
            guard.clone().ok_or(FolderSyncError::NotGranted)
        }

        fn set(&self, root: Option<PathBuf>) -> Result<()> {
            let mut guard = self
                .root
                .lock()
                .map_err(|_| FolderSyncError::Io("folder grant lock poisoned".to_string()))?;
            *guard = root;
            Ok(())
        }
    }

    // -----------------------------------------------------------------------
    // Path guard (pure over a `&Path` root, so it is unit-testable).
    // -----------------------------------------------------------------------

    /// Strip Windows' `\\?\` verbatim prefix so a canonicalised path is still
    /// the path the user recognises when it is shown back to them.
    pub(crate) fn display_path(path: &Path) -> String {
        let s = path.to_string_lossy().to_string();
        s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
    }

    /// Reject any name that could address something other than one `.elrsp`
    /// file directly inside the granted directory.
    ///
    /// Every rule is platform-independent: a folder is synced *between*
    /// machines, so a name that is harmless on the machine that wrote it must
    /// still be refused on the machine that reads it.
    pub(crate) fn validate_file_name(name: &str) -> Result<()> {
        let invalid = |why: &str| FolderSyncError::InvalidName(format!("'{name}': {why}"));

        if name.is_empty() {
            return Err(invalid("empty name"));
        }
        if name.len() > MAX_NAME_BYTES {
            return Err(invalid("name is too long"));
        }
        if name.contains("..") {
            return Err(invalid("'..' is never allowed in a profile file name"));
        }
        if let Some(ch) = name.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
            return Err(invalid(&format!("'{ch}' is not allowed in a file name")));
        }
        if let Some(ch) = name.chars().find(|c| c.is_control()) {
            return Err(invalid(&format!(
                "control character U+{:04X} is not allowed",
                ch as u32
            )));
        }
        if name.starts_with('.') {
            return Err(invalid("a profile file name cannot start with '.'"));
        }

        let suffix = format!(".{PROFILE_EXT}");
        let stem = name
            .strip_suffix(&suffix)
            .ok_or_else(|| invalid("only .elrsp files are synced"))?;
        if stem.is_empty() {
            return Err(invalid("empty profile name"));
        }
        if stem.ends_with('.') || stem.ends_with(' ') {
            // Windows silently trims trailing dots/spaces, so "a .elrsp" and
            // "a.elrsp" would alias each other across machines.
            return Err(invalid("a profile name cannot end with '.' or a space"));
        }
        let head = stem.split('.').next().unwrap_or(stem).to_ascii_uppercase();
        if RESERVED_STEMS.contains(&head.as_str()) {
            return Err(invalid("reserved device name"));
        }

        // Belt and braces: after all of the above the name must still parse as
        // exactly ONE normal, relative path component.
        let as_path = Path::new(name);
        if as_path.is_absolute() {
            return Err(invalid("absolute paths are never a profile file name"));
        }
        let mut components = as_path.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => Ok(()),
            _ => Err(invalid("not a single path component")),
        }
    }

    /// Resolve `name` to a path inside `root`, or refuse.
    ///
    /// Guards, in order: the name rules above; the canonicalised root; that the
    /// join's parent is still exactly that root; and — for a path that already
    /// exists — that it is a regular file (never a symlink, which is how a
    /// synced folder escapes its own root) whose canonical form is still under
    /// the root. A not-yet-existing path is fine: that is a write target.
    pub(crate) fn resolve_in_root(root: &Path, name: &str) -> Result<PathBuf> {
        validate_file_name(name)?;

        let canonical_root =
            fs::canonicalize(root).map_err(|e| io_err(&format!("resolve folder {root:?}"), &e))?;
        if !canonical_root.is_dir() {
            return Err(FolderSyncError::NotADirectory(display_path(
                &canonical_root,
            )));
        }

        let path = canonical_root.join(name);
        if path.parent() != Some(canonical_root.as_path()) {
            return Err(FolderSyncError::OutsideRoot(format!(
                "'{name}' does not resolve directly inside the granted folder"
            )));
        }

        match fs::symlink_metadata(&path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(FolderSyncError::OutsideRoot(format!(
                        "'{name}' is a symlink; folder sync never follows one"
                    )));
                }
                if !meta.is_file() {
                    return Err(FolderSyncError::NotAFile(format!(
                        "'{name}' is not a regular file"
                    )));
                }
                let canonical = fs::canonicalize(&path)
                    .map_err(|e| io_err(&format!("resolve {path:?}"), &e))?;
                if !canonical.starts_with(&canonical_root) {
                    return Err(FolderSyncError::OutsideRoot(format!(
                        "'{name}' resolves outside the granted folder"
                    )));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(&format!("stat {path:?}"), &e)),
        }

        Ok(path)
    }

    // -----------------------------------------------------------------------
    // IO logic (free functions over a `&Path` root — unit-testable, mirroring
    // the `*_to_dir` / `*_from_dir` convention above).
    // -----------------------------------------------------------------------

    fn modified_millis(meta: &fs::Metadata) -> i64 {
        meta.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(0)
    }

    /// Every `.elrsp` file directly inside `root`, sorted by name.
    ///
    /// Non-`.elrsp` files, subdirectories, symlinks and anything whose name
    /// fails [`validate_file_name`] are skipped silently: the folder is the
    /// user's own, other files in it are none of our business.
    pub(crate) fn list_in_dir(root: &Path) -> Result<Vec<FolderFileDto>> {
        let entries =
            fs::read_dir(root).map_err(|e| io_err(&format!("read folder {root:?}"), &e))?;
        let mut files: Vec<FolderFileDto> = Vec::new();
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_file_name(&name).is_err() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            files.push(FolderFileDto {
                name,
                modified_at: modified_millis(&meta),
                size: meta.len(),
            });
        }
        files.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(files)
    }

    /// Read one `.elrsp` file's text. The frontend parses it with
    /// `src/lib/elrsp.ts` — the format has exactly one implementation.
    pub(crate) fn read_in_dir(root: &Path, name: &str) -> Result<String> {
        let path = resolve_in_root(root, name)?;
        let meta =
            fs::symlink_metadata(&path).map_err(|e| io_err(&format!("stat {path:?}"), &e))?;
        if meta.len() > MAX_FILE_BYTES {
            return Err(FolderSyncError::TooLarge(meta.len()));
        }
        let bytes = fs::read(&path).map_err(|e| io_err(&format!("read {path:?}"), &e))?;
        String::from_utf8(bytes)
            .map_err(|_| FolderSyncError::NotUtf8(format!("'{name}' is not UTF-8 text")))
    }

    /// Write one `.elrsp` file, overwriting it if present.
    pub(crate) fn write_in_dir(root: &Path, name: &str, contents: &str) -> Result<FolderFileDto> {
        if contents.len() as u64 > MAX_FILE_BYTES {
            return Err(FolderSyncError::TooLarge(contents.len() as u64));
        }
        let path = resolve_in_root(root, name)?;
        fs::write(&path, contents).map_err(|e| io_err(&format!("write {path:?}"), &e))?;
        let meta =
            fs::symlink_metadata(&path).map_err(|e| io_err(&format!("stat {path:?}"), &e))?;
        Ok(FolderFileDto {
            name: name.to_string(),
            modified_at: modified_millis(&meta),
            size: meta.len(),
        })
    }

    /// Delete one `.elrsp` file. An absent file is not an error (idempotent).
    pub(crate) fn delete_in_dir(root: &Path, name: &str) -> Result<()> {
        let path = resolve_in_root(root, name)?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| io_err(&format!("delete {path:?}"), &e))?;
        }
        Ok(())
    }

    /// Canonicalise + store the picked directory, replacing any prior grant.
    pub(crate) fn grant_dir(state: &FolderSyncState, dir: &Path) -> Result<FolderGrantDto> {
        let canonical =
            fs::canonicalize(dir).map_err(|e| io_err(&format!("resolve folder {dir:?}"), &e))?;
        if !canonical.is_dir() {
            return Err(FolderSyncError::NotADirectory(display_path(&canonical)));
        }
        let files = list_in_dir(&canonical)?;
        state.set(Some(canonical.clone()))?;
        Ok(FolderGrantDto {
            path: display_path(&canonical),
            file_count: files.len(),
        })
    }

    // -----------------------------------------------------------------------
    // Commands. Each resolves the granted root, then delegates above.
    //
    // Reachable ONLY because `capabilities/default.json` lists
    // `folder-sync:allow-<command>`; there is no other filesystem command in
    // the ACL, and no `tauri-plugin-fs` in the build.
    // -----------------------------------------------------------------------

    /// Grant the directory the user picked in the native dialog. Replaces any
    /// previous grant.
    #[tauri::command]
    pub fn grant(
        state: State<'_, FolderSyncState>,
        path: String,
    ) -> std::result::Result<FolderGrantDto, String> {
        grant_dir(&state, Path::new(&path)).map_err(|e| e.to_string())
    }

    /// Forget the granted directory. After this every other command refuses.
    #[tauri::command]
    pub fn revoke(state: State<'_, FolderSyncState>) -> std::result::Result<(), String> {
        state.set(None).map_err(|e| e.to_string())
    }

    /// List the `.elrsp` files in the granted directory.
    #[tauri::command]
    pub fn list(
        state: State<'_, FolderSyncState>,
    ) -> std::result::Result<Vec<FolderFileDto>, String> {
        let root = state.root().map_err(|e| e.to_string())?;
        list_in_dir(&root).map_err(|e| e.to_string())
    }

    /// Read one `.elrsp` file's text from the granted directory.
    #[tauri::command]
    pub fn read(
        state: State<'_, FolderSyncState>,
        name: String,
    ) -> std::result::Result<String, String> {
        let root = state.root().map_err(|e| e.to_string())?;
        read_in_dir(&root, &name).map_err(|e| e.to_string())
    }

    /// Write one `.elrsp` file into the granted directory.
    #[tauri::command]
    pub fn write(
        state: State<'_, FolderSyncState>,
        name: String,
        contents: String,
    ) -> std::result::Result<FolderFileDto, String> {
        let root = state.root().map_err(|e| e.to_string())?;
        write_in_dir(&root, &name, &contents).map_err(|e| e.to_string())
    }

    /// Delete one `.elrsp` file from the granted directory.
    #[tauri::command]
    pub fn delete(
        state: State<'_, FolderSyncState>,
        name: String,
    ) -> std::result::Result<(), String> {
        let root = state.root().map_err(|e| e.to_string())?;
        delete_in_dir(&root, &name).map_err(|e| e.to_string())
    }

    // -----------------------------------------------------------------------
    // Tests. The path guard is the security boundary of this feature, so every
    // refusal it makes is pinned here.
    // -----------------------------------------------------------------------

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU64, Ordering};

        fn unique_dir(tag: &str) -> PathBuf {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let dir = std::env::temp_dir().join(format!("omnilink-folder-sync-{tag}-{pid}-{n}"));
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        const SAMPLE: &str = "{\n  \"schemaVersion\": 1,\n  \"name\": \"Race\"\n}";

        // -------------------------------------------------------------------
        // Round-trip + listing.
        // -------------------------------------------------------------------

        #[test]
        fn write_then_read_is_byte_identical() {
            let dir = unique_dir("roundtrip");
            let written = write_in_dir(&dir, "Race.elrsp", SAMPLE).unwrap();
            assert_eq!(written.name, "Race.elrsp");
            assert_eq!(written.size as usize, SAMPLE.len());

            // The bytes come back exactly as they went in — no re-serialisation
            // happens on the Rust side, which is why `.elrsp` has one
            // implementation (src/lib/elrsp.ts) and not two.
            assert_eq!(read_in_dir(&dir, "Race.elrsp").unwrap(), SAMPLE);

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn list_reports_only_elrsp_files_sorted_by_name() {
            let dir = unique_dir("list");
            write_in_dir(&dir, "Zulu.elrsp", SAMPLE).unwrap();
            write_in_dir(&dir, "Alpha.elrsp", SAMPLE).unwrap();
            // Not ours: a foreign file and a subdirectory (the folder is the
            // user's own — other contents are none of our business).
            fs::write(dir.join("notes.txt"), "hello").unwrap();
            fs::write(dir.join("profile.json"), "{}").unwrap();
            fs::create_dir_all(dir.join("nested.elrsp")).unwrap();

            let files = list_in_dir(&dir).unwrap();
            let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
            assert_eq!(names, vec!["Alpha.elrsp", "Zulu.elrsp"]);

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn delete_removes_the_file_and_is_idempotent() {
            let dir = unique_dir("delete");
            write_in_dir(&dir, "Race.elrsp", SAMPLE).unwrap();
            delete_in_dir(&dir, "Race.elrsp").unwrap();
            assert!(list_in_dir(&dir).unwrap().is_empty());
            // Absent file: still Ok.
            delete_in_dir(&dir, "Race.elrsp").unwrap();

            fs::remove_dir_all(&dir).unwrap();
        }

        // -------------------------------------------------------------------
        // Path traversal — the acceptance list.
        // -------------------------------------------------------------------

        #[test]
        fn traversal_out_of_the_root_is_rejected() {
            let dir = unique_dir("traversal");

            for name in [
                "../../etc/passwd",
                "../escape.elrsp",
                "..",
                "../",
                "a/../../b.elrsp", // `..` embedded mid-path
                "sub/../../b.elrsp",
                "./x.elrsp",
                "sub/x.elrsp",
            ] {
                let err = validate_file_name(name).unwrap_err();
                assert_eq!(
                    err.code(),
                    "invalid-name",
                    "expected '{name}' to be refused as an invalid name"
                );
                assert!(resolve_in_root(&dir, name).is_err(), "resolved '{name}'");
                assert!(read_in_dir(&dir, name).is_err());
                assert!(write_in_dir(&dir, name, SAMPLE).is_err());
                assert!(delete_in_dir(&dir, name).is_err());
            }

            // Nothing was created anywhere: the directory is still empty.
            assert!(list_in_dir(&dir).unwrap().is_empty());

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn absolute_paths_are_rejected() {
            let dir = unique_dir("absolute");

            for name in [
                "/etc/passwd",
                "/tmp/escape.elrsp",
                "/escape.elrsp",
                r"C:\Windows\System32\drivers\etc\hosts",
                r"\escape.elrsp",
            ] {
                assert_eq!(validate_file_name(name).unwrap_err().code(), "invalid-name");
                assert!(write_in_dir(&dir, name, SAMPLE).is_err(), "wrote '{name}'");
            }

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn names_that_normalise_outside_the_root_on_windows_are_rejected() {
            let dir = unique_dir("windows");

            for name in [
                r"..\escape.elrsp",        // parent directory, Windows separator
                "C:escape.elrsp",          // drive-RELATIVE: resolves per-drive cwd
                r"C:\escape.elrsp",        // drive-absolute
                r"\\server\share\x.elrsp", // UNC
                r"\\?\C:\escape.elrsp",    // verbatim
                "Race.elrsp:hidden.elrsp", // NTFS alternate data stream
                "CON.elrsp",               // reserved device
                "nul.elrsp",               // reserved device, lower case
                "LPT9.elrsp",              // reserved device
                "Race .elrsp",             // trailing space is trimmed by Windows
                "Race..elrsp",             // trailing dot is trimmed by Windows
            ] {
                assert_eq!(
                    validate_file_name(name).unwrap_err().code(),
                    "invalid-name",
                    "expected '{name}' to be refused"
                );
                assert!(resolve_in_root(&dir, name).is_err(), "resolved '{name}'");
            }

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn non_elrsp_and_malformed_names_are_rejected() {
            let dir = unique_dir("malformed");

            for name in [
                "",               // empty
                ".elrsp",         // no profile name
                ".hidden.elrsp",  // dotfile
                "Race.json",      // not an .elrsp
                "Race.elrsp.bak", // not an .elrsp
                "Race.ELRSP",     // one spelling only
                "Race\0.elrsp",   // NUL byte
                "Race\n.elrsp",   // control character
                "Race<1>.elrsp",  // Windows-forbidden chars
                "Race|pipe.elrsp",
                "Race?.elrsp",
                "Race*.elrsp",
            ] {
                assert_eq!(
                    validate_file_name(name).unwrap_err().code(),
                    "invalid-name",
                    "expected '{name:?}' to be refused"
                );
                assert!(read_in_dir(&dir, name).is_err());
            }

            // Overlong name (> MAX_NAME_BYTES).
            let long = format!("{}.elrsp", "x".repeat(MAX_NAME_BYTES));
            assert_eq!(
                validate_file_name(&long).unwrap_err().code(),
                "invalid-name"
            );

            // …and a perfectly ordinary name is still accepted, so the guard is
            // not simply refusing everything.
            validate_file_name("Race 250 Hz (EU).elrsp").unwrap();
            write_in_dir(&dir, "Race 250 Hz (EU).elrsp", SAMPLE).unwrap();
            assert_eq!(list_in_dir(&dir).unwrap().len(), 1);

            fs::remove_dir_all(&dir).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn a_symlink_escaping_the_root_is_refused_for_read_write_and_delete() {
            use std::os::unix::fs::symlink;

            let dir = unique_dir("symlink");
            let outside_dir = unique_dir("symlink-outside");
            let secret = outside_dir.join("secret.elrsp");
            fs::write(&secret, "OUTSIDE").unwrap();

            // A file INSIDE the granted folder that points outside it. This is
            // the realistic escape: the folder is synced, so its contents can
            // come from another machine.
            symlink(&secret, dir.join("Race.elrsp")).unwrap();

            let read = read_in_dir(&dir, "Race.elrsp").unwrap_err();
            assert_eq!(read.code(), "outside-root");
            assert_eq!(
                write_in_dir(&dir, "Race.elrsp", SAMPLE).unwrap_err().code(),
                "outside-root"
            );
            assert_eq!(
                delete_in_dir(&dir, "Race.elrsp").unwrap_err().code(),
                "outside-root"
            );

            // The symlink target was neither read, overwritten nor deleted.
            assert_eq!(fs::read_to_string(&secret).unwrap(), "OUTSIDE");
            // …and the symlink is not listed as a profile either.
            assert!(list_in_dir(&dir).unwrap().is_empty());

            // A symlinked DIRECTORY inside the root is refused the same way.
            symlink(&outside_dir, dir.join("nested")).unwrap();
            assert!(read_in_dir(&dir, "nested/secret.elrsp").is_err());

            fs::remove_dir_all(&dir).unwrap();
            fs::remove_dir_all(&outside_dir).unwrap();
        }

        #[cfg(unix)]
        #[test]
        fn a_symlinked_root_is_resolved_and_still_contains_its_files() {
            use std::os::unix::fs::symlink;

            // The user is allowed to pick a symlinked folder (~/Dropbox is often
            // one). The grant canonicalises it, so files inside it still resolve.
            let real = unique_dir("symlink-root-real");
            let link = std::env::temp_dir().join(format!(
                "omnilink-folder-sync-symlink-root-{}",
                std::process::id()
            ));
            let _ = fs::remove_file(&link);
            symlink(&real, &link).unwrap();

            write_in_dir(&link, "Race.elrsp", SAMPLE).unwrap();
            assert_eq!(read_in_dir(&link, "Race.elrsp").unwrap(), SAMPLE);
            assert!(real.join("Race.elrsp").exists());

            fs::remove_file(&link).unwrap();
            fs::remove_dir_all(&real).unwrap();
        }

        // -------------------------------------------------------------------
        // Size caps + text handling.
        // -------------------------------------------------------------------

        #[test]
        fn oversize_content_is_refused_on_write_and_on_read() {
            let dir = unique_dir("oversize");

            let huge = "x".repeat(MAX_FILE_BYTES as usize + 1);
            assert_eq!(
                write_in_dir(&dir, "Race.elrsp", &huge).unwrap_err().code(),
                "too-large"
            );
            assert!(!dir.join("Race.elrsp").exists());

            // A file that got there some other way (the folder is synced) is
            // refused on read rather than pulled into memory.
            fs::write(dir.join("Big.elrsp"), &huge).unwrap();
            assert_eq!(
                read_in_dir(&dir, "Big.elrsp").unwrap_err().code(),
                "too-large"
            );

            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn non_utf8_content_is_refused_rather_than_lossily_decoded() {
            let dir = unique_dir("utf8");
            fs::write(dir.join("Race.elrsp"), [0xff, 0xfe, 0x00, 0x01]).unwrap();
            assert_eq!(
                read_in_dir(&dir, "Race.elrsp").unwrap_err().code(),
                "not-utf8"
            );
            fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn a_missing_folder_is_an_error_not_a_silent_empty_list() {
            let dir = std::env::temp_dir().join("omnilink-folder-sync-never-created");
            assert!(!dir.exists());
            assert_eq!(list_in_dir(&dir).unwrap_err().code(), "io");
            assert_eq!(read_in_dir(&dir, "Race.elrsp").unwrap_err().code(), "io");
        }

        // -------------------------------------------------------------------
        // The grant itself.
        // -------------------------------------------------------------------

        #[test]
        fn nothing_is_reachable_before_a_grant() {
            let state = FolderSyncState::default();
            assert_eq!(state.root().unwrap_err(), FolderSyncError::NotGranted);
            assert_eq!(state.root().unwrap_err().code(), "not-granted");
        }

        #[test]
        fn granting_replaces_the_previous_folder_it_never_accumulates() {
            let first = unique_dir("grant-first");
            let second = unique_dir("grant-second");
            write_in_dir(&first, "OnlyInFirst.elrsp", SAMPLE).unwrap();
            write_in_dir(&second, "OnlyInSecond.elrsp", SAMPLE).unwrap();

            let state = FolderSyncState::default();
            let a = grant_dir(&state, &first).unwrap();
            assert_eq!(a.file_count, 1);
            assert_eq!(state.root().unwrap(), fs::canonicalize(&first).unwrap());

            let b = grant_dir(&state, &second).unwrap();
            assert_eq!(b.file_count, 1);
            // The ONE root is now the second folder. The first is unreachable —
            // this is what "scoped to the granted directory" means here.
            let root = state.root().unwrap();
            assert_eq!(root, fs::canonicalize(&second).unwrap());
            let names: Vec<String> = list_in_dir(&root)
                .unwrap()
                .into_iter()
                .map(|f| f.name)
                .collect();
            assert_eq!(names, vec!["OnlyInSecond.elrsp"]);

            // Revoking leaves nothing reachable at all.
            state.set(None).unwrap();
            assert_eq!(state.root().unwrap_err(), FolderSyncError::NotGranted);

            fs::remove_dir_all(&first).unwrap();
            fs::remove_dir_all(&second).unwrap();
        }

        #[test]
        fn granting_a_file_or_a_missing_path_is_refused() {
            let dir = unique_dir("grant-bad");
            let file = dir.join("Race.elrsp");
            fs::write(&file, SAMPLE).unwrap();

            let state = FolderSyncState::default();
            // A file is not a directory (canonicalize succeeds, is_dir does not).
            assert_eq!(
                grant_dir(&state, &file).unwrap_err().code(),
                "not-a-directory"
            );
            // A path that does not exist cannot be canonicalised.
            assert_eq!(
                grant_dir(&state, &dir.join("nope")).unwrap_err().code(),
                "io"
            );
            // Neither attempt granted anything.
            assert_eq!(state.root().unwrap_err(), FolderSyncError::NotGranted);

            fs::remove_dir_all(&dir).unwrap();
        }

        // -------------------------------------------------------------------
        // Contract with the rest of the app.
        // -------------------------------------------------------------------

        #[test]
        fn error_codes_are_stable_and_prefix_the_message() {
            // The frontend localises `folderSync.errors.<code>` from the prefix
            // before the first ':', so these strings are a contract.
            assert_eq!(FolderSyncError::NotGranted.code(), "not-granted");
            assert_eq!(
                FolderSyncError::NotADirectory("d".into()).code(),
                "not-a-directory"
            );
            assert_eq!(
                FolderSyncError::InvalidName("n".into()).code(),
                "invalid-name"
            );
            assert_eq!(
                FolderSyncError::OutsideRoot("n".into()).code(),
                "outside-root"
            );
            assert_eq!(FolderSyncError::TooLarge(1).code(), "too-large");
            assert_eq!(FolderSyncError::NotAFile("n".into()).code(), "not-a-file");
            assert_eq!(FolderSyncError::NotUtf8("n".into()).code(), "not-utf8");
            assert_eq!(FolderSyncError::Io("n".into()).code(), "io");

            let rendered = FolderSyncError::InvalidName("'x': nope".into()).to_string();
            assert!(rendered.starts_with("invalid-name: "), "{rendered}");
        }

        #[test]
        fn display_path_strips_the_windows_verbatim_prefix() {
            assert_eq!(
                display_path(Path::new(r"\\?\C:\Users\pilot\Dropbox\OmniLink")),
                r"C:\Users\pilot\Dropbox\OmniLink"
            );
            assert_eq!(
                display_path(Path::new("/home/pilot/Dropbox/OmniLink")),
                "/home/pilot/Dropbox/OmniLink"
            );
        }

        #[test]
        fn the_capability_grants_exactly_these_commands_and_nothing_filesystem_wide() {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"));
            let capability = fs::read_to_string(root.join("capabilities/default.json")).unwrap();

            // Every command this plugin exposes is ACL-granted...
            for command in COMMANDS {
                let permission = format!("{PLUGIN_NAME}:allow-{command}");
                assert!(
                    capability.contains(&permission),
                    "capabilities/default.json is missing '{permission}'"
                );
            }
            // ...and the build declares the same set, so the permissions the
            // capability names actually exist (tauri-build validates this too,
            // but a mismatch should fail here rather than only in a full build).
            let build = fs::read_to_string(root.join("build.rs")).unwrap();
            for command in COMMANDS {
                assert!(
                    build.contains(&format!("\"{command}\"")),
                    "build.rs does not declare the '{command}' command"
                );
            }

            // The ACL carries no general filesystem grant: `tauri-plugin-fs` is
            // not a dependency, so folder sync is the only filesystem reach the
            // webview has, and it is confined to the six commands above.
            assert!(!capability.contains("\"fs:"));
            let cargo_toml = fs::read_to_string(root.join("Cargo.toml")).unwrap();
            assert!(!cargo_toml.contains("tauri-plugin-fs"));
        }

        #[test]
        fn folder_sync_cannot_reach_the_network() {
            // NFR (offline-first, project policy §8): folder sync is
            // filesystem-only. `commands/config.rs` is its whole Rust surface,
            // so a network client appearing anywhere in this file is the
            // regression to catch.
            //
            // Each needle is assembled with `concat!` so that this test's own
            // source text cannot satisfy the search it performs.
            let source = fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/config.rs"),
            )
            .unwrap();

            // Anti-tautology control: the search DOES find what is really here.
            assert!(source.contains(concat!("std", "::fs")));

            for forbidden in [
                concat!("req", "west"),
                concat!("ur", "eq"),
                concat!("Tcp", "Stream"),
                concat!("Udp", "Socket"),
                concat!("http", "://"),
                concat!("https", "://"),
                concat!("to_socket", "_addrs"),
            ] {
                assert!(
                    !source.contains(forbidden),
                    "commands/config.rs mentions '{forbidden}' — folder sync must never call out"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A unique temp dir per test, to avoid cross-test collisions.
    fn unique_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        std::env::temp_dir().join(format!("omnilink-config-test-{tag}-{pid}-{n}"))
    }

    fn sample(id: &str) -> StoredProfileDto {
        StoredProfileDto {
            id: id.to_string(),
            name: format!("Profile {id}"),
            description: Some("a test profile".to_string()),
            settings: ProfileSettings {
                packet_rate: 500,
                telemetry_ratio: "1:128".to_string(),
                switch_mode: "Hybrid".to_string(),
                tx_power: 100,
                dynamic_power: true,
                model_match: false,
                model_id: 7,
                binding_phrase: "my-quad".to_string(),
                antenna_mode: "Diversity".to_string(),
                fan_threshold: 250,
            },
            updated_at: 1_700_000_000,
        }
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = unique_dir("roundtrip");
        fs::create_dir_all(&dir).unwrap();

        save_to_dir(&dir, &sample("alpha")).unwrap();
        save_to_dir(&dir, &sample("bravo")).unwrap();

        let loaded = load_from_dir(&dir).unwrap();
        assert_eq!(loaded.len(), 2);
        // sorted by id -> alpha, bravo
        assert_eq!(loaded[0].id, "alpha");
        assert_eq!(loaded[1].id, "bravo");
        assert_eq!(loaded[0].name, "Profile alpha");
        assert_eq!(loaded[0].description.as_deref(), Some("a test profile"));
        assert_eq!(loaded[0].settings.packet_rate, 500);
        assert_eq!(loaded[0].settings.telemetry_ratio, "1:128");
        assert!(loaded[0].settings.dynamic_power);
        assert_eq!(loaded[0].updated_at, 1_700_000_000);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_removes_one() {
        let dir = unique_dir("delete");
        fs::create_dir_all(&dir).unwrap();

        save_to_dir(&dir, &sample("alpha")).unwrap();
        save_to_dir(&dir, &sample("bravo")).unwrap();
        delete_from_dir(&dir, "alpha").unwrap();

        let loaded = load_from_dir(&dir).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "bravo");

        // Deleting an absent id is Ok (idempotent).
        delete_from_dir(&dir, "alpha").unwrap();

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_absent_dir_is_empty() {
        let dir = unique_dir("absent");
        // Deliberately do NOT create it.
        assert!(!dir.exists());
        let loaded = load_from_dir(&dir).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn corrupt_file_is_skipped_not_deleted() {
        let dir = unique_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();

        save_to_dir(&dir, &sample("good")).unwrap();
        let bad = dir.join("bad.json");
        fs::write(&bad, "{ this is not valid json ]").unwrap();

        let loaded = load_from_dir(&dir).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "good");
        // The garbage file must still be on disk — we never delete user data.
        assert!(bad.exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn output_is_human_readable_pretty() {
        let dir = unique_dir("pretty");
        fs::create_dir_all(&dir).unwrap();

        save_to_dir(&dir, &sample("alpha")).unwrap();
        let raw = fs::read_to_string(dir.join("alpha.json")).unwrap();

        // Pretty-printed: newlines plus 2-space indentation.
        assert!(raw.contains('\n'), "expected newlines in pretty output");
        assert!(
            raw.contains("\n  "),
            "expected 2-space indentation in pretty output"
        );
        // And it must be camelCase on the wire.
        assert!(raw.contains("\"packetRate\""));
        assert!(raw.contains("\"updatedAt\""));

        // Provably matches serde's pretty formatter (2-space indent).
        let expected = serde_json::to_string_pretty(&sample("alpha")).unwrap();
        assert_eq!(raw, expected);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn id_sanitization_rejects_traversal() {
        let dir = unique_dir("sanitize");
        fs::create_dir_all(&dir).unwrap();

        assert!(profile_path(&dir, "../escape").is_err());
        assert!(profile_path(&dir, "a/b").is_err());
        assert!(profile_path(&dir, "a\\b").is_err());
        assert!(profile_path(&dir, "..").is_err());
        assert!(profile_path(&dir, "").is_err());
        // A normal id is accepted.
        assert!(profile_path(&dir, "normal-id").is_ok());

        // The same guard applies through save/delete.
        let mut evil = sample("ok");
        evil.id = "../escape".to_string();
        assert!(save_to_dir(&dir, &evil).is_err());
        assert!(delete_from_dir(&dir, "../escape").is_err());

        fs::remove_dir_all(&dir).unwrap();
    }
}
