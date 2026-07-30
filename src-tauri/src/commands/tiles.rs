//! Offline map-tile commands (M12, FR-TELEM-07).
//!
//! Serves a fully **offline** map: a bundled low-zoom worldwide base set plus
//! user-downloaded regional packs, all read from local storage and served to
//! MapLibre through the `omnitiles://` custom URI scheme (registered in
//! `lib.rs`). No network access is required to render a flight path.
//!
//! ## `.ompack` container format
//!
//! A tile pack is one self-describing binary file so a download is a single HTTP
//! GET (no per-tile requests, no `zip` dependency):
//!
//! ```text
//!   magic:    8 bytes  = b"OMPACK01"
//!   dir_len:  4 bytes  = u32 little-endian (length of the directory JSON)
//!   dir:      dir_len bytes = JSON object { "z/x/y": [offset, length], ... }
//!   blob:     concatenated PNG tile bytes; each tile at `blob[offset..offset+length]`
//! ```
//!
//! `offset` is relative to the start of the blob (i.e. byte `12 + dir_len` of the
//! file). A real production build generates these server-side with a matching
//! packer; the bundled `resources/tiles/base-world.ompack` here is a small
//! placeholder (solid low-zoom tiles) proving the serve path end-to-end — see
//! `resources/tiles/make_placeholder_base.py`.
//!
//! ## Command / event surface
//!
//! * `list_tile_packs` → `{ base, packs }` (manifest + local-storage status).
//! * `download_tile_pack(packId)` — spawns a worker thread that streams the
//!   pack to disk, emitting `tiles://progress`, then `tiles://done` /
//!   `tiles://error`. Mirrors the `flash::start_flash` event seam.
//! * `cancel_tile_pack_download(packId)` — aborts an in-flight download.
//! * `delete_tile_pack(packId)` — removes a downloaded pack.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const OMPACK_MAGIC: &[u8; 8] = b"OMPACK01";

// ---------------------------------------------------------------------------
// Manifest (mirrors `src/lib/tile-packs.ts`, schemaVersion 1).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseManifest {
    id: String,
    name: String,
    min_zoom: u8,
    max_zoom: u8,
    size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackManifest {
    id: String,
    name: String,
    continent: String,
    #[serde(default)]
    country: Option<String>,
    min_zoom: u8,
    max_zoom: u8,
    size_bytes: u64,
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    base: BaseManifest,
    packs: Vec<PackManifest>,
}

/// Parse + validate a tile manifest (camelCase keys, shared with the TS parser
/// in `src/lib/tile-packs.ts`). Unknown keys (e.g. a pack `sha256`) are ignored.
fn parse_manifest(raw: &str) -> Result<Manifest, String> {
    let m: Manifest =
        serde_json::from_str(raw).map_err(|e| format!("tile manifest parse error: {e}"))?;
    if m.schema_version != 1 {
        return Err(format!(
            "unsupported tile manifest schemaVersion {} (expected 1)",
            m.schema_version
        ));
    }
    Ok(m)
}

// ---------------------------------------------------------------------------
// DTOs returned to the frontend (camelCase, mirror `lib/tauri.ts`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseStatusDto {
    id: String,
    name: String,
    min_zoom: u8,
    max_zoom: u8,
    size_bytes: u64,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatusDto {
    id: String,
    name: String,
    continent: String,
    country: Option<String>,
    min_zoom: u8,
    max_zoom: u8,
    size_bytes: u64,
    downloaded: bool,
    on_disk_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDto {
    base: BaseStatusDto,
    packs: Vec<PackStatusDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressDto {
    pack_id: String,
    percent: f32,
    received_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneDto {
    pack_id: String,
    on_disk_bytes: u64,
}

/// Per-domain failure category for `tiles://error`. The frontend renders
/// `t("tiles.errors.categories.${category}")` as the fallback when it has no
/// string for a specific `summaryKey`. Mirrors the categorized-error model
/// shipped in `commands/logs.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum TilesErrorCategory {
    /// HTTP transport: client build, request send, non-success status, body read.
    Network,
    /// The downloaded bytes are not a valid `.ompack` (bad magic / directory).
    Manifest,
    /// Local filesystem: create/write/flush the `.part`, or commit (rename) it.
    Storage,
    /// User-initiated cancel — a distinct, non-error outcome (mirrors how
    /// `commands/logs.rs` reports cancel: still on the error channel, own
    /// `summaryKey`, NOT a hard-failure category).
    Cancelled,
    /// Anything uncategorized.
    Unknown,
}

impl TilesErrorCategory {
    /// The camelCase category string the frontend keys i18n off of.
    fn as_str(self) -> &'static str {
        match self {
            TilesErrorCategory::Network => "network",
            TilesErrorCategory::Manifest => "manifest",
            TilesErrorCategory::Storage => "storage",
            TilesErrorCategory::Cancelled => "cancelled",
            TilesErrorCategory::Unknown => "unknown",
        }
    }
}

/// Payload for the `tiles://error` event — serializes to
/// `{ "packId": .., "category": .., "summaryKey": .., "detail": .. }` (camelCase).
/// `packId` is PRESERVED (the frontend needs it to clear that pack's progress);
/// the structured `{ category, summaryKey, detail }` trio mirrors the `ErrorDto`
/// shape in `commands/logs.rs`. `summaryKey` is an i18n suffix the frontend
/// renders as `t("tiles.errors.${summaryKey}")` with
/// `t("tiles.errors.categories.${category}")` as the fallback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDto {
    pack_id: String,
    category: String,
    summary_key: String,
    detail: String,
}

impl ErrorDto {
    fn new(pack_id: &str, category: TilesErrorCategory, summary_key: &str, detail: String) -> Self {
        ErrorDto {
            pack_id: pack_id.to_string(),
            category: category.as_str().to_string(),
            summary_key: summary_key.to_string(),
            detail,
        }
    }
}

/// Classify a `download_worker` failure message into a (category, summaryKey)
/// pair. Pure + prefix-based so it is unit-tested without a live download — the
/// worker keeps emitting consistently-prefixed messages (see [`download_worker`]).
fn classify_download_error(message: &str) -> (TilesErrorCategory, &'static str) {
    // User cancel: a distinct non-error outcome (mirrors logs.rs).
    if message.starts_with("cancelled") {
        return (TilesErrorCategory::Cancelled, "cancelled");
    }
    // Validation of the downloaded bytes (not a real `.ompack`).
    if message.starts_with("invalid pack") {
        return (TilesErrorCategory::Manifest, "invalidPack");
    }
    // HTTP transport failures.
    if message.starts_with("http client") {
        return (TilesErrorCategory::Network, "httpClient");
    }
    if message.starts_with("download request failed") {
        return (TilesErrorCategory::Network, "requestFailed");
    }
    if message.starts_with("download failed: HTTP") {
        return (TilesErrorCategory::Network, "httpStatus");
    }
    if message.starts_with("read body") {
        return (TilesErrorCategory::Network, "readFailed");
    }
    // Local filesystem failures.
    if message.starts_with("commit pack") {
        return (TilesErrorCategory::Storage, "commitFailed");
    }
    if message.starts_with("create") || message.starts_with("write") || message.starts_with("flush")
    {
        return (TilesErrorCategory::Storage, "writeFailed");
    }
    (TilesErrorCategory::Unknown, "downloadFailed")
}

// ---------------------------------------------------------------------------
// `.ompack` index: parsed directory + the file it lives in.
// ---------------------------------------------------------------------------

/// In-memory directory of one `.ompack`: tile key (`"z/x/y"`) → (offset, len)
/// within the blob, plus the byte offset where the blob starts.
#[derive(Debug)]
struct PackIndex {
    path: PathBuf,
    blob_start: u64,
    dir: HashMap<String, (u64, u64)>,
}

impl PackIndex {
    /// Read + parse an `.ompack` header (magic + directory). The tile blob is
    /// left on disk and read per-tile on demand.
    fn open(path: &Path) -> Result<PackIndex, String> {
        let mut f = fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
        let file_len = f
            .metadata()
            .map_err(|e| format!("stat {path:?}: {e}"))?
            .len();
        let mut magic = [0u8; 8];
        f.read_exact(&mut magic)
            .map_err(|e| format!("read magic: {e}"))?;
        if &magic != OMPACK_MAGIC {
            return Err(format!("{path:?}: not an .ompack (bad magic)"));
        }
        let mut len_buf = [0u8; 4];
        f.read_exact(&mut len_buf)
            .map_err(|e| format!("read dir len: {e}"))?;
        let dir_len = u32::from_le_bytes(len_buf) as u64;
        // The directory is untrusted: bound `dir_len` by the bytes actually
        // remaining after the 12-byte header before allocating, so a crafted
        // length prefix (e.g. 0xFFFFFFFF) cannot force a multi-GiB zeroed
        // allocation (and possible abort) on parse.
        let header: u64 = 8 + 4;
        if dir_len > file_len.saturating_sub(header) {
            return Err(format!(
                "{path:?}: directory length {dir_len} exceeds file size {file_len}"
            ));
        }
        let mut dir_buf = vec![0u8; dir_len as usize];
        f.read_exact(&mut dir_buf)
            .map_err(|e| format!("read dir: {e}"))?;
        let dir: HashMap<String, (u64, u64)> =
            serde_json::from_slice(&dir_buf).map_err(|e| format!("parse dir: {e}"))?;
        Ok(PackIndex {
            path: path.to_path_buf(),
            blob_start: header + dir_len,
            dir,
        })
    }

    /// Read the PNG bytes for a tile key, if this pack contains it.
    fn read_tile(&self, key: &str) -> Option<Vec<u8>> {
        let &(offset, len) = self.dir.get(key)?;
        let mut f = fs::File::open(&self.path).ok()?;
        let file_len = f.metadata().ok()?.len();
        // `offset`/`len` come from the untrusted directory JSON: bound the read
        // (and thus the allocation) by the actual file size so a tampered entry
        // (e.g. `len = u64::MAX`) cannot trigger a huge alloc / process abort.
        let start = self.blob_start.checked_add(offset)?;
        let end = start.checked_add(len)?;
        if end > file_len {
            return None;
        }
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; len as usize];
        f.read_exact(&mut buf).ok()?;
        Some(buf)
    }
}

// ---------------------------------------------------------------------------
// Managed state.
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct TileManager {
    /// Per-pack cancel flags for in-flight downloads.
    downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Lazily-opened `.ompack` indices, keyed by absolute path.
    index_cache: Mutex<HashMap<PathBuf, Arc<PackIndex>>>,
    /// Memoized ordered list of installed `.ompack` paths (downloaded packs
    /// first, then the bundled base set). The pack set changes only on a
    /// download-complete / delete — both call
    /// [`invalidate_listing`](Self::invalidate_listing) — so this listing is
    /// reused across `omnitiles://` requests instead of re-running a `read_dir`
    /// per directory on every tile (MapLibre fires many per viewport change).
    ompack_listing: Mutex<Option<Arc<Vec<PathBuf>>>>,
}

impl TileManager {
    /// Get (or open + cache) the index for an `.ompack` file. Returns `None` if
    /// the file is absent or malformed.
    fn index_for(&self, path: &Path) -> Option<Arc<PackIndex>> {
        if !path.exists() {
            return None;
        }
        let mut cache = self.index_cache.lock().unwrap();
        if let Some(idx) = cache.get(path) {
            return Some(idx.clone());
        }
        match PackIndex::open(path) {
            Ok(idx) => {
                let arc = Arc::new(idx);
                cache.insert(path.to_path_buf(), arc.clone());
                Some(arc)
            }
            Err(e) => {
                // A corrupt / non-`.ompack` file on disk: degrade gracefully
                // (this pack contributes no tiles, the serve path falls back to
                // the blank tile). Log only — never an error event.
                log_tiles(TilesErrorCategory::Manifest, &e);
                None
            }
        }
    }

    /// Drop a cached index (after a delete / completed download) so a re-open
    /// re-reads from disk.
    fn invalidate(&self, path: &Path) {
        self.index_cache.lock().unwrap().remove(path);
    }

    /// Get (or build + cache) the ordered list of installed `.ompack` files
    /// across `dirs` (callers pass the downloaded-packs dir first, the bundled
    /// base dir second). Memoized so the per-tile serve path doesn't re-scan the
    /// directories on every request; the cache is dropped by
    /// [`invalidate_listing`](Self::invalidate_listing) whenever the pack set
    /// changes, so new / deleted packs are still reflected.
    fn ompack_paths(&self, dirs: &[PathBuf]) -> Arc<Vec<PathBuf>> {
        let mut cache = self.ompack_listing.lock().unwrap();
        if let Some(list) = cache.as_ref() {
            return list.clone();
        }
        let list = Arc::new(list_ompack_files(dirs));
        *cache = Some(list.clone());
        list
    }

    /// Drop the cached `.ompack` listing so the next `omnitiles://` request
    /// re-scans the pack directories. Call after a pack is downloaded or deleted.
    fn invalidate_listing(&self) {
        *self.ompack_listing.lock().unwrap() = None;
    }
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

/// Directory holding downloaded packs (`<app_data>/tiles`).
fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?
        .join("tiles");
    fs::create_dir_all(&dir).map_err(|e| format!("create tiles dir: {e}"))?;
    Ok(dir)
}

/// On-disk path of a downloaded pack.
fn pack_path(app: &AppHandle, pack_id: &str) -> Result<PathBuf, String> {
    Ok(packs_dir(app)?.join(format!("{pack_id}.ompack")))
}

/// Path of the bundled base `.ompack` + manifest inside the resource dir.
fn resource_tiles_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resource dir: {e}"))?
        .join("resources")
        .join("tiles"))
}

fn read_manifest(app: &AppHandle) -> Result<Manifest, String> {
    let path = resource_tiles_dir(app)?.join("tile-packs.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read tile manifest {path:?}: {e}"))?;
    parse_manifest(&raw)
}

/// Returns `true` when `pack_id` names a pack in the manifest. The
/// download/delete commands gate on this before calling [`pack_path`], so a
/// non-manifest id — including `..`/absolute path-traversal attempts — can
/// never derive an on-disk path outside the tiles dir.
fn is_known_pack(manifest: &Manifest, pack_id: &str) -> bool {
    manifest.packs.iter().any(|p| p.id == pack_id)
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// List the bundled base set + downloadable packs with local-storage status.
#[tauri::command]
pub fn list_tile_packs(app: AppHandle) -> Result<InventoryDto, String> {
    let manifest = read_manifest(&app)?;
    let base_path = resource_tiles_dir(&app)?.join(format!("{}.ompack", manifest.base.id));

    let packs = manifest
        .packs
        .iter()
        .map(|p| {
            let (downloaded, on_disk_bytes) = match pack_path(&app, &p.id) {
                Ok(path) if path.exists() => {
                    (true, fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
                }
                _ => (false, 0),
            };
            PackStatusDto {
                id: p.id.clone(),
                name: p.name.clone(),
                continent: p.continent.clone(),
                country: p.country.clone(),
                min_zoom: p.min_zoom,
                max_zoom: p.max_zoom,
                size_bytes: p.size_bytes,
                downloaded,
                on_disk_bytes,
            }
        })
        .collect();

    Ok(InventoryDto {
        base: BaseStatusDto {
            id: manifest.base.id.clone(),
            name: manifest.base.name.clone(),
            min_zoom: manifest.base.min_zoom,
            max_zoom: manifest.base.max_zoom,
            size_bytes: manifest.base.size_bytes,
            available: base_path.exists(),
        },
        packs,
    })
}

/// Start downloading a pack. Returns once the worker thread is spawned; progress
/// + outcome arrive via `tiles://*` (mirrors `flash::start_flash`).
#[tauri::command]
pub fn download_tile_pack(
    app: AppHandle,
    manager: State<'_, TileManager>,
    pack_id: String,
) -> Result<(), String> {
    let manifest = read_manifest(&app)?;
    let pack = manifest
        .packs
        .iter()
        .find(|p| p.id == pack_id)
        .ok_or_else(|| format!("unknown tile pack '{pack_id}'"))?
        .clone();

    let dest = pack_path(&app, &pack_id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    manager
        .downloads
        .lock()
        .unwrap()
        .insert(pack_id.clone(), cancel.clone());

    let app_for_thread = app.clone();
    std::thread::Builder::new()
        .name(format!("tile-dl-{pack_id}"))
        .spawn(move || {
            let result = download_worker(&app_for_thread, &pack.url, &dest, &cancel);
            // Clear the cancel flag entry, then report.
            if let Some(mgr) = app_for_thread.try_state::<TileManager>() {
                mgr.downloads.lock().unwrap().remove(&pack.id);
                mgr.invalidate(&dest);
                // A newly-committed pack must appear in the serve path: drop the
                // memoized directory listing so the next tile request re-scans.
                mgr.invalidate_listing();
            }
            match result {
                Ok(on_disk_bytes) => emit_or_log(
                    &app_for_thread,
                    "tiles://done",
                    DoneDto {
                        pack_id: pack.id.clone(),
                        on_disk_bytes,
                    },
                ),
                Err(message) => {
                    let (category, summary_key) = classify_download_error(&message);
                    log_tiles(category, &format!("pack '{}': {message}", pack.id));
                    emit_or_log(
                        &app_for_thread,
                        "tiles://error",
                        ErrorDto::new(&pack.id, category, summary_key, message),
                    );
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Cancel an in-flight pack download.
#[tauri::command]
pub fn cancel_tile_pack_download(manager: State<'_, TileManager>, pack_id: String) {
    if let Some(flag) = manager.downloads.lock().unwrap().get(&pack_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Delete a downloaded pack, reclaiming its disk space.
#[tauri::command]
pub fn delete_tile_pack(
    app: AppHandle,
    manager: State<'_, TileManager>,
    pack_id: String,
) -> Result<(), String> {
    // Validate `pack_id` against the bundled manifest before deriving any path,
    // exactly as `download_tile_pack` does. `pack_path` joins the id verbatim,
    // so an unvalidated `..`/absolute id would let an IPC caller delete an
    // arbitrary `.ompack` outside the tiles dir (path traversal).
    let manifest = read_manifest(&app)?;
    if !is_known_pack(&manifest, &pack_id) {
        return Err(format!("unknown tile pack '{pack_id}'"));
    }
    let path = pack_path(&app, &pack_id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete pack: {e}"))?;
    }
    manager.invalidate(&path);
    // The deleted pack must stop being served: drop the memoized listing too.
    manager.invalidate_listing();
    Ok(())
}

/// Progress percent for a `tiles://progress` event: the determinate `[0,100]`
/// value when `total` is known, or `-1` — the indeterminate sentinel the
/// frontend renders as a busy bar — when the server sent no `Content-Length`
/// (`total == 0`).
fn progress_percent(received: u64, total: u64) -> i32 {
    if total > 0 {
        ((received as f64 / total as f64) * 100.0) as i32
    } else {
        -1
    }
}

/// Whether a progress event should fire this read. With a known total we emit
/// only when the integer percent changes; with no `Content-Length`
/// (`total == 0`) the percent is pinned at `-1`, so without this the guard
/// `pct != last_emit_pct` would never fire and the indeterminate bar would stay
/// stuck. In that case we emit on every read (which only happens when
/// `received` grew) so the UI keeps showing live byte counts.
fn should_emit_progress(pct: i32, last_emit_pct: i32, total: u64) -> bool {
    pct != last_emit_pct || total == 0
}

/// Where a pack's bytes come from, derived from its manifest `url`. v1.6 ships
/// with no tile CDN, so the bundled regional packs are sourced from the local
/// installer resources rather than over the network — but the SAME streaming
/// pipeline (progress, cancel, magic validation, atomic rename, error
/// classification) runs regardless of source. Branching only on the byte source
/// keeps the real `http(s)://` path intact for a future production CDN.
#[derive(Debug, PartialEq, Eq)]
enum PackSource {
    /// `http(s)://…` — fetch with `reqwest::blocking` (production CDN).
    Http,
    /// `file://<abs path>` — a local absolute path. Resolved WITHOUT an
    /// [`AppHandle`], so the streaming core is unit-testable.
    Local(PathBuf),
    /// `bundled:<rel path>` — resolved against the bundled resource tiles dir
    /// (see [`resource_tiles_dir`]); how the shipped regional packs are sourced.
    Bundled(PathBuf),
}

/// Classify a manifest `url` into its [`PackSource`]. Pure (no filesystem / no
/// [`AppHandle`]) so it is unit-testable; the `bundled:` relative path is
/// resolved against the resource dir later, in [`download_worker`].
fn classify_pack_url(url: &str) -> PackSource {
    if let Some(rel) = url.strip_prefix("bundled:") {
        return PackSource::Bundled(PathBuf::from(rel));
    }
    if let Some(abs) = url.strip_prefix("file://") {
        return PackSource::Local(PathBuf::from(abs));
    }
    PackSource::Http
}

/// True if a `bundled:` relative path is safe to join onto the resource tiles
/// dir — every component must be a plain name (or `.`), so no `..`, root, or
/// drive-prefix component can escape the dir. The `url` comes from the trusted,
/// read-only bundled manifest, so this is defense-in-depth that mirrors the
/// `pack_id` traversal guard applied on the IPC boundary.
fn is_safe_bundled_rel(rel: &Path) -> bool {
    use std::path::Component;
    rel.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Streaming download worker: copy the pack bytes from its source (an HTTP GET
/// for `http(s)://`, or a local file for `bundled:`/`file://`) into
/// `<dest>.part`, emitting `tiles://progress`, validating the `.ompack` magic,
/// then atomically renaming to `dest`. Honors `cancel`.
fn download_worker(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<u64, String> {
    let pack_id = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // Forward progress to the `tiles://progress` event. The streaming core takes
    // this as a closure so a unit test can drive it without an `AppHandle`.
    let mut on_progress = |dto: ProgressDto| emit_or_log(app, "tiles://progress", dto);

    match classify_pack_url(url) {
        PackSource::Http => {
            let client = reqwest::blocking::Client::builder()
                .build()
                .map_err(|e| format!("http client: {e}"))?;
            let mut resp = client
                .get(url)
                .send()
                .map_err(|e| format!("download request failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("download failed: HTTP {}", resp.status()));
            }
            let total = resp.content_length().unwrap_or(0);
            stream_to_dest(&mut resp, total, dest, &pack_id, cancel, &mut on_progress)
        }
        PackSource::Local(path) => {
            let (mut src, total) = open_local_source(&path)?;
            stream_to_dest(&mut src, total, dest, &pack_id, cancel, &mut on_progress)
        }
        PackSource::Bundled(rel) => {
            if !is_safe_bundled_rel(&rel) {
                return Err(format!(
                    "download request failed: unsafe bundled path {rel:?}"
                ));
            }
            let path = resource_tiles_dir(app)?.join(rel);
            let (mut src, total) = open_local_source(&path)?;
            stream_to_dest(&mut src, total, dest, &pack_id, cancel, &mut on_progress)
        }
    }
}

/// Open a local pack source for streaming, returning the reader + its byte
/// length (used as the `total` for determinate progress, mirroring the HTTP
/// `Content-Length`). A missing/unreadable source is reported with the SAME
/// `"download request failed"` prefix the HTTP path uses, so
/// [`classify_download_error`] maps it to the `network`/`requestFailed` category
/// (semantically: "could not fetch the source") with no new classifier branch.
fn open_local_source(path: &Path) -> Result<(fs::File, u64), String> {
    let f =
        fs::File::open(path).map_err(|e| format!("download request failed: open {path:?}: {e}"))?;
    let total = f
        .metadata()
        .map_err(|e| format!("download request failed: stat {path:?}: {e}"))?
        .len();
    Ok((f, total))
}

/// The streaming core shared by the HTTP and local-source paths: read from
/// `src` into `<dest>.part` in 64 KiB chunks, emitting progress, honoring
/// `cancel`, validating the `.ompack` magic, then atomically renaming to `dest`.
/// Generic over the byte source (`reqwest::blocking::Response` or a local
/// `fs::File`) and over the progress sink so it is unit-testable without an
/// [`AppHandle`]. Error messages keep the same prefixes [`classify_download_error`]
/// keys off of, so progress/cancel/validation/rename/classification behave
/// identically regardless of source.
fn stream_to_dest<R: Read, F: FnMut(ProgressDto)>(
    src: &mut R,
    total: u64,
    dest: &Path,
    pack_id: &str,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<u64, String> {
    let part = dest.with_extension("ompack.part");
    let mut out = fs::File::create(&part).map_err(|e| format!("create {part:?}: {e}"))?;

    let mut received: u64 = 0;
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit_pct = -1i32;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = fs::remove_file(&part);
            return Err("cancelled".to_string());
        }
        let n = src.read(&mut buf).map_err(|e| format!("read body: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("write {part:?}: {e}"))?;
        received += n as u64;

        let pct = progress_percent(received, total);
        if should_emit_progress(pct, last_emit_pct, total) {
            last_emit_pct = pct;
            on_progress(ProgressDto {
                pack_id: pack_id.to_string(),
                percent: pct as f32,
                received_bytes: received,
                total_bytes: total,
            });
        }
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    drop(out);

    // Validate it is a real `.ompack` before committing, so a corrupt/HTML
    // error body never poisons the tile store.
    PackIndex::open(&part).map_err(|e| {
        let _ = fs::remove_file(&part);
        format!("invalid pack: {e}")
    })?;

    fs::rename(&part, dest).map_err(|e| format!("commit pack: {e}"))?;
    Ok(received)
}

// ---------------------------------------------------------------------------
// `omnitiles://` protocol resolution.
// ---------------------------------------------------------------------------

/// 1×1 transparent PNG returned for any tile not present locally, so MapLibre
/// renders the themed background (not a broken-tile error) where coverage is
/// missing — honest "no data here" rather than fake geography.
const BLANK_TILE_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

/// Extract a `"z/x/y"` tile key from a request path like `/tiles/3/4/2.png`
/// (also tolerates the `http://omnitiles.localhost/...` form Windows uses).
fn tile_key_from_path(path: &str) -> Option<String> {
    let stem = path.split('?').next().unwrap_or(path);
    let parts: Vec<&str> = stem.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 3 {
        return None;
    }
    let y = parts[parts.len() - 1].strip_suffix(".png")?;
    let x = parts[parts.len() - 2];
    let z = parts[parts.len() - 3];
    // All three must be integers.
    for c in [z, x, y] {
        if c.is_empty() || !c.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    Some(format!("{z}/{x}/{y}"))
}

/// Collect every `.ompack` file path across `dirs`, in directory order. This is
/// the listing memoized by [`TileManager::ompack_paths`]; pulled out as a pure
/// function so the scan + the cache/invalidation contract are unit-testable
/// without an [`AppHandle`]. A missing/unreadable directory contributes nothing.
fn list_ompack_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("ompack") {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Resolve a tile by key across all installed packs then the bundled base set.
/// Returns `None` when no local source has the tile (caller serves a blank).
fn resolve_tile(app: &AppHandle, manager: &TileManager, key: &str) -> Option<Vec<u8>> {
    // Downloaded packs first (higher zoom / more detail), then the bundled base
    // set. The pack set rarely changes (only on download-complete / delete, which
    // call `invalidate_listing`), so the directory listing is memoized in managed
    // state rather than re-scanned with two `read_dir`s on every tile request.
    let mut dirs: Vec<PathBuf> = Vec::with_capacity(2);
    if let Ok(dir) = packs_dir(app) {
        dirs.push(dir);
    }
    if let Ok(dir) = resource_tiles_dir(app) {
        dirs.push(dir);
    }
    for pack_path in manager.ompack_paths(&dirs).iter() {
        if let Some(idx) = manager.index_for(pack_path) {
            if let Some(bytes) = idx.read_tile(key) {
                return Some(bytes);
            }
        }
    }
    None
}

/// Build an `omnitiles://` response for a tile request URI.
pub fn serve_tile(app: &AppHandle, uri_path_and_host: &str) -> (u16, Vec<u8>) {
    let manager = match app.try_state::<TileManager>() {
        Some(m) => m,
        None => return (500, Vec::new()),
    };
    match tile_key_from_path(uri_path_and_host) {
        Some(key) => match resolve_tile(app, &manager, &key) {
            Some(bytes) => (200, bytes),
            None => (200, BLANK_TILE_PNG.to_vec()),
        },
        None => (404, Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// Shared.
// ---------------------------------------------------------------------------

fn emit_or_log<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "tiles", "failed to emit {event}: {e}");
    }
}

/// Consistent structured stderr log for a categorized tiles condition:
/// `[tiles] {category}: {msg}`. Used alongside a `tiles://error` emit for genuine
/// download failures, and on degraded-but-graceful paths (a corrupt on-disk pack)
/// that log ONLY and never raise an event.
fn log_tiles(category: TilesErrorCategory, msg: &str) {
    tracing::warn!(target: "tiles", "{}: {msg}", category.as_str());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiles_error_category_maps_to_camel_case_strings() {
        assert_eq!(TilesErrorCategory::Network.as_str(), "network");
        assert_eq!(TilesErrorCategory::Manifest.as_str(), "manifest");
        assert_eq!(TilesErrorCategory::Storage.as_str(), "storage");
        assert_eq!(TilesErrorCategory::Cancelled.as_str(), "cancelled");
        assert_eq!(TilesErrorCategory::Unknown.as_str(), "unknown");
    }

    #[test]
    fn tiles_error_dto_serializes_with_pack_id_and_structured_trio() {
        let dto = ErrorDto::new(
            "eu",
            TilesErrorCategory::Network,
            "httpStatus",
            "download failed: HTTP 404 Not Found".to_string(),
        );
        let json = serde_json::to_string(&dto).unwrap();
        assert_eq!(
            json,
            r#"{"packId":"eu","category":"network","summaryKey":"httpStatus","detail":"download failed: HTTP 404 Not Found"}"#
        );
    }

    #[test]
    fn download_error_classifier_maps_representative_messages() {
        // Network transport.
        assert_eq!(
            classify_download_error("http client: builder error"),
            (TilesErrorCategory::Network, "httpClient")
        );
        assert_eq!(
            classify_download_error("download request failed: timed out"),
            (TilesErrorCategory::Network, "requestFailed")
        );
        assert_eq!(
            classify_download_error("download failed: HTTP 500 Internal Server Error"),
            (TilesErrorCategory::Network, "httpStatus")
        );
        assert_eq!(
            classify_download_error("read body: connection reset"),
            (TilesErrorCategory::Network, "readFailed")
        );
        // Storage.
        assert_eq!(
            classify_download_error("create \"/x/eu.ompack.part\": permission denied"),
            (TilesErrorCategory::Storage, "writeFailed")
        );
        assert_eq!(
            classify_download_error("write \"/x/eu.ompack.part\": no space left"),
            (TilesErrorCategory::Storage, "writeFailed")
        );
        assert_eq!(
            classify_download_error("flush: io error"),
            (TilesErrorCategory::Storage, "writeFailed")
        );
        assert_eq!(
            classify_download_error("commit pack: cross-device link"),
            (TilesErrorCategory::Storage, "commitFailed")
        );
        // Manifest validation of the downloaded bytes.
        assert_eq!(
            classify_download_error("invalid pack: not an .ompack (bad magic)"),
            (TilesErrorCategory::Manifest, "invalidPack")
        );
        // Cancel: a distinct non-error outcome.
        assert_eq!(
            classify_download_error("cancelled"),
            (TilesErrorCategory::Cancelled, "cancelled")
        );
        // Fallthrough.
        assert_eq!(
            classify_download_error("something unexpected"),
            (TilesErrorCategory::Unknown, "downloadFailed")
        );
    }

    #[test]
    fn parses_camelcase_manifest() {
        let raw = r#"{
            "schemaVersion": 1,
            "base": { "id": "base-world", "name": "World", "minZoom": 0, "maxZoom": 5, "sizeBytes": 100 },
            "packs": [
                { "id": "eu", "name": "Europe", "continent": "europe", "country": null,
                  "minZoom": 6, "maxZoom": 12, "sizeBytes": 200, "url": "https://x/eu.ompack" }
            ]
        }"#;
        let m = parse_manifest(raw).unwrap();
        assert_eq!(m.schema_version, 1);
        assert_eq!(m.base.id, "base-world");
        assert_eq!(m.packs.len(), 1);
        assert_eq!(m.packs[0].continent, "europe");
        assert!(m.packs[0].country.is_none());
    }

    #[test]
    fn rejects_unsupported_schema() {
        let raw = r#"{ "schemaVersion": 99, "base": { "id": "b", "name": "b",
            "minZoom": 0, "maxZoom": 1, "sizeBytes": 1 }, "packs": [] }"#;
        assert!(parse_manifest(raw).is_err());
    }

    #[test]
    fn tile_key_parsing() {
        assert_eq!(
            tile_key_from_path("/tiles/3/4/2.png").as_deref(),
            Some("3/4/2")
        );
        assert_eq!(
            tile_key_from_path("/tiles/3/4/2.png?v=1").as_deref(),
            Some("3/4/2")
        );
        assert_eq!(tile_key_from_path("/tiles/3/4").as_deref(), None);
        assert_eq!(tile_key_from_path("/tiles/a/b/c.png").as_deref(), None);
    }

    #[test]
    fn delete_rejects_unknown_or_traversal_pack_id() {
        // The delete/download commands gate on `is_known_pack` before deriving a
        // path, so a crafted `..`/absolute id can never reach `pack_path` /
        // `fs::remove_file` (path-traversal arbitrary `.ompack` deletion).
        let raw = r#"{
            "schemaVersion": 1,
            "base": { "id": "base-world", "name": "World", "minZoom": 0, "maxZoom": 5, "sizeBytes": 100 },
            "packs": [
                { "id": "eu", "name": "Europe", "continent": "europe", "country": null,
                  "minZoom": 6, "maxZoom": 12, "sizeBytes": 200, "url": "https://x/eu.ompack" }
            ]
        }"#;
        let m = parse_manifest(raw).unwrap();
        // A manifest id is accepted.
        assert!(is_known_pack(&m, "eu"));
        // Unknown / traversal / absolute ids are rejected.
        assert!(!is_known_pack(&m, "us"));
        assert!(!is_known_pack(&m, "../../../../etc/passwd"));
        assert!(!is_known_pack(&m, "/etc/hosts"));
        assert!(!is_known_pack(&m, "..\\..\\windows\\system32\\config"));
    }

    #[test]
    fn progress_percent_classifies_determinate_and_indeterminate() {
        // Known total -> determinate percent in [0,100].
        assert_eq!(progress_percent(0, 100), 0);
        assert_eq!(progress_percent(50, 100), 50);
        assert_eq!(progress_percent(100, 100), 100);
        // No Content-Length (total == 0) -> the -1 indeterminate sentinel.
        assert_eq!(progress_percent(64_000, 0), -1);
        assert_eq!(progress_percent(0, 0), -1);
    }

    #[test]
    fn progress_emits_on_byte_growth_without_content_length() {
        // Determinate downloads emit only when the integer percent changes.
        assert!(should_emit_progress(50, 49, 1000));
        assert!(!should_emit_progress(50, 50, 1000));
        // No Content-Length: pct stays -1 every read, so the bare
        // `pct != last_emit_pct` guard would never fire (-1 != -1 is false) and
        // the indeterminate bar would stay stuck. We must still emit so the UI
        // tracks the growing byte count.
        assert!(should_emit_progress(-1, -1, 0));
    }

    #[test]
    fn open_rejects_oversized_dir_len_before_allocating() {
        // magic + a dir_len far larger than the file. Without the size cap this
        // would `vec![0u8; dir_len]` (up to ~4 GiB) before failing; with the cap
        // it is rejected up front with a distinct error.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(OMPACK_MAGIC);
        bytes.extend_from_slice(&4_000_000u32.to_le_bytes()); // dir_len >> file
        bytes.extend_from_slice(b"{}"); // tiny actual body
        let tmp = std::env::temp_dir().join("omnilink-oversized-dirlen.ompack");
        fs::write(&tmp, &bytes).unwrap();
        let err = PackIndex::open(&tmp).unwrap_err();
        // Distinguishes the cap (rejects before alloc) from the unfixed path,
        // which would allocate then fail later with "read dir".
        assert!(
            err.contains("exceeds file size"),
            "expected size-cap rejection, got: {err}"
        );
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn read_tile_rejects_out_of_bounds_entry() {
        // Valid header, but a directory entry whose (offset,len) runs past EOF
        // (len = u64::MAX). The read must bail with None, never allocate len.
        let mut dir = HashMap::new();
        dir.insert("0/0/0".to_string(), (0u64, u64::MAX));
        let dir_json = serde_json::to_vec(&dir).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(OMPACK_MAGIC);
        bytes.extend_from_slice(&(dir_json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&dir_json);
        bytes.extend_from_slice(&[1, 2, 3]); // tiny blob
        let tmp = std::env::temp_dir().join("omnilink-oob-entry.ompack");
        fs::write(&tmp, &bytes).unwrap();
        let idx = PackIndex::open(&tmp).unwrap();
        assert_eq!(idx.read_tile("0/0/0"), None);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn ompack_listing_is_memoized_until_invalidated() {
        // The serve path memoizes the `.ompack` directory listing instead of
        // re-running `read_dir` per tile; the cache must survive between requests
        // yet still reflect packs added/removed once `invalidate_listing` fires
        // (the download-complete / delete hooks).
        let base = std::env::temp_dir().join("omnilink-listing-cache-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("a.ompack"), b"x").unwrap();
        fs::write(base.join("notes.txt"), b"x").unwrap(); // must be ignored
        let dirs = vec![base.clone()];

        let mgr = TileManager::default();
        let first = mgr.ompack_paths(&dirs);
        assert_eq!(first.len(), 1, "scan finds the pack, skips non-.ompack");
        assert!(first.iter().any(|p| p.ends_with("a.ompack")));

        // A pack added on disk is NOT seen while the listing stays cached — and
        // the very same Arc is handed back, proving no re-scan happened.
        fs::write(base.join("b.ompack"), b"x").unwrap();
        let cached = mgr.ompack_paths(&dirs);
        assert!(
            Arc::ptr_eq(&first, &cached),
            "cached listing reused verbatim"
        );
        assert_eq!(cached.len(), 1);

        // After invalidation the next request re-scans and reflects the new pack.
        mgr.invalidate_listing();
        let rescanned = mgr.ompack_paths(&dirs);
        assert_eq!(rescanned.len(), 2, "re-scan reflects the added pack");

        // A deletion is likewise reflected only after invalidation.
        fs::remove_file(base.join("a.ompack")).unwrap();
        mgr.invalidate_listing();
        let after_delete = mgr.ompack_paths(&dirs);
        assert_eq!(after_delete.len(), 1);
        assert!(after_delete.iter().any(|p| p.ends_with("b.ompack")));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ompack_roundtrip() {
        // Build a tiny in-memory .ompack and read a tile back.
        let mut dir = HashMap::new();
        dir.insert("0/0/0".to_string(), (0u64, 3u64));
        dir.insert("1/0/0".to_string(), (3u64, 2u64));
        let dir_json = serde_json::to_vec(&dir).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(OMPACK_MAGIC);
        bytes.extend_from_slice(&(dir_json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&dir_json);
        bytes.extend_from_slice(&[1, 2, 3, 4, 5]); // blob: tile0=[1,2,3], tile1=[4,5]

        let tmp = std::env::temp_dir().join("omnilink-test.ompack");
        fs::write(&tmp, &bytes).unwrap();
        let idx = PackIndex::open(&tmp).unwrap();
        assert_eq!(idx.read_tile("0/0/0"), Some(vec![1, 2, 3]));
        assert_eq!(idx.read_tile("1/0/0"), Some(vec![4, 5]));
        assert_eq!(idx.read_tile("9/9/9"), None);
        let _ = fs::remove_file(&tmp);
    }

    /// Build a minimal-but-valid `.ompack` (magic + 1-tile directory + blob) the
    /// streaming tests fetch from a local source.
    fn valid_ompack_bytes() -> Vec<u8> {
        let mut dir = HashMap::new();
        dir.insert("6/0/0".to_string(), (0u64, 3u64));
        let dir_json = serde_json::to_vec(&dir).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(OMPACK_MAGIC);
        bytes.extend_from_slice(&(dir_json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&dir_json);
        bytes.extend_from_slice(&[1, 2, 3]); // blob
        bytes
    }

    #[test]
    fn classify_pack_url_routes_by_scheme() {
        // Production CDN URLs stay on the HTTP path.
        assert_eq!(
            classify_pack_url("https://tiles.example.com/eu.ompack"),
            PackSource::Http
        );
        assert_eq!(
            classify_pack_url("http://localhost/eu.ompack"),
            PackSource::Http
        );
        // `file://` carries an absolute path resolved with no AppHandle.
        assert_eq!(
            classify_pack_url("file:///abs/path/eu.ompack"),
            PackSource::Local(PathBuf::from("/abs/path/eu.ompack"))
        );
        // `bundled:` carries a path relative to the resource tiles dir.
        assert_eq!(
            classify_pack_url("bundled:packs/europe-west.ompack"),
            PackSource::Bundled(PathBuf::from("packs/europe-west.ompack"))
        );
    }

    #[test]
    fn is_safe_bundled_rel_rejects_traversal() {
        // Plain relative paths under the resource tiles dir are allowed.
        assert!(is_safe_bundled_rel(Path::new("packs/europe-west.ompack")));
        assert!(is_safe_bundled_rel(Path::new("./base-world.ompack")));
        // Anything that could escape the dir is rejected.
        assert!(!is_safe_bundled_rel(Path::new("../secrets.ompack")));
        assert!(!is_safe_bundled_rel(Path::new("packs/../../etc/passwd")));
        assert!(!is_safe_bundled_rel(Path::new("/etc/passwd")));
    }

    #[test]
    fn stream_to_dest_persists_a_pack_from_a_local_source() {
        // Proves the download actually FETCH+PERSISTS from a LOCAL source (the
        // `bundled:`/`file://` path): given a valid local `.ompack`, after the
        // streaming core runs the destination `<id>.ompack` exists, opens via the
        // SAME `PackIndex` magic validation, the `.part` is gone (atomic rename),
        // and progress was reported — i.e. the offline pack download works.
        let bytes = valid_ompack_bytes();
        let base = std::env::temp_dir().join("omnilink-stream-persist");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let source = base.join("source.ompack");
        fs::write(&source, &bytes).unwrap();
        let dest = base.join("europe-west.ompack");

        // Drive through `open_local_source` (the `file://`/`bundled:` reader) so
        // both the source open + the streaming core are exercised end to end.
        let (mut src, total) = open_local_source(&source).unwrap();
        assert_eq!(total, bytes.len() as u64);
        let cancel = AtomicBool::new(false);
        let mut events: Vec<ProgressDto> = Vec::new();
        let n = stream_to_dest(&mut src, total, &dest, "europe-west", &cancel, &mut |dto| {
            events.push(dto)
        })
        .expect("local pack download should persist");

        assert_eq!(n, bytes.len() as u64, "all bytes copied");
        assert!(dest.exists(), "committed pack present on disk");
        assert!(
            PackIndex::open(&dest).is_ok(),
            "persisted pack passes magic validation"
        );
        assert!(
            !dest.with_extension("ompack.part").exists(),
            ".part renamed away (atomic commit)"
        );
        // A determinate source (known length) reports 100% at least once.
        assert!(!events.is_empty(), "progress was emitted");
        assert_eq!(events.last().unwrap().percent as i32, 100);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stream_to_dest_cancel_leaves_no_pack() {
        // A cancel observed before the first read aborts the copy: no committed
        // `.ompack`, and the `.part` scratch file is cleaned up.
        let bytes = valid_ompack_bytes();
        let base = std::env::temp_dir().join("omnilink-stream-cancel");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let dest = base.join("europe-west.ompack");

        let cancel = AtomicBool::new(true); // cancelled up front
        let mut reader: &[u8] = &bytes;
        let err = stream_to_dest(
            &mut reader,
            bytes.len() as u64,
            &dest,
            "europe-west",
            &cancel,
            &mut |_dto| {},
        )
        .unwrap_err();

        assert_eq!(err, "cancelled");
        assert!(!dest.exists(), "no pack committed on cancel");
        assert!(
            !dest.with_extension("ompack.part").exists(),
            ".part cleaned up on cancel"
        );

        let _ = fs::remove_dir_all(&base);
    }
}
