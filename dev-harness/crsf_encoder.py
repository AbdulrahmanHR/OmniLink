#!/usr/bin/env python3
"""Byte-correct CRSF frame encoder + minimal parser for the OmniLink dev harness.

This MUST match the wire format the app's Rust parser expects, defined in
projectomni/src-tauri/src/crsf/mod.rs. Do not invent formats here -- every
constant and layout below is copied from that parser / its tests.

Frame layout on the wire:

    +---------+--------+--------+--------------------+--------+
    | sync/   | length |  type  |     payload        |  crc8  |
    | address | (u8)   | (u8)   |  (length-2 bytes)  | (u8)   |
    +---------+--------+--------+--------------------+--------+
      byte 0    byte 1   byte 2   byte 3 ..            last

* length  = bytes after the length field = type(1) + payload + crc(1).
            Total on-wire size = length + 2. Valid range 2..=62.
* crc8    = CRC-8/DVB-S2 (poly 0xD5, init 0x00) over [type, payload...].

Extended frames (type >= 0x28) carry two extra header bytes, dest then origin,
immediately after the type byte. Device Info (0x29) and Device Ping (0x28) are
extended.

Standard-library only. No third-party deps.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

# --- Constants copied from the Rust parser ------------------------------------

CRSF_BAUD = 420_000  # ELRS CRSF serial baud (PTYs ignore it; documented for parity)

# Addresses (crsf::address)
ADDR_BROADCAST = 0x00
ADDR_FLIGHT_CONTROLLER = 0xC8
ADDR_RADIO_TRANSMITTER = 0xEA
ADDR_CRSF_TRANSMITTER = 0xEE  # ELRS TX module
ADDR_CRSF_RECEIVER = 0xEC  # ELRS receiver

# Frame types (crsf::frame_type)
TYPE_LINK_STATISTICS = 0x14
TYPE_DEVICE_PING = 0x28
TYPE_DEVICE_INFO = 0x29
EXTENDED_THRESHOLD = 0x28

MIN_LENGTH = 2
MAX_LENGTH = 62


def crc8(data: bytes) -> int:
    """CRC-8/DVB-S2 (poly 0xD5, init 0x00). Mirrors crsf::crc8 in Rust exactly."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x80:
                crc = ((crc << 1) ^ 0xD5) & 0xFF
            else:
                crc = (crc << 1) & 0xFF
    return crc


def build_frame(sync: int, frame_type: int, payload: bytes) -> bytes:
    """Assemble a complete CRSF frame from a type byte + payload (no header/crc).

    `payload` is everything that goes between the type byte and the CRC. For
    extended frames that includes the dest/origin header bytes.
    """
    body = bytes([frame_type]) + payload  # CRC covers [type, payload...]
    length = len(body) + 1  # + crc byte
    if not (MIN_LENGTH <= length <= MAX_LENGTH):
        raise ValueError(f"length {length} out of CRSF range {MIN_LENGTH}..={MAX_LENGTH}")
    return bytes([sync & 0xFF, length]) + body + bytes([crc8(body)])


# --- Device Info (0x29, extended) ---------------------------------------------


def build_device_info(
    name: str,
    *,
    sync: int = ADDR_FLIGHT_CONTROLLER,
    destination: int = ADDR_RADIO_TRANSMITTER,
    origin: int = ADDR_CRSF_TRANSMITTER,
    serial_number: int = 0,
    hardware_version: int = 1,
    firmware_major: int = 3,
    firmware_minor: int = 4,
    firmware_patch: int = 0,
    field_count: int = 12,
    parameter_version: int = 0,
) -> bytes:
    """Build a Device Info reply.

    Payload after the type byte (per crsf::decode_device_info):
        dest(1) origin(1) name...(null-terminated) serial(4 BE)
        hw(4 BE) fw(4 BE) field_count(1) param_version(1)

    ELRS packs the semantic version into the fw word's low three bytes:
    0x00MMmmpp -> MM.mm.pp.
    """
    fw_raw = ((firmware_major & 0xFF) << 16) | ((firmware_minor & 0xFF) << 8) | (firmware_patch & 0xFF)
    name_bytes = name.encode("utf-8") + b"\x00"  # null-terminated
    payload = (
        bytes([destination & 0xFF, origin & 0xFF])
        + name_bytes
        + struct.pack(">I", serial_number & 0xFFFFFFFF)
        + struct.pack(">I", hardware_version & 0xFFFFFFFF)
        + struct.pack(">I", fw_raw & 0xFFFFFFFF)
        + bytes([field_count & 0xFF, parameter_version & 0xFF])
    )
    return build_frame(sync, TYPE_DEVICE_INFO, payload)


# --- Link Statistics (0x14) ---------------------------------------------------


def build_link_statistics(
    *,
    sync: int = ADDR_FLIGHT_CONTROLLER,
    uplink_rssi_1: int = 70,
    uplink_rssi_2: int = 80,
    uplink_link_quality: int = 100,
    uplink_snr: int = 8,
    active_antenna: int = 0,
    rf_mode: int = 2,
    uplink_tx_power: int = 3,
    downlink_rssi: int = 60,
    downlink_link_quality: int = 99,
    downlink_snr: int = -5,
) -> bytes:
    """Build a 10-byte Link Statistics payload frame (per crsf::decode_link_statistics).

    RSSI values are POSITIVE magnitudes on the wire (wire 70 => -70 dBm). SNR is
    signed (encoded as i8). All fields map 1:1 to the LinkStatistics struct.
    """
    payload = bytes(
        [
            uplink_rssi_1 & 0xFF,
            uplink_rssi_2 & 0xFF,
            uplink_link_quality & 0xFF,
            uplink_snr & 0xFF,  # signed -> two's complement byte (i8 in Rust)
            active_antenna & 0xFF,
            rf_mode & 0xFF,
            uplink_tx_power & 0xFF,
            downlink_rssi & 0xFF,
            downlink_link_quality & 0xFF,
            downlink_snr & 0xFF,
        ]
    )
    return build_frame(sync, TYPE_LINK_STATISTICS, payload)


# --- Device Ping (0x28, extended) ---------------------------------------------
# The app SENDS this; the harness only needs to recognise it. Provided for
# completeness / testing.

DEVICE_PING = bytes([0xC8, 0x04, 0x28, 0x00, ADDR_RADIO_TRANSMITTER, 0x54])


# --- Minimal byte-fed parser (mirrors crsf::Parser) ---------------------------


@dataclass
class ParsedFrame:
    frame_type: int
    payload: bytes  # everything between the type byte and the CRC


class Parser:
    """Byte-fed CRSF framing state machine, faithful to crsf::Parser.

    Used by the runner to detect inbound Device Ping frames from the app.
    """

    def __init__(self) -> None:
        self.buffer = bytearray()

    def feed(self, data: bytes) -> list[ParsedFrame]:
        self.buffer.extend(data)
        frames: list[ParsedFrame] = []
        while True:
            if len(self.buffer) < 2:
                break
            length = self.buffer[1]
            if not (MIN_LENGTH <= length <= MAX_LENGTH):
                del self.buffer[0]
                continue
            total = length + 2
            if len(self.buffer) < total:
                break
            body = bytes(self.buffer[2 : total - 1])  # [type, payload...]
            if crc8(body) != self.buffer[total - 1]:
                del self.buffer[0]
                continue
            frames.append(ParsedFrame(frame_type=body[0], payload=body[1:]))
            del self.buffer[0:total]
        return frames


if __name__ == "__main__":
    # Quick smoke dump so the module is runnable on its own.
    di = build_device_info("OMNI SIM TX")
    ls = build_link_statistics()
    print("Device Info :", di.hex(" "))
    print("Link Stats  :", ls.hex(" "))
