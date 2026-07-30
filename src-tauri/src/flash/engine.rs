//! Flash orchestrator (FR-FLASH-03/05/06/07/08/10).
//!
//! [`run_flash`] drives the staged pipeline — pre-flight -> guard -> backup ->
//! fetch -> patch -> erase -> write -> verify -> done — emitting progress/log through a
//! [`FlashSink`]. All real-world side effects (HTTP, subprocess, serial) sit
//! behind [`FlashBackend`], so the happy path and failure paths are
//! integration-tested with an in-memory mock and no hardware (NFR-TEST-02).
//!
//! The production [`RealBackend`] performs the actual download/upload.
//!
//! There is no compile-from-source path: the `build_only` branch pointed at a
//! PlatformIO project directory nothing ever created, and skipped both the
//! options patch and the pre-flash image validation on the way to the device.
//! No caller ever set it, so it is gone (FLASH-13).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::flash::backup::{self, BackupTarget};
use crate::flash::cancel::{cancelled_error, FlashCancel};
use crate::flash::options::FlashOptions;
use crate::flash::validate::MAX_FIRMWARE_BYTES;
use crate::flash::{patch, DeviceType, ErrorCategory, FlashError, FlashMethod, FlashStage};

/// Everything the engine needs to run one flash. Deserialized from the frontend
/// `startFlash` payload (camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashRequest {
    /// ELRS build target id, e.g. `"BETAFPV_2400_TX"`.
    pub target: String,
    /// Target's device class (from the wizard catalogue).
    pub device_type: DeviceType,
    /// Firmware version/tag to flash.
    pub version: String,
    /// Transport.
    pub method: FlashMethod,
    /// Serial port for `uart`/`betaflight`.
    #[serde(default)]
    pub port: Option<String>,
    /// Device IP/host for `wifi` OTA.
    #[serde(default)]
    pub device_ip: Option<String>,
    /// Currently-connected device's type, for the TX/RX guard (FR-FLASH-10).
    #[serde(default)]
    pub connected_device_type: Option<DeviceType>,
    /// Currently-connected device's identity as a **catalogue build target**
    /// (e.g. `"BETAFPV_2400_TX"`), for the target-name guard (FR-FLASH-10),
    /// parallel to [`Self::connected_device_type`].
    ///
    /// Not the raw CRSF name: the handshake reports a free-form display string
    /// ("BetaFPV 2400 TX") and this guard compares build targets exactly, so the
    /// frontend resolves it through the target catalogue first
    /// (`resolveConnectedTarget` in `src/lib/elrsTargets.ts` — the catalogue
    /// does not exist on this side).
    ///
    /// `None`/blank ⇒ no evidence (unflashed board, bootloader, WiFi OTA, or a
    /// name the catalogue could not map) and the guard abstains — never
    /// substitute a default here.
    #[serde(default)]
    pub connected_target_name: Option<String>,
    /// M19 Backpack target role (FR-FLASH-11b). `Some` ⇒ fetch from the Backpack
    /// firmware source instead of main-ELRS; `None` ⇒ a normal ELRS flash. The
    /// existing shape is preserved (defaulted/optional).
    #[serde(default)]
    pub backpack_kind: Option<crate::flash::backpack::BackpackKind>,
    /// Connected Backpack device's role, for the TX-Backpack↔VRX-Backpack guard
    /// (FR-FLASH-10), parallel to `connected_device_type`.
    #[serde(default)]
    pub connected_backpack_kind: Option<crate::flash::backpack::BackpackKind>,
    /// Common no-compile options to patch into the binary.
    #[serde(default)]
    pub options: FlashOptions,
    /// Identity to snapshot before flashing (None -> skip backup).
    #[serde(default)]
    pub backup_target: Option<BackupTarget>,
    /// M25: absolute path of a user-selected local `.bin` to flash instead of a
    /// GitHub release. `Some` ⇒ the engine reads + validates this file (size /
    /// integrity / TX-vs-RX class / target alignment) in the fetch stage, BEFORE
    /// any erase/write, and flashes it verbatim (no options patch). `None` ⇒ the
    /// existing release-download / Backpack paths are unchanged.
    #[serde(default)]
    pub local_file_path: Option<String>,
    /// Target's MCU family, from the wizard catalogue's per-target `mcu`
    /// (`src/lib/elrsTargets.ts`), e.g. `"ESP32"` / `"ESP8285"`.
    ///
    /// The serial (esptool) path needs this: the `--chip` argument AND the write
    /// offset differ per family, and an ESP32 application image written at `0x0`
    /// overwrites the second-stage bootloader/partition table and bricks the
    /// device. Carried as the raw catalogue string (optional on the wire, so an
    /// older payload still deserializes) and resolved by
    /// [`McuFamily::from_catalogue`], which FAILS CLOSED on absent/unrecognised
    /// values instead of guessing an offset.
    #[serde(default)]
    pub mcu: Option<String>,
}

/// MCU family of a flash target, resolved from the catalogue's `mcu` string.
///
/// Selects both the esptool `--chip` argument and the flash offset the image is
/// written at:
/// * ESP32 — the application image lives at `0x10000`; `0x0` is the second-stage
///   bootloader and `0x8000` the partition table, so writing the app at `0x0`
///   destroys both and the device boot-loops unrecoverably from the app.
/// * ESP8285/ESP8266 — no separate bootloader/partition regions; the image is
///   written at `0x0` (the shipped behaviour, preserved exactly).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McuFamily {
    Esp32,
    Esp8266,
}

impl McuFamily {
    /// The esptool `--chip` argument for this family (never `auto`: chip
    /// autodetection cannot tell us which offset the image belongs at).
    pub fn esptool_chip(self) -> &'static str {
        match self {
            McuFamily::Esp32 => "esp32",
            McuFamily::Esp8266 => "esp8266",
        }
    }

    /// Flash offset the *application* image is written at, as an esptool
    /// argument.
    pub fn app_image_offset(self) -> &'static str {
        match self {
            McuFamily::Esp32 => "0x10000",
            McuFamily::Esp8266 => "0x0",
        }
    }

    /// Resolve a catalogue `mcu` string (case-insensitive) into a family.
    ///
    /// FAILS CLOSED (FR-FLASH-08/12): an absent, empty or unrecognised value —
    /// including an ESP32 variant we have no verified `--chip`/offset pair for
    /// (`ESP32-S3`, …) or a non-esptool MCU (`STM32`) — returns a categorised
    /// [`FlashError`] instead of defaulting to a guess that can brick hardware.
    pub fn from_catalogue(mcu: Option<&str>) -> Result<Self, FlashError> {
        let raw = mcu
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                FlashError::new(
                    ErrorCategory::FirmwareMismatch,
                    "unknownMcu",
                    "no MCU family was supplied for this target; refusing to guess a flash \
                     offset (an ESP32 image written at 0x0 destroys the bootloader)",
                )
            })?;
        match raw.to_ascii_uppercase().as_str() {
            "ESP32" => Ok(McuFamily::Esp32),
            "ESP8285" | "ESP8266" => Ok(McuFamily::Esp8266),
            other => Err(FlashError::new(
                ErrorCategory::FirmwareMismatch,
                "unknownMcu",
                format!(
                    "unsupported MCU family {other:?}; refusing to guess a flash offset \
                     (an ESP32 image written at 0x0 destroys the bootloader)"
                ),
            )),
        }
    }
}

/// Where the engine writes side artifacts. Resolved from Tauri's app-data dir
/// by the command layer; injected so tests can use a temp dir.
#[derive(Debug, Clone)]
pub struct FlashPaths {
    pub backups_dir: PathBuf,
    /// Directory the firmware image handed to esptool is staged in (FLASH-8).
    ///
    /// Deliberately NOT the system temp dir: `/tmp` is mode 1777, so any local
    /// user can pre-create or symlink a predictable name there — `fs::write`
    /// follows the symlink (arbitrary file overwrite) and, worse, the image can
    /// be swapped between the write and esptool opening it, flashing attacker
    /// bytes onto real hardware. The app-data dir lives under the user's own
    /// account, and the staged file itself is created `O_EXCL` + 0600 with a
    /// random name (see [`RealBackend::upload_uart`]).
    pub staging_dir: PathBuf,
}

/// Receives progress + log lines during a flash. Implemented by the Tauri
/// command layer (emits `flash://*` events) and by tests (collects events).
pub trait FlashSink: Send + Sync {
    /// Stage + 0..=100 percent. ETA, if any, is the sink's concern.
    fn progress(&self, stage: FlashStage, percent: f32);
    /// A raw log line; `is_error` marks stderr/diagnostic lines.
    fn log(&self, line: &str, is_error: bool);
}

/// The mockable boundary for all hardware/network/subprocess side effects.
pub trait FlashBackend {
    /// Step 0: check that everything this flash needs from the host is present,
    /// BEFORE anything is downloaded, backed up, or sent to the device
    /// (FLASH-12).
    ///
    /// Defaults to "nothing to check" so the in-memory test backends are
    /// unaffected; [`RealBackend`] probes for esptool here.
    fn preflight(&self, _req: &FlashRequest, _sink: &dyn FlashSink) -> Result<(), FlashError> {
        Ok(())
    }

    /// Stage `fetch`: obtain the firmware image — download the pre-built binary
    /// for this target/version. Should emit fetch-stage progress (0..25) via
    /// `sink`.
    fn acquire_firmware(
        &self,
        req: &FlashRequest,
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
    ) -> Result<Vec<u8>, FlashError>;

    /// Stages `erase`/`write`/`verify`: push `firmware` onto the device over the
    /// chosen transport, emitting 25..100 progress via `sink`.
    ///
    /// Implementations MUST take the point of no return
    /// ([`FlashCancel::enter_write`]) immediately before the first byte reaches
    /// the device, and abort with [`cancelled_error`] if it is refused.
    fn upload(
        &self,
        req: &FlashRequest,
        firmware: &[u8],
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
    ) -> Result<(), FlashError>;
}

/// Recovery-step i18n key suffixes for a failure category (FR-FLASH-12 (c)).
/// The UI renders `wizard.flash.recovery.<key>` for each.
pub fn recovery_keys(category: ErrorCategory) -> &'static [&'static str] {
    match category {
        ErrorCategory::Wiring => &["checkUsb", "reconnect", "bootloaderMode"],
        ErrorCategory::Driver => &["installDriver", "checkPermissions", "linuxUdev"],
        ErrorCategory::FirmwareMismatch => &["verifyTarget", "verifyDeviceType"],
        ErrorCategory::NetworkTimeout => &["checkNetwork", "retry", "deviceWifiMode"],
        ErrorCategory::CompilationError => &["checkPlatformio", "viewLog", "reportIssue"],
        ErrorCategory::Unknown => &["retry", "viewLog"],
    }
}

/// Recovery steps for one concrete failure, in the order the UI renders them.
///
/// Defaults to the failure's category ([`recovery_keys`]). A few summary keys
/// have a fix that is *more specific* than their whole category, and the generic
/// steps there are actively misleading — `firmwareNotAvailableForTarget`
/// (FWCHK-4) is one: the brand/model pick is fine, that **version** simply has
/// no build for it, so the user needs "choose a different version", not "confirm
/// your brand and model" and certainly not "check your internet connection".
pub fn recovery_keys_for(err: &FlashError) -> &'static [&'static str] {
    match err.summary_key.as_str() {
        "firmwareNotAvailableForTarget" => &["chooseAnotherVersion", "verifyTarget"],
        // Neither of these is a brand/model mistake, so the FirmwareMismatch
        // category's "confirm your brand and model" steps are noise: the artifact
        // host served something we refuse to trust (a body past the size ceiling,
        // or a redirect off the pinned domain).
        "firmwareDownloadTooLarge" | "firmwareRedirectRefused" => {
            &["chooseAnotherVersion", "reportIssue"]
        }
        // FLASH-6: the failure landed at or after the write, so the image on the
        // device may be incomplete. "Check your network and retry" (the
        // NetworkTimeout default a failed OTA would otherwise get) is actively
        // dangerous advice here — the only safe next step is another flash.
        PARTIAL_WRITE_KEY => &["reflashDevice", "keepDevicePowered", "viewLog"],
        // The tool is missing, not misbehaving: installing it is the fix, and
        // the Driver category's driver/permissions/udev steps are noise.
        "esptoolNotFound" => &["installEsptool", "reportIssue"],
        // The FC answered and refused (`$M!`). Nothing is wrong with the cable
        // OR with the brand/model pick, so neither the Wiring steps nor the
        // FirmwareMismatch category's "confirm your brand and model" applies —
        // the fix is in the flight controller's own configuration.
        crate::flash::msp::PASSTHROUGH_UNAVAILABLE_KEY => {
            &["configureFcUart", "updateFcFirmware", "flashOverUsb"]
        }
        _ => recovery_keys(err.category),
    }
}

/// Summary key for a failure that landed at or after [`FlashStage::Write`]
/// (FLASH-6). The device may hold a partially-written image, so the UI must say
/// "flash again before using it", not "retry".
pub const PARTIAL_WRITE_KEY: &str = "deviceMayBePartiallyWritten";

/// Summary keys that reach the write stage without a single byte being sent to
/// the device, and therefore must NOT be escalated to [`PARTIAL_WRITE_KEY`].
///
/// `platformio::run_streaming` announces its stage *before* spawning the child
/// (so the UI never lags the process it describes), which means a flash that
/// dies because the tool is missing or unspawnable has still "reached" the write
/// stage. Those two are exactly the cases where the child never existed; every
/// other failure means esptool/the OTA endpoint was actually talking to the
/// device and we cannot know how far it got. `cancelled` is not a failure at
/// all — a cancel is refused past the point of no return, so one can only be
/// pending when the device was never touched.
const NEVER_TOUCHED_THE_DEVICE: [&str; 3] = ["toolNotFound", "spawnFailed", "cancelled"];

/// Escalate an upload failure that could have left a half-written device
/// (FLASH-6).
///
/// `furthest` is the last stage the backend reported through [`StageTracker`].
/// Pure so the whole policy — including the "never touched the device"
/// exclusions — is unit-tested without hardware.
fn escalate_after_write(furthest: Option<FlashStage>, err: FlashError) -> FlashError {
    let reached_write = furthest.is_some_and(|s| s >= FlashStage::Write);
    if !reached_write || NEVER_TOUCHED_THE_DEVICE.contains(&err.summary_key.as_str()) {
        return err;
    }
    FlashError::new(
        err.category,
        PARTIAL_WRITE_KEY,
        format!(
            "the flash failed after writing to the device had already begun, so its firmware \
             may be incomplete — flash it again before using it. Underlying failure \
             [{}]: {}",
            err.summary_key, err.detail
        ),
    )
}

/// [`FlashSink`] decorator that remembers the furthest stage a run reported.
///
/// The engine hands this to the backend instead of the caller's sink, so the
/// pipeline can tell a failure that never touched the device from one that
/// happened with a write already in flight ([`escalate_after_write`]) without
/// the backends having to report it themselves. Everything is forwarded
/// verbatim; the only added behaviour is the high-water mark.
struct StageTracker<'a> {
    inner: &'a dyn FlashSink,
    furthest: std::sync::Mutex<Option<FlashStage>>,
}

impl<'a> StageTracker<'a> {
    fn new(inner: &'a dyn FlashSink) -> Self {
        Self {
            inner,
            furthest: std::sync::Mutex::new(None),
        }
    }

    /// The furthest stage reported so far, or `None` if nothing was reported.
    fn furthest(&self) -> Option<FlashStage> {
        *self.furthest.lock().unwrap()
    }
}

impl FlashSink for StageTracker<'_> {
    fn progress(&self, stage: FlashStage, percent: f32) {
        {
            let mut furthest = self.furthest.lock().unwrap();
            if furthest.is_none_or(|f| stage > f) {
                *furthest = Some(stage);
            }
        }
        self.inner.progress(stage, percent);
    }

    fn log(&self, line: &str, is_error: bool) {
        self.inner.log(line, is_error);
    }
}

/// Upstream names for the ESP flashing tool, in probe order (FLASH-12). The
/// classic pip install ships `esptool.py`; newer packaging ships `esptool`.
const ESPTOOL_PROGRAMS: [&str; 2] = ["esptool", "esptool.py"];

/// Whether `method` shells out to esptool. WiFi OTA is pure HTTP and needs no
/// local tool at all, so it must never be blocked by a missing one.
fn method_needs_esptool(method: FlashMethod) -> bool {
    match method {
        FlashMethod::Uart | FlashMethod::Betaflight => true,
        FlashMethod::Wifi => false,
    }
}

/// The "esptool is not installed" failure, with an actionable install hint.
///
/// Nothing about it is bundled: `tauri.conf.json` declares no sidecar and no
/// esptool resource, so the tool has to come from the user's own environment —
/// which means saying so, and saying how to get it, instead of the bare
/// "required tool `esptool` was not found on PATH" the spawn path produced deep
/// inside the upload.
fn esptool_missing_error() -> FlashError {
    FlashError::new(
        ErrorCategory::Driver,
        "esptoolNotFound",
        format!(
            "none of {} could be started — install esptool (`pip install esptool`, or your \
             platform's package) and make sure it is on your PATH, then try again; nothing \
             was written to your device",
            ESPTOOL_PROGRAMS.join(" / ")
        ),
    )
}

/// Resolve the esptool program name, or fail with the install hint (FLASH-12).
///
/// Called from [`RealBackend::preflight`] — step 0 of [`run_flash`], before the
/// backup is written, before a single byte is downloaded and before the device
/// is touched — because the shipped behaviour was to discover the missing tool
/// only at spawn time, i.e. after all of that work had already been done.
fn resolve_esptool() -> Result<&'static str, FlashError> {
    crate::platformio::resolve_program(&ESPTOOL_PROGRAMS).ok_or_else(esptool_missing_error)
}

/// Categorise a failed firmware **download** (FWCHK-4).
///
/// `reqwest`'s `error_for_status()` fires on a 404 exactly as `send()` does on a
/// timeout, and the artifactory URL is built blind from `{version}/{target}` with
/// nothing checking that a build exists for that pair. Mapping every one of them
/// to [`ErrorCategory::NetworkTimeout`] told a user who picked a version with no
/// build for their device to check their network and retry — a retry that can
/// never succeed, because the file does not exist.
///
/// So a 404 becomes [`ErrorCategory::FirmwareMismatch`] with its own summary key
/// (recovery: pick a different version/target). Everything else — connect
/// failures, timeouts, 5xx, and any other status — keeps the network mapping,
/// because those genuinely can succeed on a retry.
///
/// `redirect_refused` is the [`crate::flash::pinned_redirect_policy`] verdict:
/// the host answered, but pointed us off the pinned domain or down to plaintext.
/// That is not a flaky network — "check your connection and retry" would send
/// the user round a loop that can only end the same way — so it gets its own
/// key naming the refusal.
///
/// Pure in `status` so the mapping is unit-tested without a socket; the caller
/// passes `e.status()`, `e.is_redirect()` and `e.to_string()`.
fn download_failure(
    url: &str,
    version: &str,
    target: &str,
    status: Option<u16>,
    redirect_refused: bool,
    detail: &str,
) -> FlashError {
    if status == Some(404) {
        return FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "firmwareNotAvailableForTarget",
            format!(
                "no {version} build is published for target {target} \
                 ({url} returned 404); nothing was written to your device"
            ),
        );
    }
    if redirect_refused {
        return FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "firmwareRedirectRefused",
            format!(
                "{url} redirected off https://{FIRMWARE_DOMAIN}; refusing to download firmware \
                 from an unexpected location ({detail})"
            ),
        );
    }
    FlashError::new(
        ErrorCategory::NetworkTimeout,
        "firmwareDownloadFailed",
        format!("could not download {url}: {detail}"),
    )
}

/// Refuse a download whose body exceeds [`MAX_FIRMWARE_BYTES`] (FLASH-14).
///
/// Shared by the pre-allocation check and the per-chunk check so both report the
/// same thing; `seen` is the declared length in the first case and the bytes
/// accumulated so far in the second.
fn oversize_download_error(url: &str, seen: u64) -> FlashError {
    FlashError::new(
        ErrorCategory::FirmwareMismatch,
        "firmwareDownloadTooLarge",
        format!(
            "{url} is {seen} bytes — larger than the {MAX_FIRMWARE_BYTES}-byte ceiling for a \
             firmware image; download abandoned and nothing was written to your device"
        ),
    )
}

/// Abort the pipeline when an accepted cancel is pending (FLASH-4).
///
/// Called at every step boundary in [`run_flash`]: the long, blocking steps
/// (the firmware download) cannot be interrupted from the inside, so the
/// flag they leave behind has to be honoured *between* steps — otherwise a
/// cancel during the download still ends with the device being written.
/// Returns the shared [`cancelled_error`] so the command layer reports
/// `flash://cancelled`, never `flash://error`.
fn abort_if_cancelled(cancel: &Arc<FlashCancel>, sink: &dyn FlashSink) -> Result<(), FlashError> {
    if cancel.is_cancelled() {
        sink.log("Flash cancelled — the device was not written", false);
        return Err(cancelled_error());
    }
    Ok(())
}

/// Run the full flash pipeline. Emits progress/log via `sink`; returns `Ok` on
/// success or a categorised [`FlashError`] the caller turns into `flash://error`.
pub fn run_flash(
    req: &FlashRequest,
    paths: &FlashPaths,
    backend: &dyn FlashBackend,
    outer_sink: &dyn FlashSink,
    cancel: &Arc<FlashCancel>,
) -> Result<(), FlashError> {
    // Everything below reports through the tracker, so the pipeline knows how
    // far a failed run got (FLASH-6). It forwards to the caller's sink verbatim.
    let tracker = StageTracker::new(outer_sink);
    let sink: &dyn FlashSink = &tracker;

    sink.log(
        &format!(
            "Starting flash: target={} version={} method={:?} [{}]",
            req.target,
            req.version,
            req.method,
            req.options.redacted_summary()
        ),
        false,
    );

    // 0. Pre-flight host check (FLASH-12). esptool is neither bundled nor on
    //    every machine, and the shipped code only found that out when the
    //    uploader spawned it — after the guard, the pre-flash backup AND the
    //    whole firmware download had already run. Probe first, fail fast with an
    //    install hint, and touch nothing.
    backend.preflight(req, sink)?;

    // 1. TX/RX guard (FR-FLASH-10) — before we touch the device.
    crate::flash::guard::check_target_compatibility(req.connected_device_type, req.device_type)?;

    // 1a. Target-NAME guard (FR-FLASH-10). TX-vs-RX is a two-value comparison,
    //     so every TX target clears it on every TX device; the connected
    //     device's own name is the only thing that catches "right class, wrong
    //     model" (a Ranger image aimed at a BetaFPV Nano TX). Abstains whenever
    //     either name is unknown.
    crate::flash::guard::check_connected_target_name(
        req.connected_target_name.as_deref(),
        &req.target,
    )?;

    // 1b. Backpack cross-type/cross-FAMILY guard (FR-FLASH-10). Runs
    //     unconditionally, not just when a Backpack target was picked: gating it
    //     on `req.backpack_kind` meant a main-ELRS image aimed at a discovered
    //     Backpack never reached it. Reuses the same FirmwareMismatch
    //     abort-before-touch.
    crate::flash::backpack::check_backpack_family(req.connected_backpack_kind, req.backpack_kind)?;

    // 2. Back up the current config first (FR-FLASH-05). If we can't write a
    //    backup we refuse to flash — better to stop than to overwrite an
    //    unrecoverable config (NFR-REL-01).
    if let Some(target) = &req.backup_target {
        let ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let doc = backup::build_backup_document(target, ts);
        match backup::write_backup(&paths.backups_dir, &doc, ts) {
            Ok(path) => sink.log(
                &format!("Backed up current config to {}", path.display()),
                false,
            ),
            Err(e) => {
                return Err(FlashError::new(
                    ErrorCategory::Unknown,
                    "backupFailed",
                    format!("could not write pre-flash backup: {e}"),
                ));
            }
        }
    }

    // 3. Fetch the image (stage: fetch, 0..25).
    abort_if_cancelled(cancel, sink)?;
    sink.progress(FlashStage::Fetch, 0.0);
    let mut firmware = if let Some(path) = &req.local_file_path {
        // M25 local-file path: read the user-selected `.bin` and run the
        // pre-flash safety gate (size / integrity / TX-vs-RX class / target
        // alignment) HERE — in the fetch stage, before the upload below ever
        // erases or writes the device. A mismatched/corrupt file returns a
        // categorised `FirmwareMismatch` and the device is never touched.
        sink.log(&format!("Reading local firmware file {path}"), false);
        let bytes = std::fs::read(path).map_err(|e| {
            FlashError::new(
                ErrorCategory::FirmwareMismatch,
                "localFileUnreadable",
                format!("could not read local firmware file {path}: {e}"),
            )
        })?;
        let info = crate::flash::validate::validate_local_firmware(
            &bytes,
            &req.target,
            req.device_type,
            req.connected_device_type,
        )?;
        sink.log(
            &format!(
                "Local firmware validated: {} ({} bytes)",
                info.target_name.as_deref().unwrap_or("unidentified target"),
                info.size
            ),
            false,
        );
        sink.progress(FlashStage::Fetch, 20.0);
        bytes
    } else {
        // FLASH-2/FWCHK-5: bytes that came off the network were, until now, fed
        // straight to `patch_binary` + upload with no check at all — a truncated
        // download, an HTML error page, or a release asset built for a DIFFERENT
        // target would be written to the device. There is no publishable digest
        // to compare against (the GitHub release list carries no asset hash and
        // the artifactory base URL publishes no manifest we read), so hashing is
        // NOT available here; instead the downloaded image goes through exactly
        // the same pre-flash gate as a user-picked local `.bin` — size sanity,
        // ELRS options-region integrity, TX-vs-RX class and target-name
        // alignment — in the fetch stage, before any erase/write. The truncation
        // check that IS available at the HTTP layer (declared `Content-Length`
        // vs bytes received) lives in `RealBackend::acquire_firmware`.
        let bytes = backend.acquire_firmware(req, sink, cancel)?;
        // One deliberate skip, because the check would be semantically wrong
        // rather than merely inconvenient: a `backpack_kind` image is a
        // different firmware family with NO ExpressLRS options region and no
        // ELRS target string, so `inspect_firmware` would reject every one of
        // them as `notElrsFirmware`.
        if req.backpack_kind.is_none() {
            let info = crate::flash::validate::validate_local_firmware(
                &bytes,
                &req.target,
                req.device_type,
                req.connected_device_type,
            )?;
            sink.log(
                &format!(
                    "Firmware image validated: {} ({} bytes)",
                    info.target_name.as_deref().unwrap_or("unidentified target"),
                    info.size
                ),
                false,
            );
        }
        bytes
    };

    // 4. Binary options patch — the common no-compile case. Backpack flashes are
    //    skipped: the bundled Backpack image is a placeholder with no ELRS
    //    options region, and `req.options` is the ELRS option set (binding
    //    phrase/UID/domain), not the Backpack settings — so the placeholder
    //    flows straight to upload (reuse `upload_wifi` verbatim, no fork), as
    //    the M19 design intends. A local file is flashed VERBATIM too (M25): the
    //    user supplied that exact image, so we never rewrite its options region.
    //
    //    The fetch above is a blocking download that cannot be interrupted from
    //    the inside, so a cancel raised during it is honoured HERE — before the
    //    image is touched and, crucially, before step 5 ever reaches the device.
    abort_if_cancelled(cancel, sink)?;
    if req.backpack_kind.is_none() && req.local_file_path.is_none() {
        let discriminator = derive_discriminator(req);
        let options_json = serde_json::to_vec(&req.options.to_options_json(discriminator))
            .map_err(|e| FlashError::new(ErrorCategory::Unknown, "optionsEncode", e.to_string()))?;
        patch::patch_binary(&mut firmware, &options_json)?;
        sink.log("Applied options patch to firmware image", false);
    }
    sink.progress(FlashStage::Fetch, 25.0);

    // 5. Upload — erase/write/verify (25..100) via the transport backend. Last
    //    boundary at which a cancel is still free: past this point the backend
    //    takes the point of no return (`FlashCancel::enter_write`) and a cancel
    //    is refused rather than left to interrupt a live write.
    abort_if_cancelled(cancel, sink)?;
    // FLASH-6: a failure from here on may have left a partially-written image on
    // the device, and the generic per-category advice ("check your network and
    // retry") is the wrong thing to tell that user. The furthest stage the
    // backend reported decides.
    backend
        .upload(req, &firmware, sink, cancel)
        .map_err(|e| escalate_after_write(tracker.furthest(), e))?;

    // 6. Done.
    sink.progress(FlashStage::Done, 100.0);
    sink.log("Flash complete", false);
    Ok(())
}

/// A non-zero flash discriminator the device uses to detect a fresh patch.
/// Derived deterministically from target+version+UID so a re-flash with the
/// same inputs is reproducible, but differs across configs.
fn derive_discriminator(req: &FlashRequest) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            h ^= b as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
    };
    mix(req.target.as_bytes());
    mix(req.version.as_bytes());
    if let Some(uid) = req.options.resolved_uid() {
        mix(&uid);
    }
    h | 1 // ensure non-zero
}

// ---------------------------------------------------------------------------
// Production backend.
// ---------------------------------------------------------------------------

/// Base URL for pre-built per-target firmware binaries. The ELRS firmware
/// distribution is the integration point here; centralised so it can be pointed
/// at the real artifact host without touching the engine.
const FIRMWARE_BASE_URL: &str = "https://artifactory.expresslrs.org/ExpressLRS";

/// The only domain [`FIRMWARE_BASE_URL`] — and any redirect off it — may
/// resolve to. Subdomains are allowed (the artifact host may front a CDN);
/// anything else is refused rather than followed, because the downloaded image
/// carries no digest to catch a substitution after the fact.
/// Kept honest against [`FIRMWARE_BASE_URL`] by `the_firmware_url_stays_on_the_pinned_domain`.
const FIRMWARE_DOMAIN: &str = "expresslrs.org";

/// Time allowed to establish the TCP+TLS connection to [`FIRMWARE_DOMAIN`].
/// Separate from [`FIRMWARE_READ_TIMEOUT`] so an unreachable host fails fast
/// without also capping how long the body may legitimately take.
const FIRMWARE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Idle window for the streamed download: the longest gap allowed **between**
/// chunks, not a deadline for the whole transfer.
///
/// reqwest's blocking `ClientBuilder` has no `read_timeout` (0.13 exposes it on
/// the async builder only), but its blocking `timeout` is applied per await
/// point — once around `send()`, then afresh around every `Read::read` — so on
/// the chunked read loop below it already behaves as an idle timeout. A slow
/// but progressing transfer (a 1 MB image on a tethered link) is therefore
/// never killed mid-body; only a stalled one is. The total transfer is bounded
/// instead by [`validate::MAX_FIRMWARE_BYTES`], enforced as the bytes arrive.
const FIRMWARE_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// esptool upload rate for a DIRECT USB flash — the shipped value, unchanged.
///
/// On this path the host talks to the ESP ROM bootloader through the device's
/// own USB-serial bridge, which auto-bauds during the `sync` phase, so the rate
/// is a free choice and 460800 is esptool's usual fast upload rate. It is
/// explicitly NOT the rule for the Betaflight passthrough path — see
/// [`RealBackend::esptool_baud`].
const ESPTOOL_DIRECT_BAUD: u32 = 460_800;

/// Percent the fetch stage has reached once the whole image has arrived. The
/// download creeps from 0 to here as bytes land (FLASH-14); the engine takes it
/// the rest of the way to 25 after validation + patching.
const DOWNLOAD_PCT_END: f32 = 20.0;

/// Read size for the streamed firmware download. Big enough that the syscall
/// count stays trivial, small enough that progress moves several times even on
/// a small image.
const DOWNLOAD_CHUNK: usize = 32 * 1024;

/// Smallest progress delta worth an event, in percent. Without it a fast
/// download emits an event per 32 KiB chunk for a bar that cannot render them.
const PROGRESS_EPSILON: f32 = 0.5;

/// Assumed bytes still to come when the server declares no `Content-Length`,
/// used to shape the fallback creep. Roughly an ELRS image, so the bar tracks
/// reality on a chunked response instead of sitting at 0.
const ASSUMED_REMAINING_BYTES: f32 = 512.0 * 1024.0;

/// Fetch-stage percent for `received` bytes of a body of `declared` length
/// (FLASH-14).
///
/// With a declared length this is the true fraction of the image, scaled into
/// `0..=DOWNLOAD_PCT_END`. Without one (chunked transfer) there is no total to
/// divide by, so it degrades to a monotonic hyperbolic creep that approaches —
/// but never reaches — the end of the band, exactly like `run_streaming`'s
/// line-driven creep. Pure, so both branches are unit-tested.
fn download_progress(received: u64, declared: Option<u64>) -> f32 {
    match declared {
        Some(total) if total > 0 => {
            (received as f32 / total as f32).clamp(0.0, 1.0) * DOWNLOAD_PCT_END
        }
        _ => {
            let received = received as f32;
            DOWNLOAD_PCT_END * (received / (received + ASSUMED_REMAINING_BYTES))
        }
    }
}

/// Validate one interpolated URL path segment (FLASH-14).
///
/// `version` and `target` come from the frontend and were spliced into the
/// artifactory URL raw, so a crafted value (`../../…`, an absolute path, a query
/// string, a percent-escape) could walk the path or bend the request to another
/// resource on the host. ExpressLRS tags (`3.5.3`, `v3.5.3-RC1`) and build
/// targets (`BETAFPV_2400_TX`) are drawn from a much narrower alphabet than
/// that, so this validates rather than escapes: anything outside
/// `[A-Za-z0-9._-]` is refused outright, as is a segment that is empty or a
/// relative-path element. Refusing is safe — such a value has no build anyway —
/// and a rejected request never reaches the network, let alone the device.
fn validate_url_segment(kind: &str, value: &str) -> Result<(), FlashError> {
    let invalid = |why: &str| {
        FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "invalidFirmwareRequest",
            format!("refusing to build a firmware URL: {kind} {value:?} {why}"),
        )
    };
    if value.is_empty() {
        return Err(invalid("is empty"));
    }
    if value == "." || value == ".." {
        return Err(invalid("is a relative path element"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(invalid(
            "contains characters that are not allowed in a firmware path segment",
        ));
    }
    Ok(())
}

/// Rewrite a failed read-back pass into the "what is on the chip is not what we
/// sent" failure (FLASH-6).
///
/// Only a non-zero exit from the tool (`toolFailed`) means `verify_flash` ran
/// and found a mismatch; a tool that could not be started, or a wait/cancel
/// outcome, says nothing about the image and keeps its own error so it is not
/// mis-sold to the user as a corrupt flash. Pure, so the distinction is tested.
fn verify_failure(port: &str, err: FlashError) -> FlashError {
    if err.summary_key != "toolFailed" {
        return err;
    }
    FlashError::new(
        err.category,
        "verifyFailed",
        format!(
            "the firmware written to {port} did not read back identical to the image that was \
             sent: {}",
            err.detail
        ),
    )
}

/// Longest device response echoed back into a [`FlashError`] detail.
const OTA_BODY_EXCERPT: usize = 200;

/// Hard ceiling on the `/update` response body read into memory.
///
/// `Response::text()` is unbounded. The endpoint is a LAN address the user typed
/// (`isValidDeviceIp` accepts hostnames), so a hostile or merely broken one can
/// stream for the whole 60s request timeout straight into RAM. The real answer
/// is a status line of tens of bytes, and [`classify_ota_response`] never looks
/// past [`OTA_BODY_EXCERPT`] characters of it anyway.
const MAX_OTA_BODY_BYTES: usize = 64 * 1024;

/// Read the device's `/update` response with [`MAX_OTA_BODY_BYTES`] enforced.
///
/// An over-size body is a REJECTION, not a transport failure: nothing that long
/// is a confirmation, and [`classify_ota_response`]'s fail-closed rule — only a
/// positive confirmation counts as success — has to hold for a body we refused
/// to finish reading as much as for one we read in full.
///
/// Takes any `Read` rather than the `Response` itself so the cap is testable
/// without a socket; the call site passes `&mut resp`.
fn read_ota_body(source: impl std::io::Read) -> Result<String, FlashError> {
    use std::io::Read;
    let mut body = Vec::new();
    source
        .take(MAX_OTA_BODY_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| {
            FlashError::new(
                ErrorCategory::NetworkTimeout,
                "otaUploadFailed",
                format!("could not read the device's response to the OTA upload: {e}"),
            )
        })?;
    if body.len() > MAX_OTA_BODY_BYTES {
        return Err(FlashError::new(
            ErrorCategory::FirmwareMismatch,
            "otaRejected",
            format!(
                "the device's response to the OTA upload exceeded {MAX_OTA_BODY_BYTES} bytes \
                 and did not confirm the update"
            ),
        ));
    }
    // Lossy rather than strict: a device that answers with one stray non-UTF-8
    // byte must still be classifiable, and `classify_ota_response` fails closed
    // on anything it cannot read as a confirmation.
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// Refuse a `/update` answer that redirects the upload somewhere else.
///
/// The OTA client runs `Policy::none()`, which hands a 3xx back as an ordinary
/// response rather than following it, and `error_for_status` only rejects
/// 4xx/5xx — so without this the body that came with the redirect would be fed
/// to [`classify_ota_response`] as if it were the device's verdict on the image.
fn reject_ota_redirect(url: &str, status: reqwest::StatusCode) -> Result<(), FlashError> {
    if !status.is_redirection() {
        return Ok(());
    }
    Err(FlashError::new(
        ErrorCategory::FirmwareMismatch,
        "otaRejected",
        format!(
            "{url} answered HTTP {status} redirecting the upload elsewhere; a device update \
             endpoint does not redirect, so the update was not confirmed"
        ),
    ))
}

/// Plain-text bodies (case-insensitively contained) that a firmware upload
/// endpoint uses to say "accepted". `OK`/`FAIL` is what the Arduino
/// `HTTPUpdateServer` family answers; the longer phrases are what ExpressLRS's
/// own handler writes.
const OTA_SUCCESS_MARKERS: [&str; 3] = ["update complete", "update success", "upload success"];

/// Classify the body of the device's `/update` response (FLASH-6).
///
/// Returns the device's own confirmation message on acceptance, or the reason to
/// report on rejection.
///
/// **The exact contract is unverified against hardware.** ExpressLRS's OTA
/// endpoint is not vendored here, so this reads the shapes it is known to
/// produce — a JSON object carrying a `status` (`"ok"` vs `"error"`/`"mismatch"`,
/// the latter being a firmware built for a different target) and the plain
/// `OK`/`FAIL` of the Arduino updater — and is deliberately CONSERVATIVE about
/// everything else: a body that does not positively confirm the update is
/// treated as a rejection. Telling a user to re-flash a device that actually
/// succeeded is recoverable; showing the green success screen for an image the
/// device threw away leaves them with a radio that will not boot and no idea
/// why.
fn classify_ota_response(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("the device returned an empty response body".to_string());
    }
    let excerpt = || {
        let mut s: String = trimmed.chars().take(OTA_BODY_EXCERPT).collect();
        if trimmed.chars().count() > OTA_BODY_EXCERPT {
            s.push('…');
        }
        s
    };

    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let msg = map
            .get("msg")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return match map.get("status").and_then(|v| v.as_str()) {
            Some(status) if status.eq_ignore_ascii_case("ok") => Ok(if msg.is_empty() {
                status.to_string()
            } else {
                msg
            }),
            Some(status) => Err(format!(
                "the device reported status {status:?}{}",
                if msg.is_empty() {
                    String::new()
                } else {
                    format!(": {msg}")
                }
            )),
            // A JSON object with no `status` is not a shape we can read as a
            // confirmation — fail closed rather than assume success.
            None => Err(format!("unrecognised device response: {}", excerpt())),
        };
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered == "ok" || OTA_SUCCESS_MARKERS.iter().any(|m| lowered.contains(m)) {
        return Ok(trimmed.to_string());
    }
    Err(format!("unrecognised device response: {}", excerpt()))
}

/// Real fetch/upload implementation. No hardware is available in this
/// environment, so this path is validated structurally + by `RealBackend`'s
/// composition over the (tested) `platformio`, `msp`, and HTTP helpers; the
/// pipeline logic itself is covered by `MockBackend` integration tests.
pub struct RealBackend {
    /// Directory the esptool staging image is created in — [`FlashPaths::staging_dir`]
    /// (FLASH-8). Held on the backend because [`FlashBackend::upload`] has no
    /// paths argument.
    staging_dir: PathBuf,
}

impl RealBackend {
    /// Build the production backend, staging the esptool image in `staging_dir`.
    pub fn new(staging_dir: PathBuf) -> Self {
        Self { staging_dir }
    }

    /// Construct the download URL for a pre-built target binary.
    ///
    /// Both interpolated segments are validated first (FLASH-14) — they are
    /// frontend-supplied strings, and an unchecked one can traverse the path.
    fn firmware_url(target: &str, version: &str) -> Result<String, FlashError> {
        validate_url_segment("version", version)?;
        validate_url_segment("target", target)?;
        Ok(format!(
            "{FIRMWARE_BASE_URL}/{version}/{target}/firmware.bin"
        ))
    }

    /// esptool's `--baud` for a serial flash (FLASH-9).
    ///
    /// `passthrough_baud` is `Some(baud)` only on the Betaflight path, carrying
    /// the rate [`RealBackend::handshake_fc`] actually negotiated with the
    /// flight controller. Over passthrough every byte crosses the FC's CRSF
    /// UART at exactly that rate, so esptool MUST use it: the standard case
    /// (CRSF at 420000, the first entry in `COMMON_FC_BAUDS`) used to hand
    /// esptool a hardcoded 460800, which never syncs and surfaced as a `Wiring`
    /// "check your cable" failure on perfectly good hardware.
    ///
    /// `None` is the direct-USB path, which keeps [`ESPTOOL_DIRECT_BAUD`].
    fn esptool_baud(passthrough_baud: Option<u32>) -> u32 {
        passthrough_baud.unwrap_or(ESPTOOL_DIRECT_BAUD)
    }

    /// The `--chip/--port/--baud` prefix shared by every esptool invocation.
    fn esptool_common(mcu: McuFamily, port: &str, baud: u32) -> Vec<String> {
        vec![
            "--chip".into(),
            mcu.esptool_chip().into(),
            "--port".into(),
            port.into(),
            "--baud".into(),
            baud.to_string(),
        ]
    }

    /// Build the esptool argument vector for a UART flash.
    ///
    /// Pure + total so the per-family `--chip`/offset contract and the
    /// negotiated-baud contract are unit-tested without hardware. Chip and
    /// offset are taken from `mcu`: `--chip auto` plus a hardcoded `0x0` would
    /// write an ESP32 application image over the second-stage bootloader.
    ///
    /// `--after no_reset` leaves the chip in the ROM bootloader when the write
    /// finishes, so [`RealBackend::esptool_verify_args`] can read the image back
    /// over the SAME bootloader session instead of re-entering it (FLASH-6) —
    /// which over a Betaflight passthrough, where esptool cannot toggle the
    /// reset lines at all, it could not reliably do. The verify pass is what
    /// then resets the device into the firmware it just wrote.
    fn esptool_write_args(mcu: McuFamily, port: &str, baud: u32, bin_path: &str) -> Vec<String> {
        let mut args = Self::esptool_common(mcu, port, baud);
        args.extend([
            "--after".into(),
            "no_reset".into(),
            "write_flash".into(),
            mcu.app_image_offset().into(),
            bin_path.into(),
        ]);
        args
    }

    /// Build the esptool argument vector that READS THE IMAGE BACK and compares
    /// it with what we just wrote (FLASH-6).
    ///
    /// This is the verify stage doing actual work: `verify_flash` re-reads the
    /// written region from the chip and fails non-zero on any mismatch, so a
    /// write that silently landed short, went to the wrong offset, or was
    /// corrupted in transit is caught here instead of being reported to the user
    /// as a success. `--before no_reset` reuses the bootloader session the write
    /// left open; `--after hard_reset` is what finally boots the device into the
    /// new firmware.
    fn esptool_verify_args(mcu: McuFamily, port: &str, baud: u32, bin_path: &str) -> Vec<String> {
        let mut args = Self::esptool_common(mcu, port, baud);
        args.extend([
            "--before".into(),
            "no_reset".into(),
            "--after".into(),
            "hard_reset".into(),
            "verify_flash".into(),
            mcu.app_image_offset().into(),
            bin_path.into(),
        ]);
        args
    }
}

impl FlashBackend for RealBackend {
    fn preflight(&self, req: &FlashRequest, sink: &dyn FlashSink) -> Result<(), FlashError> {
        // Only the serial transports shell out: a WiFi OTA is plain HTTP and
        // must never be blocked by a missing local tool.
        if !method_needs_esptool(req.method) {
            return Ok(());
        }
        let program = resolve_esptool()?;
        sink.log(&format!("Using flashing tool `{program}`"), false);
        Ok(())
    }

    fn acquire_firmware(
        &self,
        req: &FlashRequest,
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
    ) -> Result<Vec<u8>, FlashError> {
        // M19: a Backpack target's *real* firmware lives in a separate upstream
        // repo (ExpressLRS/Backpack), NOT the main-ELRS artifact host. The
        // hardware-validated per-target release fetch is not implemented yet, so
        // the REAL backend FAILS CLOSED here rather than handing the offline
        // placeholder image (`flash::backpack::backpack_firmware`) to the
        // WiFi-OTA `upload()` below — which would otherwise write fabricated,
        // non-real bytes onto a real device. The offline mock/test path keeps its
        // placeholder via `MockBackend::acquire_firmware` (NFR-TEST-02).
        //
        // TODO(HW): implement the real per-target fetch — download this target's
        // `repoAsset` from `flash::backpack::BACKPACK_REPO` releases (see
        // `data/targets/backpack.json`), mirroring `flash::github`. Unverifiable
        // without a radio, so it stays hardware-pending and out of this
        // fail-closed slice.
        if let Some(kind) = req.backpack_kind {
            sink.log(
                &format!(
                    "Real {kind:?} Backpack firmware fetch is pending a hardware-validated \
                     release — refusing to write a non-real image to the device",
                ),
                true,
            );
            return Err(FlashError::new(
                ErrorCategory::Unknown,
                "backpackFirmwareUnavailable",
                format!(
                    "real {kind:?} Backpack firmware fetch from {} is not available yet \
                     (hardware-pending); refusing to flash a placeholder image",
                    crate::flash::backpack::BACKPACK_REPO
                ),
            ));
        }

        sink.log(
            &format!("Downloading firmware {} for {}", req.version, req.target),
            false,
        );
        let url = Self::firmware_url(&req.target, &req.version)?;
        let client = reqwest::blocking::Client::builder()
            .user_agent("OmniLink-Configurator")
            .connect_timeout(FIRMWARE_CONNECT_TIMEOUT)
            .timeout(FIRMWARE_READ_TIMEOUT)
            // Firmware bytes are unverifiable after the fact (no published
            // digest), so the transport must guarantee where they came from:
            // https, on the pinned domain, at most a few hops.
            .redirect(crate::flash::pinned_redirect_policy(FIRMWARE_DOMAIN))
            .build()
            .map_err(|e| FlashError::new(ErrorCategory::Unknown, "httpClient", e.to_string()))?;
        let mut resp = client
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                download_failure(
                    &url,
                    &req.version,
                    &req.target,
                    e.status().map(|s| s.as_u16()),
                    e.is_redirect(),
                    &e.to_string(),
                )
            })?;
        // FLASH-2: remember the declared body length BEFORE consuming the
        // response. A connection dropped mid-body yields a SHORT body with no
        // error at all, and a truncated image flashed to a device is a brick —
        // so a body that does not match the server's own `Content-Length` is
        // rejected here rather than patched and written. Absent header (chunked
        // transfer) ⇒ nothing to compare, and the engine's image validation
        // still runs on the bytes.
        let declared_len = resp.content_length();
        // …and refuse an over-size body BEFORE reserving for it. A response
        // declaring `Content-Length: 8589934592` used to reach
        // `Vec::with_capacity(8 GiB)` before a single byte was read: the
        // allocation failure is a Rust `alloc_error`, which ABORTS the process
        // rather than returning a `FlashError`, taking the user's wizard state
        // with it. `inspect_firmware`'s identical ceiling only ever runs on
        // bytes that are already in RAM, so it cannot be the one that catches
        // this.
        if let Some(declared) = declared_len {
            if declared > MAX_FIRMWARE_BYTES as u64 {
                return Err(oversize_download_error(&url, declared));
            }
        }
        // FLASH-14: read the body in chunks instead of `resp.bytes()`, so the
        // progress bar moves during the several-hundred-KB fetch instead of
        // sitting at 0% until it jumps to 20%. Reading incrementally is also the
        // only place a cancel raised mid-download can be honoured: the flag is
        // checked per chunk, and the engine's step boundaries only see it once
        // the whole (previously uninterruptible) download had finished.
        // Clamped so an over-large (or absent) declaration can never size the
        // allocation on its own; the loop below grows it if the body is real.
        let mut bytes: Vec<u8> =
            Vec::with_capacity(declared_len.unwrap_or(0).min(MAX_FIRMWARE_BYTES as u64) as usize);
        let mut buf = vec![0u8; DOWNLOAD_CHUNK];
        let mut last_pct = 0.0f32;
        loop {
            if cancel.is_cancelled() {
                sink.log(
                    "Flash cancelled during the firmware download — the device was not written",
                    false,
                );
                return Err(cancelled_error());
            }
            let read = std::io::Read::read(&mut resp, &mut buf).map_err(|e| {
                FlashError::new(
                    ErrorCategory::NetworkTimeout,
                    "firmwareDownloadFailed",
                    format!("could not download {url}: {e}"),
                )
            })?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..read]);
            // A chunked response declares nothing, so the ceiling has to be
            // re-checked as it streams: without this the buffer grows until the
            // read stalls or the host runs out of memory, and the size verdict
            // only arrives once the damage is done.
            if bytes.len() > MAX_FIRMWARE_BYTES {
                return Err(oversize_download_error(&url, bytes.len() as u64));
            }
            let pct = download_progress(bytes.len() as u64, declared_len);
            if pct - last_pct >= PROGRESS_EPSILON {
                last_pct = pct;
                sink.progress(FlashStage::Fetch, pct);
            }
        }
        if let Some(declared) = declared_len {
            if bytes.len() as u64 != declared {
                return Err(FlashError::new(
                    ErrorCategory::NetworkTimeout,
                    "firmwareTruncated",
                    format!(
                        "download of {url} is incomplete: the server declared {declared} bytes \
                         but {} arrived",
                        bytes.len()
                    ),
                ));
            }
        }
        sink.progress(FlashStage::Fetch, DOWNLOAD_PCT_END);
        Ok(bytes)
    }

    fn upload(
        &self,
        req: &FlashRequest,
        firmware: &[u8],
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
    ) -> Result<(), FlashError> {
        match req.method {
            FlashMethod::Wifi => self.upload_wifi(req, firmware, sink, cancel),
            FlashMethod::Uart => self.upload_uart(req, firmware, sink, cancel, None, None),
            FlashMethod::Betaflight => {
                // MSP passthrough then flash the RX over the same serial port
                // (FR-FLASH-09a–d).
                let port = req.port.as_deref().ok_or_else(|| {
                    FlashError::new(ErrorCategory::Wiring, "noPort", "no serial port selected")
                })?;
                sink.progress(FlashStage::Erase, 30.0);
                sink.log("Requesting Betaflight serial passthrough…", false);
                // FLASH-9: the negotiated baud is the transport's rate from here
                // on — the passthrough is a transparent pipe over the FC's CRSF
                // UART — so it must travel with the upload instead of being
                // dropped on the floor.
                let fc_baud = self.handshake_fc(port, sink)?;
                // The handshake loop is a blocking ≈10s serial probe; honour a
                // cancel raised during it before the receiver is written to.
                abort_if_cancelled(cancel, sink)?;
                sink.log(
                    &format!("Passthrough enabled at {fc_baud} baud; flashing receiver…"),
                    false,
                );
                self.upload_uart(
                    req,
                    firmware,
                    sink,
                    cancel,
                    Some(port.to_string()),
                    Some(fc_baud),
                )
            }
        }
    }
}

impl RealBackend {
    /// Enable Betaflight/iNav serial passthrough, trying each common FC baud in
    /// turn before giving up (FR-FLASH-09b). The flight controller's MSP baud is
    /// unknown ahead of time, so 420000 (CRSF default) is tried first, then the
    /// other common rates. The overall [`msp::FC_HANDSHAKE_TIMEOUT`] (≈10s) is
    /// divided across attempts so the whole loop stays within that budget rather
    /// than waiting 10s per baud.
    ///
    /// Returns the baud that actually acked: the passthrough is a transparent
    /// pipe over the FC's UART, so the uploader has to keep talking at exactly
    /// this rate (FLASH-9).
    fn handshake_fc(&self, port: &str, sink: &dyn FlashSink) -> Result<u32, FlashError> {
        use crate::flash::msp::{self, COMMON_FC_BAUDS, FC_HANDSHAKE_TIMEOUT};

        let per_baud = FC_HANDSHAKE_TIMEOUT / COMMON_FC_BAUDS.len() as u32;
        let mut last_err: Option<FlashError> = None;
        for &baud in COMMON_FC_BAUDS.iter() {
            sink.log(&format!("Trying flight controller at {baud} baud…"), false);
            match serialport::new(port, baud)
                .timeout(std::time::Duration::from_millis(200))
                .open()
            {
                Ok(mut serial) => match msp::enable_passthrough_with_timeout(&mut serial, per_baud)
                {
                    Ok(()) => {
                        drop(serial); // release before the uploader reopens the port
                        return Ok(baud);
                    }
                    // An MSP error reply proves we reached the FC at THIS baud
                    // and it refused. Trying the remaining bauds only burns the
                    // rest of the 10s budget and ends by blaming the user's
                    // wiring for a flight-controller configuration problem.
                    Err(e) if e.summary_key == msp::PASSTHROUGH_UNAVAILABLE_KEY => return Err(e),
                    Err(e) => last_err = Some(e),
                },
                Err(e) => {
                    last_err = Some(FlashError::new(
                        ErrorCategory::Wiring,
                        "fcOpenFailed",
                        format!("could not open flight-controller port {port} at {baud}: {e}"),
                    ));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            FlashError::new(
                ErrorCategory::Wiring,
                "fcNotResponding",
                "flight controller did not respond at any common baud",
            )
        }))
    }

    /// WiFi HTTP OTA: POST the image to the device's `/update` endpoint.
    ///
    /// The POST *is* the write — the device applies the image as it arrives and
    /// reboots into it — so `cancel` is consulted right up to the request and
    /// the point of no return is taken immediately before it (FLASH-4).
    fn upload_wifi(
        &self,
        req: &FlashRequest,
        firmware: &[u8],
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
    ) -> Result<(), FlashError> {
        let ip = req.device_ip.as_deref().ok_or_else(|| {
            FlashError::new(
                ErrorCategory::NetworkTimeout,
                "noDeviceIp",
                "no device IP provided",
            )
        })?;
        sink.progress(FlashStage::Erase, 30.0);
        let url = format!("http://{ip}/update");
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            // This client is (correctly) exempt from the pinned-domain policy —
            // it posts to a LAN address the user typed — but reqwest's DEFAULT
            // would still follow up to ten hops to ANY host, http or https.
            // `deviceIp` accepts hostnames, so a spoofed or hostile `.local`
            // endpoint could 307 the ~1 MB firmware POST somewhere else and then
            // supply the body `classify_ota_response` reads, turning a flash
            // that never happened into the green success screen. A device's
            // `/update` endpoint has no legitimate reason to redirect.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| FlashError::new(ErrorCategory::Unknown, "httpClient", e.to_string()))?;
        let part = reqwest::blocking::multipart::Part::bytes(firmware.to_vec())
            .file_name("firmware.bin")
            .mime_str("application/octet-stream")
            .map_err(|e| FlashError::new(ErrorCategory::Unknown, "multipart", e.to_string()))?;
        let form = reqwest::blocking::multipart::Form::new().part("upload", part);
        // Point of no return. Losing this race means a cancel was accepted
        // first: abort WITHOUT posting — the pre-M8 code had no cancel check at
        // all here and flashed the device anyway (FLASH-4). Winning it means
        // every later cancel is refused, so nothing can interrupt the transfer
        // half-way and leave the device with a truncated image.
        if !cancel.enter_write() {
            sink.log(
                "Flash cancelled before the OTA upload — the device was not written",
                false,
            );
            return Err(cancelled_error());
        }
        sink.progress(FlashStage::Write, 60.0);
        let mut resp = client
            .post(&url)
            .multipart(form)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                FlashError::new(
                    ErrorCategory::NetworkTimeout,
                    "otaUploadFailed",
                    format!("WiFi OTA to {url} failed: {e}"),
                )
            })?;
        let status = resp.status();
        // Say plainly that the endpoint tried to send us elsewhere, instead of
        // classifying whatever body came with the redirect as an update outcome.
        reject_ota_redirect(&url, status)?;
        sink.log(&format!("Device responded: HTTP {status}"), false);
        // FLASH-6: the status code alone is NOT the outcome. ExpressLRS's
        // `/update` handler answers 200 with a body that says whether the image
        // was accepted, and it rejects images built for another target — so a
        // flash that the device refused used to end on the green success screen
        // with an unbootable radio on the bench. The body is the only signal we
        // have here, so it is read and classified instead of dropped.
        sink.progress(FlashStage::Verify, 90.0);
        let body = read_ota_body(&mut resp)?;
        match classify_ota_response(&body) {
            Ok(msg) => sink.log(&format!("Device accepted the update: {msg}"), false),
            Err(reason) => {
                sink.log(&format!("Device rejected the update: {reason}"), true);
                return Err(FlashError::new(
                    ErrorCategory::FirmwareMismatch,
                    "otaRejected",
                    format!(
                        "the device answered HTTP {status} but did not confirm the update: \
                         {reason}"
                    ),
                ));
            }
        }
        sink.progress(FlashStage::Verify, 95.0);
        Ok(())
    }

    /// USB-serial flash via esptool. `port_override` / `passthrough_baud` are
    /// supplied by the Betaflight path after passthrough is enabled; `None` on
    /// both means a direct USB flash.
    fn upload_uart(
        &self,
        req: &FlashRequest,
        firmware: &[u8],
        sink: &dyn FlashSink,
        cancel: &Arc<FlashCancel>,
        port_override: Option<String>,
        passthrough_baud: Option<u32>,
    ) -> Result<(), FlashError> {
        let port = port_override.or_else(|| req.port.clone()).ok_or_else(|| {
            FlashError::new(ErrorCategory::Wiring, "noPort", "no serial port selected")
        })?;

        // Resolve the chip family BEFORE anything is written — the `--chip` arg
        // and the write offset both depend on it, and an unknown family fails
        // closed here rather than defaulting to an offset that bricks the device.
        let mcu = McuFamily::from_catalogue(req.mcu.as_deref())?;

        // esptool needs the image on disk. FLASH-8: staged in the app-data dir
        // (see `FlashPaths::staging_dir`) as an `O_EXCL`, mode-0600, randomly
        // named file — NOT `/tmp/omnilink-flash-<pid>.bin`, whose predictable
        // name in a mode-1777 directory let any local user pre-plant a symlink
        // (arbitrary file overwrite) or swap the image between the write and
        // esptool reading it (arbitrary firmware flashed to hardware).
        // `NamedTempFile` also unlinks the image when it drops, so the file is
        // gone on the success, error AND cancel paths below.
        std::fs::create_dir_all(&self.staging_dir).map_err(|e| {
            FlashError::new(
                ErrorCategory::Unknown,
                "tempWrite",
                format!(
                    "could not create the firmware staging directory {}: {e}",
                    self.staging_dir.display()
                ),
            )
        })?;
        let mut staged = tempfile::Builder::new()
            .prefix("omnilink-flash-")
            .suffix(".bin")
            .tempfile_in(&self.staging_dir)
            .map_err(|e| FlashError::new(ErrorCategory::Unknown, "tempWrite", e.to_string()))?;
        {
            use std::io::Write as _;
            let file = staged.as_file_mut();
            file.write_all(firmware)
                .and_then(|()| file.flush())
                .map_err(|e| FlashError::new(ErrorCategory::Unknown, "tempWrite", e.to_string()))?;
        }
        let bin_path = staged.path().to_path_buf();

        sink.progress(FlashStage::Erase, 30.0);
        sink.log(
            &format!(
                "Flashing {} image at offset {} over {port}",
                mcu.esptool_chip(),
                mcu.app_image_offset()
            ),
            false,
        );
        // Point of no return, taken BEFORE esptool is spawned: from here on the
        // chip is being erased and rewritten, and killing the tool half-way is
        // what bricks a radio. Taking it before the spawn is what makes that
        // guarantee airtight — the cancel-watcher inside `run_streaming` can no
        // longer be armed, because no cancel can be accepted any more. Losing
        // the race means a cancel got in first: bail out with the child never
        // spawned and the device untouched.
        if !cancel.enter_write() {
            // `staged` drops at the end of this scope and takes the image with it.
            sink.log(
                "Flash cancelled before esptool was started — the device was not written",
                false,
            );
            return Err(cancelled_error());
        }
        // Which of the upstream names this machine actually has (FLASH-12).
        // `run_flash` probed for it as step 0 — before the backup, the download
        // and the device — so this is normally just re-reading the same answer;
        // it is repeated here so the uploader stays correct when driven directly
        // instead of assuming the bare name `esptool` resolves. Deliberately
        // after the cancel gate above: a cancelled flash must report the cancel.
        let esptool = resolve_esptool()?;
        let baud = Self::esptool_baud(passthrough_baud);
        let bin = bin_path.display().to_string();
        let write_args = Self::esptool_write_args(mcu, &port, baud, &bin);
        let result = crate::platformio::run_streaming(
            esptool,
            &write_args,
            FlashStage::Write,
            30.0,
            92.0,
            sink,
            cancel,
        )
        // FLASH-6: the verify stage used to be a bare `progress(Verify, 98)` —
        // it asserted the flash was good without reading a single byte back.
        // esptool's `verify_flash` re-reads the written region from the chip and
        // compares it with the image we sent, so a write that landed short, at
        // the wrong offset, or corrupted is caught HERE instead of being
        // reported to the user as a success. It also performs the reset that
        // boots the device into the new firmware (`--after hard_reset`), which
        // the write pass deliberately no longer does.
        .and_then(|()| {
            sink.log("Verifying the written image against the source…", false);
            let verify_args = Self::esptool_verify_args(mcu, &port, baud, &bin);
            crate::platformio::run_streaming(
                esptool,
                &verify_args,
                FlashStage::Verify,
                92.0,
                99.0,
                sink,
                cancel,
            )
            .map_err(|e| verify_failure(&port, e))
        });
        // Remove the staged image whatever happened — an explicit close so a
        // failure to unlink is visible in the log rather than silently ignored.
        if let Err(e) = staged.close() {
            tracing::warn!(target: "flash", "could not remove the staged firmware image: {e}");
        }
        result?;
        sink.log(
            "Image verified — the device is running the new firmware",
            false,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Collecting sink for assertions.
    #[derive(Default)]
    struct TestSink {
        progress: Mutex<Vec<(FlashStage, f32)>>,
        logs: Mutex<Vec<String>>,
        /// Requests a cancel the instant a log line containing this needle is
        /// emitted. Lets a test fire the user's cancel at an EXACT pipeline
        /// boundary (e.g. right after the options patch) without a sleep.
        cancel_on_log: Mutex<Option<(String, Arc<FlashCancel>)>>,
    }
    impl TestSink {
        /// Fire `cancel` as soon as a log line containing `needle` is emitted.
        fn cancelling_on(needle: &str, cancel: &Arc<FlashCancel>) -> Self {
            Self {
                cancel_on_log: Mutex::new(Some((needle.to_string(), cancel.clone()))),
                ..Self::default()
            }
        }
    }
    impl FlashSink for TestSink {
        fn progress(&self, stage: FlashStage, percent: f32) {
            self.progress.lock().unwrap().push((stage, percent));
        }
        fn log(&self, line: &str, _is_error: bool) {
            if let Some((needle, cancel)) = self.cancel_on_log.lock().unwrap().as_ref() {
                if line.contains(needle.as_str()) {
                    cancel.request();
                }
            }
            self.logs.lock().unwrap().push(line.to_string());
        }
    }

    /// Synthetic firmware image for `target`: an embedded build-target string, a
    /// 256-byte options region, and enough padding to clear the validator's size
    /// floor — i.e. an image that survives the fetch-stage gate the engine now
    /// runs over EVERY fetched image (FLASH-2), not just a local file.
    fn synthetic_firmware_for(target: &str) -> Vec<u8> {
        let cap: u16 = 256;
        let mut fw = vec![0xAAu8; 16];
        fw.extend_from_slice(target.as_bytes());
        fw.push(0);
        fw.extend_from_slice(&patch::OPTIONS_DELIMITER);
        fw.extend_from_slice(&cap.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, cap as usize));
        fw.resize(2048, 0xFF);
        fw
    }

    /// The default synthetic image, matching [`base_request`]'s target.
    fn synthetic_firmware() -> Vec<u8> {
        synthetic_firmware_for("BETAFPV_2400_TX")
    }

    /// Mock backend that yields a synthetic image and records the patched bytes.
    struct MockBackend {
        uploaded: Mutex<Option<Vec<u8>>>,
        fail_upload: bool,
    }
    impl FlashBackend for MockBackend {
        fn acquire_firmware(
            &self,
            req: &FlashRequest,
            sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<Vec<u8>, FlashError> {
            sink.progress(FlashStage::Fetch, 15.0);
            // Mirror RealBackend: a Backpack flash sources the bundled placeholder
            // image, which (deliberately) has NO ELRS options region.
            if let Some(kind) = req.backpack_kind {
                return crate::flash::backpack::backpack_firmware(kind);
            }
            // A well-behaved source returns the image for the target that was
            // asked for.
            Ok(synthetic_firmware_for(&req.target))
        }
        fn upload(
            &self,
            _req: &FlashRequest,
            firmware: &[u8],
            sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<(), FlashError> {
            *self.uploaded.lock().unwrap() = Some(firmware.to_vec());
            sink.progress(FlashStage::Erase, 40.0);
            sink.progress(FlashStage::Write, 80.0);
            if self.fail_upload {
                return Err(FlashError::new(
                    ErrorCategory::Wiring,
                    "toolFailed",
                    "Failed to connect to ESP32",
                ));
            }
            sink.progress(FlashStage::Verify, 95.0);
            Ok(())
        }
    }

    fn base_request() -> FlashRequest {
        FlashRequest {
            target: "BETAFPV_2400_TX".into(),
            device_type: DeviceType::Tx,
            version: "3.5.3".into(),
            method: FlashMethod::Uart,
            port: Some("/dev/ttyUSB0".into()),
            device_ip: None,
            connected_device_type: Some(DeviceType::Tx),
            connected_target_name: None,
            backpack_kind: None,
            connected_backpack_kind: None,
            options: FlashOptions {
                binding_phrase: Some("test phrase".into()),
                domain: Some(0),
                ..Default::default()
            },
            backup_target: Some(BackupTarget {
                target_name: "BETAFPV_2400_TX".into(),
                firmware_version: Some("3.5.2".into()),
                device_type: Some("TX".into()),
                port: Some("/dev/ttyUSB0".into()),
            }),
            local_file_path: None,
            mcu: Some("ESP32".into()),
        }
    }

    /// Write a synthetic ELRS-like image (with the options-region delimiter and
    /// an embedded build-target string) to a unique temp `.bin`, returning its
    /// path. Mirrors the validator's synthetic fixture.
    fn write_local_bin(tag: &str, target: &str) -> std::path::PathBuf {
        let cap: u16 = 256;
        let mut fw = vec![0xAAu8; 64];
        fw.extend_from_slice(target.as_bytes());
        fw.push(0);
        fw.extend_from_slice(&patch::OPTIONS_DELIMITER);
        fw.extend_from_slice(&cap.to_le_bytes());
        fw.extend(std::iter::repeat_n(0u8, cap as usize));
        fw.resize(2048, 0xFF);
        let path = std::env::temp_dir().join(format!(
            "omnilink-local-fw-{tag}-{}.bin",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, &fw).unwrap();
        path
    }

    fn temp_paths(tag: &str) -> FlashPaths {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "omnilink-flash-engine-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        FlashPaths {
            staging_dir: dir.join("staging"),
            backups_dir: dir,
        }
    }

    /// The production backend, staging into a throwaway directory (no test ever
    /// gets far enough to spawn esptool).
    fn test_real_backend(tag: &str) -> RealBackend {
        RealBackend::new(temp_paths(tag).staging_dir)
    }

    #[test]
    fn happy_path_flashes_patched_firmware_and_reaches_done() {
        let req = base_request();
        let paths = temp_paths("happy");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        run_flash(&req, &paths, &backend, &sink, &cancel).expect("flash should succeed");

        // Reached the done stage at 100%.
        let progress = sink.progress.lock().unwrap();
        assert_eq!(*progress.last().unwrap(), (FlashStage::Done, 100.0));

        // The uploaded image carries the patched options (UID present).
        let uploaded = backend.uploaded.lock().unwrap().clone().unwrap();
        let opts = patch::read_options(&uploaded).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&opts).unwrap();
        assert!(parsed.get("uid").is_some(), "patched UID should be present");
        assert_eq!(parsed["domain"], serde_json::json!(0));

        // A backup file was written.
        let entries: Vec<_> = std::fs::read_dir(&paths.backups_dir).unwrap().collect();
        assert_eq!(entries.len(), 1);
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn failure_path_propagates_categorised_error() {
        let req = base_request();
        let paths = temp_paths("fail");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: true,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel).unwrap_err();
        assert_eq!(err.category, ErrorCategory::Wiring);
        // Never reached the done stage.
        let progress = sink.progress.lock().unwrap();
        assert!(!progress.iter().any(|(s, _)| *s == FlashStage::Done));
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn tx_rx_guard_aborts_before_any_upload() {
        let mut req = base_request();
        // Target is TX but a RX is connected.
        req.connected_device_type = Some(DeviceType::Rx);
        let paths = temp_paths("guard");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel).unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "txRxMismatch");
        // Guard fires before fetch/upload, so nothing was uploaded.
        assert!(backend.uploaded.lock().unwrap().is_none());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn guard_aborts_before_the_backup_is_written() {
        // v2.2/M67 regression marker (direct-ELRS free core). The Controller-
        // Bridge work (M63–M66) added a SEPARATE read-only probe/passthrough path
        // (`commands/bridge.rs` + `flash/bridge.rs`); it must NOT have perturbed
        // the free flashing core's staged order: guard (1) -> backpack guard (1b)
        // -> backup (2) -> fetch/validate (3) -> patch (4) -> upload (5). A TX/RX
        // mismatch must abort at step 1 — BEFORE the pre-flash backup is written —
        // so a refused flash never leaves a stray recovery snapshot on disk.
        // `base_request()` carries a `backup_target`, so had the order regressed
        // (backup before guard) the backups dir would exist after the abort.
        let mut req = base_request();
        req.connected_device_type = Some(DeviceType::Rx); // TX target, RX connected
        let paths = temp_paths("guard-before-backup");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel).unwrap_err();
        assert_eq!(err.summary_key, "txRxMismatch");
        assert!(backend.uploaded.lock().unwrap().is_none());
        // The backups dir was never created: the guard aborted before step 2.
        assert!(
            std::fs::read_dir(&paths.backups_dir).is_err(),
            "the guard must abort before the pre-flash backup is written"
        );
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn backpack_cross_type_guard_aborts_run_flash_before_upload() {
        use crate::flash::backpack::BackpackKind;
        // v2.2/M67 regression marker (WiFi/Backpack free core). The M19 Backpack
        // TX↔VRX cross-type guard (engine step 1b) must still refuse a mismatched
        // Backpack target through `run_flash`, before any erase/write — the bridge
        // work left it intact. Unit-level `check_backpack_compatibility` covers the
        // predicate; this pins the ENGINE WIRING of that guard end to end.
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        // Base TX/RX types still match (so the step-1 guard passes); the Backpack
        // kinds are crossed (TX-Backpack target onto a connected VRX-Backpack).
        req.backpack_kind = Some(BackpackKind::TxBackpack);
        req.connected_backpack_kind = Some(BackpackKind::VrxBackpack);

        let paths = temp_paths("backpack-cross");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a TX-Backpack target on a connected VRX-Backpack must be refused");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "backpackCrossType");
        // Cross-type guard fires before fetch/upload, so nothing was uploaded.
        assert!(backend.uploaded.lock().unwrap().is_none());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn connected_target_name_guard_aborts_run_flash_before_upload() {
        // The connected device's own name never guarded anything: it only titled
        // the backup document. Both the TX/RX class check (TX target, TX device)
        // and the image-vs-selected-target check (the mock serves an image for
        // `req.target`) pass here, so the ONLY thing that can catch a Ranger
        // image aimed at a connected BetaFPV Nano TX is step 1a.
        let mut req = base_request();
        req.target = "RADIOMASTER_RANGER_2400".into();
        req.connected_target_name = Some("BETAFPV_2400_TX".into());

        let paths = temp_paths("connected-name");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a Ranger target on a connected BetaFPV device must be refused");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "connectedTargetMismatch");
        // Guard fires before fetch/upload, and before the pre-flash backup.
        assert!(backend.uploaded.lock().unwrap().is_none());
        assert!(std::fs::read_dir(&paths.backups_dir).is_err());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn unknown_connected_target_name_does_not_block_the_flash() {
        // Abstain-on-unknown: an unflashed board / bootloader / WiFi OTA reports
        // no name, and that must never fail closed. `base_request` leaves
        // `connected_target_name` at None; a blank string must behave the same.
        for name in [None, Some(String::new()), Some("   ".into())] {
            let mut req = base_request();
            req.connected_target_name = name;
            let paths = temp_paths("connected-name-unknown");
            let backend = MockBackend {
                uploaded: Mutex::new(None),
                fail_upload: false,
            };
            let sink = TestSink::default();
            let cancel = Arc::new(FlashCancel::new());

            run_flash(&req, &paths, &backend, &sink, &cancel)
                .expect("an unknown connected target name must abstain, not block");
            std::fs::remove_dir_all(&paths.backups_dir).ok();
        }
    }

    #[test]
    fn backpack_cross_family_guard_blocks_main_elrs_on_a_backpack_device() {
        use crate::flash::backpack::BackpackKind;
        // The structurally-dead guard: `connected_backpack_kind` was only ever
        // consulted behind `if let Some(target_kind) = req.backpack_kind`, so a
        // main-ELRS flash aimed at a WiFi-discovered Backpack slipped through —
        // and over WiFi `connected_device_type` is None, so the TX/RX guard
        // abstains too. Step 1b now runs unconditionally.
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        req.connected_device_type = None; // nothing handshakes over WiFi
        req.backpack_kind = None; // a plain main-ELRS firmware flash
        req.connected_backpack_kind = Some(BackpackKind::VrxBackpack);

        let paths = temp_paths("backpack-cross-family");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("main-ELRS firmware must not be OTA'd to a Backpack device");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "backpackCrossFamily");
        assert!(backend.uploaded.lock().unwrap().is_none());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn backpack_flash_skips_options_patch_and_reaches_upload() {
        use crate::flash::backpack::BackpackKind;

        // A Backpack flash: WiFi-OTA, sourcing the delimiter-less placeholder
        // image. Without the backpack skip on the options-patch step, this aborts
        // at step 4 with `noOptionsRegion` and `upload` is never reached.
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        req.backpack_kind = Some(BackpackKind::TxBackpack);
        req.connected_backpack_kind = Some(BackpackKind::TxBackpack);

        let paths = temp_paths("backpack");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect("backpack flash should reach upload, not error at the patch step");

        // Reached the done stage at 100% (i.e. upload ran).
        let progress = sink.progress.lock().unwrap();
        assert_eq!(*progress.last().unwrap(), (FlashStage::Done, 100.0));

        // The placeholder was uploaded verbatim — no ELRS options patch applied.
        let uploaded = backend.uploaded.lock().unwrap().clone().unwrap();
        let expected = crate::flash::backpack::backpack_firmware(BackpackKind::TxBackpack).unwrap();
        assert_eq!(
            uploaded, expected,
            "backpack placeholder must be uploaded unpatched"
        );
        let logs = sink.logs.lock().unwrap();
        assert!(
            !logs.iter().any(|l| l.contains("Applied options patch")),
            "no ELRS options patch should be applied to a backpack flash"
        );

        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn real_backend_fails_closed_on_a_backpack_target() {
        use crate::flash::backpack::BackpackKind;

        // 2.4.9 §3 fail-closed guard: the REAL backend must NEVER hand the offline
        // placeholder image to `upload()` for a Backpack target — the per-target
        // release fetch is hardware-pending. So `acquire_firmware` returns a
        // categorised error instead of placeholder bytes; no non-real image can
        // reach a real device over WiFi-OTA. (Synchronous, no network: the
        // backpack branch returns before any HTTP.)
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        req.backpack_kind = Some(BackpackKind::TxBackpack);
        req.connected_backpack_kind = Some(BackpackKind::TxBackpack);

        let backend = test_real_backend("backpack-fail-closed");
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = backend
            .acquire_firmware(&req, &sink, &cancel)
            .expect_err("the real backend must refuse to source a placeholder Backpack image");
        assert_eq!(err.category, ErrorCategory::Unknown);
        assert_eq!(err.summary_key, "backpackFirmwareUnavailable");
        // Fail-closed: the error path returned Err, so no bytes (least of all the
        // placeholder) ever flow to `upload()`. Its recovery steps still render.
        assert!(!recovery_keys(err.category).is_empty());
    }

    #[test]
    fn local_file_flash_validates_and_uploads_verbatim() {
        // M25: a matching local `.bin` flashes unpatched (the user's exact image).
        let mut req = base_request();
        let bin = write_local_bin("ok", "BETAFPV_2400_TX");
        req.local_file_path = Some(bin.display().to_string());

        let paths = temp_paths("local-ok");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect("a matching local file should flash to done");

        // Reached done, and the uploaded bytes are the file's bytes verbatim
        // (no options patch applied to a local file).
        let progress = sink.progress.lock().unwrap();
        assert_eq!(*progress.last().unwrap(), (FlashStage::Done, 100.0));
        let uploaded = backend.uploaded.lock().unwrap().clone().unwrap();
        assert_eq!(uploaded, std::fs::read(&bin).unwrap());
        let logs = sink.logs.lock().unwrap();
        assert!(!logs.iter().any(|l| l.contains("Applied options patch")));

        std::fs::remove_file(&bin).ok();
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn local_file_mismatch_aborts_before_any_upload() {
        // M25 acceptance: the existing TX/RX guard passes (a TX is connected for
        // a TX selection), but the local FILE is actually an RX image — the
        // local-file validator catches it and returns BEFORE any erase/write.
        let mut req = base_request();
        req.connected_device_type = Some(DeviceType::Tx);
        let bin = write_local_bin("mismatch", "RADIOMASTER_RP1_2400_RX");
        req.local_file_path = Some(bin.display().to_string());

        let paths = temp_paths("local-mismatch");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("an RX local file on a TX device must be blocked");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        // Specifically the validator's mismatch, not the upstream TX/RX guard.
        assert_eq!(err.summary_key, "targetMismatch");
        // Nothing was uploaded — the device is untouched.
        assert!(backend.uploaded.lock().unwrap().is_none());
        let progress = sink.progress.lock().unwrap();
        assert!(!progress.iter().any(|(s, _)| *s == FlashStage::Done));

        std::fs::remove_file(&bin).ok();
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    /// Backend that hands the engine an EXACT byte string as the "downloaded"
    /// firmware, and records whether `upload` was ever reached. Models a fetch
    /// that succeeds at the transport level but returns the wrong/corrupt image
    /// (FLASH-2/FWCHK-5).
    struct BytesBackend {
        bytes: Vec<u8>,
        uploaded: Mutex<Option<Vec<u8>>>,
    }
    impl BytesBackend {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                bytes,
                uploaded: Mutex::new(None),
            }
        }
    }
    impl FlashBackend for BytesBackend {
        fn acquire_firmware(
            &self,
            _req: &FlashRequest,
            sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<Vec<u8>, FlashError> {
            sink.progress(FlashStage::Fetch, 15.0);
            Ok(self.bytes.clone())
        }
        fn upload(
            &self,
            _req: &FlashRequest,
            firmware: &[u8],
            _sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<(), FlashError> {
            *self.uploaded.lock().unwrap() = Some(firmware.to_vec());
            Ok(())
        }
    }

    #[test]
    fn a_downloaded_image_for_the_wrong_target_is_rejected_before_any_upload() {
        // FLASH-2/FWCHK-5 regression marker. The local-file branch ran the
        // pre-flash validator; the DOWNLOAD branch ran nothing at all, so bytes
        // straight off the network were patched and written unchecked. A
        // release asset built for a different (RX) target must now be refused in
        // the fetch stage, exactly like a mismatched local file, with the device
        // never touched.
        let req = base_request(); // TX target, TX connected
        let paths = temp_paths("download-wrong-target");
        let backend = BytesBackend::new(synthetic_firmware_for("RADIOMASTER_RP1_2400_RX"));
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a downloaded RX image on a TX device must be blocked");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "targetMismatch");
        assert!(
            backend.uploaded.lock().unwrap().is_none(),
            "the device must never be written with an unvalidated download"
        );
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn a_truncated_download_is_rejected_before_any_upload() {
        // The other half of FLASH-2: a download that ends early. `patch_binary`
        // only catches it by accident (and only when the delimiter happens to be
        // missing), so the size floor has to run over the fetched bytes too.
        let mut full = synthetic_firmware();
        full.truncate(64); // connection dropped a few bytes in
        let req = base_request();
        let paths = temp_paths("download-truncated");
        let backend = BytesBackend::new(full);
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a truncated download must never be flashed");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "firmwareTooSmall");
        assert!(backend.uploaded.lock().unwrap().is_none());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn a_downloaded_html_error_page_is_rejected_before_any_upload() {
        // The mirror/proxy failure mode: HTTP 200 with an error PAGE as the body.
        // It has no ExpressLRS options region, so it is not an ELRS image at all.
        let mut page = b"<!DOCTYPE html><html><body>404 Not Found</body></html>".to_vec();
        page.resize(4096, b' ');
        let req = base_request();
        let paths = temp_paths("download-html");
        let backend = BytesBackend::new(page);
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("an HTML error page must never be flashed");
        assert_eq!(err.summary_key, "notElrsFirmware");
        assert!(backend.uploaded.lock().unwrap().is_none());
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn a_valid_downloaded_image_still_flashes_and_is_logged_as_validated() {
        // The gate must not become a false-rejection machine: the matching image
        // for the requested target flashes through to done, and the validation
        // is visible in the log the user can inspect.
        let req = base_request();
        let paths = temp_paths("download-ok");
        let backend = BytesBackend::new(synthetic_firmware_for(&req.target));
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect("a matching downloaded image must flash");
        assert!(backend.uploaded.lock().unwrap().is_some());
        let logs = sink.logs.lock().unwrap();
        assert!(
            logs.iter().any(|l| l.contains("Firmware image validated")),
            "the fetch-stage validation must be reported: {logs:?}"
        );
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn failed_upload_still_leaves_the_recovery_backup() {
        // M29: the pre-flash backup is the user's recovery artifact. It is written
        // at step 2 (before the device is ever touched); a later upload failure
        // (step 5) must NOT remove it — otherwise a half-flashed device would have
        // no config to restore from.
        let req = base_request();
        let paths = temp_paths("fail-keeps-backup");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: true,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel).unwrap_err();
        assert_eq!(err.category, ErrorCategory::Wiring);

        // The backup survives the failed flash (exactly the one snapshot written
        // before the upload was attempted).
        let entries: Vec<_> = std::fs::read_dir(&paths.backups_dir).unwrap().collect();
        assert_eq!(
            entries.len(),
            1,
            "the pre-flash recovery backup must persist after a failed upload"
        );
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn wifi_ota_without_a_connected_device_allows_an_rx_target() {
        // M29 cross-device guard scenario: a WiFi OTA targets a device on the
        // network, so there is NO locally-connected device — `connected_device_type`
        // is None. The TX/RX guard has no context to compare against and MUST allow
        // the flash (even an RX target) rather than blocking it. A guard that
        // mistreated None as a concrete type would wrongly abort here.
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        req.device_type = DeviceType::Rx;
        req.target = "RADIOMASTER_RP1_2400_RX".into();
        req.connected_device_type = None; // nothing connected locally over WiFi
        req.backup_target = None; // nothing local to snapshot

        let paths = temp_paths("wifi-no-context");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect("a WiFi OTA with no connected-device context must be allowed");
        let progress = sink.progress.lock().unwrap();
        assert_eq!(*progress.last().unwrap(), (FlashStage::Done, 100.0));
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn esptool_args_use_the_right_chip_and_offset_per_mcu_family() {
        // FLASH-1 regression marker. The shipped command was
        // `--chip auto … write_flash 0x0 <bin>` for EVERY device: on an ESP32
        // that writes the application image over the second-stage bootloader
        // (0x1000) and the partition table (0x8000), boot-looping the device
        // unrecoverably. The chip and the offset must both follow the target's
        // MCU family, and `auto` must never be passed.
        let esp32 = RealBackend::esptool_write_args(
            McuFamily::Esp32,
            "/dev/ttyUSB0",
            ESPTOOL_DIRECT_BAUD,
            "/tmp/fw.bin",
        );
        assert_eq!(
            esp32,
            vec![
                "--chip",
                "esp32",
                "--port",
                "/dev/ttyUSB0",
                "--baud",
                "460800",
                // FLASH-6: the chip stays in the bootloader so the verify pass
                // can read the image back over the same session.
                "--after",
                "no_reset",
                "write_flash",
                "0x10000",
                "/tmp/fw.bin",
            ]
        );

        // ESP8285/ESP8266 keeps the shipped behaviour EXACTLY: image at 0x0.
        let esp8266 = RealBackend::esptool_write_args(
            McuFamily::Esp8266,
            "COM7",
            ESPTOOL_DIRECT_BAUD,
            "C:\\fw.bin",
        );
        assert_eq!(
            esp8266,
            vec![
                "--chip",
                "esp8266",
                "--port",
                "COM7",
                "--baud",
                "460800",
                "--after",
                "no_reset",
                "write_flash",
                "0x0",
                "C:\\fw.bin",
            ]
        );

        // Neither vector may still carry the offset-blind `auto` chip.
        assert!(!esp32.iter().any(|a| a == "auto"));
        assert!(!esp8266.iter().any(|a| a == "auto"));
    }

    #[test]
    fn the_esptool_image_is_staged_privately_and_removed() {
        // FLASH-8 regression marker. The image handed to esptool used to be
        // `std::env::temp_dir()/omnilink-flash-<pid>.bin`: a fully predictable
        // name in a mode-1777 directory, written with `fs::write` (which follows
        // symlinks ⇒ arbitrary file overwrite) and readable/replaceable by any
        // local user between the write and esptool opening it ⇒ attacker-chosen
        // firmware on real hardware. It is now created inside the app-data
        // staging dir under a random name, `O_EXCL` + mode 0600, and unlinked
        // when the flash ends.
        //
        // Driven through the cancel path so no esptool binary is needed: the
        // image is staged BEFORE the point-of-no-return check, so a refused
        // write still exercises staging + cleanup.
        let req = base_request(); // method = uart
        let paths = temp_paths("staging");
        let backend = RealBackend::new(paths.staging_dir.clone());
        let cancel = Arc::new(FlashCancel::new());
        assert!(cancel.request(), "the user cancels before the write");
        let sink = TestSink::default();

        let err = backend
            .upload(&req, &synthetic_firmware(), &sink, &cancel)
            .expect_err("a cancelled UART flash must not be written");
        assert_eq!(err.summary_key, "cancelled");

        // The predictable world-writable path must never be produced again.
        let legacy =
            std::env::temp_dir().join(format!("omnilink-flash-{}.bin", std::process::id()));
        assert!(
            !legacy.exists(),
            "the image must not be staged at the old predictable /tmp path"
        );
        // Staged inside the app-data dir, and cleaned up on the way out.
        let leftovers: Vec<_> = std::fs::read_dir(&paths.staging_dir)
            .expect("the staging dir is created under the app-data dir")
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect();
        assert!(
            leftovers.is_empty(),
            "the staged firmware image must be removed: {leftovers:?}"
        );
        std::fs::remove_dir_all(&paths.staging_dir).ok();
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn esptool_uses_the_negotiated_fc_baud_over_passthrough() {
        use crate::flash::msp::COMMON_FC_BAUDS;

        // FLASH-9 regression marker. `handshake_fc` discovers the FC's MSP baud
        // by trying `COMMON_FC_BAUDS` in order and used to DISCARD it (`Ok(())`),
        // after which esptool was invoked at a hardcoded 460800. Over the
        // passthrough every byte crosses the FC's UART at the negotiated rate,
        // so the standard case — CRSF at 420000, the FIRST candidate — could
        // never sync, and the failure surfaced as a `Wiring` "check your cable"
        // on hardware that was wired correctly.
        for &baud in COMMON_FC_BAUDS.iter() {
            assert_eq!(
                RealBackend::esptool_baud(Some(baud)),
                baud,
                "the passthrough upload must run at the baud the FC acked"
            );
            // Both passes — the write AND the read-back verify — cross the FC's
            // UART, so both must run at the negotiated rate.
            for args in [
                RealBackend::esptool_write_args(
                    McuFamily::Esp8266,
                    "/dev/ttyACM0",
                    RealBackend::esptool_baud(Some(baud)),
                    "/tmp/fw.bin",
                ),
                RealBackend::esptool_verify_args(
                    McuFamily::Esp8266,
                    "/dev/ttyACM0",
                    RealBackend::esptool_baud(Some(baud)),
                    "/tmp/fw.bin",
                ),
            ] {
                let at = args.iter().position(|a| a == "--baud").unwrap();
                assert_eq!(args[at + 1], baud.to_string());
            }
        }

        // The exact shipped failure: 420000 negotiated, 460800 sent.
        assert_ne!(
            RealBackend::esptool_baud(Some(COMMON_FC_BAUDS[0])),
            ESPTOOL_DIRECT_BAUD
        );

        // The direct-USB path is deliberately UNCHANGED: there the host talks to
        // the ESP ROM bootloader through the device's own USB-serial bridge,
        // which auto-bauds on sync, so no FC rate constrains it.
        assert_eq!(RealBackend::esptool_baud(None), ESPTOOL_DIRECT_BAUD);
    }

    #[test]
    fn mcu_family_resolves_the_catalogue_strings_and_fails_closed_otherwise() {
        // The two families the wizard catalogue ships (`src/lib/elrsTargets.ts`),
        // case-insensitively.
        assert_eq!(
            McuFamily::from_catalogue(Some("ESP32")).unwrap(),
            McuFamily::Esp32
        );
        assert_eq!(
            McuFamily::from_catalogue(Some("ESP8285")).unwrap(),
            McuFamily::Esp8266
        );
        assert_eq!(
            McuFamily::from_catalogue(Some(" esp8266 ")).unwrap(),
            McuFamily::Esp8266
        );

        // Fail closed: missing, empty, an ESP32 variant with a different
        // `--chip` id, and a non-esptool MCU all refuse rather than guess.
        for raw in [None, Some(""), Some("   "), Some("ESP32-S3"), Some("STM32")] {
            let err = McuFamily::from_catalogue(raw)
                .expect_err("an unknown MCU family must never resolve to a guessed offset");
            assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
            assert_eq!(err.summary_key, "unknownMcu");
        }
    }

    #[test]
    fn uart_upload_refuses_a_request_without_an_mcu() {
        // End to end through the real backend's UART path: an unknown MCU aborts
        // BEFORE esptool is spawned (and before the temp image is written), so no
        // wrong-offset write can reach the device.
        let mut req = base_request();
        req.mcu = None;
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = test_real_backend("no-mcu")
            .upload(&req, &synthetic_firmware(), &sink, &cancel)
            .expect_err("a request with no MCU family must not be flashed");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "unknownMcu");
        // Nothing was erased/written: the stage never advanced past fetch.
        let progress = sink.progress.lock().unwrap();
        assert!(progress.is_empty());
    }

    /// Backend that fires the user's cancel from *inside* the fetch — the
    /// FLASH-4 scenario: the firmware download is a blocking call that cannot be
    /// interrupted, so the flag is only observable once it returns. Records
    /// whether `upload` was ever reached (i.e. whether the device was touched).
    struct CancelDuringFetchBackend {
        cancel: Arc<FlashCancel>,
        uploaded: Mutex<Option<Vec<u8>>>,
    }
    impl FlashBackend for CancelDuringFetchBackend {
        fn acquire_firmware(
            &self,
            _req: &FlashRequest,
            sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<Vec<u8>, FlashError> {
            sink.progress(FlashStage::Fetch, 15.0);
            // The user hits cancel while the download is in flight; the download
            // still runs to completion and hands the engine an image.
            assert!(
                self.cancel.request(),
                "cancel must be accepted during fetch"
            );
            Ok(synthetic_firmware())
        }
        fn upload(
            &self,
            _req: &FlashRequest,
            firmware: &[u8],
            _sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<(), FlashError> {
            *self.uploaded.lock().unwrap() = Some(firmware.to_vec());
            Ok(())
        }
    }

    #[test]
    fn cancel_during_the_fetch_aborts_before_the_patch_and_never_uploads() {
        // FLASH-4 regression marker. `run_flash` used to check the cancel flag
        // NOWHERE in its own body: a cancel raised during the (uninterruptible,
        // blocking) firmware download was simply ignored, the options patch ran,
        // and the upload went ahead — over WiFi that meant the device was
        // flashed *despite* the cancel. Every step boundary must now honour it.
        let req = base_request();
        let paths = temp_paths("cancel-fetch");
        let cancel = Arc::new(FlashCancel::new());
        let backend = CancelDuringFetchBackend {
            cancel: cancel.clone(),
            uploaded: Mutex::new(None),
        };
        let sink = TestSink::default();

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a cancel raised during the fetch must abort the flash");

        // The shared cancellation representation — `commands::flash::run_worker`
        // keys `flash://cancelled` (not `flash://error`) off exactly this.
        assert_eq!(err.summary_key, "cancelled");
        assert_eq!(err.category, ErrorCategory::Unknown);
        // The device was never touched, and the image was never even patched.
        assert!(backend.uploaded.lock().unwrap().is_none());
        let logs = sink.logs.lock().unwrap();
        assert!(!logs.iter().any(|l| l.contains("Applied options patch")));
        let progress = sink.progress.lock().unwrap();
        assert!(!progress
            .iter()
            .any(|(s, _)| matches!(s, FlashStage::Write | FlashStage::Done)));
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn cancel_between_the_patch_and_the_upload_never_reaches_the_device() {
        // The other step boundary: the cancel lands after the options patch has
        // already been applied. The patched image must stay in memory — nothing
        // is uploaded.
        let req = base_request();
        let paths = temp_paths("cancel-pre-upload");
        let cancel = Arc::new(FlashCancel::new());
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        // Fires the cancel the moment the patch step logs its completion.
        let sink = TestSink::cancelling_on("Applied options patch", &cancel);

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a cancel before the upload must abort the flash");

        assert_eq!(err.summary_key, "cancelled");
        assert!(
            backend.uploaded.lock().unwrap().is_none(),
            "the upload must not run after an accepted cancel"
        );
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn wifi_ota_aborts_without_posting_when_cancelled() {
        // FLASH-4: `upload_wifi` did not even take a `cancel` argument, so a
        // cancelled flash still POSTed the whole image to the device. With the
        // point-of-no-return gate the POST is never attempted — the error is the
        // cancel, NOT a network failure against the (unreachable) address.
        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        // Discard port: were a POST attempted it would fail fast and loudly with
        // `otaUploadFailed`, which is exactly what this test rules out.
        req.device_ip = Some("127.0.0.1:9".into());

        let cancel = Arc::new(FlashCancel::new());
        assert!(
            cancel.request(),
            "the user cancels before the upload starts"
        );
        let sink = TestSink::default();

        let err = test_real_backend("wifi-cancel")
            .upload(&req, &synthetic_firmware(), &sink, &cancel)
            .expect_err("a cancelled WiFi OTA must not be uploaded");

        assert_eq!(err.summary_key, "cancelled");
        assert_ne!(
            err.summary_key, "otaUploadFailed",
            "no HTTP request may be attempted after a cancel"
        );
        // The point of no return was refused, so the device is untouched: no
        // write-stage progress and no device response were ever reported.
        assert!(!cancel.is_writing());
        let progress = sink.progress.lock().unwrap();
        assert!(!progress.iter().any(|(s, _)| *s == FlashStage::Write));
        let logs = sink.logs.lock().unwrap();
        assert!(!logs.iter().any(|l| l.contains("Device responded")));
    }

    #[test]
    fn a_run_past_the_point_of_no_return_is_not_treated_as_cancelled() {
        // The state word carries "writing" and "cancelling" in one place, so the
        // pipeline must not confuse them: a flash that has taken the point of no
        // return (and therefore refuses cancels) still runs to completion.
        let req = base_request();
        let paths = temp_paths("past-ponr");
        let cancel = Arc::new(FlashCancel::new());
        assert!(cancel.enter_write());
        assert!(!cancel.request(), "a cancel here must be refused");

        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: false,
        };
        let sink = TestSink::default();

        run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect("a refused cancel must not abort the flash");
        let progress = sink.progress.lock().unwrap();
        assert_eq!(*progress.last().unwrap(), (FlashStage::Done, 100.0));
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn a_refused_passthrough_gets_flight_controller_steps_not_cable_steps() {
        // An FC that answers `$M!` is reachable and refusing: neither the
        // Wiring category's "check your USB cable" nor the FirmwareMismatch
        // category's "confirm your brand and model" is the fix, and both send
        // the user to inspect something that is already correct.
        let err = FlashError::new(
            ErrorCategory::FirmwareMismatch,
            crate::flash::msp::PASSTHROUGH_UNAVAILABLE_KEY,
            "refused",
        );
        let steps = recovery_keys_for(&err);
        assert!(steps.contains(&"configureFcUart"), "steps: {steps:?}");
        assert!(!steps.contains(&"checkUsb"), "steps: {steps:?}");
        assert!(!steps.contains(&"verifyTarget"), "steps: {steps:?}");
    }

    #[test]
    fn recovery_keys_cover_every_category() {
        for cat in [
            ErrorCategory::Wiring,
            ErrorCategory::Driver,
            ErrorCategory::FirmwareMismatch,
            ErrorCategory::NetworkTimeout,
            ErrorCategory::CompilationError,
            ErrorCategory::Unknown,
        ] {
            assert!(!recovery_keys(cat).is_empty());
        }
    }

    #[test]
    fn a_404_download_is_a_missing_build_not_a_network_timeout() {
        // FWCHK-4: the artifactory URL is built blind from {version}/{target}, so
        // picking a version with no build for your device 404s. Reporting that as
        // a NetworkTimeout told the user to check their connection and retry a
        // request that can never succeed.
        let err = download_failure(
            "https://artifactory.expresslrs.org/ExpressLRS/3.6.0/BETAFPV_2400_RX/firmware.bin",
            "3.6.0",
            "BETAFPV_2400_RX",
            Some(404),
            false,
            "HTTP status client error (404 Not Found)",
        );
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "firmwareNotAvailableForTarget");
        // The detail names the pair that has no build, so the diagnostic report
        // says which version/target combination to change.
        assert!(err.detail.contains("3.6.0"), "detail: {}", err.detail);
        assert!(
            err.detail.contains("BETAFPV_2400_RX"),
            "detail: {}",
            err.detail
        );
        // …and the recovery tells them to change the VERSION, not to re-check a
        // brand/model pick that was never wrong.
        assert_eq!(
            recovery_keys_for(&err),
            &["chooseAnotherVersion", "verifyTarget"]
        );
    }

    #[test]
    fn a_refused_redirect_is_not_reported_as_a_flaky_network() {
        // The firmware image carries no digest, so a `302 Location:
        // http://attacker/firmware.bin` used to be followed in plaintext and the
        // only remaining gate was `inspect_firmware`'s heuristics. The policy
        // refuses it now — and the refusal must not be dressed up as a timeout
        // with "check your internet connection", which sends the user round a
        // loop that can only end the same way.
        let err = download_failure(
            "https://artifactory.expresslrs.org/ExpressLRS/3.6.0/BETAFPV_2400_RX/firmware.bin",
            "3.6.0",
            "BETAFPV_2400_RX",
            None,
            true,
            "error following redirect: refused redirect to http://attacker.net/firmware.bin",
        );
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "firmwareRedirectRefused");
        assert!(
            err.detail.contains(FIRMWARE_DOMAIN),
            "detail: {}",
            err.detail
        );
        assert_eq!(
            recovery_keys_for(&err),
            &["chooseAnotherVersion", "reportIssue"]
        );
        // A statusless failure that is NOT a redirect keeps the network mapping.
        let err = download_failure(
            "https://x/firmware.bin",
            "3.6.0",
            "T",
            None,
            false,
            "timed out",
        );
        assert_eq!(err.category, ErrorCategory::NetworkTimeout);
        assert_eq!(err.summary_key, "firmwareDownloadFailed");
    }

    #[test]
    fn an_oversize_download_is_refused_before_it_is_allocated() {
        // A response declaring `Content-Length: 8589934592` reached
        // `Vec::with_capacity(8 GiB)` before a byte was read; the allocation
        // failure is a Rust `alloc_error`, which ABORTS the process instead of
        // returning a FlashError, taking the user's wizard state with it. The
        // ceiling has to be consulted on the DECLARATION, and the reservation
        // clamped to it.
        let huge = 8u64 * 1024 * 1024 * 1024;
        assert!(huge > MAX_FIRMWARE_BYTES as u64);
        assert_eq!(
            huge.min(MAX_FIRMWARE_BYTES as u64) as usize,
            MAX_FIRMWARE_BYTES,
            "the pre-allocation must never exceed the ceiling"
        );

        let err = oversize_download_error("https://artifactory.expresslrs.org/f.bin", huge);
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, "firmwareDownloadTooLarge");
        assert!(
            err.detail.contains(&huge.to_string()),
            "detail: {}",
            err.detail
        );
        // The recovery must not be the FirmwareMismatch default ("confirm your
        // brand and model") — the pick was never the problem.
        assert_eq!(
            recovery_keys_for(&err),
            &["chooseAnotherVersion", "reportIssue"]
        );

        // A body that merely fits is untouched by either check.
        let ok_len = 512u64 * 1024;
        assert!(ok_len <= MAX_FIRMWARE_BYTES as u64);
        assert_eq!(ok_len.min(MAX_FIRMWARE_BYTES as u64), ok_len);
    }

    #[test]
    fn the_firmware_url_stays_on_the_pinned_domain() {
        // The redirect policy is only as good as the domain it pins; if the
        // artifact host ever moves, this catches the pin going stale rather than
        // silently refusing every download.
        let url =
            reqwest::Url::parse(&RealBackend::firmware_url("BETAFPV_2400_TX", "3.5.3").unwrap())
                .unwrap();
        assert!(crate::flash::redirect_target_allowed(&url, FIRMWARE_DOMAIN));
        assert!(reqwest::Url::parse(FIRMWARE_BASE_URL)
            .is_ok_and(|u| crate::flash::redirect_target_allowed(&u, FIRMWARE_DOMAIN)));
    }

    // -----------------------------------------------------------------------
    // FLASH-6: real verification + partial-write reporting.
    // -----------------------------------------------------------------------

    #[test]
    fn the_verify_pass_reads_the_image_back_from_the_chip() {
        // FLASH-6 regression marker. The verify stage used to be a bare
        // `progress(Verify, 98)` — it claimed the flash was good without reading
        // one byte back. The second esptool pass must actually re-read the
        // written region (`verify_flash` at the SAME offset, with the same
        // image), reuse the bootloader session the write left open, and be the
        // thing that finally resets the device into the new firmware.
        let write = RealBackend::esptool_write_args(
            McuFamily::Esp32,
            "/dev/ttyUSB0",
            ESPTOOL_DIRECT_BAUD,
            "/tmp/fw.bin",
        );
        let verify = RealBackend::esptool_verify_args(
            McuFamily::Esp32,
            "/dev/ttyUSB0",
            ESPTOOL_DIRECT_BAUD,
            "/tmp/fw.bin",
        );

        assert!(verify.iter().any(|a| a == "verify_flash"));
        // Same chip, same offset, same image as the write — verifying anything
        // else would be theatre.
        let w_at = write.iter().position(|a| a == "write_flash").unwrap();
        let v_at = verify.iter().position(|a| a == "verify_flash").unwrap();
        assert_eq!(write[w_at + 1], verify[v_at + 1], "same flash offset");
        assert_eq!(write[w_at + 2], verify[v_at + 2], "same image file");
        assert_eq!(verify[1], "esp32");

        // A mismatch reported by the tool becomes the read-back failure…
        let mismatch = verify_failure(
            "/dev/ttyUSB0",
            FlashError::new(ErrorCategory::Wiring, "toolFailed", "verify FAILED"),
        );
        assert_eq!(mismatch.summary_key, "verifyFailed");
        assert!(mismatch.detail.contains("verify FAILED"));
        // …but an outcome that says nothing about the image (the tool never ran)
        // must not be mis-sold as a corrupt flash.
        for key in ["toolNotFound", "spawnFailed", "waitFailed", "cancelled"] {
            let err = verify_failure(
                "/dev/ttyUSB0",
                FlashError::new(ErrorCategory::Driver, key, "…"),
            );
            assert_eq!(err.summary_key, key);
        }

        // The write leaves the chip in the bootloader; the verify picks that
        // session up and resets into the firmware afterwards.
        let after_write = write.iter().position(|a| a == "--after").unwrap();
        assert_eq!(write[after_write + 1], "no_reset");
        let before_verify = verify.iter().position(|a| a == "--before").unwrap();
        assert_eq!(verify[before_verify + 1], "no_reset");
        let after_verify = verify.iter().position(|a| a == "--after").unwrap();
        assert_eq!(verify[after_verify + 1], "hard_reset");
    }

    #[test]
    fn an_ota_response_is_only_a_success_when_the_device_says_so() {
        // FLASH-6: `upload_wifi` used to look at `resp.status()` and throw the
        // body away, so a device that answered 200 while REJECTING the image
        // (typically one built for a different target) produced the green
        // success screen and an unbootable radio.
        //
        // Accepted: ExpressLRS's own JSON confirmation, and the plain `OK` of the
        // Arduino updater family.
        assert_eq!(
            classify_ota_response(r#"{"status":"ok","msg":"Update complete. Please wait…"}"#)
                .unwrap(),
            "Update complete. Please wait…"
        );
        assert_eq!(classify_ota_response("OK").unwrap(), "OK");
        assert!(classify_ota_response("Update complete, rebooting").is_ok());

        // Rejected: the device's explicit refusals…
        let mismatch = classify_ota_response(
            r#"{"status":"mismatch","msg":"Current target: A, Update target: B"}"#,
        )
        .unwrap_err();
        assert!(mismatch.contains("mismatch"), "{mismatch}");
        assert!(mismatch.contains("Update target: B"), "{mismatch}");
        assert!(classify_ota_response(r#"{"status":"error","msg":"Not enough space"}"#).is_err());

        // …and everything that does not positively confirm the update. Being
        // conservative here is deliberate: a false "flash again" is recoverable,
        // a false success is a radio the user thinks is fine.
        for body in ["", "   ", "FAIL", "<html>404</html>", r#"{"msg":"hello"}"#] {
            assert!(
                classify_ota_response(body).is_err(),
                "unconfirmed body must not pass as a success: {body:?}"
            );
        }
    }

    #[test]
    fn the_ota_response_body_is_capped_and_an_oversize_one_is_a_rejection() {
        // FIX 9G: `resp.text()` was unbounded. `/update` is a LAN address the
        // user typed (`isValidDeviceIp` accepts hostnames), so a hostile or
        // merely broken endpoint could stream for the whole 60s request timeout
        // straight into RAM.
        let real = read_ota_body(&b"{\"status\":\"ok\",\"msg\":\"Update complete\"}"[..]).unwrap();
        assert!(classify_ota_response(&real).is_ok());

        // Exactly at the cap still reads in full — the ceiling is not a trap for
        // a verbose but honest device.
        let at_cap = vec![b'x'; MAX_OTA_BODY_BYTES];
        assert_eq!(
            read_ota_body(&at_cap[..]).unwrap().len(),
            MAX_OTA_BODY_BYTES
        );

        // One byte past it is refused, and refused as a REJECTION: the
        // fail-closed rule — only a positive confirmation is a success — has to
        // hold for a body we stopped reading as much as for one we read whole.
        let over = vec![b'x'; MAX_OTA_BODY_BYTES + 1];
        let err = read_ota_body(&over[..]).expect_err("an over-size body is refused");
        assert_eq!(err.summary_key, "otaRejected");
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);

        // A body prefixed with a valid confirmation does not buy a pass either:
        // the device is not answering the way an `/update` endpoint answers.
        let mut sneaky = b"Update complete".to_vec();
        sneaky.resize(MAX_OTA_BODY_BYTES + 1, b'x');
        assert!(read_ota_body(&sneaky[..]).is_err());

        // Non-UTF-8 is read lossily rather than becoming a transport error, so
        // `classify_ota_response` still gets to fail it closed.
        let lossy = read_ota_body(&[0xFF, 0xFE, b'O', b'K'][..]).unwrap();
        assert!(lossy.contains("OK"), "{lossy}");
    }

    #[test]
    fn an_ota_endpoint_that_redirects_never_reaches_the_body_classifier() {
        // FIX 9G: the OTA client is exempt from the pinned-domain policy (it
        // posts to a LAN address the user typed) but kept reqwest's DEFAULT —
        // ten hops to ANY host. `deviceIp` accepts hostnames, so a spoofed
        // `.local` endpoint could 307 the ~1 MB POST elsewhere and then supply
        // the body `classify_ota_response` reads: a flash that never happened,
        // shown as the green success screen. With `Policy::none()` the 3xx comes
        // back as an ordinary response, and `error_for_status` passes it, so the
        // guard below is what stops that body from being read as a verdict.
        for code in [301u16, 302, 303, 307, 308] {
            let status = reqwest::StatusCode::from_u16(code).unwrap();
            let err = reject_ota_redirect("http://elrs-tx.local/update", status)
                .expect_err("a redirecting /update endpoint is not an update outcome");
            assert_eq!(err.summary_key, "otaRejected");
            assert!(err.detail.contains("redirecting"), "{}", err.detail);
        }
        // Everything the device may legitimately answer with passes through to
        // the body classifier, which is where the real verdict lives.
        for code in [200u16, 204] {
            assert!(reject_ota_redirect(
                "http://10.0.0.1/update",
                reqwest::StatusCode::from_u16(code).unwrap()
            )
            .is_ok());
        }
    }

    #[test]
    fn a_failure_past_the_write_stage_is_reported_as_a_possible_partial_write() {
        // FLASH-6, the more important half: after ANY failure the user used to be
        // told to "retry" (for a WiFi OTA: "check your internet connection"),
        // with no hint that the device might be holding half an image. A failure
        // at or after the write stage now carries its own summary key and its own
        // recovery steps.
        for stage in [FlashStage::Write, FlashStage::Verify] {
            let err = escalate_after_write(
                Some(stage),
                FlashError::new(
                    ErrorCategory::NetworkTimeout,
                    "otaUploadFailed",
                    "connection reset",
                ),
            );
            assert_eq!(err.summary_key, PARTIAL_WRITE_KEY);
            // The category (and with it the log/diagnostic classification) is
            // preserved, and the original failure is not lost — it is folded into
            // the detail the diagnostic report carries.
            assert_eq!(err.category, ErrorCategory::NetworkTimeout);
            assert!(err.detail.contains("otaUploadFailed"), "{}", err.detail);
            assert!(err.detail.contains("connection reset"), "{}", err.detail);
            // …and the recovery says "flash it again", NOT "check your network".
            assert_eq!(
                recovery_keys_for(&err),
                &["reflashDevice", "keepDevicePowered", "viewLog"]
            );
            assert!(!recovery_keys_for(&err).contains(&"checkNetwork"));
        }
    }

    #[test]
    fn failures_that_never_reached_the_device_keep_their_own_error() {
        let wiring = || FlashError::new(ErrorCategory::Wiring, "noPort", "no serial port selected");

        // Nothing reported yet, or only the pre-write stages: the device was
        // never touched, so the scary message would be wrong.
        for stage in [None, Some(FlashStage::Fetch), Some(FlashStage::Erase)] {
            assert_eq!(escalate_after_write(stage, wiring()).summary_key, "noPort");
        }

        // `run_streaming` announces its stage BEFORE spawning the child, so a
        // missing/unspawnable tool "reaches" the write stage with the child never
        // existing. Those two, and a cancel (refused past the point of no
        // return, so one can only be pending when nothing was written), must not
        // be escalated either.
        for key in NEVER_TOUCHED_THE_DEVICE {
            let err = escalate_after_write(
                Some(FlashStage::Write),
                FlashError::new(ErrorCategory::Driver, key, "…"),
            );
            assert_eq!(
                err.summary_key, key,
                "{key} must not become a partial write"
            );
        }
    }

    #[test]
    fn a_failed_upload_through_run_flash_reports_the_partial_write() {
        // The wiring of the above through the real pipeline: `MockBackend`
        // reports the write stage and then fails, exactly like esptool dying
        // mid-transfer.
        let req = base_request();
        let paths = temp_paths("partial-write");
        let backend = MockBackend {
            uploaded: Mutex::new(None),
            fail_upload: true,
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel).unwrap_err();
        assert_eq!(err.summary_key, PARTIAL_WRITE_KEY);
        assert!(err.detail.contains("toolFailed"), "{}", err.detail);
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    // -----------------------------------------------------------------------
    // FLASH-12: the esptool pre-flight probe.
    // -----------------------------------------------------------------------

    /// Backend whose pre-flight check fails, standing in for a host with no
    /// esptool installed. Records whether the fetch was ever reached.
    struct NoToolBackend {
        fetched: Mutex<bool>,
    }
    impl FlashBackend for NoToolBackend {
        fn preflight(&self, _req: &FlashRequest, _sink: &dyn FlashSink) -> Result<(), FlashError> {
            Err(esptool_missing_error())
        }
        fn acquire_firmware(
            &self,
            _req: &FlashRequest,
            _sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<Vec<u8>, FlashError> {
            *self.fetched.lock().unwrap() = true;
            Ok(synthetic_firmware())
        }
        fn upload(
            &self,
            _req: &FlashRequest,
            _firmware: &[u8],
            _sink: &dyn FlashSink,
            _cancel: &Arc<FlashCancel>,
        ) -> Result<(), FlashError> {
            panic!("a flash with no flashing tool must never reach the upload");
        }
    }

    #[test]
    fn a_missing_flashing_tool_aborts_before_the_backup_and_the_download() {
        // FLASH-12 regression marker. esptool is neither bundled (no
        // `externalBin`/sidecar, no bundle resource) nor checked for, so a user
        // without it got `toolNotFound` — but only AFTER the guard, the pre-flash
        // backup AND the entire multi-hundred-KB firmware download had run. The
        // probe is step 0 now: nothing is written to disk and nothing is fetched.
        let req = base_request(); // uart
        let paths = temp_paths("no-esptool");
        let backend = NoToolBackend {
            fetched: Mutex::new(false),
        };
        let sink = TestSink::default();
        let cancel = Arc::new(FlashCancel::new());

        let err = run_flash(&req, &paths, &backend, &sink, &cancel)
            .expect_err("a flash must not start without its flashing tool");

        assert_eq!(err.summary_key, "esptoolNotFound");
        assert!(!*backend.fetched.lock().unwrap(), "nothing may be fetched");
        assert!(
            std::fs::read_dir(&paths.backups_dir).is_err(),
            "the pre-flight check must abort before the backup is written"
        );
        let progress = sink.progress.lock().unwrap();
        assert!(progress.is_empty(), "no stage may be entered: {progress:?}");
        std::fs::remove_dir_all(&paths.backups_dir).ok();
    }

    #[test]
    fn the_missing_tool_error_names_both_binaries_and_how_to_install_them() {
        let err = esptool_missing_error();
        assert_eq!(err.category, ErrorCategory::Driver);
        assert_eq!(err.summary_key, "esptoolNotFound");
        // Both upstream names are probed — an installed toolchain often only has
        // `esptool.py`, which the bare `esptool` spawn would have missed.
        for name in ESPTOOL_PROGRAMS {
            assert!(err.detail.contains(name), "{}", err.detail);
        }
        assert!(err.detail.contains("pip install esptool"), "{}", err.detail);
        // Actionable recovery: install it, rather than the Driver category's
        // driver/permissions/udev steps.
        assert_eq!(recovery_keys_for(&err), &["installEsptool", "reportIssue"]);
    }

    #[test]
    fn only_the_serial_transports_need_esptool() {
        // A WiFi OTA is plain HTTP — it must never be blocked by a missing local
        // tool (and the real backend's pre-flight returns Ok for it).
        assert!(method_needs_esptool(FlashMethod::Uart));
        assert!(method_needs_esptool(FlashMethod::Betaflight));
        assert!(!method_needs_esptool(FlashMethod::Wifi));

        let mut req = base_request();
        req.method = FlashMethod::Wifi;
        req.port = None;
        req.device_ip = Some("10.0.0.1".into());
        test_real_backend("wifi-preflight")
            .preflight(&req, &TestSink::default())
            .expect("a WiFi OTA must not require a local flashing tool");
    }

    // -----------------------------------------------------------------------
    // FLASH-14: download progress + URL segment validation.
    // -----------------------------------------------------------------------

    #[test]
    fn the_download_reports_progress_as_bytes_arrive() {
        // FLASH-14: the bar sat at 0% for the whole fetch and then jumped to 20%,
        // because the body was consumed in one `resp.bytes()` call.
        let total = Some(1000u64);
        assert_eq!(download_progress(0, total), 0.0);
        assert_eq!(download_progress(500, total), DOWNLOAD_PCT_END / 2.0);
        assert_eq!(download_progress(1000, total), DOWNLOAD_PCT_END);
        // Monotonic, and never past the end of the fetch band even if the server
        // sends more than it declared.
        assert_eq!(download_progress(4000, total), DOWNLOAD_PCT_END);

        // No `Content-Length` (chunked): a monotonic creep that approaches but
        // never reaches the end of the band, so the bar still moves.
        let mut last = -1.0;
        for received in [0u64, 1024, 64 * 1024, 512 * 1024, 8 * 1024 * 1024] {
            let pct = download_progress(received, None);
            assert!(pct > last, "creep must be monotonic");
            assert!(pct < DOWNLOAD_PCT_END, "creep must never reach the end");
            last = pct;
        }
        // A zero declared length is treated as "unknown", not a division by zero.
        assert!(download_progress(10, Some(0)).is_finite());
    }

    #[test]
    fn the_firmware_url_refuses_crafted_version_and_target_segments() {
        // FLASH-14: `{version}` and `{target}` were interpolated into the
        // artifactory URL raw, so a crafted value walked the path within the host
        // (`3.5.3/../../other/thing`) or bent the request elsewhere.
        let ok = RealBackend::firmware_url("BETAFPV_2400_TX", "3.5.3").unwrap();
        assert_eq!(
            ok,
            "https://artifactory.expresslrs.org/ExpressLRS/3.5.3/BETAFPV_2400_TX/firmware.bin"
        );
        // The real tag/target alphabet keeps working, dots and dashes included.
        assert!(RealBackend::firmware_url("RADIOMASTER_RP1_2400_RX", "v3.5.3-RC1").is_ok());

        for (target, version) in [
            ("BETAFPV_2400_TX", "../../../etc"),
            ("BETAFPV_2400_TX", ".."),
            ("BETAFPV_2400_TX", "3.5.3/../../evil"),
            ("BETAFPV_2400_TX", "3.5.3?x=1"),
            ("BETAFPV_2400_TX", "3.5.3%2f..%2f"),
            ("BETAFPV_2400_TX", ""),
            ("../secrets", "3.5.3"),
            ("BETAFPV 2400 TX", "3.5.3"),
            ("BETAFPV_2400_TX\n", "3.5.3"),
        ] {
            let err = RealBackend::firmware_url(target, version)
                .expect_err("a crafted segment must never reach the network: {target}/{version}");
            assert_eq!(err.summary_key, "invalidFirmwareRequest");
            assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        }
    }

    #[test]
    fn transport_failures_and_5xx_stay_network_timeouts() {
        // The other half of FWCHK-4: a genuine transport failure or a server-side
        // 5xx CAN succeed on a retry, so it keeps the network mapping (and with it
        // the checkNetwork/retry recovery steps).
        for status in [None, Some(500), Some(502), Some(503)] {
            let err = download_failure(
                "https://x/firmware.bin",
                "3.5.3",
                "T",
                status,
                false,
                "timed out",
            );
            assert_eq!(
                err.category,
                ErrorCategory::NetworkTimeout,
                "status {status:?} must stay retryable"
            );
            assert_eq!(err.summary_key, "firmwareDownloadFailed");
            assert_eq!(recovery_keys_for(&err), recovery_keys(err.category));
        }
    }
}
