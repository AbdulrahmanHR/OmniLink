/**
 * Tauri API bridge utilities.
 *
 * Typed wrappers around the Rust `device` commands (M6-API) plus event
 * listeners for the connection lifecycle. Mirrors the DTOs emitted by
 * `src-tauri/src/commands/device.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { DeviceInfo } from "@/stores/device";
import type { ProfileSettings } from "@/lib/profileSettings";

/** An available serial port, as enumerated by the Rust `list_serial_ports`. */
export interface SerialPortInfo {
  path: string;
  vendorId?: number | null;
  productId?: number | null;
  manufacturer?: string | null;
  product?: string | null;
}

/** Payload of the `device://error` event. */
export interface DeviceErrorPayload {
  message: string;
  /** Emitting reader's generation — see {@link DeviceConnectedPayload}. */
  generation: number;
}

/**
 * Payload of the `device://connected` event: the device identity plus the
 * **generation** of the reader thread that produced it.
 *
 * Generations are issued by the Rust `DeviceManager`, one per reader. A reader
 * that is torn down (the bar's Cancel, a port switch, a flash takeover) can
 * still have an event in flight, so the store keeps a floor and drops anything
 * from a superseded generation — otherwise a cancelled connect could announce
 * itself as connected, or raise a scary `device://error`, after the UI had
 * already moved on.
 */
export interface DeviceConnectedPayload extends DeviceInfo {
  generation: number;
}

/**
 * Decoded CRSF GPS telemetry (frame `0x02`), nested in {@link LinkStats} as the
 * optional `gps` sub-object (M11). Values are the **raw scaled-integer wire
 * representation** — `src/lib/telemetry-crsf.ts` applies the scaling/offset to
 * obtain human units, mirroring how RSSI magnitudes are handled.
 */
export interface GpsTelemetry {
  /** Latitude, degrees × 1e7 (signed). */
  latitude: number;
  /** Longitude, degrees × 1e7 (signed). */
  longitude: number;
  /** Ground speed, km/h × 10. */
  groundSpeed: number;
  /** Heading, degrees × 100. */
  heading: number;
  /** Altitude in metres, offset by +1000 (real metres = value − 1000). */
  altitude: number;
  /** Number of satellites in the fix. */
  satellites: number;
}

/**
 * Decoded CRSF Link Statistics, emitted on `device://link-stats`.
 * Consumed by M7-API (telemetry); defined here so the contract is shared.
 */
export interface LinkStats {
  uplinkRssi1: number;
  uplinkRssi2: number;
  uplinkLinkQuality: number;
  uplinkSnr: number;
  activeAntenna: number;
  rfMode: number;
  uplinkTxPower: number;
  downlinkRssi: number;
  downlinkLinkQuality: number;
  downlinkSnr: number;
  /**
   * Latest GPS fix (M11). Absent/`null` on devices without a GPS module, so the
   * dashboard degrades gracefully rather than showing `0,0`.
   */
  gps?: GpsTelemetry | null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Enumerate attached serial ports for the connection picker. */
export function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

/**
 * Open `port` and start the CRSF handshake. Resolves once the reader thread is
 * spawned; the connection result arrives via the `device://*` events.
 *
 * Resolves with the new reader's generation (see
 * {@link DeviceConnectedPayload}), or `0` when the backend refused to open
 * anything because a disconnect — the bar's Cancel — landed while this connect
 * was still queued.
 */
export function connectDevice(port: string): Promise<number> {
  return invoke<number>("connect_device", { port });
}

/**
 * Tear down the active connection. Resolves with the highest reader generation
 * the backend has issued, so the store can raise its event floor above every
 * reader that could still have an event in flight.
 */
export function disconnectDevice(): Promise<number> {
  return invoke<number>("disconnect_device");
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Fired when the handshake yields a device's target name + firmware. */
export function onDeviceConnected(
  handler: (payload: DeviceConnectedPayload) => void
): Promise<UnlistenFn> {
  return listen<DeviceConnectedPayload>("device://connected", (event) =>
    handler(event.payload)
  );
}

/** Fired when the connection is torn down. */
export function onDeviceDisconnected(
  handler: () => void
): Promise<UnlistenFn> {
  return listen("device://disconnected", () => handler());
}

/** Fired on open/read/handshake failure. */
export function onDeviceError(
  handler: (payload: DeviceErrorPayload) => void
): Promise<UnlistenFn> {
  return listen<DeviceErrorPayload>("device://error", (event) =>
    handler(event.payload)
  );
}

/** Fired for each decoded Link Statistics frame (telemetry, M7-API). */
export function onLinkStats(
  handler: (stats: LinkStats) => void
): Promise<UnlistenFn> {
  return listen<LinkStats>("device://link-stats", (event) =>
    handler(event.payload)
  );
}

// ===========================================================================
// M8-API: firmware flashing engine.
//
// Typed wrappers around the Rust `flash` commands + `flash://*` event
// listeners, mirroring the DTOs emitted by `src-tauri/src/commands/flash.rs`
// and `src-tauri/src/flash/`.
// ===========================================================================

/** A firmware release as returned by `fetch_firmware_releases` (FR-FLASH-01). */
export interface FirmwareRelease {
  tag: string;
  name: string;
  changelog: string;
  publishedAt: string;
  /**
   * True for a pre-release/beta tag (`3.6.0-RC1`), set by the backend from
   * GitHub's flag OR the tag's own semver pre-release suffix. NOT decorative:
   * the wizard hides these by default and never labels one "Latest" (FWCHK-2).
   */
  prerelease: boolean;
}

/**
 * The `fetch_firmware_releases` payload: the release list plus its provenance.
 *
 * `releases` arrives sorted **semver-descending** from the backend (GitHub's own
 * order is newest-*created*-first, which puts a backported patch above a newer
 * minor), so index 0 is the highest version — not merely the newest one.
 */
export interface FirmwareReleaseList {
  releases: FirmwareRelease[];
  /**
   * True when GitHub was unreachable and this list came out of the in-process
   * cache. The UI must not badge a stale list "live" (FWCHK-7).
   */
  stale: boolean;
  /** Unix epoch ms of the fetch that produced `releases`, for "last updated …". */
  fetchedAt?: number | null;
}

/** Common no-compile options patched into the pre-built binary (FR-FLASH-03). */
export interface FlashOptionsPayload {
  /** SENSITIVE — hashed into the UID; never sent to the AI API. */
  bindingPhrase?: string;
  uid?: number[];
  useTraditionalBinding?: boolean;
  /** Sub-GHz regulatory-domain index (omitted for 2.4GHz). */
  domain?: number;
  tlmIntervalMs?: number;
  wifiSsid?: string;
  wifiPassword?: string;
  autoWifiIntervalS?: number;
  rxBaud?: number;
}

/** Identity snapshotted to an `.elrsp` backup before flashing (FR-FLASH-05). */
export interface BackupTargetPayload {
  targetName: string;
  /** `null` when the device reported no firmware version (see `DeviceInfo`). */
  firmwareVersion: string | null;
  /** `null` when the handshake could not classify the device (CONN-5). */
  deviceType: "TX" | "RX" | null;
  /**
   * Serial port the device was talking on, when there was one (a WiFi OTA has
   * none). Recorded in the snapshot so the user can tell which device it came
   * from; the backend writes `null` rather than guessing.
   */
  port?: string | null;
}

/** Full request consumed by the Rust `start_flash` command. */
export interface FlashRequestPayload {
  target: string;
  deviceType: "TX" | "RX";
  /**
   * The target's MCU family from the catalogue (`DeviceModel.mcu` in
   * `src/lib/elrsTargets.ts`), e.g. `"ESP32"` / `"ESP8285"`.
   *
   * Required for the serial (esptool) transports: the Rust engine derives both
   * the `--chip` argument and the flash offset from it — an ESP32 application
   * image must be written at `0x10000`, never at `0x0` (which would overwrite
   * the bootloader + partition table). Absent/unrecognised ⇒ the backend fails
   * closed with a `unknownMcu` flash error rather than guessing an offset.
   */
  mcu?: string | null;
  version: string;
  method: "wifi" | "uart" | "betaflight";
  port?: string | null;
  deviceIp?: string | null;
  /**
   * The connected device's TX/RX class for the flash guard (FR-FLASH-10).
   *
   * `null` means "no device connected, or its class could not be determined"
   * and is a MEANINGFUL value: the Rust guard abstains on `null` and blocks on a
   * concrete mismatch, so never substitute a default here (CONN-5/FWCHK-3).
   */
  connectedDeviceType?: "TX" | "RX" | null;
  /**
   * The connected device's identity as a CATALOGUE BUILD TARGET, for the
   * target-name guard (FR-FLASH-10), parallel to {@link connectedDeviceType}.
   *
   * TX-vs-RX is a two-value comparison, so it can never catch "right class,
   * wrong model" — this is what stops a Ranger image reaching a BetaFPV Nano TX
   * when the wizard's selection and the hardware disagree.
   *
   * NOT the raw CRSF name: that is a free-form display string ("BetaFPV 2400
   * TX") and the Rust guard compares build targets EXACTLY, so an unresolved
   * name would false-block correct flashes. Producers must run it through
   * `resolveConnectedTarget` (`src/lib/elrsTargets.ts`) — the catalogue only
   * exists on this side of the seam. `null` means "unknown / could not be
   * resolved"; the guard abstains on it, so never guess a value.
   */
  connectedTargetName?: string | null;
  options?: FlashOptionsPayload;
  backupTarget?: BackupTargetPayload | null;
  /**
   * M25: absolute path of a user-selected local firmware `.bin`. When set, the
   * Rust engine reads + safety-validates this file (size / integrity / TX-vs-RX
   * class / target alignment) before any erase/write and flashes it verbatim,
   * instead of downloading a GitHub release. Absent ⇒ the existing release path.
   */
  localFilePath?: string | null;
  /**
   * M19 Backpack signal (FR-FLASH-11b). When set, the engine fetches from the
   * Backpack firmware source instead of the main-ELRS path; absent ⇒ a normal
   * ELRS flash (existing shape unchanged). The target's Backpack role.
   */
  backpackKind?: "tx-backpack" | "vrx-backpack" | null;
  /**
   * The picked Backpack device's role, for the TX-Backpack↔VRX-Backpack
   * cross-type guard (FR-FLASH-10), parallel to {@link connectedDeviceType}.
   * Mismatch with {@link backpackKind} ⇒ the backend blocks the flash.
   */
  connectedBackpackKind?: "tx-backpack" | "vrx-backpack" | null;
}

/** Payload of `flash://progress` (FR-FLASH-07). */
export interface FlashProgressPayload {
  stage: "fetch" | "erase" | "write" | "verify" | "done";
  percent: number;
  etaSeconds?: number | null;
}

/** Payload of `flash://log` (FR-FLASH-06). */
export interface FlashLogPayload {
  line: string;
  isError: boolean;
}

/** Payload of `flash://error` (FR-FLASH-08/12). */
export interface FlashErrorPayload {
  category:
    | "wiring"
    | "driver"
    | "firmwareMismatch"
    | "networkTimeout"
    | "compilationError"
    | "unknown";
  /** i18n key suffix → `wizard.flash.errors.<summaryKey>`. */
  summaryKey: string;
  /** Raw, untranslated detail for the collapsible log. */
  detail: string;
  /** i18n key suffixes → `wizard.flash.recovery.<step>`. */
  recoverySteps: string[];
  /** Clipboard-ready diagnostic block. */
  diagnostic: string;
}

/**
 * Fetch the ExpressLRS firmware release list + changelog (FR-FLASH-01).
 *
 * Returns the list *and* its provenance ({@link FirmwareReleaseList}) so the
 * wizard can tell a live fetch from a cache served after GitHub was unreachable
 * (FWCHK-7). A bare array from an older mock is accepted and read as a fresh
 * list, so test doubles that predate the provenance wrapper keep working.
 */
export async function fetchFirmwareReleases(): Promise<FirmwareReleaseList> {
  const payload = await invoke<FirmwareReleaseList | FirmwareRelease[]>(
    "fetch_firmware_releases"
  );
  return Array.isArray(payload)
    ? { releases: payload, stale: false, fetchedAt: null }
    : payload;
}

/**
 * Why {@link fetchFirmwareReleases} failed — coarse enough to pick one line of
 * UI copy. This is the set the wizard renders, NOT the full set Rust can send:
 * see {@link ReleaseFetchError.kind}.
 */
export type ReleaseFetchReason = "rateLimited" | "offline" | "unknown";

/** Rejection payload of `fetch_firmware_releases` (Rust `ReleaseFetchError`). */
export interface ReleaseFetchError {
  /**
   * Mirrors the Rust `FetchFailureKind`, which carries kinds with no UI copy of
   * their own — `redirectRefused` (the pinned redirect policy refused to leave
   * github.com) exists so the LOG can name the cause; it degrades to
   * `"unknown"` here rather than to `"offline"`, whose "check your network"
   * copy would be exactly as wrong as before.
   */
  kind: ReleaseFetchReason | "redirectRefused";
  /** Raw, untranslated detail — for the log, never the user-facing copy. */
  detail: string;
}

/**
 * Read the coarse reason out of a rejected release fetch.
 *
 * The wizard used to `.catch(() => …)` and render "Offline — couldn't reach
 * ExpressLRS GitHub" for every failure, including the most common real one: a
 * GitHub 403, where the network is fine and the remedy is to wait out the
 * 60-request/hour unauthenticated quota. Anything that isn't a recognised
 * discriminant (an older mock rejecting with a bare string, a thrown Error)
 * degrades to `"unknown"`, which keeps the existing offline copy.
 */
export function releaseFetchReason(err: unknown): ReleaseFetchReason {
  const kind = (err as Partial<ReleaseFetchError> | null | undefined)?.kind;
  return kind === "rateLimited" || kind === "offline" ? kind : "unknown";
}

/**
 * Derive the real ExpressLRS 6-byte binding UID from a phrase (FR-FLASH-03).
 *
 * Wraps the Rust `derive_uid` command (MD5 of `-DMY_BINDING_PHRASE="<phrase>"`),
 * so the UID shown in the wizard equals the UID actually flashed. The phrase is
 * SENSITIVE — never logged or sent to the AI API (NFR-PRIV-01).
 */
export function deriveUid(phrase: string): Promise<number[]> {
  return invoke<number[]>("derive_uid", { phrase });
}

/**
 * Start flashing. Resolves once the worker thread is spawned; progress and the
 * final outcome arrive via the `flash://*` events.
 */
export function startFlash(request: FlashRequestPayload): Promise<void> {
  return invoke("start_flash", { request });
}

/**
 * What a cancel request actually did (mirrors `CancelOutcome` in
 * `src-tauri/src/commands/flash.rs`).
 *
 * * `notRunning` — nothing was in flight (or the worker had already finished).
 * * `cancelled` — accepted; `flash://cancelled` follows.
 * * `writeInProgress` — **refused**: the device's flash is being rewritten and
 *   stopping half-way would brick it, so the flash runs to completion.
 */
export type FlashCancelOutcome = "notRunning" | "cancelled" | "writeInProgress";

/**
 * Cancel an in-progress flash. Resolves with what the backend actually did —
 * a cancel is refused once the write has begun (FLASH-4), so the caller must
 * not assume the flash stopped.
 */
export function cancelFlash(): Promise<FlashCancelOutcome> {
  return invoke<FlashCancelOutcome>("cancel_flash");
}

/**
 * Localized labels for the native firmware-file picker (M25). The seam stays
 * string-free; the calling component supplies translated copy so the OS dialog
 * is localized and no user-facing string is hardcoded here.
 */
export interface FirmwareFileDialogLabels {
  /** Dialog window title. */
  title: string;
  /** Display name for the `.bin` filter group. */
  filterName: string;
}

/**
 * M25: open the native file dialog so the user can pick a local firmware `.bin`
 * to flash (`@tauri-apps/plugin-dialog`). Resolves to the chosen absolute path,
 * or `null` if the user cancelled. Restricted to `.bin` files, single-select.
 */
export async function pickLocalFirmwareFile(
  labels: FirmwareFileDialogLabels
): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    title: labels.title,
    filters: [{ name: labels.filterName, extensions: ["bin"] }],
  });
  // `open` returns the path string (single-select) or `null` on cancel.
  return typeof selected === "string" ? selected : null;
}

/** Fired repeatedly as the flash advances through its stages. */
export function onFlashProgress(
  handler: (payload: FlashProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<FlashProgressPayload>("flash://progress", (event) =>
    handler(event.payload)
  );
}

/** Fired for each streamed build/upload log line. */
export function onFlashLog(
  handler: (payload: FlashLogPayload) => void
): Promise<UnlistenFn> {
  return listen<FlashLogPayload>("flash://log", (event) =>
    handler(event.payload)
  );
}

/** Fired once on successful completion. */
export function onFlashDone(handler: () => void): Promise<UnlistenFn> {
  return listen("flash://done", () => handler());
}

/**
 * Fired once when a flash is cancelled by the user (FR-FLASH — distinct from
 * an error). Lets the store land on idle without a spurious `flash://error`.
 */
export function onFlashCancelled(handler: () => void): Promise<UnlistenFn> {
  return listen("flash://cancelled", () => handler());
}

/** Fired once on failure, with category + recovery steps + diagnostic. */
export function onFlashError(
  handler: (payload: FlashErrorPayload) => void
): Promise<UnlistenFn> {
  return listen<FlashErrorPayload>("flash://error", (event) =>
    handler(event.payload)
  );
}

// ===========================================================================
// M12-API: offline map tiles (FR-TELEM-07).
//
// Typed wrappers around the Rust `tiles` commands + `tiles://*` event listeners
// for long-running pack downloads. Mirrors the DTOs emitted by
// `src-tauri/src/commands/tiles.rs`. Downloads use the event seam (not
// request-response), exactly like the flash engine: `download_tile_pack`
// resolves once the worker thread is spawned, and progress/done/error arrive on
// `tiles://*`.
//
// Tiles themselves are served to MapLibre out-of-band via the `omnitiles://`
// custom URI scheme registered in `lib.rs` — not through these commands.
// ===========================================================================

/**
 * A regional tile pack as reported by `list_tile_packs`. The static manifest
 * fields mirror {@link TilePack} in `src/lib/tile-packs.ts`; `downloaded` and
 * `onDiskBytes` are the live local-storage status the Rust side fills in.
 */
export interface TilePackStatus {
  id: string;
  name: string;
  continent: string;
  country: string | null;
  minZoom: number;
  maxZoom: number;
  sizeBytes: number;
  /** Whether the `.ompack` is present in local storage and ready to serve. */
  downloaded: boolean;
  /** Actual bytes on disk (0 when not downloaded). */
  onDiskBytes: number;
}

/** The bundled worldwide base set status (always present). */
export interface TileBaseStatus {
  id: string;
  name: string;
  minZoom: number;
  maxZoom: number;
  sizeBytes: number;
  /** Whether the bundled base `.ompack` resolved on disk / in resources. */
  available: boolean;
}

/** Full reply of `list_tile_packs`: base set + the downloadable packs. */
export interface TileInventory {
  base: TileBaseStatus;
  packs: TilePackStatus[];
}

/** Payload of `tiles://progress` — one in-flight pack download. */
export interface TileDownloadProgress {
  packId: string;
  /** 0–100; `-1` when total size is unknown (no Content-Length). */
  percent: number;
  receivedBytes: number;
  totalBytes: number;
}

/** Payload of `tiles://done` — a pack finished downloading. */
export interface TileDownloadDone {
  packId: string;
  onDiskBytes: number;
}

/**
 * Payload of `tiles://error` — a pack download failed (or was cancelled).
 *
 * M20: structured + categorized (mirrors `logs://error` / `FlashErrorPayload`).
 * `packId` is preserved so the consumer can clear that pack's progress.
 * The frontend renders `t(\`tiles.errors.${summaryKey}\`)` with
 * `t(\`tiles.errors.categories.${category}\`)` as the fallback.
 */
export interface TileDownloadError {
  packId: string;
  /** Coarse failure class — see `tiles.errors.categories.*`. */
  category: string;
  /** i18n key suffix → `tiles.errors.<summaryKey>`. */
  summaryKey: string;
  /** Raw, untranslated detail for diagnostics. */
  detail: string;
}

/** List the bundled base set + downloadable packs with local-storage status. */
export function listTilePacks(): Promise<TileInventory> {
  return invoke<TileInventory>("list_tile_packs");
}

/**
 * Start downloading a pack. Resolves once the worker thread is spawned; progress
 * and the final outcome arrive via the `tiles://*` events (mirrors `start_flash`).
 */
export function downloadTilePack(packId: string): Promise<void> {
  return invoke("download_tile_pack", { packId });
}

/** Cancel an in-progress pack download. */
export function cancelTilePackDownload(packId: string): Promise<void> {
  return invoke("cancel_tile_pack_download", { packId });
}

/** Delete a downloaded pack from local storage, reclaiming its disk space. */
export function deleteTilePack(packId: string): Promise<void> {
  return invoke("delete_tile_pack", { packId });
}

/** Fired repeatedly as a pack download advances. */
export function onTileDownloadProgress(
  handler: (payload: TileDownloadProgress) => void
): Promise<UnlistenFn> {
  return listen<TileDownloadProgress>("tiles://progress", (event) =>
    handler(event.payload)
  );
}

/** Fired once when a pack download completes successfully. */
export function onTileDownloadDone(
  handler: (payload: TileDownloadDone) => void
): Promise<UnlistenFn> {
  return listen<TileDownloadDone>("tiles://done", (event) =>
    handler(event.payload)
  );
}

/** Fired once when a pack download fails or is cancelled. */
export function onTileDownloadError(
  handler: (payload: TileDownloadError) => void
): Promise<UnlistenFn> {
  return listen<TileDownloadError>("tiles://error", (event) =>
    handler(event.payload)
  );
}

// ===========================================================================
// M14-API: flight log decode (FR-LOG-01).
//
// Typed wrappers around the Rust `logs` commands + `logs://*` event listeners
// for decoding a Betaflight blackbox `.bbl` log into CSV. Mirrors the DTOs
// emitted by `src-tauri/src/commands/logs.rs`. Decoding uses the event seam
// (not request-response), exactly like flash/tiles: `decodeBlackboxLog`
// resolves once the worker thread is spawned, and progress/log/done/error
// arrive on `logs://*`.
//
// csvPath-vs-csv decision: `@tauri-apps/plugin-fs` is NOT a dependency (checked
// package.json), so the frontend cannot read the decoded file off disk. Rather
// than adding an fs plugin, `logs://done` carries the decoded CSV text inline
// (`csv`) alongside its on-disk path (`csvPath`), so no filesystem access is
// needed to consume the result.
// ===========================================================================

/** Payload of `logs://progress` — decode advancement. */
export interface LogDecodeProgressPayload {
  /** 0–100. */
  percent: number;
  /** Coarse phase label (e.g. `"decoding"`); omitted when unknown. */
  stage?: string;
}

/** Payload of `logs://log` — one line of decoder output. */
export interface LogDecodeLogPayload {
  line: string;
  isError: boolean;
}

/** Payload of `logs://done` — decode finished successfully. */
export interface LogDecodeDonePayload {
  /** Path of the decoded `.csv` written alongside the input. */
  csvPath: string;
  /** Full decoded CSV text (returned inline; no fs plugin required). */
  csv: string;
}

/** Payload of `logs://error` — decode failed or was cancelled. */
export interface LogDecodeErrorPayload {
  category: string;
  summaryKey: string;
  detail: string;
}

/**
 * Decode a Betaflight blackbox `.bbl` log at `path` into CSV. Resolves once the
 * worker thread is spawned; progress + outcome arrive via `logs://*` events
 * (mirrors `startFlash` / `downloadTilePack`).
 */
export function decodeBlackboxLog(path: string): Promise<void> {
  return invoke("decode_blackbox_log", { path });
}

/** Cancel an in-progress blackbox decode. */
export function cancelBlackboxDecode(): Promise<void> {
  return invoke("cancel_blackbox_decode");
}

/** Fired repeatedly as a decode advances. */
export function onLogDecodeProgress(
  handler: (payload: LogDecodeProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<LogDecodeProgressPayload>("logs://progress", (event) =>
    handler(event.payload)
  );
}

/** Fired for each line of decoder stdout/stderr output. */
export function onLogDecodeLog(
  handler: (payload: LogDecodeLogPayload) => void
): Promise<UnlistenFn> {
  return listen<LogDecodeLogPayload>("logs://log", (event) =>
    handler(event.payload)
  );
}

/** Fired once when the decode completes successfully. */
export function onLogDecodeDone(
  handler: (payload: LogDecodeDonePayload) => void
): Promise<UnlistenFn> {
  return listen<LogDecodeDonePayload>("logs://done", (event) =>
    handler(event.payload)
  );
}

/** Fired once when the decode fails or is cancelled. */
export function onLogDecodeError(
  handler: (payload: LogDecodeErrorPayload) => void
): Promise<UnlistenFn> {
  return listen<LogDecodeErrorPayload>("logs://error", (event) =>
    handler(event.payload)
  );
}

// ---------------------------------------------------------------------------
// Config profile persistence (M17, FR-CFG-02). User profiles are stored as
// human-readable JSON files (one per profile) under the app config dir by
// `src-tauri/src/commands/config.rs`. Built-in + community presets are NOT
// persisted here — only user-created profiles. This is the seam that flips
// `stores/profiles.ts` from in-memory mock to real local file IO.
// ---------------------------------------------------------------------------

/**
 * The persistent shape of a user profile on disk. Mirrors `StoredProfileDto`
 * in `commands/config.rs` and the persistent fields of `ConfigProfile`.
 */
export interface StoredProfileDto {
  id: string;
  name: string;
  description?: string;
  settings: ProfileSettings;
  updatedAt: number;
}

/** Persist (create or overwrite) one user profile as a pretty-JSON file. */
export function saveProfile(profile: StoredProfileDto): Promise<void> {
  return invoke<void>("save_profile", { profile });
}

/** Load all persisted user profiles (empty array if none / dir absent). */
export function loadProfiles(): Promise<StoredProfileDto[]> {
  return invoke<StoredProfileDto[]>("load_profiles");
}

/** Delete one persisted user profile by id (no-op if already absent). */
export function deleteStoredProfile(id: string): Promise<void> {
  return invoke<void>("delete_profile", { id });
}

/**
 * Wipe every pre-flash device-config backup (`<app_data_dir>/backups`) for the
 * "Delete all my data" erase (NFR-PRIV-02). The `.elrsp` backups are the user's
 * own device config = personal data. A missing dir is a clean no-op backend-side.
 */
export function deleteAllBackups(): Promise<void> {
  return invoke<void>("delete_all_backups");
}

/**
 * Reveal `<app_data_dir>/backups` in the OS file manager (FLASH-5).
 *
 * The pre-flash `.elrsp` snapshots are written there before every flash; this is
 * how the user actually gets at one to import it from the Profiles page. The
 * directory is created backend-side if it does not exist yet.
 */
export function openBackupsFolder(): Promise<void> {
  return invoke<void>("open_backups_dir");
}

// ---------------------------------------------------------------------------
// M71-API: user-owned folder sync (decision D37).
//
// The zero-infrastructure replacement for the cloud sync deleted at `3.0.0`:
// `.elrsp` files in ONE directory the user picked. There is no server, no
// index, no manifest and no database — and, by construction, no network call on
// this path at all. If that directory happens to live in Dropbox / Drive /
// OneDrive / Syncthing / a git checkout, that tool does the syncing.
//
// These are the app's only filesystem commands, and unlike every other command
// here they are PLUGIN commands (`plugin:folder-sync|<name>`): Tauri's ACL only
// gates plugin commands, so this is what makes each one reachable solely via its
// `folder-sync:allow-*` permission in `src-tauri/capabilities/default.json`.
// See `folder_sync` in `src-tauri/src/commands/config.rs`.
// ---------------------------------------------------------------------------

/** Inlined-plugin name — mirrors `folder_sync::PLUGIN_NAME` on the Rust side. */
export const FOLDER_SYNC_PLUGIN = "folder-sync";

/** Fully-qualified IPC name of one folder-sync command. */
function folderSyncCommand(command: string): string {
  return `plugin:${FOLDER_SYNC_PLUGIN}|${command}`;
}

/** The result of granting a directory. Mirrors `FolderGrantDto`. */
export interface FolderGrantDto {
  /** Canonical path of the granted directory (shown back to the user). */
  path: string;
  /** How many `.elrsp` files are already in it. */
  fileCount: number;
}

/** One `.elrsp` file in the granted directory. Mirrors `FolderFileDto`. */
export interface FolderFileDto {
  /** File name including the `.elrsp` extension — the file IS the identity. */
  name: string;
  /** Last-modified time (ms since epoch), or 0 when the OS won't say. */
  modifiedAt: number;
  /** Size in bytes. */
  size: number;
}

/** Localized labels for the native folder dialog. */
export interface FolderDialogLabels {
  /** Dialog window title. */
  title: string;
}

/**
 * Open the native directory picker (`tauri-plugin-dialog`, already a
 * dependency — M71 adds none). Resolves to the chosen absolute path, or `null`
 * if the user cancelled.
 */
export async function pickSyncFolder(
  labels: FolderDialogLabels
): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: true,
    title: labels.title,
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Grant the picked directory to the backend for this session, REPLACING any
 * previous grant. Resolves to its canonical path + current `.elrsp` count.
 * Every other folder-sync command refuses until this has succeeded.
 */
export function grantSyncFolder(path: string): Promise<FolderGrantDto> {
  return invoke<FolderGrantDto>(folderSyncCommand("grant"), { path });
}

/** Forget the granted directory. Afterwards nothing in it is reachable. */
export function revokeSyncFolder(): Promise<void> {
  return invoke<void>(folderSyncCommand("revoke"));
}

/** List the `.elrsp` files in the granted directory (sorted by name). */
export function listSyncFolder(): Promise<FolderFileDto[]> {
  return invoke<FolderFileDto[]>(folderSyncCommand("list"));
}

/**
 * Read one `.elrsp` file's raw text. Parsing is the frontend's job (via
 * `lib/elrsp.ts`) so the format keeps exactly one implementation.
 */
export function readSyncFolderFile(name: string): Promise<string> {
  return invoke<string>(folderSyncCommand("read"), { name });
}

/** Write (create or overwrite) one `.elrsp` file in the granted directory. */
export function writeSyncFolderFile(
  name: string,
  contents: string
): Promise<FolderFileDto> {
  return invoke<FolderFileDto>(folderSyncCommand("write"), { name, contents });
}

/** Delete one `.elrsp` file from the granted directory (idempotent). */
export function deleteSyncFolderFile(name: string): Promise<void> {
  return invoke<void>(folderSyncCommand("delete"), { name });
}

// ===========================================================================
// M18-API: WiFi device discovery (FR-DISC-02 mDNS + self-AP) [HW].
//
// Typed wrappers around the Rust `wifi` commands + `wifi://*` event listeners,
// mirroring the DTOs emitted by `src-tauri/src/commands/wifi.rs`. Discovery is
// continuous/streaming (mDNS subnet scan + visible-SSID self-AP match), so it
// uses the event seam (not request-response) exactly like the flash/tiles
// engines: `startWifiScan` resolves once the scan worker is spawned, and each
// found device arrives on `wifi://discovered` (errors on `wifi://error`).
//
// A discovered device's `address` feeds the wizard's `deviceIp`, so the
// existing WiFi-OTA path (`flash/engine.rs` upload_wifi → http://{ip}/update,
// FR-FLASH-09) runs with no USB and no manually-typed IP. The serial seam
// (device.rs / stores/device.ts) is untouched — this is a parallel store.
//
// M19 boundary: the SSID matcher excludes Backpack/VRX SSIDs (those belong to
// M19, which extends this same scanner).
// ===========================================================================

/**
 * A discovered WiFi device, emitted on `wifi://discovered`. Mirrors `WifiDevice`
 * in `src/lib/wifiDiscovery.ts` and the camelCase `WifiDeviceDto` in
 * `commands/wifi.rs`.
 */
export interface WifiDeviceDto {
  /** Stable id: `${source}:${address}` (or ssid for AP). */
  id: string;
  /** SSID (AP) or mDNS instance name. */
  name: string;
  /** Host to reach the device HTTP API ("10.0.0.1" for AP; resolved IP for mDNS). */
  address: string;
  /** `"ap"` = self-AP (fresh WiFi-mode device); `"mdns"` = already on the LAN. */
  source: "ap" | "mdns";
  /**
   * Device role. M19 widens this with the two Backpack roles, emitted by the
   * parallel Backpack SSID classifier in `commands/wifi.rs` — a Backpack AP is a
   * DISTINCT kind here and is never admitted to the plain ELRS TX/RX list.
   */
  kind: "tx" | "rx" | "unknown" | "tx-backpack" | "vrx-backpack";
}

/**
 * Identity read back from a device's HTTP API by `probe_wifi_device` (reqwest
 * blocking GET). `reachable` is false when the device did not answer.
 */
export interface WifiDeviceIdentityDto {
  name: string;
  deviceType: "TX" | "RX";
  firmwareVersion?: string;
  reachable: boolean;
}

/**
 * Start the WiFi discovery scan (mDNS subnet + self-AP SSID). Idempotent;
 * resolves once the scan worker is spawned. Discovered devices arrive on
 * `wifi://discovered`, failures on `wifi://error`. A missing WiFi adapter /
 * scan tool / no devices yields no events (never an error) — graceful empty.
 *
 * `generation` is a frontend-supplied monotonic scan token threaded back into
 * the worker's `wifi://done` payload, so the store can ignore a stale `done`
 * from a cancelled older scan that exits while a newer scan is live.
 */
export function startWifiScan(generation: number): Promise<void> {
  return invoke<void>("start_wifi_scan", { generation });
}

/** Stop the WiFi discovery scan (sets the backend cancel flag). */
export function stopWifiScan(): Promise<void> {
  return invoke<void>("stop_wifi_scan");
}

/**
 * Probe a discovered device's HTTP API at `address` to confirm reachability and
 * read its identity (reqwest blocking GET). Resolves with `reachable:false`
 * rather than throwing when the device is offline.
 */
export function probeWifiDevice(
  address: string
): Promise<WifiDeviceIdentityDto> {
  return invoke<WifiDeviceIdentityDto>("probe_wifi_device", { address });
}

/** Fired once per discovered WiFi device during a scan. */
export function onWifiDiscovered(
  handler: (device: WifiDeviceDto) => void
): Promise<UnlistenFn> {
  return listen<WifiDeviceDto>("wifi://discovered", (event) =>
    handler(event.payload)
  );
}

/**
 * Payload of `wifi://error` — a genuine discovery failure (e.g. the mDNS
 * subsystem failed to initialize). M20: structured + categorized, mirroring
 * `logs://error` / `FlashErrorPayload`. Graceful degraded paths (no adapter,
 * no scan tool, no devices) emit NO event — only real failures arrive here.
 * The frontend renders `t(\`wifi.errors.${summaryKey}\`)` with
 * `t(\`wifi.errors.categories.${category}\`)` as the fallback.
 */
export interface WifiScanErrorPayload {
  /** Coarse failure class — see `wifi.errors.categories.*`. */
  category: string;
  /** i18n key suffix → `wifi.errors.<summaryKey>`. */
  summaryKey: string;
  /** Raw, untranslated detail for diagnostics. */
  detail: string;
}

/** Fired when the scan fails with a genuine error (e.g. mDNS init failure). */
export function onWifiScanError(
  handler: (payload: WifiScanErrorPayload) => void
): Promise<UnlistenFn> {
  return listen<WifiScanErrorPayload>("wifi://error", (event) =>
    handler(event.payload)
  );
}

// ===========================================================================
// M63: Controller Bridge discovery (v2.2 "Controller Bridge Mode") [HW].
//
// Typed wrappers around the Rust `probe_bridge` command, mirroring the DTOs
// emitted by `src-tauri/src/flash/bridge.rs`. READ-ONLY: the FC is a passthrough
// bridge endpoint only, never a managed device — only MSP GET probes are sent
// (FC_VARIANT/API_VERSION/FC_VERSION), never an `MSP_SET_*`.
//
// Request/response shape (like `probeWifiDevice`), NOT the streaming event seam:
// the caller awaits the classification directly. An ELRS RX speaking CRSF never
// answers MSP framing, so it resolves to `notAController` — the zero-false-
// positive outcome.
// ===========================================================================

/**
 * The flight-controller family behind a bridge candidate (camelCase, mirrors
 * `BridgeFamily` in `flash/bridge.rs`). `"unknown"` is an FC variant outside the
 * supported Betaflight/iNav set (D28) ⇒ surfaced as an unsupported bridge.
 */
export type BridgeFamilyDto = "betaflight" | "inav" | "unknown";

/**
 * A recognized controller-bridge candidate. Mirrors `BridgeCandidate` in
 * `flash/bridge.rs`. The FC is a transport endpoint only.
 */
export interface BridgeCandidateDto {
  family: BridgeFamilyDto;
  /** Raw 4-char FC variant id, e.g. `"BTFL"` / `"INAV"`. */
  fcVariant: string;
  /** `MSP_API_VERSION` as `"major.minor"`, when the FC answered (best-effort). */
  apiVersion?: string | null;
  /** `MSP_FC_VERSION` as `"major.minor.patch"`, when answered (best-effort). */
  fcVersion?: string | null;
}

/**
 * The outcome of probing a serial endpoint for a controller bridge. Mirrors the
 * internally-tagged `BridgeClassification` enum in `flash/bridge.rs`; switch on
 * `kind`:
 *  - `"bridge"` — a supported Betaflight/iNav controller usable as a bridge;
 *  - `"unsupportedBridge"` — answered MSP but with an unsupported variant (D28);
 *  - `"notAController"` — did not answer MSP framing (e.g. an ELRS RX on CRSF).
 */
export type BridgeClassificationDto =
  | ({ kind: "bridge" } & BridgeCandidateDto)
  | { kind: "unsupportedBridge"; reason: string }
  | { kind: "notAController" };

/**
 * Probe `port` for a Betaflight/iNav controller usable as a passthrough bridge
 * (READ-ONLY MSP handshake, baud-fallback across the common FC bauds). Resolves
 * with the {@link BridgeClassificationDto}; rejects only on an open failure
 * (busy/permission/missing port), which the caller maps to `bridge.recovery.*`.
 */
export function probeBridge(port: string): Promise<BridgeClassificationDto> {
  return invoke<BridgeClassificationDto>("probe_bridge", { port });
}

/**
 * Fired once when the scan worker finishes (the single-pass SSID scan + bounded
 * mDNS browse return), on EVERY exit path — normal completion AND cancellation.
 * Lets the store clear `scanning` on the Tauri happy path, which otherwise emits
 * no terminal event.
 *
 * The payload carries the originating scan's `generation` (the token passed to
 * {@link startWifiScan}), so the store can correlate a `done` to a specific
 * scan and ignore a stale one from a cancelled older worker.
 */
export function onWifiScanComplete(
  handler: (generation: number) => void
): Promise<UnlistenFn> {
  return listen<{ generation: number }>("wifi://done", (event) =>
    handler(event.payload.generation)
  );
}

// ===========================================================================
// M64: Passthrough diagnostics + wiring checks (v2.2 "Controller Bridge Mode").
//
// Typed wrappers around the Rust `run_passthrough_check` command, mirroring the
// DTOs emitted by `src-tauri/src/flash/bridge.rs`. EXTENDS the shipped
// `MSP_SET_PASSTHROUGH` transport path: a failed passthrough attempt becomes a
// SPECIFIC, actionable failure category (not a generic flash error).
//
// READ-ONLY: only the read-only `MSP_FC_VARIANT` GET and the in-scope
// `MSP_SET_PASSTHROUGH` transport command are sent — never an FC settings write.
// Request/response shape (like `probeBridge`): the caller awaits the report.
// ===========================================================================

/** One ordered step of the guided check (mirrors `PassthroughStep`). */
export type PassthroughStepDto = "handshake" | "uart" | "receiver" | "crsf";

/** Per-step status (mirrors `StepStatus`). */
export type PassthroughStepStatusDto = "pass" | "fail" | "skipped";

/**
 * A specific, actionable passthrough failure (mirrors `PassthroughFailure`).
 * Each maps to `bridge.passthrough.failure.<value>` copy + recovery guidance:
 *  - `controllerNotResponding` — step 1: no MSP reply;
 *  - `passthroughUnavailable`  — step 2: FC refused/can't passthrough;
 *  - `rxNotPowered`            — step 3: passthrough ok but zero RX bytes;
 *  - `rxNotWired`              — step 3: bytes back, not the RX on the UART;
 *  - `crsfTimeout`             — step 4: CRSF-shaped bytes, no valid frame in time.
 */
export type PassthroughFailureDto =
  | "controllerNotResponding"
  | "passthroughUnavailable"
  | "rxNotPowered"
  | "rxNotWired"
  | "crsfTimeout";

/** One step's outcome (mirrors `StepOutcome`). */
export interface PassthroughStepOutcomeDto {
  step: PassthroughStepDto;
  status: PassthroughStepStatusDto;
}

/**
 * The result of a guided passthrough check (mirrors `PassthroughCheckReport`).
 * `failure === null` ⇒ every step passed. `category`/`summaryKey` are the coarse
 * flash error category + i18n suffix derived in Rust (mirrors `FlashErrorPayload`),
 * so the frontend + M66 export read them authoritatively.
 */
export interface PassthroughCheckReportDto {
  steps: PassthroughStepOutcomeDto[];
  failure: PassthroughFailureDto | null;
  /** Coarse flash error category (e.g. `"wiring"`), or null on success. */
  category: string | null;
  /** i18n key suffix → `bridge.passthrough.failure.<summaryKey>`, or null. */
  summaryKey: string | null;
  /** The baud the check ran at (from the fallback loop). */
  baud: number | null;
  /** The FC UART index the user wired the RX to (diagnostic echo). */
  uart: number | null;
}

/**
 * Run the M64 guided passthrough check on `port` (READ-ONLY MSP GET +
 * `MSP_SET_PASSTHROUGH`, baud-fallback across the common FC bauds). `baudOverride`
 * picks which common rate to try FIRST; `uart` is the FC UART the RX is wired to,
 * echoed back into the report. Resolves with the {@link PassthroughCheckReportDto}
 * (including any failure category); rejects only on an open failure
 * (busy/permission/missing port), which the caller maps to recovery copy.
 */
export function runPassthroughCheck(
  port: string,
  baudOverride?: number,
  uart?: number
): Promise<PassthroughCheckReportDto> {
  return invoke<PassthroughCheckReportDto>("run_passthrough_check", {
    port,
    baudOverride: baudOverride ?? null,
    uart: uart ?? null,
  });
}

// ===========================================================================
// M65: Read-only controller context for ELRS troubleshooting (v2.2).
//
// Typed wrappers around the Rust `fetch_bridge_context` command, mirroring the
// DTOs emitted by `src-tauri/src/flash/bridge.rs`. READ-ONLY BY CONSTRUCTION:
// only read-only MSP GET ids (FC_VARIANT/API_VERSION/FC_VERSION/SERIAL_CONFIG)
// are sent — NEVER an `MSP_SET_*` (not even `MSP_SET_PASSTHROUGH`). The context
// surface is display-only and has ZERO write path to the flight controller.
//
// The returned DTO carries ONLY ELRS-passthrough-relevant fields (FC family/
// version + coarse serial-port metadata). When it is optionally folded into an
// Omnia payload, it passes through the Rust `sanitize_context()` redaction
// baseline first, so no serial numbers or identifiers ever leave.
// ===========================================================================

/**
 * Coarse metadata for one FC serial port (mirrors `SerialPortMeta`). Kept to ONLY
 * what helps explain an ELRS passthrough problem: a human-readable port label and
 * a coarse function. NO serial numbers, NO MAC/IP.
 */
export interface SerialPortMetaDto {
  /** Coarse port label, e.g. `"UART1"` / `"USB"`. */
  identifier: string;
  /** Coarse function: `"serialRx"`/`"msp"`/`"gps"`/`"telemetry"`/`"blackbox"`, or null. */
  function?: string | null;
}

/**
 * Read-only controller context for ELRS troubleshooting (mirrors
 * `BridgeContextDto`). Carries ONLY the FC family/version and coarse serial-port
 * metadata — never settings, never a config dump. An empty `serialPorts` (FC too
 * old or unparseable reply) drives the "not enough controller context" empty state.
 */
export interface BridgeContextDto {
  family: BridgeFamilyDto;
  /** Raw 4-char FC variant id (`"BTFL"`/`"INAV"`), when the FC answered. */
  fcVariant?: string | null;
  /** `MSP_API_VERSION` as `"major.minor"`, best-effort. */
  apiVersion?: string | null;
  /** `MSP_FC_VERSION` as `"major.minor.patch"`, best-effort. */
  fcVersion?: string | null;
  /** Coarse per-port metadata; empty when unavailable/unparseable. */
  serialPorts: SerialPortMetaDto[];
}

/**
 * Fetch READ-ONLY controller context from `port` for ELRS troubleshooting
 * (FC family/version + coarse serial-port metadata, baud-fallback across the
 * common FC bauds). Resolves with the {@link BridgeContextDto}; rejects when no
 * controller answers MSP framing (the "not enough context" case) or on an open
 * failure (busy/permission/missing port). Sends ONLY read-only MSP GETs — there
 * is no write path to the flight controller from this surface.
 */
export function fetchBridgeContext(port: string): Promise<BridgeContextDto> {
  return invoke<BridgeContextDto>("fetch_bridge_context", { port });
}
