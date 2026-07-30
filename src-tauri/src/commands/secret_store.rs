//! Backend-only secret storage for BYOK API keys (closes the PHASE-2 keychain
//! TODO; doc M30).
//!
//! Keys are kept OUT of the webview and read only at request time — no command
//! ever returns a key to the frontend (only booleans / opaque results leave the
//! backend). This module abstracts *where* the bytes live behind a small
//! [`SecretStore`] trait so the storage backend can vary without touching the
//! command handlers:
//!
//! * [`KeychainStore`] — the OS secret store via the `keyring` crate (pure-Rust
//!   Secret Service over zbus on Linux, native Keychain on macOS, native
//!   Credential Manager on Windows). One credential per key slot, service
//!   `"omnilink"`.
//! * [`FileStore`] — the legacy `0600` plaintext-JSON `ai_keys.json` under the
//!   app data dir. Kept VERBATIM as the guaranteed fallback for headless /
//!   no-daemon environments (CI, WSL) where no secret service is reachable.
//! * [`KeychainFirstStore`] — the composite the commands actually use: reads
//!   keychain-first (falling through to the file), writes to the keychain and
//!   purges any lingering plaintext file copy on success, and only falls back to
//!   the `0600` file when the keychain write fails.
//!
//! On real desktops with a running secret service this means **no plaintext key
//! at rest**; on headless/no-daemon boxes the keychain calls return a catchable
//! `Err` and everything degrades to the exact `0600`-file behavior of before, so
//! there is no regression and `cargo build`/`cargo test` stay green without a
//! secret service.
//!
//! NOTE: keyring's synchronous `Entry` blocks internally on the async
//! Secret-Service backend. Calling it directly from inside a `tokio` async task
//! (e.g. the async `ai_send_message` / `ai_list_models` commands) risks a
//! "cannot start a runtime from within a runtime" panic, so those call sites
//! route the store access through `tokio::task::spawn_blocking`. The synchronous
//! CRUD commands call the store directly.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use keyring::{Entry, Error as KeyringError};
use tauri::{AppHandle, Manager};

/// The OS-keychain service name every OmniLink credential is stored under. The
/// per-key "account"/user is the key slot id (see `key_slot` in `ai.rs`).
const KEYCHAIN_SERVICE: &str = "omnilink";

// ---------------------------------------------------------------------------
// The storage seam.
// ---------------------------------------------------------------------------

/// Backend-only key storage. Implementors persist opaque secret strings keyed by
/// a slot id. Errors are surfaced as human-readable strings that **must never**
/// contain a raw key (keyring's own error Display does not embed the secret).
pub trait SecretStore {
    /// Read the key stored in `slot`, or `None` if there is none / it can't be
    /// read (a keychain read error is treated as "not here" so reads can fall
    /// through to the next store).
    fn get(&self, slot: &str) -> Option<String>;
    /// Store (or overwrite) the key in `slot`.
    fn set(&self, slot: &str, key: &str) -> Result<(), String>;
    /// Remove the key in `slot` (a missing slot is not an error).
    fn delete(&self, slot: &str) -> Result<(), String>;
    /// Whether a non-empty key exists in `slot`.
    fn has(&self, slot: &str) -> bool {
        self.get(slot).map(|k| !k.is_empty()).unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------
// FileStore — the legacy 0600 JSON store, kept verbatim as the fallback.
// ---------------------------------------------------------------------------

/// Path to the backend-only key file (`ai_keys.json` under the app data dir),
/// creating the directory if needed. This is the same resolution the pre-M30
/// store used.
pub fn keys_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create app data dir: {e}"))?;
    Ok(dir.join("ai_keys.json"))
}

/// Read the whole `slot -> key` map from the plaintext file (empty map when the
/// file is absent or unreadable). Kept VERBATIM from the pre-M30 `read_keys`.
fn read_keys(path: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Serialize the map back and lock it down to owner-only (`0600`) on Unix. Kept
/// VERBATIM from the pre-M30 `write_keys`.
fn write_keys(path: &Path, keys: &BTreeMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Could not save key: {e}"))?;
    // Best-effort lock-down to owner-only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The `0600` plaintext-JSON store. Wraps [`read_keys`]/[`write_keys`] with a
/// resolved path. `None` path means the app data dir could not be resolved —
/// reads yield nothing and writes error, mirroring the pre-M30 behavior.
pub struct FileStore {
    path: Option<PathBuf>,
}

impl FileStore {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self { path }
    }

    fn path(&self) -> Result<&PathBuf, String> {
        self.path
            .as_ref()
            .ok_or_else(|| "Could not resolve key storage path".to_string())
    }
}

impl SecretStore for FileStore {
    fn get(&self, slot: &str) -> Option<String> {
        let path = self.path.as_ref()?;
        read_keys(path).remove(slot)
    }

    fn set(&self, slot: &str, key: &str) -> Result<(), String> {
        let path = self.path()?;
        let mut keys = read_keys(path);
        keys.insert(slot.to_string(), key.to_string());
        write_keys(path, &keys)
    }

    fn delete(&self, slot: &str) -> Result<(), String> {
        let path = self.path()?;
        // Nothing to purge (and don't create an empty plaintext file just to
        // "clear" a slot that was never written to disk).
        if !path.exists() {
            return Ok(());
        }
        let mut keys = read_keys(path);
        keys.remove(slot);
        write_keys(path, &keys)
    }
}

// ---------------------------------------------------------------------------
// KeychainStore — the OS secret store via keyring.
// ---------------------------------------------------------------------------

/// One credential per slot in the OS secret store (`keyring`), under the
/// `"omnilink"` service. On headless / no-daemon boxes every op returns a
/// catchable `Err` (never panics), so the composite can fall back to the file.
pub struct KeychainStore;

impl KeychainStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, slot: &str) -> Result<Entry, KeyringError> {
        Entry::new(KEYCHAIN_SERVICE, slot)
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, slot: &str) -> Option<String> {
        // Treat ANY error (NoEntry, or a headless PlatformFailure/NoStorageAccess)
        // as "not here" so the composite read falls through to the file.
        match self.entry(slot) {
            Ok(entry) => entry.get_password().ok(),
            Err(_) => None,
        }
    }

    fn set(&self, slot: &str, key: &str) -> Result<(), String> {
        // keyring's error Display never embeds the secret, so this is safe to
        // surface / log.
        self.entry(slot)
            .and_then(|entry| entry.set_password(key))
            .map_err(|e| e.to_string())
    }

    fn delete(&self, slot: &str) -> Result<(), String> {
        let entry = self.entry(slot).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// KeychainFirstStore — the composite the commands use.
// ---------------------------------------------------------------------------

/// Keychain-first with a `0600`-file fallback.
///
/// * `get`: keychain, falling through to the file when the keychain has nothing
///   (read-only, no side effects).
/// * `set`: keychain; on success ALSO purge the file slot so no plaintext copy
///   lingers for keys saved after M30; on keychain failure, write the `0600`
///   file fallback.
/// * `delete`: best-effort remove from both.
/// * `has`: keychain OR file.
pub struct KeychainFirstStore<K: SecretStore, F: SecretStore> {
    pub keychain: K,
    pub file: F,
}

impl<K: SecretStore, F: SecretStore> SecretStore for KeychainFirstStore<K, F> {
    fn get(&self, slot: &str) -> Option<String> {
        match self.keychain.get(slot) {
            Some(k) if !k.is_empty() => Some(k),
            _ => self.file.get(slot),
        }
    }

    fn set(&self, slot: &str, key: &str) -> Result<(), String> {
        match self.keychain.set(slot, key) {
            Ok(()) => {
                // Best-effort: drop any lingering plaintext copy of this slot.
                let _ = self.file.delete(slot);
                Ok(())
            }
            // Keychain unavailable (headless / no-daemon): keep working via the
            // 0600 file exactly as before M30.
            Err(_) => self.file.set(slot, key),
        }
    }

    fn delete(&self, slot: &str) -> Result<(), String> {
        // Attempt both regardless.
        let keychain = self.keychain.delete(slot);
        let file = self.file.delete(slot);
        match keychain {
            // Keychain slot cleared: propagate the file result.
            Ok(()) => file,
            // Keychain delete FAILED and the secret is STILL there (e.g. locked
            // session / NoStorageAccess): surface the real failure. Masking it
            // with a file no-op `Ok` would tell the UI "cleared" while the key
            // is still in the keychain and would be re-read and sent.
            Err(e) if self.keychain.has(slot) => Err(e),
            // Keychain had nothing / is unavailable (headless): the file governs.
            Err(_) => file,
        }
    }

    fn has(&self, slot: &str) -> bool {
        self.keychain.has(slot) || self.file.has(slot)
    }
}

/// The store the commands use: keychain-first with the `0600` file as fallback.
pub fn secret_store(app: &AppHandle) -> KeychainFirstStore<KeychainStore, FileStore> {
    KeychainFirstStore {
        keychain: KeychainStore::new(),
        file: FileStore::new(keys_path(app).ok()),
    }
}

// ---------------------------------------------------------------------------
// Wholesale erase — "Delete all my data" (NFR-PRIV-02).
// ---------------------------------------------------------------------------

/// Wholesale-clear EVERY file-backed BYOK key plus each known keychain slot, for
/// the GDPR-style "Delete all my data" erase. Pure over a `&Path` + a
/// [`SecretStore`] keychain seam so it is unit-testable without a real
/// `AppHandle`. Two steps:
///
///  1. Delete `ai_keys.json` **outright** — this drops every file-backed slot at
///     once, INCLUDING orphans referenced nowhere after the legacy
///     multi-config→single-credential migration (the common headless/WSL
///     fallback, where keys live in the file).
///  2. Best-effort clear each known keychain slot in `slots` (the per-provider
///     default slots plus any `keyId`s the frontend still knows about). A
///     locked/headless keychain-delete failure is ignored so it can't abort the
///     wipe.
///
/// LIMITATION: a keychain-ONLY slot whose id is NOT in `slots` (e.g. a legacy
/// slot migrated into the OS keychain whose id the frontend can no longer
/// enumerate) cannot be removed — `keyring` exposes no portable "list every
/// entry for a service" API. The wholesale file delete + known-slot clear covers
/// every other case; this is the one documented residual.
fn delete_all_keys_from<K: SecretStore>(
    keychain: &K,
    key_file: &Path,
    slots: &[String],
) -> Result<(), String> {
    // (1) Wholesale file delete — clears file-backed orphans too.
    if key_file.exists() {
        std::fs::remove_file(key_file).map_err(|e| format!("delete key file: {e}"))?;
    }
    // (2) Best-effort keychain clear per known slot.
    for slot in slots {
        let _ = keychain.delete(slot);
    }
    Ok(())
}

/// App-facing wholesale key erase: resolves `ai_keys.json` and drives the real OS
/// keychain. See [`delete_all_keys_from`] for the behavior + the one residual
/// (keychain-only, unenumerable) case.
pub fn delete_all_keys(app: &AppHandle, slots: &[String]) -> Result<(), String> {
    let key_file = keys_path(app)?;
    delete_all_keys_from(&KeychainStore::new(), &key_file, slots)
}

// ---------------------------------------------------------------------------
// Startup migration — move legacy plaintext file keys into the keychain.
// ---------------------------------------------------------------------------

/// Best-effort: if `ai_keys.json` exists and the keychain is writable, copy each
/// slot into the keychain; once ALL slots are stored, delete the plaintext file
/// so nothing lingers at rest. If the keychain is unavailable (headless /
/// no-daemon) the very first write fails and this NO-OPs, leaving the file
/// intact as the fallback (no data loss).
///
/// Does NOT overwrite a slot that is ALREADY in the keychain: an existing
/// keychain value always wins over the stale file. This avoids a startup race
/// where the detached migration thread snapshots the file, an early
/// `ai_set_api_key` writes a NEW key to the keychain (and purges the file), and
/// the migration would otherwise clobber it back to the OLD file value.
fn migrate_file_into_keychain<K: SecretStore>(keychain: &K, path: &Path) {
    if !path.exists() {
        return;
    }
    let keys = read_keys(path);
    if keys.is_empty() {
        return;
    }
    for (slot, key) in &keys {
        if key.is_empty() {
            continue;
        }
        // An existing keychain value wins over the stale file — never clobber a
        // key saved after this thread snapshotted the file.
        if keychain.get(slot).is_some() {
            continue;
        }
        if keychain.set(slot, key).is_err() {
            // Keychain unavailable — leave the file untouched (fallback). Never
            // log the key.
            return;
        }
    }
    // Every slot is now in the keychain: drop the plaintext file at rest.
    let _ = std::fs::remove_file(path);
}

/// Startup migration hook, called once from the Tauri `setup` hook. Wrap the
/// call in a blocking thread so the keychain I/O never blocks or panics setup.
/// Any error is swallowed (best-effort); a key is never logged.
pub fn migrate_legacy_file_keys(app: &AppHandle) {
    let Ok(path) = keys_path(app) else {
        return;
    };
    migrate_file_into_keychain(&KeychainStore::new(), &path);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Temp `ai_keys.json` path under a unique per-test dir (created lazily by
    /// the store on first write).
    fn temp_keys_path(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("omnilink-secret-test-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("ai_keys.json")
    }

    // --- FileStore -------------------------------------------------------

    #[test]
    fn file_store_roundtrips_and_is_0600() {
        let path = temp_keys_path("file-rt");
        let store = FileStore::new(Some(path.clone()));

        assert!(store.get("openai").is_none());
        assert!(!store.has("openai"));

        store.set("openai", "sk-file-1").unwrap();
        assert_eq!(store.get("openai").as_deref(), Some("sk-file-1"));
        assert!(store.has("openai"));

        // A second slot is independent.
        store.set("anthropic", "sk-file-2").unwrap();
        assert_eq!(store.get("anthropic").as_deref(), Some("sk-file-2"));
        assert_eq!(store.get("openai").as_deref(), Some("sk-file-1"));

        // On Unix the file must be owner-only (0600).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "key file must be 0600");
        }

        store.delete("openai").unwrap();
        assert!(store.get("openai").is_none());
        assert_eq!(store.get("anthropic").as_deref(), Some("sk-file-2"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn file_store_delete_missing_file_is_noop() {
        // Clearing a slot when nothing was ever written must NOT create an empty
        // plaintext file at rest.
        let path = temp_keys_path("file-del-missing");
        let store = FileStore::new(Some(path.clone()));
        store.delete("openai").unwrap();
        assert!(!path.exists(), "delete must not create the file");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // --- Mock keychains --------------------------------------------------

    /// A keychain whose every op fails (models a headless / no-daemon box).
    struct FailingKeychain;
    impl SecretStore for FailingKeychain {
        fn get(&self, _slot: &str) -> Option<String> {
            None
        }
        fn set(&self, _slot: &str, _key: &str) -> Result<(), String> {
            Err("keychain unavailable".to_string())
        }
        fn delete(&self, _slot: &str) -> Result<(), String> {
            Err("keychain unavailable".to_string())
        }
    }

    /// An in-memory keychain that succeeds (models a working secret service).
    #[derive(Default)]
    struct MapKeychain {
        map: RefCell<BTreeMap<String, String>>,
    }
    impl SecretStore for MapKeychain {
        fn get(&self, slot: &str) -> Option<String> {
            self.map.borrow().get(slot).cloned()
        }
        fn set(&self, slot: &str, key: &str) -> Result<(), String> {
            self.map
                .borrow_mut()
                .insert(slot.to_string(), key.to_string());
            Ok(())
        }
        fn delete(&self, slot: &str) -> Result<(), String> {
            self.map.borrow_mut().remove(slot);
            Ok(())
        }
    }

    /// A keychain that HOLDS a value (so `get`/`has` report it present) but whose
    /// `delete` always FAILS without removing it — models a locked session /
    /// `NoStorageAccess` where the secret genuinely can't be cleared.
    struct StuckKeychain {
        map: RefCell<BTreeMap<String, String>>,
    }
    impl SecretStore for StuckKeychain {
        fn get(&self, slot: &str) -> Option<String> {
            self.map.borrow().get(slot).cloned()
        }
        fn set(&self, slot: &str, key: &str) -> Result<(), String> {
            self.map
                .borrow_mut()
                .insert(slot.to_string(), key.to_string());
            Ok(())
        }
        fn delete(&self, _slot: &str) -> Result<(), String> {
            // Fails and does NOT remove the entry.
            Err("keychain locked".to_string())
        }
    }

    // --- Composite: failing keychain -> file fallback --------------------

    #[test]
    fn composite_falls_back_to_file_when_keychain_fails() {
        let path = temp_keys_path("composite-fallback");
        let store = KeychainFirstStore {
            keychain: FailingKeychain,
            file: FileStore::new(Some(path.clone())),
        };

        // set must land in the 0600 file (keychain refused).
        store.set("openai", "sk-fallback").unwrap();
        assert_eq!(store.get("openai").as_deref(), Some("sk-fallback"));
        assert!(store.has("openai"));

        // Prove it really is on disk (0600) — the fallback path.
        assert_eq!(
            read_keys(&path).get("openai").map(String::as_str),
            Some("sk-fallback")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        store.delete("openai").unwrap();
        assert!(store.get("openai").is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // --- Composite: keychain hit clears the file slot --------------------

    #[test]
    fn composite_keychain_hit_stores_in_keychain_and_clears_file_slot() {
        let path = temp_keys_path("composite-hit");
        // Seed a STALE plaintext copy on disk first.
        FileStore::new(Some(path.clone()))
            .set("openai", "sk-stale-file")
            .unwrap();
        assert!(path.exists());

        let store = KeychainFirstStore {
            keychain: MapKeychain::default(),
            file: FileStore::new(Some(path.clone())),
        };

        store.set("openai", "sk-keychain").unwrap();

        // Stored in the keychain...
        assert_eq!(store.keychain.get("openai").as_deref(), Some("sk-keychain"));
        // ...and the plaintext file slot was purged (no lingering copy).
        assert!(!read_keys(&path).contains_key("openai"));
        // Read returns the keychain value, shadowing any stale file value.
        assert_eq!(store.get("openai").as_deref(), Some("sk-keychain"));
        assert!(store.has("openai"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn composite_read_shadows_stale_file_with_keychain_value() {
        let path = temp_keys_path("composite-shadow");
        // File holds an old value; keychain holds the current one.
        FileStore::new(Some(path.clone()))
            .set("openai", "sk-old-file")
            .unwrap();
        let keychain = MapKeychain::default();
        keychain.set("openai", "sk-new-keychain").unwrap();

        let store = KeychainFirstStore {
            keychain,
            file: FileStore::new(Some(path.clone())),
        };
        assert_eq!(store.get("openai").as_deref(), Some("sk-new-keychain"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn composite_delete_removes_from_both() {
        let path = temp_keys_path("composite-del");
        let keychain = MapKeychain::default();
        keychain.set("openai", "sk-kc").unwrap();
        FileStore::new(Some(path.clone()))
            .set("openai", "sk-file")
            .unwrap();

        let store = KeychainFirstStore {
            keychain,
            file: FileStore::new(Some(path.clone())),
        };
        assert!(store.has("openai"));

        store.delete("openai").unwrap();
        assert!(store.keychain.get("openai").is_none());
        assert!(!read_keys(&path).contains_key("openai"));
        assert!(!store.has("openai"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn composite_delete_surfaces_keychain_failure_when_secret_remains() {
        // A real keychain-delete failure (locked session) must NOT be masked by
        // a file no-op `Ok`: the secret is still stored + readable, so "cleared"
        // would be a lie.
        let path = temp_keys_path("composite-del-stuck");
        let keychain = StuckKeychain {
            map: RefCell::new(BTreeMap::new()),
        };
        keychain.set("openai", "sk-stuck").unwrap();

        // No file on disk, so file.delete is a no-op Ok.
        let store = KeychainFirstStore {
            keychain,
            file: FileStore::new(Some(path.clone())),
        };

        let result = store.delete("openai");
        assert!(result.is_err(), "delete must surface the keychain failure");
        // The secret is still there and still readable — nothing was silently lost.
        assert!(store.has("openai"));
        assert_eq!(store.get("openai").as_deref(), Some("sk-stuck"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn composite_delete_is_ok_when_keychain_has_nothing() {
        // Headless: the keychain delete "fails" but there is nothing there
        // (has == false), so the file governs and clearing succeeds.
        let path = temp_keys_path("composite-del-headless");
        let store = KeychainFirstStore {
            keychain: FailingKeychain,
            file: FileStore::new(Some(path.clone())),
        };
        // Nothing on disk either -> file.delete is a no-op Ok.
        store.delete("openai").expect("headless clear must succeed");
        assert!(!store.has("openai"));
        assert!(!path.exists(), "delete must not create a plaintext file");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // --- Wholesale erase (NFR-PRIV-02) -----------------------------------

    #[test]
    fn delete_all_keys_wholesale_removes_file_and_all_slots_incl_orphans() {
        let path = temp_keys_path("delete-all-file");
        let file = FileStore::new(Some(path.clone()));
        file.set("openai", "sk-1").unwrap();
        file.set("anthropic", "sk-2").unwrap();
        // An ORPHAN slot the frontend can't name (legacy multi-config leftover).
        file.set("openai#legacy", "sk-orphan").unwrap();
        assert!(path.exists());

        // The frontend passes only the provider-default slots — NOT the orphan.
        let keychain = MapKeychain::default();
        keychain.set("openai", "sk-kc").unwrap();
        let slots = vec!["openai".to_string(), "anthropic".to_string()];

        delete_all_keys_from(&keychain, &path, &slots).unwrap();

        // The file is gone OUTRIGHT — every file-backed slot, incl. the orphan.
        assert!(!path.exists(), "key file must be wiped wholesale");
        assert!(read_keys(&path).is_empty());
        // Known keychain slots cleared too.
        assert!(keychain.get("openai").is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn delete_all_keys_headless_no_file_is_clean_noop() {
        // Headless: nothing on disk, keychain unavailable — must not error or
        // create a plaintext file.
        let path = temp_keys_path("delete-all-headless");
        assert!(!path.exists());
        delete_all_keys_from(&FailingKeychain, &path, &["openai".to_string()]).unwrap();
        assert!(!path.exists(), "wipe must not create a key file");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // --- Migration -------------------------------------------------------

    #[test]
    fn migration_moves_keys_and_deletes_file_when_keychain_works() {
        let path = temp_keys_path("migrate-ok");
        let file = FileStore::new(Some(path.clone()));
        file.set("openai", "sk-1").unwrap();
        file.set("anthropic", "sk-2").unwrap();
        assert!(path.exists());

        let keychain = MapKeychain::default();
        migrate_file_into_keychain(&keychain, &path);

        // Both keys are now in the keychain, and the plaintext file is gone.
        assert_eq!(keychain.get("openai").as_deref(), Some("sk-1"));
        assert_eq!(keychain.get("anthropic").as_deref(), Some("sk-2"));
        assert!(
            !path.exists(),
            "plaintext file must be removed after migration"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn migration_does_not_clobber_an_existing_keychain_slot() {
        // Startup race: an early ai_set_api_key already stored openai=NEW in the
        // keychain (and the file still holds the stale openai=OLD). Migration
        // must keep NEW and only carry over the slot the keychain lacks.
        let path = temp_keys_path("migrate-no-clobber");
        let file = FileStore::new(Some(path.clone()));
        file.set("openai", "sk-OLD").unwrap();
        file.set("anthropic", "sk-X").unwrap();

        let keychain = MapKeychain::default();
        keychain.set("openai", "sk-NEW").unwrap();

        migrate_file_into_keychain(&keychain, &path);

        // The fresh key survives; the missing one is carried over; file removed.
        assert_eq!(keychain.get("openai").as_deref(), Some("sk-NEW"));
        assert_eq!(keychain.get("anthropic").as_deref(), Some("sk-X"));
        assert!(
            !path.exists(),
            "plaintext file must be removed after migration"
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn migration_is_noop_and_preserves_file_when_keychain_fails() {
        let path = temp_keys_path("migrate-fail");
        let file = FileStore::new(Some(path.clone()));
        file.set("openai", "sk-1").unwrap();
        file.set("anthropic", "sk-2").unwrap();

        migrate_file_into_keychain(&FailingKeychain, &path);

        // Headless: file is untouched, no data loss.
        assert!(path.exists(), "file must survive a failed migration");
        let keys = read_keys(&path);
        assert_eq!(keys.get("openai").map(String::as_str), Some("sk-1"));
        assert_eq!(keys.get("anthropic").map(String::as_str), Some("sk-2"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // --- Real OS keychain round-trip (desktop-only) ----------------------

    /// Round-trips a key through the REAL OS secret store. Ignored by default:
    /// headless `cargo test` has no secret service, so run this only on a
    /// desktop CI runner with a live keychain:
    /// `cargo test -- --ignored keychain_store_real_roundtrip`.
    #[test]
    #[ignore = "requires a live OS secret service (desktop only)"]
    fn keychain_store_real_roundtrip() {
        let store = KeychainStore::new();
        let slot = format!("omnilink-test-slot-{}", std::process::id());
        store.set(&slot, "sk-real-roundtrip").unwrap();
        assert_eq!(store.get(&slot).as_deref(), Some("sk-real-roundtrip"));
        assert!(store.has(&slot));
        store.delete(&slot).unwrap();
        assert!(store.get(&slot).is_none());
    }
}
