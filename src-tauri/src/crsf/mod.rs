//! CRSF protocol parser.
//!
//! Implements the CrossFire Serial Protocol (CRSF) state machine used by
//! ExpressLRS / TBS Crossfire hardware. Per `docs/CRSF_PROTOCOL.md`.
//!
//! M6 scope: byte-fed sync/length/type/CRC8 framing plus decoding of
//! **Link Statistics** (0x14) and **Device Info** (0x29) frames. M7-API
//! (telemetry) builds on top of [`LinkStatistics`].
//!
//! This module is intentionally dependency-free (`std` only) so the framing
//! and CRC logic can be unit-tested in isolation, independent of the Tauri /
//! serialport build.
//!
//! # Frame layout
//!
//! Every CRSF frame on the wire looks like:
//!
//! ```text
//! +---------+--------+--------+--------------------+--------+
//! | sync/   | length |  type  |     payload        |  crc8  |
//! | address | (u8)   | (u8)   |  (length-2 bytes)  | (u8)   |
//! +---------+--------+--------+--------------------+--------+
//!   byte 0    byte 1   byte 2   byte 3 ..            last
//! ```
//!
//! * **sync/address** — the destination address of the frame. Common values:
//!   `0xC8` flight-controller, `0xEA` radio/handset, `0xEE` TX module,
//!   `0xEC` receiver. We accept any byte here and rely on the length + CRC
//!   check to validate, resyncing one byte at a time on failure.
//! * **length** — number of bytes that follow the length field itself, i.e.
//!   `type (1) + payload + crc (1)`. Total frame size on the wire is
//!   `length + 2`. Valid range is `2..=62`.
//! * **type** — frame type identifier (see [`frame_type`]).
//! * **crc8** — CRC-8/DVB-S2 (polynomial `0xD5`, init `0x00`) computed over
//!   the bytes from `type` through the end of the payload (i.e. everything
//!   between the length field and the CRC byte itself).
//!
//! ## Extended frames
//!
//! Frame types `>= 0x28` are "extended" and carry two extra address bytes —
//! `destination` then `origin` — immediately after the type byte and before
//! the type-specific payload. Device Info (0x29) is an extended frame; we use
//! the `origin` address to classify the device as TX or RX.

/// CRSF frame type identifiers we care about (subset).
#[allow(dead_code)] // documentary constants; not all are referenced internally
pub mod frame_type {
    /// GPS telemetry (lat, lon, ground speed, heading, altitude, satellites).
    /// Not extended. Big-endian payload. See [`super::decode_gps`].
    pub const GPS: u8 = 0x02;
    /// Link statistics (uplink/downlink RSSI, LQ, SNR, power). Not extended.
    pub const LINK_STATISTICS: u8 = 0x14;
    /// Device ping — request a Device Info reply. Extended frame.
    pub const DEVICE_PING: u8 = 0x28;
    /// Device information (target name, versions). Extended frame.
    pub const DEVICE_INFO: u8 = 0x29;
    /// Parameter settings entry — a device's reply to a Parameter Read,
    /// carrying one configuration field (name, type, value). Extended,
    /// potentially chunked. See [`super::decode_param_entry`].
    pub const PARAM_ENTRY: u8 = 0x2B;
    /// Parameter settings read — request a single config field (by index +
    /// chunk) from a device. Extended. See [`super::param_read_frame`].
    pub const PARAM_READ: u8 = 0x2C;
    /// First extended frame type — types at or above `0x28` carry a
    /// `dest`/`origin` extended header before their payload.
    pub const EXTENDED_THRESHOLD: u8 = 0x28;
}

/// Well-known CRSF device addresses.
#[allow(dead_code)] // documentary constants; not all are referenced internally
pub mod address {
    pub const BROADCAST: u8 = 0x00;
    pub const FLIGHT_CONTROLLER: u8 = 0xC8;
    pub const RADIO_TRANSMITTER: u8 = 0xEA;
    /// ExpressLRS TX module.
    pub const CRSF_TRANSMITTER: u8 = 0xEE;
    /// ExpressLRS receiver.
    pub const CRSF_RECEIVER: u8 = 0xEC;
    /// ELRS Lua / configurator endpoint. Some firmware services its parameter
    /// and device-info subsystem keyed to this address and ignores a plain
    /// broadcast ping, so it's worth presenting as an origin during discovery.
    pub const ELRS_LUA: u8 = 0xEF;
}

/// Smallest legal value of the length byte (`type + crc`, empty payload).
const MIN_LENGTH: u8 = 2;
/// Largest legal value of the length byte per the CRSF spec.
const MAX_LENGTH: u8 = 62;

/// Compute CRC-8/DVB-S2 (poly `0xD5`, init `0x00`) over `data`.
///
/// This is the CRC used by CRSF over `[type, payload...]`.
pub fn crc8(data: &[u8]) -> u8 {
    let mut crc: u8 = 0;
    for &byte in data {
        crc ^= byte;
        for _ in 0..8 {
            if crc & 0x80 != 0 {
                crc = (crc << 1) ^ 0xD5;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

/// Build a CRSF **Device Ping** frame (extended type `0x28`, broadcast dest).
///
/// The host transmits this to actively elicit a [`DeviceInfo`] (`0x29`) reply
/// from a connected module/receiver — an idle ELRS device emits nothing until
/// pinged. `origin` is the address we present ourselves as; ELRS modules expect
/// a configurator to use [`address::RADIO_TRANSMITTER`] (`0xEA`, a handset).
///
/// The CRC is computed here from the actual bytes, so callers that change the
/// origin can't accidentally ship a stale/wrong CRC.
///
/// Layout: `[sync 0xC8][len 0x04][type 0x28][dest 0x00][origin][crc8]`.
// Convenience wrapper; the live probe drives `device_ping_to` directly to cycle
// dest/origin variants, so the broadcast-only form is currently test-only.
#[allow(dead_code)]
pub fn device_ping(origin: u8) -> Vec<u8> {
    device_ping_to(address::BROADCAST, origin)
}

/// Build a CRSF **Device Ping** addressed to a specific `dest`.
///
/// Like [`device_ping`] but lets the caller target a particular device address
/// (e.g. [`address::CRSF_TRANSMITTER`] / [`address::CRSF_RECEIVER`]) instead of
/// broadcasting. Some firmware that ignores a broadcast ping will answer a
/// directly-addressed one, so discovery cycles through several dest/origin
/// pairs. The CRC is computed from the actual bytes.
///
/// Layout: `[sync 0xC8][len 0x04][type 0x28][dest][origin][crc8]`.
pub fn device_ping_to(dest: u8, origin: u8) -> Vec<u8> {
    let mut frame = vec![
        address::FLIGHT_CONTROLLER, // sync byte
        0x04,                       // len: type + dest + origin + crc
        frame_type::DEVICE_PING,
        dest,
        origin,
    ];
    let crc = crc8(&frame[2..]);
    frame.push(crc);
    frame
}

/// Build a CRSF **Parameter Read** frame (extended type `0x2C`).
///
/// Requests configuration field `field_index` (1-based; field 0 is the device
/// root) chunk `chunk_index` from the device at `dest`, with the reply addressed
/// back to `origin`. The device answers with one or more [`frame_type::PARAM_ENTRY`]
/// (`0x2B`) frames — see [`decode_param_entry`].
///
/// Layout: `[sync 0xC8][len 0x06][type 0x2C][dest][origin][field][chunk][crc8]`.
// Tested config-read primitive; the live connect flow doesn't yet drive a full
// parameter walk (see the note in `commands::device`), so allow it unused.
#[allow(dead_code)]
pub fn param_read_frame(dest: u8, origin: u8, field_index: u8, chunk_index: u8) -> Vec<u8> {
    let mut frame = vec![
        address::FLIGHT_CONTROLLER, // sync byte
        0x06,                       // len: type + dest + origin + field + chunk + crc
        frame_type::PARAM_READ,
        dest,
        origin,
        field_index,
        chunk_index,
    ];
    let crc = crc8(&frame[2..]);
    frame.push(crc);
    frame
}

/// One configuration field from a [`frame_type::PARAM_ENTRY`] (`0x2B`) reply.
///
/// NOTE — chunking: a real entry may be split across multiple `0x2B` frames
/// when its payload exceeds one CRSF frame. Only the *first* chunk carries the
/// `parent`/`data_type`/`name` header; `chunks_remaining > 0` means more chunks
/// follow and must be concatenated (after the 4-byte `[dest][origin][field]
/// [chunks_remaining]` prefix of each) before [`name`](Self::name)/`value` are
/// complete. This decoder handles the common single-chunk case; full multi-chunk
/// reassembly + per-`data_type` value parsing is the remaining work for a full
/// config read (see the note in `commands::device`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // tested config-read scaffold; not yet driven by the live flow
pub struct ParamEntry {
    pub destination: u8,
    pub origin: u8,
    /// 1-based field index this entry describes.
    pub field_index: u8,
    /// Chunks still to come after this one (`0` = this is the last/only chunk).
    pub chunks_remaining: u8,
    /// Parent folder field index (`0` = top level).
    pub parent: u8,
    /// CRSF parameter data type (UINT8, TEXT_SELECTION, STRING, FOLDER, …).
    pub data_type: u8,
    /// Null-terminated display name of the field.
    pub name: String,
    /// Type-specific value bytes following the name. Interpretation depends on
    /// `data_type` and is intentionally left raw here.
    pub value: Vec<u8>,
}

/// Decode a single (complete) Parameter Entry payload. The payload here already
/// excludes the type byte but begins with the extended header (`dest`,`origin`).
///
/// Returns `None` for a chunk that is too short to contain the fixed header +
/// a name terminator. See [`ParamEntry`] for the multi-chunk caveat.
#[allow(dead_code)] // tested config-read scaffold; not yet driven by the live flow
pub fn decode_param_entry(payload: &[u8]) -> Option<ParamEntry> {
    // dest + origin + field + chunks_remaining + parent + data_type = 6 bytes.
    if payload.len() < 6 {
        return None;
    }
    let destination = payload[0];
    let origin = payload[1];
    let field_index = payload[2];
    let chunks_remaining = payload[3];
    let parent = payload[4];
    let data_type = payload[5];

    let rest = &payload[6..];
    let name_end = rest.iter().position(|&b| b == 0)?;
    let name = String::from_utf8_lossy(&rest[..name_end]).into_owned();
    let value = rest[name_end + 1..].to_vec();

    Some(ParamEntry {
        destination,
        origin,
        field_index,
        chunks_remaining,
        parent,
        data_type,
        name,
        value,
    })
}

/// Decoded Link Statistics (frame type `0x14`).
///
/// Field semantics follow the CRSF spec. RSSI values are reported on the wire
/// as a positive magnitude (the dBm value is the negation), so a wire value of
/// `70` means `-70 dBm`. We keep the raw spec representation here and let the
/// presentation layer (M7-API telemetry) apply sign/labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkStatistics {
    /// Uplink RSSI, antenna 1 (positive magnitude, i.e. `-value` dBm).
    pub uplink_rssi_1: u8,
    /// Uplink RSSI, antenna 2 (positive magnitude).
    pub uplink_rssi_2: u8,
    /// Uplink link quality, percent (0..=100).
    pub uplink_link_quality: u8,
    /// Uplink SNR, dB (signed).
    pub uplink_snr: i8,
    /// Active antenna index (0 or 1).
    pub active_antenna: u8,
    /// RF mode / packet-rate index.
    pub rf_mode: u8,
    /// Uplink TX power index (maps to mW per the ELRS power table).
    pub uplink_tx_power: u8,
    /// Downlink RSSI (positive magnitude).
    pub downlink_rssi: u8,
    /// Downlink link quality, percent.
    pub downlink_link_quality: u8,
    /// Downlink SNR, dB (signed).
    pub downlink_snr: i8,
}

/// Decoded GPS telemetry (frame type `0x02`, big-endian).
///
/// Fields are kept in their raw on-the-wire (scaled-integer) representation,
/// exactly as in [`LinkStatistics`]; the presentation layer
/// (`src/lib/telemetry-crsf.ts`) applies the scaling/offsets below to obtain
/// human units. Per `docs/CRSF_PROTOCOL.md` §5.3:
///
/// * `latitude` / `longitude` — degrees × 1e7 (signed).
/// * `ground_speed` — km/h × 10.
/// * `heading` — degrees × 100.
/// * `altitude` — metres with a **+1000 m** bias (i.e. real metres =
///   `altitude as i32 - 1000`).
/// * `satellites` — satellite count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpsData {
    /// Latitude, degrees × 1e7 (signed).
    pub latitude: i32,
    /// Longitude, degrees × 1e7 (signed).
    pub longitude: i32,
    /// Ground speed, km/h × 10.
    pub ground_speed: u16,
    /// Heading, degrees × 100.
    pub heading: u16,
    /// Altitude in metres, offset by +1000 (real metres = value − 1000).
    pub altitude: u16,
    /// Number of satellites in the GPS fix.
    pub satellites: u8,
}

/// Decoded Device Info (frame type `0x29`, extended).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    /// Destination address from the extended header.
    pub destination: u8,
    /// Origin address from the extended header — identifies the sender
    /// (e.g. `0xEE` TX module, `0xEC` receiver).
    pub origin: u8,
    /// Null-terminated device / target name (e.g. `"BetaFPV Nano TX"`).
    pub name: String,
    /// Serial number (big-endian u32).
    pub serial_number: u32,
    /// Hardware version (big-endian u32).
    pub hardware_version: u32,
    /// Raw firmware/software version word (big-endian u32). ExpressLRS packs
    /// the semantic version into the low three bytes as `major.minor.patch`;
    /// see [`DeviceInfo::firmware_version`].
    pub firmware_version_raw: u32,
    /// Number of configuration parameters/fields exposed by the device.
    pub field_count: u8,
    /// Parameter protocol version.
    pub parameter_version: u8,
}

impl DeviceInfo {
    /// Decode the ExpressLRS semantic firmware version as `"major.minor.patch"`,
    /// or `None` when the device reported no version at all.
    ///
    /// ELRS encodes the version in the firmware word's low three bytes:
    /// `0x00MMmmpp` → `MM.mm.pp`.
    ///
    /// An all-zero word is ABSENCE, not version 0.0.0: Betaflight's
    /// `crsfFrameDeviceInfo` answers `DEVICE_PING` on the very RX↔FC CRSF UART
    /// the app tells the user to wire up, and writes an all-zero
    /// serial/hardware/firmware triple. Formatting that unconditionally
    /// announced a concrete `v0.0.0` — which the UI renders as fact and the
    /// profile-import compat check treats as a real (permanently mismatched)
    /// version. Same "unknown stays null" discipline as
    /// [`DeviceInfo::is_transmitter`].
    pub fn firmware_version(&self) -> Option<String> {
        if self.firmware_version_raw == 0 {
            return None;
        }
        let major = (self.firmware_version_raw >> 16) & 0xFF;
        let minor = (self.firmware_version_raw >> 8) & 0xFF;
        let patch = self.firmware_version_raw & 0xFF;
        Some(format!("{major}.{minor}.{patch}"))
    }

    /// Best-effort TX vs RX classification from the `origin` address.
    ///
    /// Returns `Some(true)` for a transmitter, `Some(false)` for a receiver,
    /// and `None` when the address is ambiguous.
    pub fn is_transmitter(&self) -> Option<bool> {
        match self.origin {
            address::CRSF_TRANSMITTER | address::RADIO_TRANSMITTER => Some(true),
            address::CRSF_RECEIVER => Some(false),
            // Flight-controller address implies the link's RX side.
            address::FLIGHT_CONTROLLER => Some(false),
            _ => None,
        }
    }
}

/// A successfully decoded CRSF frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// GPS telemetry (lat/lon/speed/heading/altitude/satellites).
    Gps(GpsData),
    /// Link statistics (telemetry foundation for M7-API).
    LinkStatistics(LinkStatistics),
    /// Device information (handshake target name + firmware).
    DeviceInfo(DeviceInfo),
    /// A valid (CRC-checked) frame we don't specifically decode. Carries the
    /// type byte and the raw payload (everything between type and CRC).
    Other { frame_type: u8, payload: Vec<u8> },
}

/// Byte-fed CRSF framing state machine.
///
/// Push raw serial bytes with [`Parser::feed`]; it returns every complete,
/// CRC-valid frame found so far. Partial frames are buffered across calls, and
/// the parser resynchronises one byte at a time on a bad length or CRC so a
/// mid-stream connection (the common case) recovers cleanly.
#[derive(Debug, Default)]
pub struct Parser {
    buffer: Vec<u8>,
}

impl Parser {
    /// Create an empty parser.
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    /// Feed bytes into the parser, returning any frames that completed.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Frame> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();

        loop {
            // Need at least address + length to make a decision.
            if self.buffer.len() < 2 {
                break;
            }

            let length = self.buffer[1];

            // Invalid length byte → not a frame boundary; drop one byte and
            // try to resync on the next candidate address.
            if !(MIN_LENGTH..=MAX_LENGTH).contains(&length) {
                self.buffer.remove(0);
                continue;
            }

            let total = length as usize + 2; // address + length + (length bytes)
            if self.buffer.len() < total {
                // Wait for the rest of the frame.
                break;
            }

            // CRC covers type..=last payload byte: buffer[2 .. total-1].
            let crc_calc = crc8(&self.buffer[2..total - 1]);
            let crc_frame = self.buffer[total - 1];
            if crc_calc != crc_frame {
                // Corrupt / misaligned — resync by one byte.
                self.buffer.remove(0);
                continue;
            }

            let frame_type = self.buffer[2];
            // Payload is everything between the type byte and the CRC.
            let payload = self.buffer[3..total - 1].to_vec();

            if let Some(frame) = decode_frame(frame_type, &payload) {
                frames.push(frame);
            }

            // Consume the frame.
            self.buffer.drain(0..total);
        }

        frames
    }

    /// Discard any buffered partial data (e.g. on reconnect).
    #[allow(dead_code)] // public reset API; used by the reader loop on reconnect paths
    pub fn reset(&mut self) {
        self.buffer.clear();
    }
}

/// Decode a CRC-validated frame body into a [`Frame`].
fn decode_frame(frame_type: u8, payload: &[u8]) -> Option<Frame> {
    match frame_type {
        frame_type::GPS => {
            let decoded = decode_gps(payload).map(Frame::Gps);
            if decoded.is_none() {
                tracing::warn!(
                    target: "crsf",
                    "valid-CRC GPS frame with undecodable {}-byte payload, dropping",
                    payload.len()
                );
            }
            decoded
        }
        frame_type::LINK_STATISTICS => {
            let decoded = decode_link_statistics(payload).map(Frame::LinkStatistics);
            if decoded.is_none() {
                // CRC was valid but the payload is too short to decode. Without
                // this it would be dropped with no trace; log so a truncated /
                // out-of-spec stream is diagnosable rather than silently lossy.
                tracing::warn!(
                    target: "crsf",
                    "valid-CRC Link Statistics frame with undecodable {}-byte payload, dropping",
                    payload.len()
                );
            }
            decoded
        }
        frame_type::DEVICE_INFO => {
            let decoded = decode_device_info(payload).map(Frame::DeviceInfo);
            if decoded.is_none() {
                tracing::warn!(
                    target: "crsf",
                    "valid-CRC Device Info frame with undecodable {}-byte payload, dropping",
                    payload.len()
                );
            }
            decoded
        }
        other => Some(Frame::Other {
            frame_type: other,
            payload: payload.to_vec(),
        }),
    }
}

/// Decode a Link Statistics payload (10 bytes, no extended header).
fn decode_link_statistics(payload: &[u8]) -> Option<LinkStatistics> {
    if payload.len() < 10 {
        return None;
    }
    Some(LinkStatistics {
        uplink_rssi_1: payload[0],
        uplink_rssi_2: payload[1],
        uplink_link_quality: payload[2],
        uplink_snr: payload[3] as i8,
        active_antenna: payload[4],
        rf_mode: payload[5],
        uplink_tx_power: payload[6],
        downlink_rssi: payload[7],
        downlink_link_quality: payload[8],
        downlink_snr: payload[9] as i8,
    })
}

/// Decode a GPS payload (15 bytes, big-endian, no extended header).
///
/// Layout: `lat i32 | lon i32 | ground_speed u16 | heading u16 | altitude u16 |
/// satellites u8`. Returns `None` for a short payload so a truncated frame
/// resyncs rather than panicking.
fn decode_gps(payload: &[u8]) -> Option<GpsData> {
    if payload.len() < 15 {
        return None;
    }
    Some(GpsData {
        latitude: i32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]),
        longitude: i32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]),
        ground_speed: u16::from_be_bytes([payload[8], payload[9]]),
        heading: u16::from_be_bytes([payload[10], payload[11]]),
        altitude: u16::from_be_bytes([payload[12], payload[13]]),
        satellites: payload[14],
    })
}

/// Decode a Device Info payload. The payload here already excludes the type
/// byte but still begins with the extended header (`dest`, `origin`).
fn decode_device_info(payload: &[u8]) -> Option<DeviceInfo> {
    // Need dest + origin + at least a null terminator + the trailing fixed
    // fields (4 + 4 + 4 + 1 + 1 = 14 bytes after the name).
    if payload.len() < 2 {
        return None;
    }
    let destination = payload[0];
    let origin = payload[1];

    let rest = &payload[2..];
    // Name is null-terminated.
    let name_end = rest.iter().position(|&b| b == 0)?;
    let name = String::from_utf8_lossy(&rest[..name_end]).into_owned();

    // After the name's null terminator come the fixed fields.
    let after_name = &rest[name_end + 1..];
    if after_name.len() < 14 {
        return None;
    }
    let serial_number =
        u32::from_be_bytes([after_name[0], after_name[1], after_name[2], after_name[3]]);
    let hardware_version =
        u32::from_be_bytes([after_name[4], after_name[5], after_name[6], after_name[7]]);
    let firmware_version_raw =
        u32::from_be_bytes([after_name[8], after_name[9], after_name[10], after_name[11]]);
    let field_count = after_name[12];
    let parameter_version = after_name[13];

    Some(DeviceInfo {
        destination,
        origin,
        name,
        serial_number,
        hardware_version,
        firmware_version_raw,
        field_count,
        parameter_version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known-good frames generated with an independent reference CRC
    // implementation (CRC-8/DVB-S2, poly 0xD5) — see commit notes. Hardcoding
    // the CRC bytes keeps these tests non-circular w.r.t. `crc8`.

    /// Link Statistics: -70/-80 dBm uplink RSSI, LQ 100, SNR 8, ant 0,
    /// rf_mode 2, tx_power idx 3, downlink -60 dBm RSSI, LQ 99, SNR -5.
    const LINK_STATS_FRAME: &[u8] = &[
        0xC8, 0x0C, 0x14, 0x46, 0x50, 0x64, 0x08, 0x00, 0x02, 0x03, 0x3C, 0x63, 0xFB, 0xCD,
    ];

    /// Device Info from a TX module (origin 0xEE), name "ELRS TX",
    /// firmware word 0x00030400 → version "3.4.0", 12 fields.
    const DEVICE_INFO_FRAME: &[u8] = &[
        0xC8, 0x1A, 0x29, 0xEA, 0xEE, 0x45, 0x4C, 0x52, 0x53, 0x20, 0x54, 0x58, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x04, 0x00, 0x0C, 0x00, 0x74,
    ];

    /// GPS frame: lat 37.7749° (377749000), lon −122.4194° (−1224194000),
    /// ground speed 15.0 km/h (150), heading 180.00° (18000), altitude 100 m
    /// (raw 1100 = 100 + 1000 offset), 9 satellites. CRC computed independently.
    const GPS_FRAME: &[u8] = &[
        0xC8, 0x11, 0x02, 0x16, 0x83, 0xFE, 0x08, 0xB7, 0x08, 0x48, 0x30, 0x00, 0x96, 0x46, 0x50,
        0x04, 0x4C, 0x09, 0x8A,
    ];

    #[test]
    fn parses_gps() {
        let mut parser = Parser::new();
        let frames = parser.feed(GPS_FRAME);
        assert_eq!(frames.len(), 1);
        let expected = GpsData {
            latitude: 377_749_000,
            longitude: -1_224_194_000,
            ground_speed: 150,
            heading: 18_000,
            altitude: 1_100,
            satellites: 9,
        };
        assert_eq!(frames[0], Frame::Gps(expected));
    }

    #[test]
    fn rejects_truncated_gps() {
        // CRC-valid but only 14 bytes of payload (one short) → not decoded.
        let mut short = vec![0xC8u8, 0x10, 0x02];
        short.extend_from_slice(&GPS_FRAME[3..17]); // 14 payload bytes
        let crc = crc8(&short[2..]);
        short.push(crc);
        let mut parser = Parser::new();
        assert!(parser.feed(&short).is_empty());
    }

    #[test]
    fn crc8_matches_known_vectors() {
        // CRC over [type, payload...] of the link-stats frame == final byte.
        assert_eq!(crc8(&LINK_STATS_FRAME[2..LINK_STATS_FRAME.len() - 1]), 0xCD);
        assert_eq!(
            crc8(&DEVICE_INFO_FRAME[2..DEVICE_INFO_FRAME.len() - 1]),
            0x74
        );
    }

    #[test]
    fn parses_link_statistics() {
        let mut parser = Parser::new();
        let frames = parser.feed(LINK_STATS_FRAME);
        assert_eq!(frames.len(), 1);
        let expected = LinkStatistics {
            uplink_rssi_1: 70,
            uplink_rssi_2: 80,
            uplink_link_quality: 100,
            uplink_snr: 8,
            active_antenna: 0,
            rf_mode: 2,
            uplink_tx_power: 3,
            downlink_rssi: 60,
            downlink_link_quality: 99,
            downlink_snr: -5,
        };
        assert_eq!(frames[0], Frame::LinkStatistics(expected));
    }

    #[test]
    fn parses_device_info() {
        let mut parser = Parser::new();
        let frames = parser.feed(DEVICE_INFO_FRAME);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            Frame::DeviceInfo(info) => {
                assert_eq!(info.name, "ELRS TX");
                assert_eq!(info.origin, address::CRSF_TRANSMITTER);
                assert_eq!(info.firmware_version().as_deref(), Some("3.4.0"));
                assert_eq!(info.field_count, 12);
                assert_eq!(info.is_transmitter(), Some(true));
            }
            other => panic!("expected DeviceInfo, got {other:?}"),
        }
    }

    #[test]
    fn an_absent_firmware_word_is_none_not_zero_zero_zero() {
        // Betaflight's `crsfFrameDeviceInfo` answers DEVICE_PING with an
        // all-zero serial/hardware/firmware triple. Reporting that as a concrete
        // `0.0.0` is a fabrication the UI then renders as fact; absence must
        // stay absent.
        let mut info = DeviceInfo {
            destination: address::RADIO_TRANSMITTER,
            origin: address::FLIGHT_CONTROLLER,
            name: "Betaflight".into(),
            serial_number: 0,
            hardware_version: 0,
            firmware_version_raw: 0,
            field_count: 0,
            parameter_version: 0,
        };
        assert_eq!(info.firmware_version(), None);
        // A real version — including a genuine 0.x.y — still decodes.
        info.firmware_version_raw = 0x0000_0501;
        assert_eq!(info.firmware_version().as_deref(), Some("0.5.1"));
    }

    #[test]
    fn handles_split_feeds() {
        // Frame delivered one byte at a time must still parse exactly once.
        let mut parser = Parser::new();
        let mut total = Vec::new();
        for &b in LINK_STATS_FRAME {
            total.extend(parser.feed(&[b]));
        }
        assert_eq!(total.len(), 1);
        assert!(matches!(total[0], Frame::LinkStatistics(_)));
    }

    #[test]
    fn resyncs_after_leading_garbage() {
        // Prepend junk bytes whose length fields are out of range, forcing a
        // one-byte-at-a-time resync until the real frame's sync is found.
        let mut bytes = vec![0xFF, 0xFF, 0xFF];
        bytes.extend_from_slice(LINK_STATS_FRAME);
        let mut parser = Parser::new();
        let frames = parser.feed(&bytes);
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0], Frame::LinkStatistics(_)));
    }

    #[test]
    fn resyncs_after_bad_crc_short_frame() {
        // A complete but CRC-invalid short frame ahead of a good one must be
        // discarded byte-by-byte, leaving exactly the valid frame.
        let mut bytes = vec![0xC8, 0x02, 0xAA, 0x00]; // crc8([0xAA]) != 0x00
        bytes.extend_from_slice(LINK_STATS_FRAME);
        let mut parser = Parser::new();
        let frames = parser.feed(&bytes);
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0], Frame::LinkStatistics(_)));
    }

    #[test]
    fn rejects_bad_crc() {
        let mut corrupt = LINK_STATS_FRAME.to_vec();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xFF; // break the CRC
        let mut parser = Parser::new();
        let frames = parser.feed(&corrupt);
        // No valid frame; parser resynced and consumed the garbage.
        assert!(frames.is_empty());
    }

    #[test]
    fn builds_well_formed_device_ping() {
        // Must match the historically-verified handset ping byte-for-byte and
        // carry a CRC that round-trips through the parser.
        let ping = device_ping(address::RADIO_TRANSMITTER);
        assert_eq!(ping, vec![0xC8, 0x04, 0x28, 0x00, 0xEA, 0x54]);
        // CRC covers [type, dest, origin].
        assert_eq!(crc8(&ping[2..ping.len() - 1]), *ping.last().unwrap());
    }

    #[test]
    fn builds_directed_device_ping() {
        // Directed ping to the TX module with handset origin: dest/origin land in
        // the right slots and the CRC self-consists.
        let ping = device_ping_to(address::CRSF_TRANSMITTER, address::RADIO_TRANSMITTER);
        assert_eq!(ping[0], address::FLIGHT_CONTROLLER); // sync
        assert_eq!(ping[1], 0x04); // len
        assert_eq!(ping[2], frame_type::DEVICE_PING);
        assert_eq!(&ping[3..5], &[0xEE, 0xEA]); // dest, origin
        assert_eq!(crc8(&ping[2..ping.len() - 1]), *ping.last().unwrap());
        // Broadcast convenience wrapper stays equivalent to the explicit form.
        assert_eq!(
            device_ping(address::RADIO_TRANSMITTER),
            device_ping_to(address::BROADCAST, address::RADIO_TRANSMITTER)
        );
    }

    #[test]
    fn builds_well_formed_param_read() {
        let frame = param_read_frame(address::CRSF_TRANSMITTER, address::RADIO_TRANSMITTER, 1, 0);
        assert_eq!(frame[0], 0xC8); // sync
        assert_eq!(frame[1], 0x06); // len
        assert_eq!(frame[2], frame_type::PARAM_READ);
        assert_eq!(&frame[3..7], &[0xEE, 0xEA, 0x01, 0x00]);
        assert_eq!(crc8(&frame[2..frame.len() - 1]), *frame.last().unwrap());
    }

    #[test]
    fn decodes_param_entry() {
        // dest, origin, field 5, 0 chunks remaining, parent 0, type 9 (STRING),
        // name "Name", value bytes [0x07, 0x00].
        let payload = [
            0xEA, 0xEE, 0x05, 0x00, 0x00, 0x09, b'N', b'a', b'm', b'e', 0x00, 0x07, 0x00,
        ];
        let entry = decode_param_entry(&payload).expect("decodes");
        assert_eq!(entry.field_index, 5);
        assert_eq!(entry.chunks_remaining, 0);
        assert_eq!(entry.parent, 0);
        assert_eq!(entry.data_type, 9);
        assert_eq!(entry.name, "Name");
        assert_eq!(entry.value, vec![0x07, 0x00]);
    }

    #[test]
    fn rejects_truncated_param_entry() {
        assert!(decode_param_entry(&[0xEA, 0xEE, 0x01]).is_none());
        // Header present but no name terminator.
        assert!(decode_param_entry(&[0xEA, 0xEE, 0x01, 0x00, 0x00, 0x09, b'X']).is_none());
    }

    #[test]
    fn parses_two_back_to_back_frames() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(LINK_STATS_FRAME);
        bytes.extend_from_slice(DEVICE_INFO_FRAME);
        let mut parser = Parser::new();
        let frames = parser.feed(&bytes);
        assert_eq!(frames.len(), 2);
        assert!(matches!(frames[0], Frame::LinkStatistics(_)));
        assert!(matches!(frames[1], Frame::DeviceInfo(_)));
    }
}
