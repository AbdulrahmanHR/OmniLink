//! Controller-bridge discovery command (M63). READ-ONLY.
//!
//! Thin Tauri wrapper over the pure [`crate::flash::bridge`] classifier: open the
//! serial port (via `serialport`, like `commands/device.rs`), then run
//! [`probe_bridge_candidate`] across the common FC bauds ([`COMMON_FC_BAUDS`])
//! until one yields a valid MSP reply. ONLY read-only MSP GET requests are sent
//! (`MSP_FC_VARIANT` / `MSP_API_VERSION` / `MSP_FC_VERSION`) — never an
//! `MSP_SET_*`, never an FC write (see `docs/Controller_Scope_Decision.md`).
//!
//! Request/response shape (mirrors `probe_wifi_device`), NOT the worker-thread/
//! event shape: the caller awaits the [`BridgeClassification`] directly. Open/
//! busy/permission failures map to a clear error string the frontend turns into
//! `bridge.recovery.*` guidance.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::commands::device::{DeviceManager, PortUse};
use crate::flash::bridge::{
    fetch_bridge_context as fetch_bridge_context_core, probe_bridge_candidate,
    run_passthrough_check_across_bauds, run_passthrough_check_stream, BridgeClassification,
    BridgeContextDto, PassthroughCheckReport, PassthroughTimeouts,
};
use crate::flash::msp::COMMON_FC_BAUDS;

/// Per-baud handshake budget for the bridge probe. The baud-fallback loop tries
/// each [`COMMON_FC_BAUDS`] rate in turn, so the worst case is
/// `COMMON_FC_BAUDS.len() * BRIDGE_PROBE_TIMEOUT`.
const BRIDGE_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// Per-read serial timeout; short so the probe loop stays responsive.
const BRIDGE_READ_TIMEOUT: Duration = Duration::from_millis(100);

/// Probe `port` for a Betaflight/iNav controller usable as a passthrough bridge
/// (READ-ONLY MSP handshake). Resolves with the [`BridgeClassification`]; an open
/// failure (busy/permission/missing) resolves to `Err` with an actionable
/// message. A port that answers no MSP framing at any baud resolves to
/// `Ok(NotAController)` — the zero-false-positive outcome for an ELRS RX.
///
/// Runs on the BLOCKING pool (CONN-3): the baud-fallback loop below is a
/// BLOCKING serial probe whose worst case is
/// `COMMON_FC_BAUDS.len() * BRIDGE_PROBE_TIMEOUT` (≈3.2 s). A plain `pub fn`
/// command would run it on the main/webview thread and freeze the window solid;
/// `#[tauri::command(async)]` would instead occupy one of only
/// `available_parallelism()` tokio workers for those seconds, which on a 2-core
/// machine is enough to leave `connect_device` unscheduled. `spawn_blocking` is
/// the only variant that does neither.
///
/// The port is CLAIMED for the probe's duration ([`DeviceManager::claim_port`]):
/// this command used to open the serial port behind the manager's back, so a
/// Connect or a UART flash could be started against a port OmniLink was already
/// driving.
#[tauri::command]
pub async fn probe_bridge(app: AppHandle, port: String) -> Result<BridgeClassification, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = app
            .state::<DeviceManager>()
            .claim_port(&port, PortUse::ControllerProbe)?;
        probe_bridge_blocking(&port)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn probe_bridge_blocking(port: &str) -> Result<BridgeClassification, String> {
    // Open once at the first candidate baud. Open failures are baud-independent,
    // so classify + surface immediately rather than retrying per baud.
    let mut serial = serialport::new(port, COMMON_FC_BAUDS[0])
        .timeout(BRIDGE_READ_TIMEOUT)
        .open()
        .map_err(|e| describe_open_error(port, &e))?;

    // Baud-fallback: the first rate that yields a valid MSP reply (a supported
    // bridge OR an unsupported one) wins. A `NotAController` at one baud might
    // just be the wrong rate, so keep trying the rest before concluding.
    for &baud in &COMMON_FC_BAUDS {
        if serial.set_baud_rate(baud).is_err() {
            continue;
        }
        // Drop bytes buffered at the previous baud so the parser only sees data
        // sampled at the new rate.
        let _ = serial.clear(serialport::ClearBuffer::All);

        match probe_bridge_candidate(&mut serial.as_mut(), BRIDGE_PROBE_TIMEOUT) {
            Ok(BridgeClassification::NotAController) => continue,
            Ok(classification) => return Ok(classification),
            // A transient write/IO error on this baud: try the next rate.
            Err(_) => continue,
        }
    }

    // No baud produced a valid MSP FC_VARIANT reply ⇒ not a controller bridge.
    Ok(BridgeClassification::NotAController)
}

/// Translate a serial-port open failure into a clear, actionable message. Mirrors
/// the common ELRS-on-desktop failure modes handled in `commands/device.rs`
/// (busy port / permission / missing) so the frontend can map them to
/// `bridge.recovery.*` copy.
fn describe_open_error(port: &str, err: &serialport::Error) -> String {
    use serialport::ErrorKind;
    use std::io::ErrorKind as IoKind;

    match err.kind {
        ErrorKind::Io(IoKind::PermissionDenied) => {
            format!("Permission denied opening {port}. The port may need elevated access or be held open by another program.")
        }
        ErrorKind::NoDevice | ErrorKind::Io(IoKind::NotFound) => {
            format!("Port {port} is no longer available — unplug/replug the controller and refresh the port list.")
        }
        ErrorKind::Io(IoKind::ResourceBusy) | ErrorKind::Io(IoKind::AddrInUse) => {
            format!("Port {port} is busy — another program (Betaflight/iNav Configurator, a serial monitor) is using it. Close it and try again.")
        }
        _ => format!("Failed to open {port}: {err}"),
    }
}

/// Per-baud budget for the read-only context fetch (M65). Mirrors the bridge
/// probe: the baud-fallback loop tries each [`COMMON_FC_BAUDS`] rate in turn.
const CONTEXT_FETCH_TIMEOUT: Duration = Duration::from_millis(800);

/// Fetch READ-ONLY controller context from `port` for ELRS troubleshooting (M65).
///
/// Opens the serial port and tries each [`COMMON_FC_BAUDS`] rate until one yields
/// a valid MSP reply, then returns the [`BridgeContextDto`] (FC family/version +
/// coarse serial-port metadata). READ-ONLY BY CONSTRUCTION: only the read-only GET
/// ids (`MSP_FC_VARIANT`/`MSP_API_VERSION`/`MSP_FC_VERSION`/`MSP_SERIAL_CONFIG`)
/// are ever sent — there is NO `MSP_SET_*` write path from this surface (not even
/// `MSP_SET_PASSTHROUGH`). A port that answers no MSP framing at any baud resolves
/// to `Err`, which the frontend turns into the "not enough controller context"
/// empty state. An open failure resolves to `Err` with an actionable message.
///
/// Request/response shape (like [`probe_bridge`]). The returned DTO is the exact
/// shape the optional Omnia/export path runs through `sanitize_context` before any
/// of it leaves the machine.
///
/// Same blocking baud-fallback budget as [`probe_bridge`] (≈3.2 s), so the same
/// treatment: claimed port, body on the BLOCKING pool (CONN-3).
#[tauri::command]
pub async fn fetch_bridge_context(
    app: AppHandle,
    port: String,
) -> Result<BridgeContextDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = app
            .state::<DeviceManager>()
            .claim_port(&port, PortUse::ControllerContext)?;
        fetch_bridge_context_blocking(&port)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn fetch_bridge_context_blocking(port: &str) -> Result<BridgeContextDto, String> {
    let mut serial = serialport::new(port, COMMON_FC_BAUDS[0])
        .timeout(BRIDGE_READ_TIMEOUT)
        .open()
        .map_err(|e| describe_open_error(port, &e))?;

    // Baud-fallback: the first rate that yields a valid MSP reply wins. A read
    // that fails at one rate might just be the wrong baud, so try the rest.
    for &baud in &COMMON_FC_BAUDS {
        if serial.set_baud_rate(baud).is_err() {
            continue;
        }
        let _ = serial.clear(serialport::ClearBuffer::All);
        match fetch_bridge_context_core(&mut serial.as_mut(), CONTEXT_FETCH_TIMEOUT) {
            Ok(context) => return Ok(context),
            Err(_) => continue,
        }
    }

    // No baud produced a valid MSP reply ⇒ not enough controller context.
    Err("noControllerContext".to_string())
}

/// Per-read serial timeout for the passthrough check — short so each phase's
/// poll loop stays responsive while honouring its bounded budget.
const PASSTHROUGH_READ_TIMEOUT: Duration = Duration::from_millis(100);

/// Ordered baud candidates for the passthrough check: a user override (if any)
/// FIRST, then the remaining [`COMMON_FC_BAUDS`]. Reuses the shipped baud list
/// (never invents a new one) and still EXHAUSTS every candidate before declaring
/// the FC unreachable (the M64 acceptance).
fn candidate_bauds(baud_override: Option<u32>) -> Vec<u32> {
    match baud_override {
        Some(b) => {
            let mut v = vec![b];
            v.extend(COMMON_FC_BAUDS.iter().copied().filter(|&x| x != b));
            v
        }
        None => COMMON_FC_BAUDS.to_vec(),
    }
}

/// Run the M64 guided passthrough check on `port` and return a categorised
/// [`PassthroughCheckReport`] (READ-ONLY: only the read-only `MSP_FC_VARIANT` GET
/// and the in-scope `MSP_SET_PASSTHROUGH` transport command are sent — no FC
/// settings write).
///
/// Request/response shape (like [`probe_bridge`]). `baud_override` selects which
/// common rate to try FIRST; `uart` is the FC UART the user wired the RX to,
/// echoed back into the report for the diagnostic event log (it does not change
/// the all-ports passthrough). Opens the serial port, then drives the baud-
/// fallback loop: only a `ControllerNotResponding` advances to the next rate, so
/// the candidate list is exhausted before declaring the controller unreachable;
/// any other outcome is returned immediately (baud-independent). An open failure
/// resolves to `Err` with an actionable message.
///
/// The longest blocking command on this surface: every candidate baud runs the
/// full guided check ([`PassthroughTimeouts::DEFAULT`]), for up to ~14 s of
/// held-open serial port. It therefore matters most that it (a) holds a real
/// [`crate::commands::device::PortClaim`] for that whole window, so a Connect
/// or a UART flash started meanwhile is refused with an honest message instead
/// of an EBUSY blamed on a third-party program, and (b) runs on the BLOCKING
/// pool rather than pinning a tokio worker for 14 s (CONN-3).
#[tauri::command]
pub async fn run_passthrough_check(
    app: AppHandle,
    port: String,
    baud_override: Option<u32>,
    uart: Option<u8>,
) -> Result<PassthroughCheckReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _claim = app
            .state::<DeviceManager>()
            .claim_port(&port, PortUse::PassthroughCheck)?;
        run_passthrough_check_blocking(&port, baud_override, uart)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_passthrough_check_blocking(
    port: &str,
    baud_override: Option<u32>,
    uart: Option<u8>,
) -> Result<PassthroughCheckReport, String> {
    let mut serial = serialport::new(port, COMMON_FC_BAUDS[0])
        .timeout(PASSTHROUGH_READ_TIMEOUT)
        .open()
        .map_err(|e| describe_open_error(port, &e))?;

    let timeouts = PassthroughTimeouts::DEFAULT;
    let candidates = candidate_bauds(baud_override);

    // Baud-fallback over the single serial handle, driven by the SHARED discipline
    // helper the unit tests also exercise (`run_passthrough_check_across_bauds`):
    // the closure re-tunes, flushes stale bytes and runs the guided check, while
    // the helper owns the advance/stop rule — so the discipline tests guard this
    // production path. A candidate the handle can't retune is skipped (None).
    let result = run_passthrough_check_across_bauds(&candidates, |baud| {
        if serial.set_baud_rate(baud).is_err() {
            return None;
        }
        let _ = serial.clear(serialport::ClearBuffer::All);
        let mut report = run_passthrough_check_stream(&mut serial.as_mut(), &timeouts);
        report.baud = Some(baud);
        report.uart = uart;
        Some(report)
    });

    // Every candidate either failed to retune or returned ControllerNotResponding.
    Ok(match result {
        Some(report) => report,
        None => {
            // Defensive: no candidate baud could be set — run once at the open
            // default so the caller still gets a real, categorised report.
            let _ = serial.clear(serialport::ClearBuffer::All);
            let mut report = run_passthrough_check_stream(&mut serial.as_mut(), &timeouts);
            report.baud = candidates.first().copied();
            report.uart = uart;
            report
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash::msp::COMMON_FC_BAUDS;

    #[test]
    fn candidate_bauds_without_override_is_the_common_set() {
        // No override ⇒ exactly the shipped common set, in order (never invents a rate).
        assert_eq!(candidate_bauds(None), COMMON_FC_BAUDS.to_vec());
    }

    #[test]
    fn candidate_bauds_puts_an_in_set_override_first_without_duplicating() {
        // An override already in COMMON_FC_BAUDS is tried FIRST and de-duplicated,
        // so the candidate list still exhausts every common rate exactly once.
        let inset = COMMON_FC_BAUDS[2];
        let got = candidate_bauds(Some(inset));
        assert_eq!(got[0], inset, "override must be tried first");
        assert_eq!(got.len(), COMMON_FC_BAUDS.len(), "no rate added or lost");
        assert_eq!(
            got.iter().filter(|&&b| b == inset).count(),
            1,
            "override must not be duplicated"
        );
        let mut sorted = got.clone();
        sorted.sort_unstable();
        let mut expected = COMMON_FC_BAUDS.to_vec();
        expected.sort_unstable();
        assert_eq!(
            sorted, expected,
            "still the full common set, just reordered"
        );
    }

    #[test]
    fn candidate_bauds_prepends_a_novel_override_then_the_full_common_set() {
        // An override OUTSIDE the common set is prepended; every common rate then
        // follows in its original order (still exhaustive — nothing dropped).
        let novel = 921_600;
        assert!(!COMMON_FC_BAUDS.contains(&novel));
        let got = candidate_bauds(Some(novel));
        assert_eq!(got[0], novel);
        assert_eq!(got.len(), COMMON_FC_BAUDS.len() + 1);
        assert_eq!(&got[1..], &COMMON_FC_BAUDS[..]);
    }
}
