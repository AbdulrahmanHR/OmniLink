//! Firmware flashing commands (FR-FLASH-01 → 12).
//!
//! M8-API: replaces the M4-UI flash mock with a real backend. This module is
//! the thin Tauri glue around the engine in [`crate::flash`]:
//!
//! * [`fetch_firmware_releases`] — GitHub release list + changelog (FR-FLASH-01).
//! * [`start_flash`] — spawns a worker thread (mirroring `device.rs`) that runs
//!   [`crate::flash::engine::run_flash`] and streams `flash://*` events.
//! * [`cancel_flash`] — signals the worker to abort, unless the flash has passed
//!   the point of no return (see [`CancelOutcome`]).
//!
//! Events (camelCase payloads, mirroring `FlashStage`/`FlashStatus` in
//! `src/stores/wizard.ts`):
//! * `flash://progress` — `{ stage, percent, etaSeconds? }`
//! * `flash://log` — `{ line, isError }`
//! * `flash://done` — `{}`
//! * `flash://error` — `{ category, summaryKey, detail, recoverySteps, diagnostic }`

use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::device::DeviceManager;
use crate::flash::cancel::FlashCancel;
use crate::flash::engine::{self, FlashBackend, FlashPaths, FlashRequest, FlashSink};
use crate::flash::github;
use crate::flash::{FlashError, FlashMethod, FlashStage};

// ---------------------------------------------------------------------------
// Event payloads.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressDto {
    stage: String,
    percent: f32,
    /// Estimated seconds remaining; `None` until enough progress to estimate.
    eta_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogDto {
    line: String,
    is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDto {
    category: String,
    summary_key: String,
    detail: String,
    recovery_steps: Vec<String>,
    /// Clipboard-ready diagnostic block (FR-FLASH-12 (d)).
    diagnostic: String,
}

// ---------------------------------------------------------------------------
// Sink: emits flash://* events and computes ETA from elapsed/percent.
// ---------------------------------------------------------------------------

struct EventSink {
    app: AppHandle,
    started: Instant,
}

impl FlashSink for EventSink {
    fn progress(&self, stage: FlashStage, percent: f32) {
        let eta_seconds = if percent > 1.0 && percent < 100.0 {
            let elapsed = self.started.elapsed().as_secs_f32();
            let total = elapsed / (percent / 100.0);
            Some((total - elapsed).max(0.0) as u64)
        } else {
            None
        };
        emit_or_log(
            &self.app,
            "flash://progress",
            ProgressDto {
                stage: stage.as_str().to_string(),
                percent,
                eta_seconds,
            },
        );
    }

    fn log(&self, line: &str, is_error: bool) {
        if is_error {
            tracing::error!(target: "flash", "{line}");
        }
        emit_or_log(
            &self.app,
            "flash://log",
            LogDto {
                line: line.to_string(),
                is_error,
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Managed worker state.
// ---------------------------------------------------------------------------

struct ActiveFlash {
    cancel: Arc<FlashCancel>,
    handle: JoinHandle<()>,
}

/// Tauri-managed handle to the running flash worker, if any.
///
/// `active` is locked with `unwrap_or_else(|e| e.into_inner())`, never
/// `unwrap()`: the guarded value is a single `Option` slot with no invariant to
/// tear, and the commands that take it run on the blocking pool, so a panic here
/// fails one command instead of aborting the app. Propagating poison would wedge
/// start/cancel for the lifetime of the process — see [`super::device::DeviceManager`].
#[derive(Default)]
pub struct FlashManager {
    active: Mutex<Option<ActiveFlash>>,
}

/// What a cancel request actually did. Returned to the UI by [`cancel_flash`]
/// so it can distinguish "stopped" from "too late to stop" instead of assuming
/// the flash ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelOutcome {
    /// No flash was running (or the worker had already finished) — a no-op.
    NotRunning,
    /// Accepted: the worker was signalled and joined, and `flash://cancelled`
    /// has been emitted.
    Cancelled,
    /// REFUSED — the device's flash is being rewritten (FLASH-4). Stopping
    /// esptool / the OTA transfer half-way leaves a truncated image, i.e. a
    /// bricked device, so the flash is deliberately allowed to finish. The UI
    /// hides its cancel control from the same point (`write` stage onward).
    WriteInProgress,
}

impl FlashManager {
    /// Signal any running flash to cancel and join the worker.
    ///
    /// The point-of-no-return policy lives HERE (and in [`FlashCancel`]) rather
    /// than in `platformio::run_streaming`: the runner stays a dumb "stop when
    /// told" mechanism, while the one place that owns the worker decides whether
    /// a stop may be requested at all. Past the write stage
    /// [`FlashCancel::request`] refuses, the flag is never raised, and — just as
    /// importantly — we do NOT join, so the UI thread isn't blocked for the
    /// duration of a write it cannot stop anyway.
    fn cancel_and_join(&self) -> CancelOutcome {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        let Some(active) = slot.as_ref() else {
            return CancelOutcome::NotRunning;
        };
        // The state word latches at "writing", so a *finished* write must not
        // block later cancels (or the next `start_flash`) forever.
        let already_finished = active.handle.is_finished();
        if !already_finished && !active.cancel.request() {
            debug_assert!(
                active.cancel.is_writing(),
                "a cancel is only ever refused past the point of no return"
            );
            tracing::info!(
                target: "flash",
                "cancel refused: the device is being written and stopping now would brick it"
            );
            return CancelOutcome::WriteInProgress;
        }
        let active = slot.take().expect("checked Some above");
        // Never join while holding the manager lock.
        drop(slot);
        if active.handle.join().is_err() {
            tracing::error!(target: "flash", "worker thread panicked before exit");
        }
        if already_finished {
            CancelOutcome::NotRunning
        } else {
            CancelOutcome::Cancelled
        }
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Fetch the ExpressLRS firmware release list + changelog (FR-FLASH-01).
/// Cached + offline-tolerant in the engine layer; the returned
/// [`github::ReleaseList`] carries the `stale`/`fetchedAt` provenance so the UI
/// can tell a live list from a cached one (FWCHK-7). A failure rejects with a
/// typed [`github::ReleaseFetchError`] (`{ kind, detail }`) so the wizard can
/// distinguish a GitHub rate-limit from an actually-offline machine.
///
/// Runs on the BLOCKING pool (FWCHK-1): the body is a BLOCKING HTTP fetch that
/// can take ~31 s offline with a cold cache (3 attempts × 10 s + backoff). A
/// plain `pub fn` command would freeze the webview for exactly that long, and
/// `#[tauri::command(async)]` — which spawns a synchronous body as a *task* —
/// would pin one of only `available_parallelism()` tokio workers instead: on a
/// 2-core machine one offline release check plus one passthrough check left
/// `connect_device` unscheduled for half a minute.
#[tauri::command]
pub async fn fetch_firmware_releases() -> Result<github::ReleaseList, github::ReleaseFetchError> {
    tauri::async_runtime::spawn_blocking(github::fetch_releases)
        .await
        .map_err(|e| github::ReleaseFetchError {
            kind: github::FetchFailureKind::Unknown,
            detail: e.to_string(),
        })?
}

/// Derive the real ExpressLRS 6-byte binding UID from a phrase (FR-FLASH-03).
///
/// Thin wrapper over [`crate::flash::options::derive_uid`] so the wizard can show
/// the user the *exact* UID that will be flashed (`MD5("-DMY_BINDING_PHRASE=…")`),
/// rather than a cosmetic preview. The phrase is trimmed to match the engine's
/// `resolved_uid` behaviour. SENSITIVE input — never logged (NFR-PRIV-01).
#[tauri::command]
pub fn derive_uid(phrase: String) -> [u8; 6] {
    crate::flash::options::derive_uid(phrase.trim())
}

/// Whether a transport takes exclusive ownership of the serial port.
///
/// The CRSF reader thread holds the port with `TIOCEXCL` + `flock(LOCK_EX)` on
/// POSIX (exclusive open on Windows), so a serial flash MUST have it released
/// first or esptool / the `handshake_fc` re-open fail with a busy/access-denied
/// error the UI can only report as a wiring fault. WiFi OTA goes over HTTP and
/// never touches the port, so a live CRSF connection is deliberately left alone.
fn method_holds_serial_port(method: FlashMethod) -> bool {
    match method {
        FlashMethod::Uart | FlashMethod::Betaflight => true,
        FlashMethod::Wifi => false,
    }
}

/// Start a flash. Returns once the worker thread is spawned; the result arrives
/// via `flash://*` events (FR-FLASH-06/07).
///
/// Runs on the BLOCKING pool (FLASH-7): spawning the worker is quick, but the
/// two guards ahead of it are not — `cancel_and_join` joins a previous worker
/// and the device takeover joins the CRSF reader thread. Neither belongs on the
/// webview thread, nor on a tokio worker where it would sit in front of every
/// other queued command.
#[tauri::command]
pub async fn start_flash(app: AppHandle, request: FlashRequest) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || start_flash_blocking(handle, request))
        .await
        .map_err(|e| e.to_string())?
}

fn start_flash_blocking(app: AppHandle, request: FlashRequest) -> Result<(), String> {
    let manager = app.state::<FlashManager>();
    let devices = app.state::<DeviceManager>();

    // One flash at a time — cancel any prior worker first. A worker that is
    // mid-write cannot be cancelled, so we refuse to start a second flash rather
    // than run two uploaders against the same device.
    if manager.cancel_and_join() == CancelOutcome::WriteInProgress {
        return Err("a flash is already writing to the device".to_string());
    }

    // CONN-1/FLASH-3: release the serial port BEFORE the worker starts, and take
    // the port's CLAIM in the same breath. Enforced here rather than only in the
    // frontend so the invariant cannot be bypassed by a caller that forgets to
    // disconnect first.
    //
    // The claim is what makes the release meaningful: the CRSF reader was never
    // the only opener — a controller probe / context fetch / passthrough check
    // holds the port too, and the reader teardown cannot see those. Without a
    // claim, esptool opened a port OmniLink was already driving, failed "could
    // not open port ... busy", and `categorize_tool_failure` reported that to
    // the user as a WIRING fault — telling them to re-cable a device nothing had
    // touched, after the UI had passed the point of no return.
    let claim = if method_holds_serial_port(request.method) {
        let (released, claim) = devices.claim_for_flash(request.port.as_deref())?;
        if released {
            // The connection really was live — tell the UI it is gone, so it
            // can't keep claiming a link (or offer a Connect/probe button) over
            // a port the flash now owns.
            emit_or_log(&app, "device://disconnected", ());
        }
        claim
    } else {
        // WiFi OTA goes over HTTP and never touches the serial port.
        None
    };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    // Both live under the app-data dir: the recovery backups, and (FLASH-8) the
    // directory the image handed to esptool is staged in — never the
    // world-writable system temp dir.
    let paths = FlashPaths {
        backups_dir: app_data_dir.join("backups"),
        staging_dir: app_data_dir.join("staging"),
    };

    let cancel = Arc::new(FlashCancel::new());
    let cancel_for_thread = cancel.clone();
    let app_for_thread = app.clone();

    let handle = std::thread::Builder::new()
        .name("flash-worker".into())
        .spawn(move || {
            // The port claim lives for the whole flash and is released when this
            // worker exits — including on a panic — so nothing can take the port
            // out from under esptool / the MSP passthrough mid-write.
            let _claim = claim;
            run_worker(app_for_thread, request, paths, cancel_for_thread);
        })
        .map_err(|e| e.to_string())?;

    *manager.active.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(ActiveFlash { cancel, handle });
    Ok(())
}

/// Cancel the active flash, if any.
///
/// Returns what actually happened: a cancel is **refused** once the write has
/// begun ([`CancelOutcome::WriteInProgress`]), because interrupting an erase or
/// a half-finished write bricks the device. The UI keeps showing progress in
/// that case instead of pretending the flash stopped.
///
/// Runs on the BLOCKING pool (FLASH-7): a cancel BEFORE the point of no return
/// still joins the worker, which can take as long as the current step; past it
/// the join is skipped, but neither wait belongs on the webview thread — nor on
/// a tokio worker, where it would block every other queued command.
#[tauri::command]
pub async fn cancel_flash(app: AppHandle) -> Result<CancelOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<FlashManager>().cancel_and_join())
        .await
        .map_err(|e| e.to_string())
}

/// Wipe every pre-flash device-config backup (`<app_data_dir>/backups`) for the
/// GDPR-style "Delete all my data" erase (NFR-PRIV-02). The `.elrsp` files are
/// the user's own device config = personal data, so the local erase must clear
/// them too. A missing directory is a clean no-op.
#[tauri::command]
pub fn delete_all_backups(app: AppHandle) -> Result<(), String> {
    let backups_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("backups"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    crate::flash::backup::clear_backups_dir(&backups_dir).map_err(|e| format!("clear backups: {e}"))
}

/// Open `<app_data_dir>/backups` in the OS file manager (FLASH-5).
///
/// The pre-flash snapshots were written to a directory no UI ever mentioned and
/// no user action could reach — `delete_all_backups` was the only reference to
/// them in the whole frontend — so the artifact the engine refuses to flash
/// without was, in practice, unreachable. With the document now importable by
/// the Profiles page (`src/lib/elrsp.ts`), this is the one action that makes it
/// real: show the user where the files are so they can import one.
///
/// The directory is created if it does not exist yet, so a user who has never
/// flashed sees an empty folder rather than an error.
#[tauri::command]
pub fn open_backups_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let backups_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("backups"))
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&backups_dir).map_err(|e| format!("create backups dir: {e}"))?;
    app.opener()
        .open_path(backups_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("open backups dir: {e}"))
}

/// Worker body: run the engine against the production backend and translate the
/// outcome into `flash://done` / `flash://error`.
fn run_worker(app: AppHandle, request: FlashRequest, paths: FlashPaths, cancel: Arc<FlashCancel>) {
    let sink = EventSink {
        app: app.clone(),
        started: Instant::now(),
    };
    let real = engine::RealBackend::new(paths.staging_dir.clone());
    let backend: &dyn FlashBackend = &real;

    match engine::run_flash(&request, &paths, backend, &sink, &cancel) {
        Ok(()) => emit_or_log(&app, "flash://done", ()),
        // A user cancel is a distinct outcome, not a failure: when an accepted
        // cancel is pending we emit `flash://cancelled` instead of
        // `flash://error` so the UI lands on idle and never flashes a spurious
        // error (the worker is already joined by `cancel_and_join`, so this is
        // race-free). A *refused* cancel never sets that state, so a failure
        // during the write is still reported as the error it is.
        Err(_) if cancel.is_cancelled() => emit_or_log(&app, "flash://cancelled", ()),
        Err(err) => emit_error(&app, &request, &err),
    }
}

/// Emit a categorised `flash://error` with recovery steps + a diagnostic block.
fn emit_error(app: &AppHandle, request: &FlashRequest, err: &FlashError) {
    let recovery_steps = engine::recovery_keys_for(err)
        .iter()
        .map(|k| (*k).to_string())
        .collect::<Vec<_>>();
    let diagnostic = build_diagnostic(request, err);
    emit_or_log(
        app,
        "flash://error",
        ErrorDto {
            category: err.category.as_str().to_string(),
            summary_key: err.summary_key.clone(),
            detail: err.detail.clone(),
            recovery_steps,
            diagnostic,
        },
    );
}

/// Build the clipboard-ready diagnostic report (FR-FLASH-12 (d)). Secrets are
/// redacted (NFR-PRIV-01).
fn build_diagnostic(request: &FlashRequest, err: &FlashError) -> String {
    format!(
        "OmniLink flash diagnostic\n\
         app: {} v{}\n\
         target: {} ({:?})\n\
         version: {}\n\
         method: {:?}\n\
         options: {}\n\
         error[{}]: {} — {}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        request.target,
        request.device_type,
        request.version,
        request.method,
        request.options.redacted_summary(),
        err.category.as_str(),
        err.summary_key,
        err.detail,
    )
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors device.rs).
// ---------------------------------------------------------------------------

fn emit_or_log<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "flash", "failed to emit {event}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_uid_command_matches_engine_and_trims() {
        // The command must yield exactly the UID the engine flashes, so the
        // wizard preview can't drift from reality (MAJOR 1).
        let expected = crate::flash::options::derive_uid("my secret");
        assert_eq!(derive_uid("my secret".to_string()), expected);
        // Trimmed, matching `FlashOptions::resolved_uid`.
        assert_eq!(derive_uid("  my secret  ".to_string()), expected);
    }

    /// Install a fake in-flight flash whose "worker" blocks until `release` is
    /// set, so the manager's cancel policy can be exercised without Tauri.
    fn spawn_fake_flash(
        manager: &FlashManager,
        cancel: Arc<FlashCancel>,
        release: Arc<std::sync::atomic::AtomicBool>,
    ) {
        let worker_cancel = cancel.clone();
        let handle = std::thread::spawn(move || {
            while !release.load(std::sync::atomic::Ordering::SeqCst)
                && !worker_cancel.is_cancelled()
            {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        // `unwrap_or_else` to match `start_flash_blocking`: this helper stands in
        // for it, including in the poisoned-lock test.
        *manager.active.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(ActiveFlash { cancel, handle });
    }

    #[test]
    fn a_poisoned_active_slot_does_not_wedge_cancel_for_the_process_lifetime() {
        // FIX 9C, the flash half: `.lock().unwrap()` here meant one panic under
        // this lock left every later cancel (and every `start_flash`, which
        // stores into the same slot) panicking for the life of the app. The
        // guarded value is a single `Option` with no invariant to tear, so
        // poison is recovered from instead of propagated.
        let manager = Arc::new(FlashManager::default());
        let m = Arc::clone(&manager);
        let _ = std::thread::spawn(move || {
            let _g = m.active.lock().unwrap();
            panic!("poison the flash slot");
        })
        .join();
        assert!(manager.active.lock().is_err(), "the test poisoned it");

        assert_eq!(manager.cancel_and_join(), CancelOutcome::NotRunning);
        let cancel = Arc::new(FlashCancel::new());
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_fake_flash(&manager, cancel.clone(), release);
        assert_eq!(manager.cancel_and_join(), CancelOutcome::Cancelled);
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn cancel_before_the_write_signals_and_joins_the_worker() {
        let manager = FlashManager::default();
        let cancel = Arc::new(FlashCancel::new());
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_fake_flash(&manager, cancel.clone(), release);

        assert_eq!(manager.cancel_and_join(), CancelOutcome::Cancelled);
        assert!(cancel.is_cancelled());
        // Joined and cleared, so the next `start_flash` can take over.
        assert!(manager.active.lock().unwrap().is_none());
        // A second cancel is a clean no-op.
        assert_eq!(manager.cancel_and_join(), CancelOutcome::NotRunning);
    }

    #[test]
    fn cancel_is_refused_once_the_write_has_begun() {
        // FLASH-4 acceptance: the uploader has taken the point of no return, so
        // the cancel must NOT raise the flag (which would kill esptool mid-write
        // and brick the device) and must NOT block the UI joining a write it
        // cannot stop. The worker keeps running.
        let manager = FlashManager::default();
        let cancel = Arc::new(FlashCancel::new());
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_fake_flash(&manager, cancel.clone(), release.clone());
        assert!(cancel.enter_write(), "the uploader starts writing");

        assert_eq!(manager.cancel_and_join(), CancelOutcome::WriteInProgress);
        assert!(!cancel.is_cancelled(), "the cancel flag must stay unset");
        assert!(
            manager.active.lock().unwrap().is_some(),
            "the still-running flash must stay registered"
        );

        // …and a new flash cannot be started while that write is live.
        assert_eq!(manager.cancel_and_join(), CancelOutcome::WriteInProgress);

        // Once the worker finishes, the manager stops refusing (the state word
        // latches at "writing", so this is what keeps it from wedging forever).
        release.store(true, std::sync::atomic::Ordering::SeqCst);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while manager
            .active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| !a.handle.is_finished())
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(manager.cancel_and_join(), CancelOutcome::NotRunning);
        assert!(manager.active.lock().unwrap().is_none());
    }

    #[test]
    fn only_serial_methods_release_the_crsf_connection() {
        // The serial transports need the port to themselves (CONN-1/FLASH-3)…
        assert!(method_holds_serial_port(FlashMethod::Uart));
        assert!(method_holds_serial_port(FlashMethod::Betaflight));
        // …but a WiFi OTA must NOT tear down a live CRSF connection: it flashes
        // over HTTP and never opens the serial port.
        assert!(!method_holds_serial_port(FlashMethod::Wifi));
    }
}
