//! Flight-log import commands (M14, FR-LOG-01).
//!
//! Decodes a Betaflight/INAV blackbox binary log (`.bbl`) into the canonical
//! decoded CSV **in process** with the pure-Rust [`blackbox_log`] crate — no
//! external `blackbox_decode` sidecar, no C toolchain. The decode can take a
//! while on large logs, so — exactly like firmware flashing
//! ([`crate::commands::flash`]) and tile-pack downloads
//! ([`crate::commands::tiles`]) — it is **event-driven, not request-response**:
//! [`decode_blackbox_log`] spawns a worker thread, returns immediately, and the
//! outcome streams over `logs://*` events.
//!
//! Events (camelCase payloads, mirroring the flash/tiles DTOs):
//! * `logs://progress` — `{ percent, stage? }`
//! * `logs://log` — `{ line, isError }`
//! * `logs://done` — `{ csvPath, csv }` (decoded CSV path + its full text)
//! * `logs://error` — `{ category, summaryKey, detail }`
//!
//! ## CSV compatibility (the frontend contract is unchanged)
//!
//! The emitted CSV is `blackbox_decode`-compatible: one header row + one row per
//! main frame, with the last-seen GPS frame values merged onto each row exactly
//! the way the reference CLI does. The importer ([`parseBlackboxCsv`] in
//! `src/lib/blackbox.ts`) is unchanged — it keys on `time (us)` (microseconds),
//! the physical units in each header (`vbatLatest (V)`, `amperageLatest (A)`, …),
//! and the *bare* `GPS_coord[0]`/`GPS_coord[1]` columns. Physical values come
//! from the crate's unit-aware [`uom`] quantities so volts/amps/deg-per-s/metres
//! match what `blackbox_decode` writes. GPS coordinate columns are intentionally
//! left without a unit suffix (degrees) so the importer's lat/lon detection —
//! which strips whitespace and compares against `gps_coord[0]` — still matches.
//!
//! A corrupt or unsupported `.bbl` — including one crafted to trip a `panic!`
//! or `assert!` deep inside the third-party decoder (the `blackbox-log` crate
//! keeps release-surviving asserts on malformed GPS frame defs) — is caught with
//! [`std::panic::catch_unwind`] and mapped to a structured `logs://error`. The
//! worker therefore **always** emits a terminal event (`logs://done` or
//! `logs://error`) and clears its manager slot, so the import can never hang on
//! an unwound-but-silent worker (`ImportDropzone` has no timeout). The 64 MiB
//! inline cap ([`MAX_INLINE_CSV_BYTES`]) and cancel are preserved: the CSV is
//! built in memory and the decode aborts the moment it crosses the cap or the
//! cancel flag is set.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use blackbox_log::frame::{FieldDef, GpsValue, MainValue, Unit};
use blackbox_log::prelude::*;
use blackbox_log::File;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Maximum size of a decoded CSV returned inline over IPC (64 MiB). The full
/// decoded text rides in `DoneDto.csv` because the frontend has no filesystem
/// plugin to read `csvPath` itself, so a pathologically long flight could decode
/// to hundreds of MiB and — held as a `String`, then JSON-serialized across the
/// Tauri IPC boundary — cost several multiples of that in transient memory.
/// The in-process decoder therefore checks the growing CSV after every main
/// frame and, once past this cap, aborts with a structured `logs://error`
/// (`summaryKey = "decodedLogTooLarge"`) instead of continuing, so peak memory
/// stays bounded and a huge log can never OOM the process.
const MAX_INLINE_CSV_BYTES: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Event payloads (camelCase, mirror `src/lib/tauri.ts`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressDto {
    percent: f32,
    /// Coarse human-readable phase (e.g. `"decoding"`); `None` when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogDto {
    line: String,
    is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneDto {
    /// Path of the decoded `.csv` written alongside the input (mirrors
    /// `blackbox_decode`). Best-effort — the frontend reads `csv`, not this.
    csv_path: String,
    /// Full decoded CSV text. Returned inline because the frontend has no
    /// filesystem-plugin dependency (`@tauri-apps/plugin-fs` is not installed),
    /// so it cannot read `csvPath` itself — see the csvPath-vs-csv note in
    /// `src/lib/tauri.ts`.
    csv: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDto {
    category: String,
    summary_key: String,
    detail: String,
}

// ---------------------------------------------------------------------------
// Managed worker state (mirrors `flash::FlashManager`).
// ---------------------------------------------------------------------------

struct ActiveDecode {
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
pub struct LogDecodeManager {
    active: Mutex<Option<ActiveDecode>>,
}

impl LogDecodeManager {
    /// Signal any running decode to cancel and join the worker. Safe to call
    /// when idle (no-op).
    fn cancel_and_join(&self) {
        let active = self.active.lock().unwrap().take();
        if let Some(active) = active {
            active.cancel.store(true, Ordering::SeqCst);
            if active.handle.join().is_err() {
                tracing::error!(target: "logs", "worker thread panicked before exit");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Decode a Betaflight/INAV blackbox `.bbl` log into the canonical decoded CSV.
///
/// Returns once the worker thread is spawned; progress + outcome arrive via
/// `logs://*` events (mirrors `flash::start_flash` / `tiles::download_tile_pack`).
#[tauri::command]
pub fn decode_blackbox_log(
    app: AppHandle,
    manager: State<'_, LogDecodeManager>,
    path: String,
) -> Result<(), String> {
    // One decode at a time — cancel any prior worker first.
    manager.cancel_and_join();

    let input = PathBuf::from(path);

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_thread = cancel.clone();
    let app_for_thread = app.clone();

    let handle = std::thread::Builder::new()
        .name("blackbox-decode-worker".into())
        .spawn(move || {
            run_worker(&app_for_thread, &input, &cancel_for_thread);
            // Clear our slot so a later cancel/decode sees an idle manager.
            if let Some(mgr) = app_for_thread.try_state::<LogDecodeManager>() {
                *mgr.active.lock().unwrap() = None;
            }
        })
        .map_err(|e| e.to_string())?;

    *manager.active.lock().unwrap() = Some(ActiveDecode { cancel, handle });
    Ok(())
}

/// Cancel the active decode, if any.
#[tauri::command]
pub fn cancel_blackbox_decode(manager: State<'_, LogDecodeManager>) -> Result<(), String> {
    manager.cancel_and_join();
    Ok(())
}

// ---------------------------------------------------------------------------
// Worker.
// ---------------------------------------------------------------------------

/// Worker body: decode `input` in process, stream progress/log lines as
/// `logs://*`, and translate the outcome into `logs://done` / `logs://error`.
fn run_worker(app: &AppHandle, input: &Path, cancel: &Arc<AtomicBool>) {
    match decode(app, input, cancel) {
        Ok(done) => emit_or_log(app, "logs://done", done),
        // A user cancel is a distinct, non-error outcome; still reported on the
        // `logs://error` channel (the only failure channel) so the UI can land
        // back on idle without a spurious toolchain error.
        Err(err) => emit_or_log(app, "logs://error", err),
    }
}

/// Read the `.bbl`, decode it to a CSV in process, and (best-effort) write the
/// CSV next to the input the way `blackbox_decode` does.
fn decode(app: &AppHandle, input: &Path, cancel: &Arc<AtomicBool>) -> Result<DoneDto, ErrorDto> {
    emit_progress(app, 0.0, "decoding");

    let bytes = std::fs::read(input).map_err(|e| ErrorDto {
        category: "decode".into(),
        summary_key: "logReadFailed".into(),
        detail: format!("could not read {}: {e}", input.display()),
    })?;

    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled_error());
    }

    emit_log(
        app,
        format!("Decoding {} ({} bytes)", input.display(), bytes.len()),
        false,
    );

    // `decode_catching` turns a panic deep in the decoder into a normal `Err`,
    // so a crafted `.bbl` cannot unwind this worker into emitting no terminal
    // event (which would hang the import spinner).
    let result = decode_catching(
        &bytes,
        || cancel.load(Ordering::SeqCst),
        |percent| emit_progress(app, percent, "decoding"),
    )?;

    // A Betaflight flash-chip download concatenates one log per arm/disarm; we
    // decode only the first (the importer consumes a single CSV), so surface the
    // skipped flights honestly instead of silently dropping them.
    if result.total_logs > 1 {
        emit_log(
            app,
            format!(
                "{} additional flight log(s) in this file were not shown (only the first is decoded).",
                result.total_logs - 1
            ),
            false,
        );
    }

    emit_log(
        app,
        format!("Decoded {} main frame(s)", result.main_frames),
        false,
    );

    // Mirror `blackbox_decode`, which writes `<input>.csv` next to the input.
    // Best-effort: the decoded text also rides inline in `DoneDto.csv` (the only
    // copy the frontend reads), so a failed write is logged, not fatal.
    let csv_path = csv_output_path(input);
    if let Err(e) = std::fs::write(&csv_path, &result.csv) {
        emit_log(
            app,
            format!("could not write {}: {e}", csv_path.display()),
            true,
        );
    }

    emit_progress(app, 100.0, "decoding");
    Ok(DoneDto {
        csv_path: csv_path.display().to_string(),
        csv: result.csv,
    })
}

// ---------------------------------------------------------------------------
// In-process decode (pure — no `AppHandle`, so it is unit-tested directly).
// ---------------------------------------------------------------------------

/// Outcome of a successful in-process decode.
#[derive(Debug)]
struct DecodeResult {
    /// The `blackbox_decode`-compatible CSV text.
    csv: String,
    /// Number of main (loop) frames emitted as rows.
    main_frames: usize,
    /// Total logs in the file (a `.bbl` may concatenate several flights). Only
    /// the first is decoded; the rest are surfaced as a notice, not dropped.
    total_logs: usize,
}

/// Decode a `.bbl` to CSV, catching any panic from the third-party decoder and
/// mapping it to a clean [`ErrorDto`] (never re-raising). This is what makes the
/// "always a terminal event, never a hung import" guarantee real: the crate has
/// release-surviving `assert!`s (e.g. on malformed GPS frame defs) that would
/// otherwise unwind the worker with no `logs://done`/`logs://error` emitted.
///
/// The mapped error carries only a generic message — never any raw `.bbl` bytes
/// or the panic payload.
fn decode_catching<C, P>(
    bytes: &[u8],
    is_cancelled: C,
    on_progress: P,
) -> Result<DecodeResult, ErrorDto>
where
    C: Fn() -> bool,
    P: FnMut(f32),
{
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        decode_bbl_to_csv(bytes, is_cancelled, on_progress)
    }));
    match attempt {
        Ok(result) => result,
        Err(_) => Err(decode_failed(
            "the log could not be decoded — it is corrupt or uses an unsupported format"
                .to_string(),
        )),
    }
}

/// Decode the bytes of a `.bbl` file into a `blackbox_decode`-compatible CSV.
///
/// Only the first log in the file is decoded (a `.bbl` may concatenate several
/// logs with differing field sets; the reference CLI writes one CSV per log,
/// and the importer consumes a single CSV). `is_cancelled` is polled per frame
/// so a long decode aborts promptly; `on_progress` receives 0..=100 percentages.
///
/// Structured [`ErrorDto`]s cover the expected failures: a missing marker /
/// unsupported firmware / malformed headers → `decodeFailed`, a header-only log
/// with no decodable main frames → `decodeFailed` ("no flight data"), crossing
/// the inline cap → `decodedLogTooLarge`, and a cancel → `cancelled`. This
/// function may still *panic* on a crafted log (the crate asserts internally);
/// callers must wrap it in [`decode_catching`] to honour the never-hang contract.
fn decode_bbl_to_csv<C, P>(
    bytes: &[u8],
    is_cancelled: C,
    mut on_progress: P,
) -> Result<DecodeResult, ErrorDto>
where
    C: Fn() -> bool,
    P: FnMut(f32),
{
    let file = File::new(bytes);
    let total_logs = file.log_count();
    let headers = match file.iter().next() {
        Some(Ok(headers)) => headers,
        Some(Err(err)) => return Err(decode_failed(err.to_string())),
        None => {
            return Err(decode_failed(
                "no blackbox log found in the file (missing the Blackbox header marker)"
                    .to_string(),
            ))
        }
    };

    // Capture the column headers up front (owned Strings) so the immutable borrow
    // of `headers` ends before the data parser takes its own borrow. The main
    // frame def yields `loopIteration` first (index 0); `time` is frame metadata
    // (not a def field), so we inject a `time (us)` column right after it. GPS
    // frame fields (when present) are appended and merged onto every main row.
    let mut main_headers: Vec<String> = Vec::new();
    for FieldDef { name, unit, .. } in headers.main_frame_def().iter() {
        main_headers.push(format!("{name}{}", header_unit_suffix(unit.into())));
    }
    let mut gps_headers: Vec<String> = Vec::new();
    if let Some(gps_def) = headers.gps_frame_def() {
        for FieldDef { name, unit, .. } in gps_def.iter() {
            gps_headers.push(format!("{name}{}", header_unit_suffix(unit.into())));
        }
    }

    let mut out = String::new();
    out.push_str(
        main_headers
            .first()
            .map(String::as_str)
            .unwrap_or("loopIteration"),
    );
    out.push_str(",time (us)");
    for header in main_headers.iter().skip(1) {
        out.push(',');
        out.push_str(header);
    }
    for header in &gps_headers {
        out.push(',');
        out.push_str(header);
    }
    out.push('\n');

    // Latest GPS frame values, one string per GPS column, merged onto each main
    // row until a newer GPS frame arrives (empty before the first fix).
    let mut latest_gps: Vec<String> = vec![String::new(); gps_headers.len()];
    let mut main_frames: usize = 0;
    let mut last_pct: f32 = 0.0;

    let mut parser = headers.data_parser();
    while let Some(event) = parser.next() {
        if is_cancelled() {
            return Err(cancelled_error());
        }
        match event {
            ParserEvent::Gps(gps) => {
                for (i, value) in gps.iter().enumerate() {
                    if let Some(slot) = latest_gps.get_mut(i) {
                        *slot = fmt_gps_value(value);
                    }
                }
            }
            ParserEvent::Main(main) => {
                let time_us = main.time_raw();
                for (i, value) in main.iter().enumerate() {
                    if i == 0 {
                        // loopIteration, then the injected time column.
                        out.push_str(&fmt_main_value(value));
                        out.push(',');
                        out.push_str(&time_us.to_string());
                    } else {
                        out.push(',');
                        out.push_str(&fmt_main_value(value));
                    }
                }
                for cell in &latest_gps {
                    out.push(',');
                    out.push_str(cell);
                }
                out.push('\n');
                main_frames += 1;

                if exceeds_inline_cap(out.len() as u64) {
                    return Err(too_large_error(out.len() as u64));
                }
            }
            ParserEvent::Slow(_) | ParserEvent::Event(_) => {}
        }

        // Progress reflects how much of the data section has been consumed
        // (0..=1), throttled to whole-percent steps to bound event volume.
        let pct = (parser.stats().progress * 100.0).clamp(0.0, 100.0);
        if pct - last_pct >= 1.0 {
            on_progress(pct);
            last_pct = pct;
        }
    }

    // A valid-marker log with no decodable main frames is an empty import, not a
    // success — surface it as a clean error (matching the honest not-enough-data
    // pattern) instead of returning a header-only CSV that parses to 0 samples.
    if main_frames == 0 {
        return Err(no_flight_data_error());
    }

    Ok(DecodeResult {
        csv: out,
        main_frames,
        total_logs,
    })
}

/// The header unit suffix (` (V)`, ` (A)`, …) for a decoded field's [`Unit`].
///
/// GPS coordinates deliberately get **no** suffix: the importer detects lat/lon
/// by stripping whitespace and comparing against `gps_coord[0]`/`[1]`, so a
/// `GPS_coord[0] (deg)` header would break detection. Flags/booleans/unitless
/// fields carry no unit either.
fn header_unit_suffix(unit: Unit) -> &'static str {
    match unit {
        Unit::Amperage => " (A)",
        Unit::Voltage => " (V)",
        Unit::Acceleration => " (g)",
        Unit::Rotation => " (deg/s)",
        Unit::Altitude => " (m)",
        Unit::Velocity => " (m/s)",
        Unit::GpsHeading => " (deg)",
        Unit::GpsCoordinate
        | Unit::FlightMode
        | Unit::State
        | Unit::FailsafePhase
        | Unit::Boolean
        | Unit::Unitless => "",
    }
}

/// Format a decoded main-frame value as a CSV cell, converting unit-aware
/// quantities to the physical units named in the header.
fn fmt_main_value(value: MainValue) -> String {
    use blackbox_log::units::si::{
        acceleration::standard_gravity, angular_velocity::degree_per_second,
        electric_current::ampere, electric_potential::volt,
    };
    match value {
        MainValue::Amperage(v) => fmt_float(v.get::<ampere>(), 4),
        MainValue::Voltage(v) => fmt_float(v.get::<volt>(), 4),
        MainValue::Acceleration(v) => fmt_float(v.get::<standard_gravity>(), 4),
        MainValue::Rotation(v) => fmt_float(v.get::<degree_per_second>(), 4),
        MainValue::Unsigned(v) => v.to_string(),
        MainValue::Signed(v) => v.to_string(),
    }
}

/// Format a decoded GPS-frame value as a CSV cell. Coordinates are emitted in
/// decimal degrees (bare column), matching the importer's expectation.
fn fmt_gps_value(value: GpsValue) -> String {
    use blackbox_log::units::si::{length::meter, velocity::meter_per_second};
    match value {
        GpsValue::Coordinate(v) => fmt_float(v, 7),
        GpsValue::Altitude(v) => fmt_float(v.get::<meter>(), 2),
        GpsValue::Velocity(v) => fmt_float(v.get::<meter_per_second>(), 4),
        GpsValue::Heading(v) => fmt_float(v, 2),
        GpsValue::Unsigned(v) => v.to_string(),
        GpsValue::Signed(v) => v.to_string(),
    }
}

/// Format an `f64` with at most `decimals` places, trimming trailing zeros (and
/// a trailing `.`) for clean, deterministic CSV cells. Non-finite → empty cell.
fn fmt_float(value: f64, decimals: usize) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let mut s = format!("{value:.decimals$}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/// A parse / unsupported-log failure. The frontend renders every non-cancel,
/// non-`decodedLogTooLarge` decode error through the generic `logs.errors.decode`
/// message, so the `summaryKey` here is for diagnostics/logging.
fn decode_failed(detail: String) -> ErrorDto {
    ErrorDto {
        category: "decode".into(),
        summary_key: "decodeFailed".into(),
        detail,
    }
}

/// A valid log that carried no decodable flight data (header-only, or every
/// data frame corrupt). Rendered generically by the frontend like any other
/// decode error; the distinct message aids diagnostics/log lines.
fn no_flight_data_error() -> ErrorDto {
    ErrorDto {
        category: "decode".into(),
        summary_key: "decodeFailed".into(),
        detail: "no flight data frames in this log (header only)".into(),
    }
}

/// A user cancel — reported on the failure channel but flagged so the UI can
/// distinguish it from a real error (see `ImportDropzone`).
fn cancelled_error() -> ErrorDto {
    ErrorDto {
        category: "cancelled".into(),
        summary_key: "cancelled".into(),
        detail: "blackbox decode cancelled by user".into(),
    }
}

/// The decoded CSV crossed the inline cap (see [`MAX_INLINE_CSV_BYTES`]).
fn too_large_error(byte_len: u64) -> ErrorDto {
    ErrorDto {
        category: "decode".into(),
        summary_key: "decodedLogTooLarge".into(),
        detail: format!(
            "decoded log is {byte_len} bytes, above the {MAX_INLINE_CSV_BYTES}-byte inline cap; \
             re-record a shorter flight or split the log"
        ),
    }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// The decoded CSV path written for a given input: the input path with its
/// extension swapped to `.csv` (mirrors `blackbox_decode`).
fn csv_output_path(input: &Path) -> PathBuf {
    input.with_extension("csv")
}

/// Whether a decoded CSV of `byte_len` exceeds the inline-return cap
/// ([`MAX_INLINE_CSV_BYTES`]). Pulled out as a pure predicate so the boundary is
/// unit-tested. The cap is inclusive — exactly the cap is still served inline;
/// one byte over is refused.
fn exceeds_inline_cap(byte_len: u64) -> bool {
    byte_len > MAX_INLINE_CSV_BYTES
}

fn emit_progress(app: &AppHandle, percent: f32, stage: &str) {
    emit_or_log(
        app,
        "logs://progress",
        ProgressDto {
            percent,
            stage: Some(stage.to_string()),
        },
    );
}

fn emit_log(app: &AppHandle, line: String, is_error: bool) {
    emit_or_log(app, "logs://log", LogDto { line, is_error });
}

fn emit_or_log<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "logs", "failed to emit {event}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A REAL Betaflight 4.2.11 `.bbl` from the `blackbox-log` crate's own
    /// MIT-OR-Apache-2.0 test corpus (see `data/fixtures/logs/ATTRIBUTION.md`).
    const FIXTURE: &[u8] = include_bytes!("../../../data/fixtures/logs/error-recovery.bbl");

    /// The committed golden CSV the TS round-trip test also consumes. Embedded so
    /// the live decode is asserted byte-for-byte equal to it (catches mapping
    /// drift — e.g. a changed unit suffix — that column spot-checks would miss).
    const GOLDEN_CSV: &str = include_str!("../../../data/fixtures/logs/error-recovery.decoded.csv");

    /// Reconstruct a header-only `.bbl` from the real fixture: the leading run of
    /// `H …` header lines with the data section chopped off (the first data frame
    /// in this log is an `I`ntra frame, so the run stops exactly at the boundary).
    /// The result parses to valid headers with zero decodable main frames.
    fn header_only_bbl(bbl: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for line in bbl.split(|&b| b == b'\n') {
            if line.first() == Some(&b'H') {
                out.extend_from_slice(line);
                out.push(b'\n');
            } else {
                break;
            }
        }
        out
    }

    #[test]
    fn cancel_is_safe_when_idle() {
        // No active worker: cancel must be a no-op, not a panic/deadlock.
        let mgr = LogDecodeManager::default();
        mgr.cancel_and_join();
        assert!(mgr.active.lock().unwrap().is_none());
    }

    #[test]
    fn inline_cap_rejects_only_above_limit() {
        // Resource-exhaustion guard ("huge logs"): the inline-return cap is
        // inclusive — exactly the cap is still served, one byte over is refused
        // (and aborts the decode with `summaryKey = "decodedLogTooLarge"` instead
        // of continuing to grow the CSV, so a pathological log can never OOM).
        assert!(!exceeds_inline_cap(0));
        assert!(!exceeds_inline_cap(MAX_INLINE_CSV_BYTES - 1));
        assert!(!exceeds_inline_cap(MAX_INLINE_CSV_BYTES));
        assert!(exceeds_inline_cap(MAX_INLINE_CSV_BYTES + 1));
        assert!(exceeds_inline_cap(u64::MAX));
    }

    #[test]
    fn csv_output_path_swaps_extension() {
        assert_eq!(
            csv_output_path(Path::new("/logs/flight1.bbl")),
            PathBuf::from("/logs/flight1.csv")
        );
        // No extension → appends `.csv`.
        assert_eq!(
            csv_output_path(Path::new("/logs/flight1")),
            PathBuf::from("/logs/flight1.csv")
        );
    }

    #[test]
    fn decodes_real_bbl_fixture_to_expected_csv() {
        // Proves the pure-Rust decoder + the CSV mapping produce exactly the
        // columns/units the importer keys on, on a REAL `.bbl`.
        let result = decode_bbl_to_csv(FIXTURE, || false, |_| {}).expect("fixture should decode");
        let csv = result.csv;

        let mut lines = csv.lines();
        let header = lines.next().expect("header row");
        let cols: Vec<&str> = header.split(',').collect();

        // The columns `parseBlackboxCsv` relies on, with the right unit tags.
        assert_eq!(cols.first(), Some(&"loopIteration"), "header: {header}");
        assert!(cols.contains(&"time (us)"), "header: {header}");
        assert!(cols.contains(&"rssi"), "header: {header}");
        assert!(cols.contains(&"vbatLatest (V)"), "header: {header}");
        assert!(cols.contains(&"amperageLatest (A)"), "header: {header}");
        // GPS coord columns, when present, must stay bare (no unit) — this
        // fixture has no GPS frame, so assert none leaked a suffixed variant.
        assert!(
            !cols
                .iter()
                .any(|c| c.starts_with("GPS_coord") && c.contains('(')),
            "GPS coord columns must be bare: {header}"
        );

        // At least one decoded data row, aligned to the header.
        let first_row = lines.next().expect("at least one data row");
        let fields: Vec<&str> = first_row.split(',').collect();
        assert_eq!(fields.len(), cols.len(), "row width matches header");
        assert!(result.main_frames >= 1, "expected ≥1 main frame");

        // Plausible values: finite time (µs) and finite rssi.
        let time_idx = cols.iter().position(|c| *c == "time (us)").unwrap();
        let time: f64 = fields[time_idx].parse().expect("numeric time");
        assert!(time.is_finite() && time >= 0.0, "time = {time}");
        let rssi_idx = cols.iter().position(|c| *c == "rssi").unwrap();
        let rssi: f64 = fields[rssi_idx].parse().expect("numeric rssi");
        assert!(rssi.is_finite(), "rssi = {rssi}");

        // Regenerate the golden CSV consumed by the TS round-trip test on demand:
        //   BLACKBOX_WRITE_GOLDEN=1 cargo test decodes_real_bbl_fixture_to_expected_csv
        // Otherwise assert the live decode is byte-for-byte the committed golden,
        // so any CSV-mapping drift fails here instead of shipping stale-but-green.
        if std::env::var("BLACKBOX_WRITE_GOLDEN").is_ok() {
            let golden = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../data/fixtures/logs/error-recovery.decoded.csv");
            std::fs::write(golden, &csv).expect("write golden csv");
        } else {
            assert_eq!(
                csv, GOLDEN_CSV,
                "decoded CSV drifted from the committed golden; regenerate with \
                 BLACKBOX_WRITE_GOLDEN=1 if the mapping change is intentional"
            );
        }
    }

    #[test]
    fn corrupt_bbl_yields_clean_error_not_panic() {
        // No marker → no logs found → a clean structured error, never a panic.
        let err = decode_bbl_to_csv(b"definitely not a blackbox log", || false, |_| {})
            .expect_err("garbage must not decode");
        assert_eq!(err.category, "decode");
        assert_eq!(err.summary_key, "decodeFailed");
    }

    #[test]
    fn cancel_flag_aborts_decode() {
        // A set cancel flag stops the decode promptly with the cancel outcome.
        let err = decode_bbl_to_csv(FIXTURE, || true, |_| {}).expect_err("cancel must abort");
        assert_eq!(err.category, "cancelled");
        assert_eq!(err.summary_key, "cancelled");
    }

    #[test]
    fn panic_inside_decoder_is_caught_as_terminal_error() {
        // FIX 1: the crate keeps release-surviving asserts that a crafted `.bbl`
        // can trip, panicking the worker. `decode_catching` must convert that
        // into a clean structured error (so a terminal `logs://error` is always
        // emitted and the import never hangs), never re-raise or leak the payload.
        // Simulate the deep panic via a callback that unwinds inside the loop.
        let err = decode_catching(
            FIXTURE,
            || -> bool { panic!("simulated crate assert") },
            |_| {},
        )
        .expect_err("a panic must map to a clean error, not unwind the caller");
        assert_eq!(err.category, "decode");
        assert_eq!(err.summary_key, "decodeFailed");
        assert!(!err.detail.is_empty());
        // The generic detail must not smuggle the panic payload / raw bytes.
        assert!(!err.detail.contains("simulated crate assert"));
    }

    #[test]
    fn multi_log_bbl_counts_all_logs_but_decodes_the_first() {
        // FIX 2: a flash-chip download concatenates several logs. Two markers →
        // `total_logs == 2` so the worker surfaces the skipped flight instead of
        // dropping it silently; we still decode (only) the first log's frames.
        let mut doubled = FIXTURE.to_vec();
        doubled.extend_from_slice(FIXTURE);
        let result =
            decode_bbl_to_csv(&doubled, || false, |_| {}).expect("first log should decode");
        assert_eq!(
            result.total_logs, 2,
            "both concatenated logs must be counted"
        );
        assert!(result.main_frames >= 1, "the first log must still decode");
    }

    #[test]
    fn header_only_bbl_is_a_clean_no_data_error() {
        // FIX 4: a valid-marker log with zero decodable main frames is an empty
        // import — surface a clean error, not an `Ok` header-only CSV.
        let header_only = header_only_bbl(FIXTURE);
        let err = decode_bbl_to_csv(&header_only, || false, |_| {})
            .expect_err("header-only log must not decode to an empty success");
        assert_eq!(err.category, "decode");
        assert_eq!(err.summary_key, "decodeFailed");
        assert!(
            err.detail.to_lowercase().contains("no flight data"),
            "detail = {}",
            err.detail
        );
    }
}
