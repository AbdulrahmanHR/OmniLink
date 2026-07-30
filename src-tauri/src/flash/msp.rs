//! MultiWii Serial Protocol (MSP v1) + Betaflight serial passthrough
//! (FR-FLASH-09a–d).
//!
//! To flash an ELRS receiver that is wired to a flight controller's UART, we
//! ask the FC (Betaflight/iNav) over MSP to drop into transparent serial
//! passthrough to that UART. After passthrough is enabled the same serial port
//! becomes a direct pipe to the receiver, and the normal UART uploader takes
//! over.
//!
//! This module implements the MSP v1 framing (encode request / decode reply +
//! checksum) and the `MSP_SET_PASSTHROUGH` request. The actual serial I/O and
//! the post-passthrough CRSF readiness probe live in
//! [`enable_passthrough_with_timeout`], which is parameterised over a
//! [`std::io::Read`] + [`std::io::Write`] so it is testable without a real FC.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::flash::{ErrorCategory, FlashError};

/// `MSP_SET_PASSTHROUGH` command id (Betaflight/iNav).
pub const MSP_SET_PASSTHROUGH: u8 = 245;

/// `MSP_SET_PASSTHROUGH` mode byte: "pipe the UART carrying serial function
/// `<argument>`" (Betaflight `MSP_PASSTHROUGH_SERIAL_FUNCTION_ID`, defined in
/// `src/main/msp/msp.c`; iNav has the same value in `src/main/fc/fc_msp.c`).
///
/// Emphatically NOT `0xFF`, which this app used to send. `0xFF` is
/// `MSP_PASSTHROUGH_ESC_4WAY`: the FC answers it with `esc4wayInit()` — which
/// calls `motorDisable()` and drives every enabled motor pin — and installs
/// `esc4wayProcess`, i.e. it takes over the motor outputs and connects the port
/// to the ESC bus instead of to the receiver's UART. It still acks, so the
/// handshake below read that as success and esptool then talked to the ESCs.
/// Betaflight also *defaults* to `0xFF` when the payload is empty, so the mode
/// byte can never be omitted either.
const MSP_PASSTHROUGH_SERIAL_FUNCTION_ID: u8 = 0xFE;

/// Argument for [`MSP_PASSTHROUGH_SERIAL_FUNCTION_ID`]: the UART configured as
/// Serial RX, which is the one an ELRS receiver is wired to.
///
/// A bit *index*, not the mask — the FC does
/// `findSerialPortConfig(1 << mspPassthroughArgument)`, and
/// `FUNCTION_RX_SERIAL = (1 << 6)` in `src/main/io/serial.h`. Sending the mask
/// `0x40` (the value that appears in a `functionMask`) would ask for `1 << 64`,
/// which matches no port and is answered with the "unavailable" `0` byte.
const FUNCTION_RX_SERIAL_BIT: u8 = 6;

/// FC handshake timeout (FR-FLASH-09c).
pub const FC_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Common FC CRSF baud rates to try / offer (FR-FLASH-09b). 420000 first.
pub const COMMON_FC_BAUDS: [u32; 4] = [420_000, 115_200, 230_400, 460_800];

/// Encode an MSP v1 *request* frame: `$M<` + len + cmd + payload + xor-crc.
pub fn encode_request(command: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(6 + payload.len());
    frame.extend_from_slice(b"$M<");
    let len = payload.len() as u8;
    frame.push(len);
    frame.push(command);
    frame.extend_from_slice(payload);
    let mut crc = len ^ command;
    for &b in payload {
        crc ^= b;
    }
    frame.push(crc);
    frame
}

/// Summary key for an FC that refused `MSP_SET_PASSTHROUGH` — either with an
/// MSP error frame or with the `0` ack byte (see
/// [`passthrough_ack_is_positive`]). Shared so [`crate::flash::engine`] can both
/// recognise the refusal (and stop sweeping bauds) and give it
/// configuration-specific recovery steps.
pub const PASSTHROUGH_UNAVAILABLE_KEY: &str = "passthroughUnavailable";

/// The `MSP_SET_PASSTHROUGH` request every passthrough surface sends.
///
/// ONE builder rather than a literal per call site: the mode byte decides
/// whether the FC pipes the port to the receiver's UART or takes over the motor
/// outputs, so the two senders (this module and
/// [`crate::flash::bridge::run_passthrough_check_stream`]) must not be able to
/// drift apart.
pub fn passthrough_request() -> Vec<u8> {
    encode_request(
        MSP_SET_PASSTHROUGH,
        &[MSP_PASSTHROUGH_SERIAL_FUNCTION_ID, FUNCTION_RX_SERIAL_BIT],
    )
}

/// Whether a `MSP_SET_PASSTHROUGH` reply is an actual acknowledgement.
///
/// The FC answers with ONE payload byte: `sbufWriteU8(dst, 1)` when it found the
/// UART and armed the passthrough, `sbufWriteU8(dst, 0)` when it did not (no
/// matching port, or a build without `USE_SERIAL_PASSTHROUGH`). The `0` arrives
/// as a perfectly ordinary `$M>` *success* frame, so checking only the frame
/// form reads "there is no passthrough-capable UART" as "passthrough enabled"
/// and hands the still-MSP port straight to esptool.
///
/// An ABSENT payload byte is deliberately not treated as a refusal: both
/// firmwares always write one, so an empty ack is an unknown dialect rather than
/// a known "no", and failing it here would report an FC-configuration fault we
/// were never actually told about.
pub fn passthrough_ack_is_positive(reply: &MspReply) -> bool {
    !reply.result_error && reply.payload.first() != Some(&0)
}

/// A decoded MSP v1 reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MspReply {
    pub command: u8,
    pub payload: Vec<u8>,
    /// The frame was the MSP v1 *error* form (`$M!`, Betaflight's
    /// `MSP_RESULT_ERROR`) rather than the success form (`$M>`): the FC
    /// understood the command and refused it. Callers that treat any framed
    /// reply as an ack MUST check this — a refusal is not an acknowledgement.
    pub result_error: bool,
}

/// Offset of the first MSP v1 reply header in `buf`, and whether it is the
/// error form.
///
/// MSP v1 answers `$M>` on success and `$M!` on `MSP_RESULT_ERROR` (Betaflight's
/// `mspSerialEncode`). Scanning only for `$M>` throws the refusal away as noise,
/// which is how an FC with no passthrough-capable UART used to look identical to
/// a silent one.
fn find_header(buf: &[u8]) -> Option<(usize, bool)> {
    buf.windows(3).enumerate().find_map(|(i, w)| match w {
        b"$M>" => Some((i, false)),
        b"$M!" => Some((i, true)),
        _ => None,
    })
}

/// Parse a single MSP v1 *reply* frame (`$M>` or `$M!`). Returns `None` if `buf`
/// does not yet contain a complete, checksum-valid frame.
pub fn parse_reply(buf: &[u8]) -> Option<MspReply> {
    // Find the reply header (skip leading noise).
    let (start, result_error) = find_header(buf)?;
    let rest = &buf[start + 3..];
    if rest.len() < 2 {
        return None;
    }
    let len = rest[0] as usize;
    let command = rest[1];
    // header-consumed + payload + crc
    if rest.len() < 2 + len + 1 {
        return None;
    }
    let payload = &rest[2..2 + len];
    let crc_pos = 2 + len;
    let mut crc = rest[0] ^ command;
    for &b in payload {
        crc ^= b;
    }
    if crc != rest[crc_pos] {
        return None;
    }
    Some(MspReply {
        command,
        payload: payload.to_vec(),
        result_error,
    })
}

/// Collect every checksum-valid MSP v1 reply frame in `buf`, resyncing past any
/// noise/incomplete frames between them. Extends the single-frame
/// [`parse_reply`], which locks onto the FIRST header and never advances — so a
/// corrupt or unrelated frame ahead of the one we want masks it forever.
///
/// Shared by the passthrough handshake here and by
/// [`crate::flash::bridge`], where one accumulated read buffer has to yield the
/// FC_VARIANT, API_VERSION and FC_VERSION replies a controller sends back
/// together.
pub fn collect_replies(buf: &[u8]) -> Vec<MspReply> {
    let mut out = Vec::new();
    let mut offset = 0;
    while offset + 3 <= buf.len() {
        match find_header(&buf[offset..]) {
            Some((pos, _)) => {
                let start = offset + pos;
                if let Some(reply) = parse_reply(&buf[start..]) {
                    // Frame = header(3) + len(1) + cmd(1) + payload + crc(1).
                    let frame_len = 6 + reply.payload.len();
                    out.push(reply);
                    offset = start + frame_len;
                } else {
                    // Header present but the frame is incomplete/corrupt here:
                    // skip past it and keep scanning for the next header.
                    offset = start + 3;
                }
            }
            None => break,
        }
    }
    out
}

/// Request Betaflight serial passthrough and wait for the FC to acknowledge
/// (FR-FLASH-09a/d). `port` must be opened at the FC's MSP baud by the caller.
///
/// Returns `Ok(())` once the FC replies to `MSP_SET_PASSTHROUGH`; the caller
/// then flashes the RX over the same port. On no reply within
/// [`FC_HANDSHAKE_TIMEOUT`] returns a wiring-categorised error with the
/// recovery hint key the UI expands (FR-FLASH-09c).
///
/// `timeout` bounds the handshake wait. The baud-fallback loop (FR-FLASH-09b)
/// tries each common baud in turn and so divides the overall
/// [`FC_HANDSHAKE_TIMEOUT`] budget across attempts instead of waiting the full
/// 10s per baud.
pub fn enable_passthrough_with_timeout<S: Read + Write>(
    port: &mut S,
    timeout: Duration,
) -> Result<(), FlashError> {
    let request = passthrough_request();
    port.write_all(&request).map_err(|e| {
        FlashError::new(
            ErrorCategory::Wiring,
            "fcWriteFailed",
            format!("failed to send MSP passthrough request: {e}"),
        )
    })?;
    let _ = port.flush();

    let deadline = Instant::now() + timeout;
    let mut acc = Vec::new();
    let mut chunk = [0u8; 64];
    while Instant::now() < deadline {
        match port.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                // Scan EVERY framed reply in the accumulator, not just the
                // first: `parse_reply` alone locks onto the leading header, so a
                // corrupt or unrelated frame arriving ahead of the ack masked it
                // for the whole attempt.
                if let Some(reply) = collect_replies(&acc)
                    .into_iter()
                    .find(|r| r.command == MSP_SET_PASSTHROUGH)
                {
                    return if passthrough_ack_is_positive(&reply) {
                        Ok(())
                    } else {
                        Err(passthrough_refused_error(&reply))
                    };
                }
            }
            // Read timeouts are expected; keep polling until the deadline.
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => {
                return Err(FlashError::new(
                    ErrorCategory::Wiring,
                    "fcReadFailed",
                    format!("error reading from flight controller: {e}"),
                ));
            }
        }
    }
    Err(FlashError::new(
        ErrorCategory::Wiring,
        "fcNotResponding",
        "flight controller did not respond to MSP passthrough in time",
    ))
}

/// The FC refused `MSP_SET_PASSTHROUGH`: it is reachable, it understood the
/// request, and it said no — either with an MSP v1 error frame (`$M!`) or with
/// the `0` ack byte (see [`passthrough_ack_is_positive`]).
///
/// That is an FC *configuration* problem — no UART is set to serial RX, or this
/// build has no passthrough support — so it must NOT be reported as the wiring
/// timeout a silent FC gets. "Check your cable" sends the user to re-seat a
/// cable that is working while the actual fix is in the Configurator.
fn passthrough_refused_error(reply: &MspReply) -> FlashError {
    let how = if reply.result_error {
        "an MSP error frame ($M!)"
    } else {
        "an ack whose payload byte is 0"
    };
    FlashError::new(
        ErrorCategory::FirmwareMismatch,
        PASSTHROUGH_UNAVAILABLE_KEY,
        format!(
            "the flight controller refused MSP_SET_PASSTHROUGH with {how} — no \
             passthrough-capable UART is configured, or this firmware does not support it"
        ),
    )
}

// ---------------------------------------------------------------------------
// Test support: an in-memory fake flight controller, shared across the MSP unit
// tests (M29) and the bridge-classification tests (M63). Hoisted to module
// scope (instead of living inside `mod tests`) and `pub(crate)` so the sibling
// `flash::bridge` test module can drive its read-only probe against the same
// fixtures.
// ---------------------------------------------------------------------------

/// Build a valid MSP v1 `$M>` *reply* frame (`$M>`+len+cmd+payload+xor-crc).
/// Test-only helper used to queue canned FC replies into [`FakeFc`].
#[cfg(test)]
pub(crate) fn build_reply(cmd: u8, payload: &[u8]) -> Vec<u8> {
    build_framed_reply(b'>', cmd, payload)
}

/// Build a valid MSP v1 **error** reply frame (`$M!`) — what Betaflight's
/// `mspSerialEncode` emits for `MSP_RESULT_ERROR`, i.e. an explicit refusal.
#[cfg(test)]
pub(crate) fn build_error_reply(cmd: u8, payload: &[u8]) -> Vec<u8> {
    build_framed_reply(b'!', cmd, payload)
}

#[cfg(test)]
fn build_framed_reply(direction: u8, cmd: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![b'$', b'M', direction];
    frame.push(payload.len() as u8);
    frame.push(cmd);
    frame.extend_from_slice(payload);
    let mut crc = payload.len() as u8 ^ cmd;
    for &b in payload {
        crc ^= b;
    }
    frame.push(crc);
    frame
}

/// Fake flight controller for MSP tests: feeds a canned reply byte stream and
/// captures everything written. Generic over [`Read`] + [`Write`] so it drives
/// both [`enable_passthrough_with_timeout`] (M29) and
/// [`crate::flash::bridge::probe_bridge_candidate`] (M63) without real hardware.
#[cfg(test)]
pub(crate) struct FakeFc {
    pub(crate) to_read: std::collections::VecDeque<u8>,
    pub(crate) written: Vec<u8>,
}

#[cfg(test)]
impl FakeFc {
    /// A FakeFc preloaded with raw bytes to feed back on read.
    pub(crate) fn from_bytes(bytes: impl IntoIterator<Item = u8>) -> Self {
        Self {
            to_read: bytes.into_iter().collect(),
            written: Vec::new(),
        }
    }

    /// Queue a valid FC_VARIANT reply carrying `variant`, plus best-effort
    /// API_VERSION + FC_VERSION replies, so the bridge probe can enrich the
    /// candidate with version fields (M63).
    fn with_variant(variant: &[u8; 4]) -> Self {
        use crate::flash::bridge::{MSP_API_VERSION, MSP_FC_VARIANT, MSP_FC_VERSION};
        let mut bytes = build_reply(MSP_FC_VARIANT, variant);
        // API_VERSION payload: [mspProtocolVersion, apiMajor, apiMinor].
        bytes.extend_from_slice(&build_reply(MSP_API_VERSION, &[1, 1, 46]));
        // FC_VERSION payload: [versionMajor, versionMinor, versionPatch].
        bytes.extend_from_slice(&build_reply(MSP_FC_VERSION, &[4, 5, 1]));
        Self::from_bytes(bytes)
    }

    /// Betaflight bridge fixture: a valid FC_VARIANT reply carrying `"BTFL"`.
    pub(crate) fn betaflight_bridge() -> Self {
        Self::with_variant(b"BTFL")
    }

    /// iNav bridge fixture: a valid FC_VARIANT reply carrying `"INAV"`.
    pub(crate) fn inav_bridge() -> Self {
        Self::with_variant(b"INAV")
    }

    /// Unsupported-bridge fixture: a valid FC_VARIANT reply with a 4-char id that
    /// is neither Betaflight nor iNav, so it is labeled "unsupported bridge"
    /// rather than misclassified (D28).
    pub(crate) fn unsupported_bridge() -> Self {
        use crate::flash::bridge::MSP_FC_VARIANT;
        Self::from_bytes(build_reply(MSP_FC_VARIANT, b"QUAD"))
    }

    /// Non-controller fixture (the ZERO-false-positive case): an ELRS RX speaking
    /// CRSF — bytes that never form a valid `$M>` MSP frame, so the classifier
    /// must conclude `NotAController`.
    pub(crate) fn non_controller() -> Self {
        // CRSF-ish: sync 0xC8, len, type 0x14 (link statistics), payload. Contains
        // no `$M>` header and no checksum-valid MSP frame.
        Self::from_bytes([0xC8, 0x18, 0x14, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55])
    }

    /// M65 read-only-context fixture: a Betaflight bridge that also answers the
    /// read-only `MSP_SERIAL_CONFIG` GET with two legacy 7-byte port records —
    /// UART1 as MSP (functionMask `0x0001`) and UART2 as serial RX (functionMask
    /// `0x0040`). Drives [`crate::flash::bridge::fetch_bridge_context`] end to end.
    pub(crate) fn bridge_with_serial_config() -> Self {
        use crate::flash::bridge::{
            MSP_API_VERSION, MSP_FC_VARIANT, MSP_FC_VERSION, MSP_SERIAL_CONFIG,
        };
        let mut bytes = build_reply(MSP_FC_VARIANT, b"BTFL");
        bytes.extend_from_slice(&build_reply(MSP_API_VERSION, &[1, 1, 46]));
        bytes.extend_from_slice(&build_reply(MSP_FC_VERSION, &[4, 5, 1]));
        // Two legacy port records: identifier(1) + functionMask(2 LE) + 4 baud idx.
        let serial_config: [u8; 14] = [
            0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, // UART1, MSP
            0x01, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, // UART2, serial RX
        ];
        bytes.extend_from_slice(&build_reply(MSP_SERIAL_CONFIG, &serial_config));
        Self::from_bytes(bytes)
    }

    // -- M64: passthrough-diagnostics fixtures (timeout / failure categories) --
    //
    // Each models one outcome of the guided passthrough check. A handshake-OK
    // preamble (one FC_VARIANT reply) is followed — for the cases that get past
    // step 1 — by an `MSP_SET_PASSTHROUGH` ack and then a post-passthrough RX
    // stream. All bytes are queued in wire order; the check's single accumulation
    // buffer consumes them across phases even under a greedy read.
    //
    // v2.2/M67 — "passthrough failure fixture capture": these five `passthrough_*`
    // constructors are the CANONICAL, reusable capture of every `PassthroughFailure`
    // variant (silent → ControllerNotResponding, refused → PassthroughUnavailable,
    // no_rx → RxNotPowered, wrong_uart → RxNotWired, rx_no_crsf → CrsfTimeout), plus
    // `passthrough_success`. `flash::bridge`'s
    // `captured_failure_fixture_set_covers_every_passthrough_failure` guards that the
    // set stays exhaustive — a new variant must add its fixture here.

    /// Shared preamble + optional ack + RX tail for the M64 fixtures.
    fn passthrough_stream(with_ack: bool, rx_tail: &[u8]) -> Self {
        use crate::flash::bridge::MSP_FC_VARIANT;
        // Handshake: a valid FC_VARIANT reply proves MSP is reachable.
        let mut bytes = build_reply(MSP_FC_VARIANT, b"BTFL");
        if with_ack {
            // Empty-payload MSP_SET_PASSTHROUGH ack, as a real FC sends.
            bytes.extend_from_slice(&build_reply(MSP_SET_PASSTHROUGH, &[]));
        }
        bytes.extend_from_slice(rx_tail);
        Self::from_bytes(bytes)
    }

    /// Silent FC — no MSP reply at all ⇒ `ControllerNotResponding` (and the
    /// bounded-timeout case).
    pub(crate) fn passthrough_silent() -> Self {
        Self::from_bytes([])
    }

    /// FC handshakes but never acks `MSP_SET_PASSTHROUGH` ⇒ `PassthroughUnavailable`.
    pub(crate) fn passthrough_refused() -> Self {
        Self::passthrough_stream(false, &[])
    }

    /// Passthrough ok but the RX sends nothing back ⇒ `RxNotPowered`.
    pub(crate) fn passthrough_no_rx() -> Self {
        Self::passthrough_stream(true, &[])
    }

    /// Passthrough ok, bytes come back but NONE are CRSF-shaped (echo / wrong
    /// UART) ⇒ `RxNotWired`.
    pub(crate) fn passthrough_wrong_uart() -> Self {
        Self::passthrough_stream(true, &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66])
    }

    /// Passthrough ok, CRSF-shaped bytes flow but no frame ever passes CRC
    /// before the deadline ⇒ `CrsfTimeout`. The tail looks like a CRSF Link
    /// Statistics frame (sync 0xC8, len 0x0C, type 0x14) with a deliberately
    /// wrong CRC, so the CRSF parser resyncs forever and never yields a frame.
    pub(crate) fn passthrough_rx_no_crsf() -> Self {
        Self::passthrough_stream(
            true,
            &[0xC8, 0x0C, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00],
        )
    }

    /// Full happy path: handshake + ack + a VALID CRSF Link Statistics frame ⇒
    /// all four steps pass. (The frame bytes are the CRC-valid vector used by the
    /// `crsf` parser tests.)
    pub(crate) fn passthrough_success() -> Self {
        Self::passthrough_stream(
            true,
            &[
                0xC8, 0x0C, 0x14, 0x46, 0x50, 0x64, 0x08, 0x00, 0x02, 0x03, 0x3C, 0x63, 0xFB, 0xCD,
            ],
        )
    }
}

#[cfg(test)]
impl Read for FakeFc {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.to_read.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no data"));
        }
        let mut n = 0;
        while n < buf.len() {
            match self.to_read.pop_front() {
                Some(b) => {
                    buf[n] = b;
                    n += 1;
                }
                None => break,
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
impl Write for FakeFc {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.written.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn encodes_request_with_correct_crc() {
        let frame = encode_request(MSP_SET_PASSTHROUGH, &[0xFF, 0x00]);
        assert_eq!(&frame[..3], b"$M<");
        assert_eq!(frame[3], 2); // payload len
        assert_eq!(frame[4], MSP_SET_PASSTHROUGH);
        assert_eq!(&frame[5..7], &[0xFF, 0x00]);
        // crc = len ^ cmd ^ payload
        let expected = 2u8 ^ MSP_SET_PASSTHROUGH ^ 0xFF;
        assert_eq!(*frame.last().unwrap(), expected);
    }

    #[test]
    fn parse_reply_roundtrips_a_crafted_frame() {
        // Build a reply frame by hand: $M> len cmd payload crc.
        let cmd = MSP_SET_PASSTHROUGH;
        let payload = [0x01u8, 0x02];
        let mut frame = b"$M>".to_vec();
        frame.push(payload.len() as u8);
        frame.push(cmd);
        frame.extend_from_slice(&payload);
        let mut crc = payload.len() as u8 ^ cmd;
        for &b in &payload {
            crc ^= b;
        }
        frame.push(crc);

        let reply = parse_reply(&frame).unwrap();
        assert_eq!(reply.command, cmd);
        assert_eq!(reply.payload, payload);
    }

    #[test]
    fn parse_reply_rejects_bad_crc_and_partial() {
        let mut frame = b"$M>".to_vec();
        frame.extend_from_slice(&[0x00, MSP_SET_PASSTHROUGH, 0xEE]); // wrong crc
        assert!(parse_reply(&frame).is_none());
        // Truncated frame.
        assert!(parse_reply(b"$M>\x02").is_none());
    }

    #[test]
    fn parse_reply_resyncs_past_leading_noise() {
        // M29: a serial line routinely carries boot chatter / partial bytes before
        // the reply header. The `$M>` window scan must skip that noise and still
        // return the framed reply (resync), not give up at byte 0.
        let frame = build_reply(MSP_SET_PASSTHROUGH, &[0xAA, 0xBB]);
        let mut buf = b"\x00\x11boot garbage".to_vec(); // no "$M>" in here
        buf.extend_from_slice(&frame);
        let reply = parse_reply(&buf).expect("resyncs past leading noise");
        assert_eq!(reply.command, MSP_SET_PASSTHROUGH);
        assert_eq!(reply.payload, vec![0xAA, 0xBB]);
    }

    #[test]
    fn parse_reply_completes_across_a_growing_buffer() {
        // M29 partial-buffer edge: header+len+cmd present but the payload/CRC have
        // not arrived yet ⇒ None (wait for more); once the tail lands the SAME
        // bytes parse to the frame. Models the accumulate-then-parse read loop.
        let full = build_reply(MSP_SET_PASSTHROUGH, &[0x01, 0x02]);
        assert!(
            parse_reply(&full[..full.len() - 1]).is_none(),
            "a frame missing its CRC byte must not parse yet"
        );
        assert_eq!(parse_reply(&full).unwrap().payload, vec![0x01, 0x02]);
    }

    #[test]
    fn enable_passthrough_accepts_ack_after_leading_noise() {
        // End-to-end: the FC prefixes its ack with junk bytes. The handshake must
        // still recognise the ack (via the resyncing parser) and succeed.
        let mut stream = b"\x00\xFFnoise".to_vec(); // junk, contains no "$M>"
        stream.extend_from_slice(&build_reply(MSP_SET_PASSTHROUGH, &[]));
        let mut fc = FakeFc {
            to_read: stream.into_iter().collect(),
            written: Vec::new(),
        };
        assert!(enable_passthrough_with_timeout(&mut fc, FC_HANDSHAKE_TIMEOUT).is_ok());
    }

    #[test]
    fn enable_passthrough_succeeds_on_ack() {
        // Canned ack reply.
        let mut reply = b"$M>".to_vec();
        reply.push(0); // len
        reply.push(MSP_SET_PASSTHROUGH);
        reply.push(MSP_SET_PASSTHROUGH);
        let mut fc = FakeFc {
            to_read: reply.into_iter().collect(),
            written: Vec::new(),
        };
        assert!(enable_passthrough_with_timeout(&mut fc, FC_HANDSHAKE_TIMEOUT).is_ok());
        // We actually sent the passthrough request.
        assert_eq!(&fc.written[..3], b"$M<");
        assert_eq!(fc.written[4], MSP_SET_PASSTHROUGH);
    }

    #[test]
    fn parse_reply_decodes_the_error_form_and_flags_it() {
        // MSP v1 signals failure with `$M!` (Betaflight `MSP_RESULT_ERROR`).
        // Scanning only for `$M>` threw the refusal away as noise.
        let frame = build_error_reply(MSP_SET_PASSTHROUGH, &[]);
        let reply = parse_reply(&frame).expect("an error frame is still a framed reply");
        assert_eq!(reply.command, MSP_SET_PASSTHROUGH);
        assert!(reply.result_error, "`$M!` must be flagged as a refusal");
        // …and the success form stays unflagged.
        assert!(
            !parse_reply(&build_reply(MSP_SET_PASSTHROUGH, &[]))
                .unwrap()
                .result_error
        );
    }

    #[test]
    fn collect_replies_resyncs_past_a_corrupt_leading_frame() {
        // The defect this fixes: `parse_reply` locks onto the FIRST header and
        // never advances, so a corrupt frame ahead of the real ack masks it for
        // the whole attempt. `collect_replies` must skip it and still find both
        // frames behind it.
        let mut buf = b"$M>\x02\x63\xAA\xBB\x00".to_vec(); // header, wrong CRC
        buf.extend_from_slice(&build_reply(MSP_FC_VARIANT_FOR_TEST, b"BTFL"));
        buf.extend_from_slice(&build_reply(MSP_SET_PASSTHROUGH, &[]));
        let replies = collect_replies(&buf);
        assert_eq!(
            replies.len(),
            2,
            "the corrupt lead frame must not stop the scan"
        );
        assert_eq!(replies[0].payload, b"BTFL");
        assert_eq!(replies[1].command, MSP_SET_PASSTHROUGH);
    }

    /// `MSP_FC_VARIANT`, re-declared here so the framing tests do not depend on
    /// the bridge module's command table.
    const MSP_FC_VARIANT_FOR_TEST: u8 = 2;

    #[test]
    fn enable_passthrough_finds_the_ack_behind_a_non_ack_frame() {
        // Resync end-to-end: the FC sends an unrelated (or corrupt) framed reply
        // before the ack. With the single-frame parser the handshake sat on the
        // first frame and timed out; it must now read past it.
        let mut stream = b"$M>\x02\x63\xAA\xBB\x00".to_vec(); // corrupt frame
        stream.extend_from_slice(&build_reply(MSP_FC_VARIANT_FOR_TEST, b"BTFL"));
        stream.extend_from_slice(&build_reply(MSP_SET_PASSTHROUGH, &[]));
        let mut fc = FakeFc::from_bytes(stream);
        assert!(enable_passthrough_with_timeout(&mut fc, Duration::from_millis(200)).is_ok());
    }

    #[test]
    fn an_msp_error_reply_is_a_configuration_failure_not_a_wiring_timeout() {
        // An FC with no passthrough-capable UART answers `$M!`. That used to be
        // discarded, so the handshake burned its whole budget and reported
        // `Wiring`/`fcNotResponding` — "check your cable" for a pure FC-config
        // problem. It must now fail FAST and in the right category.
        let mut fc = FakeFc::from_bytes(build_error_reply(MSP_SET_PASSTHROUGH, &[]));
        let started = Instant::now();
        let err = enable_passthrough_with_timeout(&mut fc, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, PASSTHROUGH_UNAVAILABLE_KEY);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "an explicit refusal must not wait out the timeout"
        );
    }

    #[test]
    fn enable_passthrough_times_out_when_fc_silent() {
        // No data to read -> the FC never acks. With a short per-attempt timeout
        // (as used by the baud-fallback loop) we give up promptly with a wiring
        // error rather than blocking the full handshake budget.
        let mut fc = FakeFc {
            to_read: VecDeque::new(),
            written: Vec::new(),
        };
        let started = Instant::now();
        let err = enable_passthrough_with_timeout(&mut fc, Duration::from_millis(50)).unwrap_err();
        assert_eq!(err.category, ErrorCategory::Wiring);
        assert_eq!(err.summary_key, "fcNotResponding");
        // Honoured the short timeout instead of the 10s default.
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn the_passthrough_request_asks_for_the_serial_rx_uart_and_never_esc_4way() {
        // FIX 9H. Verified against Betaflight `src/main/msp/msp.c`:
        //
        //   MSP_PASSTHROUGH_SERIAL_ID = 0xFD,
        //   MSP_PASSTHROUGH_SERIAL_FUNCTION_ID = 0xFE,
        //   MSP_PASSTHROUGH_ESC_4WAY = 0xFF,
        //
        // and `findSerialPortConfig(1 << mspPassthroughArgument)` for the
        // FUNCTION form, with `FUNCTION_RX_SERIAL = (1 << 6)` in
        // `src/main/io/serial.h` (iNav's `src/main/fc/fc_msp.c` is identical).
        // This app used to send `0xFF` — ESC 4-way — which the FC answers by
        // calling `esc4wayInit()` (`motorDisable()`, then every enabled motor
        // pin driven high) and wiring the port to the ESC bus, while still
        // acking. esptool would then have been talking to the ESCs.
        let frame = passthrough_request();
        assert_eq!(&frame[..3], b"$M<");
        assert_eq!(frame[3], 2, "mode + argument");
        assert_eq!(frame[4], MSP_SET_PASSTHROUGH);
        assert_eq!(
            frame[5], 0xFE,
            "mode must be MSP_PASSTHROUGH_SERIAL_FUNCTION_ID, NOT 0xFF (ESC 4-way)"
        );
        assert_eq!(
            frame[6], 6,
            "the argument is the BIT INDEX the FC shifts (1 << arg), not the 0x40 mask"
        );
        // An empty payload is not an option either: Betaflight's "legacy format"
        // branch defaults `mspPassthroughMode` to `MSP_PASSTHROUGH_ESC_4WAY`.
        assert!(!frame[3..].is_empty());
    }

    #[test]
    fn an_ack_whose_payload_byte_is_zero_is_a_refusal_not_a_success() {
        // FIX 9H, the other half: the FC answers this command with ONE payload
        // byte — `sbufWriteU8(dst, 1)` when it found the UART and armed the
        // passthrough, `sbufWriteU8(dst, 0)` when it did not (no matching port,
        // or a build without `USE_SERIAL_PASSTHROUGH`, which falls to the
        // `default:` arm). The `0` arrives as an ordinary `$M>` SUCCESS frame,
        // so checking only the frame form read "there is no passthrough-capable
        // UART" as "passthrough enabled" and handed the still-MSP port to
        // esptool.
        let mut fc = FakeFc::from_bytes(build_reply(MSP_SET_PASSTHROUGH, &[0]));
        let started = Instant::now();
        let err = enable_passthrough_with_timeout(&mut fc, Duration::from_secs(5)).unwrap_err();
        assert_eq!(err.category, ErrorCategory::FirmwareMismatch);
        assert_eq!(err.summary_key, PASSTHROUGH_UNAVAILABLE_KEY);
        assert!(
            err.detail.contains("payload byte is 0"),
            "the two refusal forms must stay distinguishable in the log: {}",
            err.detail
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "an explicit refusal must not wait out the timeout"
        );

        // The positive byte is what a real armed passthrough sends.
        let mut fc = FakeFc::from_bytes(build_reply(MSP_SET_PASSTHROUGH, &[1]));
        assert!(enable_passthrough_with_timeout(&mut fc, Duration::from_secs(5)).is_ok());

        // An ABSENT byte stays a success: both firmwares always write one, so an
        // empty ack is an unknown dialect rather than a known "no", and failing
        // it would report an FC-configuration fault we were never told about.
        assert!(passthrough_ack_is_positive(
            &parse_reply(&build_reply(MSP_SET_PASSTHROUGH, &[])).unwrap()
        ));
        // An `$M!` error frame is a refusal whatever it carries.
        assert!(!passthrough_ack_is_positive(
            &parse_reply(&build_error_reply(MSP_SET_PASSTHROUGH, &[1])).unwrap()
        ));
    }
}
