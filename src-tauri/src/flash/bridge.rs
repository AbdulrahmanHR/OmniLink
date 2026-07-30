//! Controller-bridge discovery (M63, FR — v2.2 "Controller Bridge Mode").
//!
//! When a Betaflight/iNav flight controller is the path to an ELRS receiver, we
//! want to *label* it as a passthrough bridge candidate — WITHOUT treating it as
//! a managed device. This module is **READ-ONLY**: it sends only MSP v1 GET
//! queries (`MSP_API_VERSION` / `MSP_FC_VARIANT` / `MSP_FC_VERSION`), never any
//! `MSP_SET_*`. It does not edit FC settings, flash FC firmware, or read the
//! flight-stack configuration (see `docs/Controller_Scope_Decision.md`).
//!
//! It **extends** the shipped MSP v1 framing in [`crate::flash::msp`]
//! (`encode_request` / `parse_reply`) rather than reimplementing it, and the
//! core [`probe_bridge_candidate`] is generic over [`Read`] + [`Write`] exactly
//! like `enable_passthrough_with_timeout`, so it is unit-tested against the
//! `FakeFc` fixtures with no real hardware.
//!
//! Classification is restricted to **Betaflight + iNav on recent stable MSP**
//! (D28): an unrecognized 4-char FC variant is labeled an "unsupported bridge",
//! never misclassified. An endpoint that does not answer MSP framing at all —
//! e.g. an ELRS RX speaking CRSF — is reported `NotAController`, which is what
//! guarantees **zero false positives** against the non-controller fixtures.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::flash::msp::{
    collect_replies, encode_request, parse_reply, passthrough_ack_is_positive, passthrough_request,
    MspReply, MSP_SET_PASSTHROUGH,
};
use crate::flash::{ErrorCategory, FlashError};

/// `MSP_API_VERSION` — read-only GET: MSP protocol + API version.
pub const MSP_API_VERSION: u8 = 1;
/// `MSP_FC_VARIANT` — read-only GET: the 4-char FC identifier (`"BTFL"`/`"INAV"`).
pub const MSP_FC_VARIANT: u8 = 2;
/// `MSP_FC_VERSION` — read-only GET: FC firmware version (major.minor.patch).
pub const MSP_FC_VERSION: u8 = 3;
/// `MSP_CF_SERIAL_CONFIG` — read-only GET (legacy MSP v1 id 54): per-port serial
/// configuration. We read it ONLY for coarse passthrough-relevant metadata (which
/// UART is a serial-RX port) — never to write a port config. There is no
/// `MSP_SET_*` counterpart anywhere in this module (M65, read-only by construction).
pub const MSP_SERIAL_CONFIG: u8 = 54;

/// The flight-controller family behind a bridge, derived from `MSP_FC_VARIANT`.
/// Restricted to the two stacks OmniLink supports as passthrough bridges (D28);
/// any other variant is [`BridgeFamily::Unknown`] ⇒ an unsupported bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeFamily {
    Betaflight,
    Inav,
    Unknown,
}

/// A recognized controller-bridge candidate. The FC is a transport endpoint
/// only — never a managed device — so this carries just enough identity to label
/// it and (best-effort) show its versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCandidate {
    /// The mapped family (`Betaflight`/`Inav`).
    pub family: BridgeFamily,
    /// The raw 4-char FC variant id, e.g. `"BTFL"` / `"INAV"`.
    pub fc_variant: String,
    /// `MSP_API_VERSION` as `"major.minor"`, when the FC answered (best-effort).
    pub api_version: Option<String>,
    /// `MSP_FC_VERSION` as `"major.minor.patch"`, when answered (best-effort).
    pub fc_version: Option<String>,
}

/// The outcome of probing a serial endpoint for a controller bridge.
///
/// Serialized as an internally-tagged shape (`{ "kind": .. }`) the frontend can
/// switch on:
///  - `{"kind":"bridge", "family":.., "fcVariant":.., "apiVersion":.., "fcVersion":..}`
///  - `{"kind":"unsupportedBridge", "reason":..}`
///  - `{"kind":"notAController"}`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeClassification {
    /// A supported Betaflight/iNav controller usable as a passthrough bridge.
    Bridge(BridgeCandidate),
    /// Answered MSP but with a variant we do not support as a bridge (D28).
    /// `reason` carries the raw variant id so the UI can show it.
    UnsupportedBridge { reason: String },
    /// Did not answer MSP framing within the timeout — not a controller. The
    /// zero-false-positive outcome for an ELRS RX speaking CRSF.
    NotAController,
}

/// Map a 4-char `MSP_FC_VARIANT` id to a [`BridgeFamily`]. Only the two stacks
/// supported as passthrough bridges map to a known family (D28); everything else
/// is [`BridgeFamily::Unknown`].
pub fn classify_variant(fc_variant: &str) -> BridgeFamily {
    match fc_variant {
        "BTFL" => BridgeFamily::Betaflight,
        "INAV" => BridgeFamily::Inav,
        _ => BridgeFamily::Unknown,
    }
}

/// Probe an open serial endpoint for a controller bridge (READ-ONLY).
///
/// Sends the read-only `MSP_FC_VARIANT` GET (plus best-effort `MSP_API_VERSION`
/// and `MSP_FC_VERSION` GETs to enrich the candidate), then reads + parses `$M>`
/// replies until a valid FC_VARIANT reply arrives or `timeout` elapses:
///
///  - a valid FC_VARIANT reply ⇒ classify the variant ([`classify_variant`]):
///    a known family yields [`BridgeClassification::Bridge`]; an unknown variant
///    yields [`BridgeClassification::UnsupportedBridge`] (not a misclassification);
///  - no valid MSP reply (or a read error) within the timeout ⇒
///    [`BridgeClassification::NotAController`] — an ELRS RX speaking CRSF never
///    answers MSP framing, so it can never be read as a bridge (zero false
///    positives).
///
/// Generic over [`Read`] + [`Write`] (like `enable_passthrough_with_timeout`) so
/// it is testable with `FakeFc`. Returns `Err` only when the request itself
/// cannot be written (busy/disconnected port).
pub fn probe_bridge_candidate<S: Read + Write>(
    port: &mut S,
    timeout: Duration,
) -> Result<BridgeClassification, FlashError> {
    // READ-ONLY GET probes. FC_VARIANT decides the classification; API/FC version
    // are best-effort enrichment. NONE of these is an MSP_SET_* command.
    for cmd in [MSP_FC_VARIANT, MSP_API_VERSION, MSP_FC_VERSION] {
        let request = encode_request(cmd, &[]);
        port.write_all(&request).map_err(|e| {
            FlashError::new(
                ErrorCategory::Wiring,
                "bridgeWriteFailed",
                format!("failed to send MSP GET request {cmd}: {e}"),
            )
        })?;
    }
    let _ = port.flush();

    let deadline = Instant::now() + timeout;
    let mut acc: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64];
    let mut replies: Vec<MspReply> = Vec::new();
    while Instant::now() < deadline {
        match port.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                replies = collect_replies(&acc);
                // The FC_VARIANT reply is what we must classify on; once it (and
                // whatever else arrived in the same burst) is in hand, stop.
                if find_ok(&replies, MSP_FC_VARIANT).is_some() {
                    break;
                }
            }
            // A read timeout is the expected "nothing yet" case — keep polling.
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            // Any other read error: the endpoint is not answering MSP framing.
            // Treat as "not a controller" rather than an error so a CRSF-only
            // device can never be misread as a bridge.
            Err(_) => break,
        }
    }

    Ok(classify_replies(&replies))
}

/// Turn the collected `$M>` replies into a [`BridgeClassification`].
fn classify_replies(replies: &[MspReply]) -> BridgeClassification {
    let variant = match find_ok(replies, MSP_FC_VARIANT) {
        Some(reply) => variant_id(&reply.payload),
        // No valid MSP FC_VARIANT reply within the timeout ⇒ not a controller.
        None => return BridgeClassification::NotAController,
    };

    match classify_variant(&variant) {
        // Recognized as neither Betaflight nor iNav: an unsupported bridge — NOT
        // misclassified. `reason` carries the raw variant id.
        BridgeFamily::Unknown => BridgeClassification::UnsupportedBridge { reason: variant },
        family => {
            let api_version =
                find_ok(replies, MSP_API_VERSION).and_then(|r| format_api_version(&r.payload));
            let fc_version =
                find_ok(replies, MSP_FC_VERSION).and_then(|r| format_fc_version(&r.payload));
            BridgeClassification::Bridge(BridgeCandidate {
                family,
                fc_variant: variant,
                api_version,
                fc_version,
            })
        }
    }
}

/// The first SUCCESSFUL (`$M>`) reply to `cmd`.
///
/// An MSP error frame (`$M!`) is a refusal, not an answer — its payload is empty
/// or meaningless — so reading a variant / version / serial-config out of one
/// would invent facts the controller never sent.
fn find_ok(replies: &[MspReply], cmd: u8) -> Option<&MspReply> {
    replies.iter().find(|r| r.command == cmd && !r.result_error)
}

/// Decode the FC variant id from an `MSP_FC_VARIANT` payload: the first up-to-4
/// bytes as ASCII, dropping control chars and surrounding whitespace.
fn variant_id(payload: &[u8]) -> String {
    let take = payload.len().min(4);
    String::from_utf8_lossy(&payload[..take])
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// Format an `MSP_API_VERSION` payload (`[mspProtocol, apiMajor, apiMinor]`) as
/// `"major.minor"`. `None` if the payload is too short to read.
fn format_api_version(payload: &[u8]) -> Option<String> {
    if payload.len() >= 3 {
        Some(format!("{}.{}", payload[1], payload[2]))
    } else {
        None
    }
}

/// Format an `MSP_FC_VERSION` payload (`[major, minor, patch]`) as
/// `"major.minor.patch"`. `None` if the payload is too short to read.
fn format_fc_version(payload: &[u8]) -> Option<String> {
    if payload.len() >= 3 {
        Some(format!("{}.{}.{}", payload[0], payload[1], payload[2]))
    } else {
        None
    }
}

// ===========================================================================
// M65 — Read-only controller context for ELRS troubleshooting (v2.2).
//
// A pure, READ-ONLY context fetch: it sends ONLY MSP v1 GET ids
// (`MSP_FC_VARIANT` / `MSP_API_VERSION` / `MSP_FC_VERSION` / `MSP_SERIAL_CONFIG`)
// and parses the replies into a [`BridgeContextDto`] carrying ONLY fields
// relevant to ELRS passthrough troubleshooting: the FC family/version and coarse
// serial-port metadata (which UART is a serial-RX port). It is READ-ONLY BY
// CONSTRUCTION — there is NO `MSP_SET_*` of any kind here (not even
// `MSP_SET_PASSTHROUGH`; a context fetch is a pure direct MSP read and never
// energizes/passthroughs the RX). Identifiers never leave: the optional Omnia/
// export path runs the whole DTO through `commands::ai::sanitize_context` first.
// ===========================================================================

/// Coarse metadata for one FC serial port, kept to ONLY what helps explain an
/// ELRS passthrough problem (which UART carries the serial RX). Deliberately
/// minimal: a human-readable port identifier (`"UART1"`, `"USB"`) and a coarse
/// function label (`"serialRx"`, `"msp"`, …). NO serial numbers, NO MAC/IP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortMeta {
    /// Coarse port label derived from the MSP serial-port identifier byte.
    pub identifier: String,
    /// Coarse port function (`"serialRx"`/`"msp"`/`"gps"`/`"telemetry"`/
    /// `"blackbox"`), or `None` when unset/unrecognized.
    pub function: Option<String>,
}

/// Read-only controller context for ELRS troubleshooting (M65). Carries ONLY the
/// FC family/version and coarse serial-port metadata — never settings, never a
/// config dump. An empty/absent `serial_ports` (FC too old or the reply was
/// unparseable) drives the frontend "not enough controller context" empty state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeContextDto {
    /// The mapped family ([`BridgeFamily::Unknown`] for an unsupported variant).
    pub family: BridgeFamily,
    /// The raw 4-char FC variant id (`"BTFL"`/`"INAV"`), when the FC answered.
    pub fc_variant: Option<String>,
    /// `MSP_API_VERSION` as `"major.minor"`, best-effort.
    pub api_version: Option<String>,
    /// `MSP_FC_VERSION` as `"major.minor.patch"`, best-effort.
    pub fc_version: Option<String>,
    /// Coarse per-port metadata parsed from `MSP_SERIAL_CONFIG`. Empty when the
    /// reply is absent or unparseable (never fabricated).
    pub serial_ports: Vec<SerialPortMeta>,
}

/// Bytes per port record in the legacy `MSP_CF_SERIAL_CONFIG` reply:
/// identifier(1) + functionMask(2, LE) + 4 baud-rate indices(1 each).
const SERIAL_CONFIG_PORT_LEN: usize = 7;
/// Bound on the number of parsed serial ports (a real FC has far fewer).
const MAX_SERIAL_PORTS: usize = 16;

/// Fetch read-only controller context from an open serial endpoint (M65).
///
/// Sends ONLY the read-only GET ids `MSP_FC_VARIANT` / `MSP_API_VERSION` /
/// `MSP_FC_VERSION` / `MSP_SERIAL_CONFIG` — NEVER an `MSP_SET_*` — then parses the
/// `$M>` replies into a [`BridgeContextDto`]. Generic over [`Read`] + [`Write`]
/// (like [`probe_bridge_candidate`]) so the no-write-path guarantee is unit-tested
/// against `FakeFc` with no real hardware.
///
/// Returns `Err` when no controller answered MSP framing within `timeout` (the
/// "not a controller" case for an ELRS RX speaking CRSF) or when the request
/// could not be written. The serial-config reply is parsed CONSERVATIVELY: if it
/// is absent or unparseable, `serial_ports` is left empty rather than fabricated.
pub fn fetch_bridge_context<S: Read + Write>(
    port: &mut S,
    timeout: Duration,
) -> Result<BridgeContextDto, FlashError> {
    // READ-ONLY GETs only. FC_VARIANT is the decisive reply; the rest enrich the
    // context. NONE of these is an MSP_SET_* command (no write path exists here).
    for cmd in [
        MSP_FC_VARIANT,
        MSP_API_VERSION,
        MSP_FC_VERSION,
        MSP_SERIAL_CONFIG,
    ] {
        let request = encode_request(cmd, &[]);
        port.write_all(&request).map_err(|e| {
            FlashError::new(
                ErrorCategory::Wiring,
                "bridgeContextWriteFailed",
                format!("failed to send MSP GET request {cmd}: {e}"),
            )
        })?;
    }
    let _ = port.flush();

    let deadline = Instant::now() + timeout;
    let mut acc: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64];
    let mut replies: Vec<MspReply> = Vec::new();
    while Instant::now() < deadline {
        match port.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                replies = collect_replies(&acc);
                // The decisive FC_VARIANT reply (and whatever arrived in the same
                // greedy burst, including the serial-config reply) is enough.
                if find_ok(&replies, MSP_FC_VARIANT).is_some() {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            // Any other read error: the endpoint is not answering MSP framing.
            Err(_) => break,
        }
    }

    parse_context_replies(&replies)
}

/// Turn the collected `$M>` replies into a [`BridgeContextDto`], or `Err` when no
/// valid FC_VARIANT reply arrived (not a controller).
fn parse_context_replies(replies: &[MspReply]) -> Result<BridgeContextDto, FlashError> {
    let variant = find_ok(replies, MSP_FC_VARIANT)
        .map(|r| variant_id(&r.payload))
        .filter(|v| !v.is_empty());
    let Some(variant) = variant else {
        return Err(FlashError::new(
            ErrorCategory::Wiring,
            "bridgeContextNoController",
            "no controller answered MSP framing in time",
        ));
    };

    let family = classify_variant(&variant);
    let api_version =
        find_ok(replies, MSP_API_VERSION).and_then(|r| format_api_version(&r.payload));
    let fc_version = find_ok(replies, MSP_FC_VERSION).and_then(|r| format_fc_version(&r.payload));
    let serial_ports = find_ok(replies, MSP_SERIAL_CONFIG)
        .map(|r| parse_serial_config(&r.payload))
        .unwrap_or_default();

    Ok(BridgeContextDto {
        family,
        fc_variant: Some(variant),
        api_version,
        fc_version,
        serial_ports,
    })
}

/// Parse the legacy `MSP_CF_SERIAL_CONFIG` payload into coarse [`SerialPortMeta`].
/// CONSERVATIVE: requires a positive whole number of 7-byte port records; an
/// empty, odd-length, or otherwise unparseable payload yields an empty Vec (the
/// "not enough context" case) rather than fabricated entries.
fn parse_serial_config(payload: &[u8]) -> Vec<SerialPortMeta> {
    if payload.is_empty() || !payload.len().is_multiple_of(SERIAL_CONFIG_PORT_LEN) {
        return Vec::new();
    }
    payload
        .chunks_exact(SERIAL_CONFIG_PORT_LEN)
        .take(MAX_SERIAL_PORTS)
        .map(|rec| {
            let function_mask = u16::from_le_bytes([rec[1], rec[2]]);
            SerialPortMeta {
                identifier: port_identifier(rec[0]),
                function: port_function(function_mask),
            }
        })
        .collect()
}

/// Map an MSP serial-port identifier byte to a coarse, human-readable label.
/// Covers the common Betaflight/iNav identifiers; anything else becomes a generic
/// `"PORT<n>"` (never a serial number — it is just the index byte).
fn port_identifier(id: u8) -> String {
    match id {
        0..=9 => format!("UART{}", id + 1),
        20 => "USB".to_string(),
        30 => "SOFTSERIAL1".to_string(),
        31 => "SOFTSERIAL2".to_string(),
        40 => "LPUART1".to_string(),
        other => format!("PORT{other}"),
    }
}

/// Map a serial-port function bitmask to ONE coarse label relevant to ELRS
/// passthrough troubleshooting, in priority order (serial RX first). `None` when
/// no recognized function bit is set. Coarse by design — never a precise config.
fn port_function(mask: u16) -> Option<String> {
    const FUNCTION_MSP: u16 = 1 << 0;
    const FUNCTION_GPS: u16 = 1 << 1;
    const FUNCTION_RX_SERIAL: u16 = 1 << 6;
    const FUNCTION_BLACKBOX: u16 = 1 << 7;
    // FRSKY_HUB | HOTT | LTM | SMARTPORT | MAVLINK telemetry bits.
    const TELEMETRY_MASK: u16 = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 9);
    if mask & FUNCTION_RX_SERIAL != 0 {
        Some("serialRx".to_string())
    } else if mask & FUNCTION_MSP != 0 {
        Some("msp".to_string())
    } else if mask & FUNCTION_GPS != 0 {
        Some("gps".to_string())
    } else if mask & TELEMETRY_MASK != 0 {
        Some("telemetry".to_string())
    } else if mask & FUNCTION_BLACKBOX != 0 {
        Some("blackbox".to_string())
    } else {
        None
    }
}

// ===========================================================================
// M64 — Passthrough diagnostics and wiring checks (v2.2 "Controller Bridge
// Mode"). EXTENDS the shipped `MSP_SET_PASSTHROUGH` transport path, the
// baud-fallback discipline and the `flash::ErrorCategory` set.
//
// A failed passthrough attempt is turned into a SPECIFIC, actionable failure
// category (not a generic flash error) by running an ordered, stream-generic
// check — controller handshake → UART/passthrough enable → receiver response →
// CRSF response — and mapping the FIRST failing step to a `PassthroughFailure`.
//
// READ-ONLY contract (unchanged): the check sends only the read-only
// `MSP_FC_VARIANT` GET and the in-scope `MSP_SET_PASSTHROUGH` transport command
// — never an FC settings/config write.
// ===========================================================================

/// A specific, actionable passthrough failure (M64). Each maps to a known
/// [`ErrorCategory`] (extending the flash error categories — most are
/// [`ErrorCategory::Wiring`]) and a stable i18n suffix the UI expands to copy +
/// recovery guidance. Serialized camelCase to mirror the frontend union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PassthroughFailure {
    /// Step 1: the FC answered no MSP framing within the handshake window.
    ControllerNotResponding,
    /// Step 2: the FC is reachable but refused / cannot enter passthrough.
    PassthroughUnavailable,
    /// Step 3: passthrough succeeded but ZERO bytes came back from the RX.
    RxNotPowered,
    /// Step 3: bytes came back, but none are CRSF-shaped — the RX is not wired
    /// to the passed-through UART (echo / wrong UART).
    RxNotWired,
    /// Step 4: CRSF-shaped bytes flowed but no valid frame arrived in time.
    CrsfTimeout,
}

impl PassthroughFailure {
    /// Map to the coarse [`ErrorCategory`] (extends the existing flash error
    /// categories). Most passthrough failures are wiring/bench problems; a FC
    /// that handshakes yet cannot passthrough is a firmware/capability mismatch.
    pub fn error_category(&self) -> ErrorCategory {
        match self {
            PassthroughFailure::ControllerNotResponding => ErrorCategory::Wiring,
            PassthroughFailure::PassthroughUnavailable => ErrorCategory::FirmwareMismatch,
            PassthroughFailure::RxNotPowered => ErrorCategory::Wiring,
            PassthroughFailure::RxNotWired => ErrorCategory::Wiring,
            PassthroughFailure::CrsfTimeout => ErrorCategory::Wiring,
        }
    }

    /// Stable i18n key suffix → `bridge.passthrough.failure.<suffix>`.
    pub fn summary_key(&self) -> &'static str {
        match self {
            PassthroughFailure::ControllerNotResponding => "controllerNotResponding",
            PassthroughFailure::PassthroughUnavailable => "passthroughUnavailable",
            PassthroughFailure::RxNotPowered => "rxNotPowered",
            PassthroughFailure::RxNotWired => "rxNotWired",
            PassthroughFailure::CrsfTimeout => "crsfTimeout",
        }
    }
}

/// One ordered step of the guided passthrough check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PassthroughStep {
    /// MSP reachable — the controller answered a read-only GET.
    Handshake,
    /// UART/passthrough enabled — the FC acked `MSP_SET_PASSTHROUGH`.
    Uart,
    /// Receiver response — bytes came back after passthrough.
    Receiver,
    /// CRSF response — a valid CRSF frame was seen.
    Crsf,
}

/// The ordered steps of the guided check, used to synthesize a full report from
/// the single failing step (earlier steps pass, later steps are skipped).
const PASSTHROUGH_STEPS: [PassthroughStep; 4] = [
    PassthroughStep::Handshake,
    PassthroughStep::Uart,
    PassthroughStep::Receiver,
    PassthroughStep::Crsf,
];

/// Per-step result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    Pass,
    Fail,
    Skipped,
}

/// One step's outcome in a [`PassthroughCheckReport`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepOutcome {
    pub step: PassthroughStep,
    pub status: StepStatus,
}

/// The result of a guided passthrough check: the per-step outcomes plus the
/// mapped failure category (`None` ⇒ all four steps passed). `baud` and `uart`
/// are filled in by the Tauri command (the stream-generic core is unaware of
/// either) so the frontend event log + M66 export can record the attempt.
///
/// Serialize-only (no `Deserialize`): it carries [`ErrorCategory`], which is a
/// serialize-only flash type, and the report only ever flows Rust → frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassthroughCheckReport {
    /// One outcome per [`PassthroughStep`], in order.
    pub steps: Vec<StepOutcome>,
    /// The specific failure category, or `None` on full success.
    pub failure: Option<PassthroughFailure>,
    /// The coarse [`ErrorCategory`] of the failure (`None` on success), derived
    /// from [`PassthroughFailure::error_category`]. Mirrors `FlashErrorPayload`
    /// so the frontend + M66 export read the category authoritatively from Rust.
    pub category: Option<ErrorCategory>,
    /// The failure's stable i18n key suffix (`None` on success), from
    /// [`PassthroughFailure::summary_key`] → `bridge.passthrough.failure.<suffix>`.
    pub summary_key: Option<String>,
    /// The baud the check ran at (set by the command's fallback loop).
    pub baud: Option<u32>,
    /// The user-selected FC UART index the RX is wired to (diagnostic only —
    /// passthrough still opens all ports). Echoed back for the log/export.
    pub uart: Option<u8>,
}

impl PassthroughCheckReport {
    /// Build a report whose first failing step is `failing` (earlier steps pass,
    /// later steps are skipped), carrying `failure` and its derived
    /// category/summary-key. `baud`/`uart` default to `None` and are set by the
    /// command.
    fn failed(failing: PassthroughStep, failure: PassthroughFailure) -> Self {
        let mut steps = Vec::with_capacity(PASSTHROUGH_STEPS.len());
        let mut past_failure = false;
        for &step in &PASSTHROUGH_STEPS {
            let status = if step == failing {
                past_failure = true;
                StepStatus::Fail
            } else if past_failure {
                StepStatus::Skipped
            } else {
                StepStatus::Pass
            };
            steps.push(StepOutcome { step, status });
        }
        Self {
            steps,
            failure: Some(failure),
            category: Some(failure.error_category()),
            summary_key: Some(failure.summary_key().to_string()),
            baud: None,
            uart: None,
        }
    }

    /// Build an all-steps-pass report.
    fn passed() -> Self {
        let steps = PASSTHROUGH_STEPS
            .iter()
            .map(|&step| StepOutcome {
                step,
                status: StepStatus::Pass,
            })
            .collect();
        Self {
            steps,
            failure: None,
            category: None,
            summary_key: None,
            baud: None,
            uart: None,
        }
    }
}

/// Per-phase timeouts bounding the guided check. Kept explicit (not hard-coded
/// inside the loop) so the command can budget the overall handshake allowance
/// across the baud-fallback loop and tests can run fast.
#[derive(Debug, Clone, Copy)]
pub struct PassthroughTimeouts {
    /// MSP handshake wait (step 1).
    pub handshake: Duration,
    /// `MSP_SET_PASSTHROUGH` ack wait (step 2).
    pub passthrough: Duration,
    /// Post-passthrough wait for ANY receiver bytes (step 3).
    pub receiver: Duration,
    /// Further wait for a valid CRSF frame once bytes flow (step 4).
    pub crsf: Duration,
}

impl PassthroughTimeouts {
    /// Per-baud default phase budget. The handshake slice repeats per candidate
    /// baud (only a `ControllerNotResponding` advances the fallback loop), so
    /// the worst case stays comfortably within the shipped
    /// [`crate::flash::msp::FC_HANDSHAKE_TIMEOUT`] spirit.
    pub const DEFAULT: Self = Self {
        handshake: Duration::from_millis(800),
        passthrough: Duration::from_millis(800),
        receiver: Duration::from_millis(800),
        crsf: Duration::from_millis(1200),
    };
}

/// Smallest/largest legal CRSF length byte. Mirrors the (private) `MIN_LENGTH`/
/// `MAX_LENGTH` in [`crate::crsf`]; duplicated here only to keep the cheap
/// "CRSF-shaped?" signature check independent of that module's internals.
const CRSF_MIN_LEN: u8 = 2;
const CRSF_MAX_LEN: u8 = 62;

/// Does `buf` carry a CRSF *framing signature* — a known CRSF sync/address byte
/// immediately followed by a plausible length byte — even if no frame ever
/// passes CRC?
///
/// This distinguishes a receiver that IS speaking CRSF on the passed-through
/// UART (⇒ [`PassthroughFailure::CrsfTimeout`]: frames present but not
/// completing/validating in time, e.g. a baud mismatch) from unrelated bytes /
/// echo on the wrong UART (⇒ [`PassthroughFailure::RxNotWired`]).
fn looks_like_crsf(buf: &[u8]) -> bool {
    use crate::crsf::address;
    const SYNCS: [u8; 5] = [
        address::FLIGHT_CONTROLLER,
        address::RADIO_TRANSMITTER,
        address::CRSF_TRANSMITTER,
        address::CRSF_RECEIVER,
        address::ELRS_LUA,
    ];
    buf.windows(2)
        .any(|w| SYNCS.contains(&w[0]) && (CRSF_MIN_LEN..=CRSF_MAX_LEN).contains(&w[1]))
}

/// Byte offset in `buf` just past the first checksum-valid `$M>` reply whose
/// command is `cmd`, or `None` if no such complete frame is present. Lets the
/// check find the END of the passthrough ack so anything trailing it is treated
/// as the post-passthrough RX stream (the same accumulation buffer carries the
/// handshake replies, the ack and the RX bytes, since a greedy serial read can
/// pull all three at once).
fn offset_after_reply(buf: &[u8], cmd: u8) -> Option<usize> {
    let mut offset = 0;
    while offset + 3 <= buf.len() {
        match buf[offset..].windows(3).position(|w| w == b"$M>") {
            Some(pos) => {
                let start = offset + pos;
                if let Some(reply) = parse_reply(&buf[start..]) {
                    let end = start + 6 + reply.payload.len();
                    if reply.command == cmd {
                        return Some(end);
                    }
                    offset = end;
                } else {
                    offset = start + 3;
                }
            }
            None => break,
        }
    }
    None
}

/// One bounded read appending to `acc`. `Ok(n)` = bytes added (0 on an expected
/// read timeout / no data); `Err(())` = a hard read error (treat as end-of-stream).
fn pump<S: Read>(port: &mut S, acc: &mut Vec<u8>) -> Result<usize, ()> {
    let mut chunk = [0u8; 64];
    match port.read(&mut chunk) {
        Ok(0) => Ok(0),
        Ok(n) => {
            acc.extend_from_slice(&chunk[..n]);
            Ok(n)
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(0),
        Err(_) => Err(()),
    }
}

/// Run the guided passthrough check against an open stream (READ-ONLY MSP GET +
/// the in-scope `MSP_SET_PASSTHROUGH` transport command — no FC settings write).
///
/// Ordered steps, mapping the FIRST failing step to a [`PassthroughFailure`]:
///  1. **handshake** — a read-only `MSP_FC_VARIANT` GET; any valid `$M>` reply
///     proves MSP is reachable. No reply ⇒ [`PassthroughFailure::ControllerNotResponding`].
///  2. **uart** — `MSP_SET_PASSTHROUGH`; no ack ⇒ [`PassthroughFailure::PassthroughUnavailable`].
///  3. **receiver** — bytes after passthrough: none ⇒ [`PassthroughFailure::RxNotPowered`];
///     bytes but nothing CRSF-shaped ⇒ [`PassthroughFailure::RxNotWired`].
///  4. **crsf** — a valid CRSF frame: present ⇒ success; CRSF-shaped but never
///     valid in time ⇒ [`PassthroughFailure::CrsfTimeout`].
///
/// Generic over [`Read`] + [`Write`] (like [`probe_bridge_candidate`]) so every
/// category is driven by `FakeFc` in tests with no real hardware. A single
/// accumulation buffer carries all phases so a greedy serial read can't drop
/// bytes between them.
pub fn run_passthrough_check_stream<S: Read + Write>(
    port: &mut S,
    timeouts: &PassthroughTimeouts,
) -> PassthroughCheckReport {
    let mut acc: Vec<u8> = Vec::new();

    // ---- Step 1: controller handshake (MSP reachable). READ-ONLY GET. ----
    if port
        .write_all(&encode_request(MSP_FC_VARIANT, &[]))
        .is_err()
    {
        return PassthroughCheckReport::failed(
            PassthroughStep::Handshake,
            PassthroughFailure::ControllerNotResponding,
        );
    }
    let _ = port.flush();
    if !wait_until(port, &mut acc, timeouts.handshake, |acc| {
        !collect_replies(acc).is_empty()
    }) {
        return PassthroughCheckReport::failed(
            PassthroughStep::Handshake,
            PassthroughFailure::ControllerNotResponding,
        );
    }

    // ---- Step 2: UART / passthrough enable (in-scope transport command). ----
    if port
        // Same builder the flash path uses, so this diagnostic can never end up
        // asking for a different passthrough mode than the flash it predicts.
        .write_all(&passthrough_request())
        .is_err()
        || !{
            let _ = port.flush();
            wait_until(port, &mut acc, timeouts.passthrough, |acc| {
                // Neither an MSP error frame (`$M!`) nor a `$M>` ack carrying the
                // `0` "no passthrough-capable UART" byte is an acknowledgement,
                // so neither may satisfy the ack this step waits for.
                collect_replies(acc)
                    .iter()
                    .any(|r| r.command == MSP_SET_PASSTHROUGH && passthrough_ack_is_positive(r))
            })
        }
    {
        return PassthroughCheckReport::failed(
            PassthroughStep::Uart,
            PassthroughFailure::PassthroughUnavailable,
        );
    }

    // ---- Steps 3 & 4: read the post-passthrough stream. ----
    // Everything trailing the ack frame is the RX stream (a greedy read may have
    // already pulled some of it into `acc` during the prior phases).
    let rx_start = offset_after_reply(&acc, MSP_SET_PASSTHROUGH).unwrap_or(acc.len());
    let mut parser = crate::crsf::Parser::new();
    let mut fed = rx_start;
    let mut saw_crsf = false;

    let deadline = Instant::now() + timeouts.receiver + timeouts.crsf;
    loop {
        if fed < acc.len() {
            if !parser.feed(&acc[fed..]).is_empty() {
                saw_crsf = true;
            }
            fed = acc.len();
        }
        // A valid CRSF frame ends the check early (success).
        if saw_crsf || Instant::now() >= deadline {
            break;
        }
        if pump(port, &mut acc).is_err() {
            break;
        }
    }

    let rx = &acc[rx_start..];
    if saw_crsf {
        PassthroughCheckReport::passed()
    } else if rx.is_empty() {
        // Passthrough ok but the RX sent nothing ⇒ it isn't powered.
        PassthroughCheckReport::failed(PassthroughStep::Receiver, PassthroughFailure::RxNotPowered)
    } else if looks_like_crsf(rx) {
        // CRSF-shaped bytes but no valid frame in time ⇒ a CRSF timeout.
        PassthroughCheckReport::failed(PassthroughStep::Crsf, PassthroughFailure::CrsfTimeout)
    } else {
        // Bytes back, but nothing CRSF-shaped ⇒ not the RX on the selected UART.
        PassthroughCheckReport::failed(PassthroughStep::Receiver, PassthroughFailure::RxNotWired)
    }
}

/// Poll-read into `acc` until `done(acc)` is true or `timeout` elapses. Returns
/// whether `done` was satisfied. Read timeouts are the expected "nothing yet"
/// case; a hard read error ends the wait.
fn wait_until<S: Read>(
    port: &mut S,
    acc: &mut Vec<u8>,
    timeout: Duration,
    done: impl Fn(&[u8]) -> bool,
) -> bool {
    if done(acc) {
        return true;
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match pump(port, acc) {
            Ok(0) => {}
            Ok(_) => {
                if done(acc) {
                    return true;
                }
            }
            Err(()) => break,
        }
    }
    done(acc)
}

/// Apply the M64 baud-fallback DISCIPLINE over an ordered list of candidate
/// `bauds`, obtaining a categorised report per candidate from `check_at`. Only a
/// [`PassthroughFailure::ControllerNotResponding`] (which might just be the wrong
/// rate) advances to the next candidate, so the list is EXHAUSTED before the FC
/// is declared unreachable; any other outcome (success OR a specific downstream
/// failure) means the FC was reached at this baud and is returned immediately (a
/// powered/wired/CRSF verdict is baud-independent). `check_at` returns `None` for
/// a candidate that could not be selected (e.g. the serial handle refused that
/// baud), which is skipped; the helper returns `None` overall ONLY when no
/// candidate was selectable, so the caller can apply its own fallback rather than
/// fabricate a verdict for a baud it never ran.
///
/// This is the SINGLE source of the discipline: the shipped `run_passthrough_check`
/// command (in `commands/bridge.rs`) drives it over its one re-tuned serial handle,
/// and the unit tests drive it with `FakeFc` — so the discipline tests guard the
/// PRODUCTION path. The injected closure is the only thing that differs (a real
/// re-tune vs. a fresh fixture per baud); the fallback logic is shared.
pub fn run_passthrough_check_across_bauds<F>(
    bauds: &[u32],
    mut check_at: F,
) -> Option<PassthroughCheckReport>
where
    F: FnMut(u32) -> Option<PassthroughCheckReport>,
{
    let mut last: Option<PassthroughCheckReport> = None;
    for &baud in bauds {
        let Some(report) = check_at(baud) else {
            continue;
        };
        match report.failure {
            Some(PassthroughFailure::ControllerNotResponding) => last = Some(report),
            _ => return Some(report),
        }
    }
    // Exhausted every candidate: the last ControllerNotResponding report (if any),
    // else `None` (no candidate was selectable — the caller handles that).
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash::msp::{FakeFc, COMMON_FC_BAUDS};

    const PROBE_TIMEOUT: Duration = Duration::from_millis(200);

    /// Extract the command id of every `$M<` request written to the FC, so a
    /// test can prove only read-only GETs were sent (never an `MSP_SET_*`).
    fn sent_commands(written: &[u8]) -> Vec<u8> {
        let mut cmds = Vec::new();
        let mut i = 0;
        while i + 5 <= written.len() {
            if &written[i..i + 3] == b"$M<" {
                let len = written[i + 3] as usize;
                cmds.push(written[i + 4]);
                i += 6 + len;
            } else {
                i += 1;
            }
        }
        cmds
    }

    #[test]
    fn classify_variant_maps_known_and_unknown() {
        assert_eq!(classify_variant("BTFL"), BridgeFamily::Betaflight);
        assert_eq!(classify_variant("INAV"), BridgeFamily::Inav);
        // Unknown/legacy variants are NOT mapped to a supported family.
        assert_eq!(classify_variant("QUAD"), BridgeFamily::Unknown);
        assert_eq!(classify_variant("ARDU"), BridgeFamily::Unknown);
        assert_eq!(classify_variant(""), BridgeFamily::Unknown);
    }

    #[test]
    fn betaflight_fixture_classifies_as_betaflight_bridge() {
        let mut fc = FakeFc::betaflight_bridge();
        let result = probe_bridge_candidate(&mut fc, PROBE_TIMEOUT).unwrap();
        match result {
            BridgeClassification::Bridge(c) => {
                assert_eq!(c.family, BridgeFamily::Betaflight);
                assert_eq!(c.fc_variant, "BTFL");
                assert_eq!(c.api_version.as_deref(), Some("1.46"));
                assert_eq!(c.fc_version.as_deref(), Some("4.5.1"));
            }
            other => panic!("expected a Betaflight bridge, got {other:?}"),
        }
        // READ-ONLY contract: only GET commands were ever sent to the FC.
        let cmds = sent_commands(&fc.written);
        assert!(cmds.contains(&MSP_FC_VARIANT));
        assert!(
            cmds.iter()
                .all(|c| [MSP_API_VERSION, MSP_FC_VARIANT, MSP_FC_VERSION].contains(c)),
            "only read-only GET commands may be sent, got {cmds:?}"
        );
    }

    #[test]
    fn inav_fixture_classifies_as_inav_bridge() {
        let mut fc = FakeFc::inav_bridge();
        let result = probe_bridge_candidate(&mut fc, PROBE_TIMEOUT).unwrap();
        match result {
            BridgeClassification::Bridge(c) => {
                assert_eq!(c.family, BridgeFamily::Inav);
                assert_eq!(c.fc_variant, "INAV");
            }
            other => panic!("expected an iNav bridge, got {other:?}"),
        }
    }

    #[test]
    fn non_controller_fixture_never_classifies_as_bridge() {
        // ZERO FALSE POSITIVES: an ELRS RX speaking CRSF answers no MSP framing,
        // so it must resolve to `NotAController` and NEVER to `Bridge`.
        let mut fc = FakeFc::non_controller();
        let result = probe_bridge_candidate(&mut fc, PROBE_TIMEOUT).unwrap();
        assert!(
            !matches!(result, BridgeClassification::Bridge(_)),
            "a non-controller must never be classified as a bridge"
        );
        assert_eq!(result, BridgeClassification::NotAController);
    }

    #[test]
    fn unsupported_variant_classifies_as_unsupported_bridge() {
        // A valid MSP reply with an unmapped 4-char variant is labeled
        // "unsupported bridge", not misclassified as a supported family.
        let mut fc = FakeFc::unsupported_bridge();
        let result = probe_bridge_candidate(&mut fc, PROBE_TIMEOUT).unwrap();
        match result {
            BridgeClassification::UnsupportedBridge { reason } => assert_eq!(reason, "QUAD"),
            other => panic!("expected an unsupported bridge, got {other:?}"),
        }
    }

    #[test]
    fn silent_endpoint_is_not_a_controller() {
        // No bytes at all (FakeFc::from_bytes empty) ⇒ no MSP reply ⇒ NotAController.
        let mut fc = FakeFc::from_bytes([]);
        let result = probe_bridge_candidate(&mut fc, Duration::from_millis(50)).unwrap();
        assert_eq!(result, BridgeClassification::NotAController);
    }

    #[test]
    fn collect_replies_resyncs_and_collects_multiple_frames() {
        // Leading CRSF-ish noise, then two valid back-to-back `$M>` frames.
        let mut buf = vec![0xC8, 0x18, 0x14];
        buf.extend_from_slice(&crate::flash::msp::build_reply(MSP_FC_VARIANT, b"BTFL"));
        buf.extend_from_slice(&crate::flash::msp::build_reply(
            MSP_API_VERSION,
            &[1, 1, 46],
        ));
        let replies = collect_replies(&buf);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0].command, MSP_FC_VARIANT);
        assert_eq!(replies[0].payload, b"BTFL");
        assert_eq!(replies[1].command, MSP_API_VERSION);
    }

    #[test]
    fn classification_serializes_with_kind_tag() {
        let bridge = BridgeClassification::Bridge(BridgeCandidate {
            family: BridgeFamily::Betaflight,
            fc_variant: "BTFL".into(),
            api_version: Some("1.46".into()),
            fc_version: Some("4.5.1".into()),
        });
        let json = serde_json::to_value(&bridge).unwrap();
        assert_eq!(json["kind"], "bridge");
        assert_eq!(json["family"], "betaflight");
        assert_eq!(json["fcVariant"], "BTFL");
        assert_eq!(json["apiVersion"], "1.46");
        assert_eq!(json["fcVersion"], "4.5.1");

        let none = serde_json::to_value(BridgeClassification::NotAController).unwrap();
        assert_eq!(none["kind"], "notAController");

        let unsupported = serde_json::to_value(BridgeClassification::UnsupportedBridge {
            reason: "QUAD".into(),
        })
        .unwrap();
        assert_eq!(unsupported["kind"], "unsupportedBridge");
        assert_eq!(unsupported["reason"], "QUAD");
    }

    // -- M65: read-only controller context ----------------------------------

    const CONTEXT_TIMEOUT: Duration = Duration::from_millis(200);

    /// The full GET id set the context fetch is allowed to send (NO `MSP_SET_*`).
    const CONTEXT_GET_IDS: [u8; 4] = [
        MSP_API_VERSION,
        MSP_FC_VARIANT,
        MSP_FC_VERSION,
        MSP_SERIAL_CONFIG,
    ];

    #[test]
    fn fetch_bridge_context_returns_family_version_and_serial_ports() {
        let mut fc = FakeFc::bridge_with_serial_config();
        let ctx = fetch_bridge_context(&mut fc, CONTEXT_TIMEOUT).unwrap();
        assert_eq!(ctx.family, BridgeFamily::Betaflight);
        assert_eq!(ctx.fc_variant.as_deref(), Some("BTFL"));
        assert_eq!(ctx.api_version.as_deref(), Some("1.46"));
        assert_eq!(ctx.fc_version.as_deref(), Some("4.5.1"));
        // Coarse serial-port metadata: UART1 = MSP, UART2 = serial RX.
        assert_eq!(ctx.serial_ports.len(), 2);
        assert_eq!(ctx.serial_ports[0].identifier, "UART1");
        assert_eq!(ctx.serial_ports[0].function.as_deref(), Some("msp"));
        assert_eq!(ctx.serial_ports[1].identifier, "UART2");
        assert_eq!(ctx.serial_ports[1].function.as_deref(), Some("serialRx"));
    }

    /// BINARY ACCEPTANCE PROOF (M65): the read-only context surface has ZERO
    /// write path. Every command written to the FC must be a read-only GET
    /// (∈ {1, 2, 3, 54}); NO `MSP_SET_*` — and in particular NOT
    /// `MSP_SET_PASSTHROUGH` (245) — may EVER be sent from this surface.
    #[test]
    fn fetch_bridge_context_sends_only_read_only_gets_no_set() {
        let mut fc = FakeFc::bridge_with_serial_config();
        let _ = fetch_bridge_context(&mut fc, CONTEXT_TIMEOUT).unwrap();
        let cmds = sent_commands(&fc.written);
        // It actually performed the read-only handshake.
        assert!(cmds.contains(&MSP_FC_VARIANT));
        // Not a single MSP_SET_* — explicitly NOT MSP_SET_PASSTHROUGH.
        assert!(
            !cmds.contains(&MSP_SET_PASSTHROUGH),
            "context fetch must NEVER send MSP_SET_PASSTHROUGH (245), got {cmds:?}"
        );
        // Every written command is one of the four allowed read-only GET ids.
        assert!(
            cmds.iter().all(|c| CONTEXT_GET_IDS.contains(c)),
            "only read-only GET ids {CONTEXT_GET_IDS:?} may be sent, got {cmds:?}"
        );
    }

    #[test]
    fn fetch_bridge_context_not_a_controller_errors() {
        // A silent endpoint (e.g. an ELRS RX speaking CRSF) answers no MSP framing
        // ⇒ Err, which the command surfaces and the UI turns into the empty state.
        let mut fc = FakeFc::from_bytes([]);
        assert!(fetch_bridge_context(&mut fc, Duration::from_millis(50)).is_err());
    }

    #[test]
    fn fetch_bridge_context_without_serial_config_leaves_ports_empty() {
        // A bridge that answers FC_VARIANT/API/FC_VERSION but NOT the serial-config
        // GET ⇒ a valid context with empty serial_ports (the "not enough context"
        // case), never fabricated.
        let mut fc = FakeFc::betaflight_bridge();
        let ctx = fetch_bridge_context(&mut fc, CONTEXT_TIMEOUT).unwrap();
        assert_eq!(ctx.family, BridgeFamily::Betaflight);
        assert!(ctx.serial_ports.is_empty());
    }

    #[test]
    fn serial_config_parse_is_conservative_about_bad_payloads() {
        // Whole 7-byte records parse; a non-multiple-of-7 or empty payload is
        // treated as unparseable ⇒ empty (never fabricated).
        assert!(parse_serial_config(&[]).is_empty());
        assert!(parse_serial_config(&[0x00, 0x01, 0x00]).is_empty()); // 3 bytes
        let one_record = [0x14, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]; // USB, MSP
        let ports = parse_serial_config(&one_record);
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].identifier, "USB");
        assert_eq!(ports[0].function.as_deref(), Some("msp"));
    }

    #[test]
    fn bridge_context_serializes_camelcase_for_the_frontend() {
        let ctx = fetch_bridge_context(&mut FakeFc::bridge_with_serial_config(), CONTEXT_TIMEOUT)
            .unwrap();
        let json = serde_json::to_value(&ctx).unwrap();
        assert_eq!(json["family"], "betaflight");
        assert_eq!(json["fcVariant"], "BTFL");
        assert_eq!(json["apiVersion"], "1.46");
        assert_eq!(json["fcVersion"], "4.5.1");
        assert_eq!(json["serialPorts"][0]["identifier"], "UART1");
        assert_eq!(json["serialPorts"][1]["function"], "serialRx");
    }

    // -- M64: passthrough diagnostics ---------------------------------------

    /// Fast per-phase budget so the failure-category tests stay sub-second.
    const FAST: PassthroughTimeouts = PassthroughTimeouts {
        handshake: Duration::from_millis(60),
        passthrough: Duration::from_millis(60),
        receiver: Duration::from_millis(60),
        crsf: Duration::from_millis(60),
    };

    /// The status recorded for `step` in a report.
    fn status_of(report: &PassthroughCheckReport, step: PassthroughStep) -> StepStatus {
        report
            .steps
            .iter()
            .find(|o| o.step == step)
            .unwrap_or_else(|| panic!("missing step {step:?}"))
            .status
    }

    #[test]
    fn silent_fc_maps_to_controller_not_responding() {
        let mut fc = FakeFc::passthrough_silent();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::ControllerNotResponding)
        );
        assert_eq!(
            status_of(&report, PassthroughStep::Handshake),
            StepStatus::Fail
        );
        // Later steps are not run.
        assert_eq!(
            status_of(&report, PassthroughStep::Uart),
            StepStatus::Skipped
        );
        assert_eq!(
            status_of(&report, PassthroughStep::Crsf),
            StepStatus::Skipped
        );
        let failure = report.failure.unwrap();
        assert_eq!(failure.error_category(), ErrorCategory::Wiring);
        assert_eq!(failure.summary_key(), "controllerNotResponding");
    }

    #[test]
    fn refused_passthrough_maps_to_passthrough_unavailable() {
        let mut fc = FakeFc::passthrough_refused();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::PassthroughUnavailable)
        );
        // Handshake succeeded; the UART/passthrough step is where it failed.
        assert_eq!(
            status_of(&report, PassthroughStep::Handshake),
            StepStatus::Pass
        );
        assert_eq!(status_of(&report, PassthroughStep::Uart), StepStatus::Fail);
        assert_eq!(
            status_of(&report, PassthroughStep::Receiver),
            StepStatus::Skipped
        );
        let failure = report.failure.unwrap();
        assert_eq!(failure.error_category(), ErrorCategory::FirmwareMismatch);
        assert_eq!(failure.summary_key(), "passthroughUnavailable");
    }

    #[test]
    fn an_msp_error_frame_is_never_mistaken_for_a_reply() {
        // `parse_reply` now also decodes the MSP v1 error form (`$M!`) so the
        // flash handshake can tell "refused" from "silent". Everything in THIS
        // module reads answers out of replies, so an error frame must not be
        // read as one: an `$M!` FC_VARIANT is not an unsupported bridge (its
        // payload is empty), and an `$M!` MSP_SET_PASSTHROUGH is not an ack.
        use crate::flash::msp::{build_error_reply, build_reply};

        let variant_error = collect_replies(&build_error_reply(MSP_FC_VARIANT, &[]));
        assert_eq!(variant_error.len(), 1, "the error frame is still decoded");
        assert_eq!(
            classify_replies(&variant_error),
            BridgeClassification::NotAController
        );
        assert!(parse_context_replies(&variant_error).is_err());

        let mut fc = FakeFc::from_bytes({
            let mut bytes = build_reply(MSP_FC_VARIANT, b"BTFL");
            bytes.extend_from_slice(&build_error_reply(MSP_SET_PASSTHROUGH, &[]));
            bytes
        });
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::PassthroughUnavailable),
            "a refusal must fail step 2, not satisfy it"
        );
    }

    #[test]
    fn a_zero_ack_byte_fails_the_uart_step_and_the_request_matches_the_flash_path() {
        // FIX 9H. Betaflight/iNav answer `MSP_SET_PASSTHROUGH` with one payload
        // byte: 1 when the passthrough was armed, 0 when no matching UART was
        // found. The 0 comes in an ordinary `$M>` frame, so this diagnostic used
        // to report "UART OK" for exactly the FC configuration it exists to
        // detect — and then predict a flash that cannot work.
        use crate::flash::msp::{build_reply, passthrough_request};

        let mut fc = FakeFc::from_bytes({
            let mut bytes = build_reply(MSP_FC_VARIANT, b"BTFL");
            bytes.extend_from_slice(&build_reply(MSP_SET_PASSTHROUGH, &[0]));
            bytes
        });
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::PassthroughUnavailable),
            "a `0` ack byte is 'no passthrough-capable UART', not an acknowledgement"
        );
        assert_eq!(status_of(&report, PassthroughStep::Uart), StepStatus::Fail);

        // And this surface must ask for the SAME thing the flash path asks for:
        // a diagnostic that requests a different passthrough mode than the flash
        // it predicts is worse than no diagnostic.
        let mut fc = FakeFc::passthrough_success();
        let _ = run_passthrough_check_stream(&mut fc, &FAST);
        let request = passthrough_request();
        assert!(
            fc.written
                .windows(request.len())
                .any(|window| window == request.as_slice()),
            "the guided check must send the flash path's exact passthrough request"
        );
    }

    #[test]
    fn passthrough_no_rx_maps_to_rx_not_powered() {
        let mut fc = FakeFc::passthrough_no_rx();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(report.failure, Some(PassthroughFailure::RxNotPowered));
        assert_eq!(status_of(&report, PassthroughStep::Uart), StepStatus::Pass);
        assert_eq!(
            status_of(&report, PassthroughStep::Receiver),
            StepStatus::Fail
        );
        assert_eq!(
            status_of(&report, PassthroughStep::Crsf),
            StepStatus::Skipped
        );
        assert_eq!(
            report.failure.unwrap().error_category(),
            ErrorCategory::Wiring
        );
        assert_eq!(report.failure.unwrap().summary_key(), "rxNotPowered");
    }

    #[test]
    fn passthrough_wrong_uart_maps_to_rx_not_wired() {
        let mut fc = FakeFc::passthrough_wrong_uart();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(report.failure, Some(PassthroughFailure::RxNotWired));
        // Bytes came back (so the FC passthrough worked) but the receiver step
        // fails — they are not a CRSF receiver on the selected UART.
        assert_eq!(status_of(&report, PassthroughStep::Uart), StepStatus::Pass);
        assert_eq!(
            status_of(&report, PassthroughStep::Receiver),
            StepStatus::Fail
        );
        assert_eq!(report.failure.unwrap().summary_key(), "rxNotWired");
    }

    #[test]
    fn passthrough_rx_without_crsf_maps_to_crsf_timeout() {
        let mut fc = FakeFc::passthrough_rx_no_crsf();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(report.failure, Some(PassthroughFailure::CrsfTimeout));
        // The receiver step passes (CRSF-shaped bytes flow); the CRSF step is
        // where it fails — no valid frame before the deadline.
        assert_eq!(
            status_of(&report, PassthroughStep::Receiver),
            StepStatus::Pass
        );
        assert_eq!(status_of(&report, PassthroughStep::Crsf), StepStatus::Fail);
        assert_eq!(report.failure.unwrap().summary_key(), "crsfTimeout");
    }

    #[test]
    fn passthrough_success_passes_every_step() {
        let mut fc = FakeFc::passthrough_success();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(report.failure, None);
        for step in PASSTHROUGH_STEPS {
            assert_eq!(status_of(&report, step), StepStatus::Pass);
        }
    }

    #[test]
    fn captured_failure_fixture_set_covers_every_passthrough_failure() {
        // v2.2/M67 "passthrough failure fixture capture": the M64 `FakeFc`
        // passthrough fixtures are the CANONICAL, reusable capture of every real
        // failure mode. This guard manifests the fixture→variant set in one place
        // so that EVERY `PassthroughFailure` variant has a captured fixture and a
        // distinct, non-empty `bridge.passthrough.failure.<key>` mapping. Adding a
        // sixth variant without capturing a fixture for it FAILS this test.
        //
        // The manifest below must list one fixture per variant; the assertions then
        // prove (a) each fixture maps to its expected variant, (b) the captured set
        // covers all five distinct variants, and (c) every summary key is distinct
        // and non-empty (the actionable, category-specific copy — never generic).
        let captured: [(fn() -> FakeFc, PassthroughFailure); 5] = [
            (
                FakeFc::passthrough_silent,
                PassthroughFailure::ControllerNotResponding,
            ),
            (
                FakeFc::passthrough_refused,
                PassthroughFailure::PassthroughUnavailable,
            ),
            (FakeFc::passthrough_no_rx, PassthroughFailure::RxNotPowered),
            (
                FakeFc::passthrough_wrong_uart,
                PassthroughFailure::RxNotWired,
            ),
            (
                FakeFc::passthrough_rx_no_crsf,
                PassthroughFailure::CrsfTimeout,
            ),
        ];

        let mut summary_keys = std::collections::HashSet::new();
        for (make_fixture, expected) in captured {
            let mut fc = make_fixture();
            let report = run_passthrough_check_stream(&mut fc, &FAST);
            assert_eq!(
                report.failure,
                Some(expected),
                "captured fixture must map to its expected failure variant"
            );
            let key = expected.summary_key();
            assert!(!key.is_empty(), "every failure must carry a summary key");
            // The report's serialized summary_key mirrors the variant's.
            assert_eq!(report.summary_key.as_deref(), Some(key));
            summary_keys.insert(key);
        }
        // The five captured variants each map to a distinct, non-empty key (the
        // mapping is 1:1, so five distinct keys ⇒ all five variants are covered).
        assert_eq!(
            summary_keys.len(),
            5,
            "every passthrough failure variant has a distinct captured fixture + key"
        );
    }

    #[test]
    fn passthrough_check_sends_only_read_only_get_and_set_passthrough() {
        // READ-ONLY contract: the only commands written to the FC are the
        // read-only FC_VARIANT GET and the in-scope MSP_SET_PASSTHROUGH transport
        // command — never any other MSP_SET_* settings write.
        let mut fc = FakeFc::passthrough_success();
        let _ = run_passthrough_check_stream(&mut fc, &FAST);
        let cmds = sent_commands(&fc.written);
        assert!(cmds.contains(&MSP_FC_VARIANT));
        assert!(cmds.contains(&MSP_SET_PASSTHROUGH));
        assert!(
            cmds.iter()
                .all(|c| [MSP_FC_VARIANT, MSP_SET_PASSTHROUGH].contains(c)),
            "only FC_VARIANT GET + MSP_SET_PASSTHROUGH may be sent, got {cmds:?}"
        );
    }

    #[test]
    fn silent_fc_fails_fast_within_the_bounded_timeout() {
        let mut fc = FakeFc::passthrough_silent();
        let started = Instant::now();
        let report = run_passthrough_check_stream(&mut fc, &FAST);
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::ControllerNotResponding)
        );
        // Honoured the short handshake budget rather than blocking.
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// Run the guided check on a fresh `FakeFc` for one candidate baud, stamping
    /// the rate onto the report — the closure body the discipline helper drives in
    /// tests (the production command's closure re-tunes one real handle instead).
    fn check_fake_at(baud: u32, mut fc: FakeFc) -> Option<PassthroughCheckReport> {
        let mut report = run_passthrough_check_stream(&mut fc, &FAST);
        report.baud = Some(baud);
        Some(report)
    }

    #[test]
    fn baud_fallback_exhausts_candidates_before_succeeding() {
        // Wrong rate (silent) on the first three bauds, a working FC on the last:
        // the loop must try EVERY candidate up to the one that handshakes.
        let mut tried: Vec<u32> = Vec::new();
        let report = run_passthrough_check_across_bauds(&COMMON_FC_BAUDS, |baud| {
            tried.push(baud);
            let fc = if baud == *COMMON_FC_BAUDS.last().unwrap() {
                FakeFc::passthrough_success()
            } else {
                FakeFc::passthrough_silent()
            };
            check_fake_at(baud, fc)
        })
        .expect("a candidate produced a report");
        assert_eq!(tried, COMMON_FC_BAUDS.to_vec());
        assert_eq!(report.failure, None);
        assert_eq!(report.baud, Some(*COMMON_FC_BAUDS.last().unwrap()));
    }

    #[test]
    fn baud_fallback_declares_failure_only_after_all_candidates() {
        // Silent at every baud ⇒ ControllerNotResponding, but ONLY after the
        // whole candidate list is exhausted.
        let mut tried = 0usize;
        let report = run_passthrough_check_across_bauds(&COMMON_FC_BAUDS, |baud| {
            tried += 1;
            check_fake_at(baud, FakeFc::passthrough_silent())
        })
        .expect("every silent baud still yields a categorised report");
        assert_eq!(tried, COMMON_FC_BAUDS.len());
        assert_eq!(
            report.failure,
            Some(PassthroughFailure::ControllerNotResponding)
        );
    }

    #[test]
    fn baud_fallback_stops_at_the_first_handshaking_baud() {
        // A downstream (powered/wired/CRSF) verdict is baud-independent, so once
        // the FC handshakes the loop returns without trying more rates.
        let mut tried: Vec<u32> = Vec::new();
        let report = run_passthrough_check_across_bauds(&COMMON_FC_BAUDS, |baud| {
            tried.push(baud);
            check_fake_at(baud, FakeFc::passthrough_no_rx())
        })
        .expect("the first baud handshakes");
        assert_eq!(tried, vec![COMMON_FC_BAUDS[0]]);
        assert_eq!(report.failure, Some(PassthroughFailure::RxNotPowered));
    }

    #[test]
    fn baud_fallback_returns_none_when_no_candidate_is_selectable() {
        // If the handle refuses every candidate rate (closure returns None each
        // time), the discipline reports None so the caller can fall back — it never
        // fabricates a verdict for a baud it never actually ran.
        let mut tried = 0usize;
        let report = run_passthrough_check_across_bauds(&COMMON_FC_BAUDS, |_| {
            tried += 1;
            None
        });
        assert_eq!(tried, COMMON_FC_BAUDS.len());
        assert!(report.is_none());
    }

    #[test]
    fn report_serializes_camelcase_for_the_frontend() {
        let report = run_passthrough_check_stream(&mut FakeFc::passthrough_no_rx(), &FAST);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["failure"], "rxNotPowered");
        assert_eq!(json["steps"][0]["step"], "handshake");
        assert_eq!(json["steps"][0]["status"], "pass");
        assert_eq!(json["steps"][2]["step"], "receiver");
        assert_eq!(json["steps"][2]["status"], "fail");
    }
}
