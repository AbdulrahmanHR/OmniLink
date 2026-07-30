#!/usr/bin/env python3
"""Unit self-check for the CRSF encoder.

Asserts the encoder's CRC8 and full-frame output match the EXACT known-good
vectors hardcoded in the Rust parser's tests
(projectomni/src-tauri/src/crsf/mod.rs, mod tests). If these pass, the harness
produces bytes the real app will parse -- provable WITHOUT socat or hardware.

Run:  python3 selfcheck.py
"""

from __future__ import annotations

import sys

from crsf_encoder import (
    Parser,
    TYPE_DEVICE_INFO,
    TYPE_DEVICE_PING,
    TYPE_LINK_STATISTICS,
    build_device_info,
    build_link_statistics,
    crc8,
    DEVICE_PING,
)

# Vectors copied verbatim from crsf/mod.rs `mod tests`.

# Link Statistics: -70/-80 dBm uplink RSSI, LQ 100, SNR 8, ant 0, rf_mode 2,
# tx_power idx 3, downlink -60 dBm RSSI, LQ 99, SNR -5.
LINK_STATS_FRAME = bytes(
    [0xC8, 0x0C, 0x14, 0x46, 0x50, 0x64, 0x08, 0x00, 0x02, 0x03, 0x3C, 0x63, 0xFB, 0xCD]
)

# Device Info from a TX module (origin 0xEE), name "ELRS TX",
# firmware word 0x00030400 -> "3.4.0", 12 fields.
DEVICE_INFO_FRAME = bytes(
    [
        0xC8, 0x1A, 0x29, 0xEA, 0xEE, 0x45, 0x4C, 0x52, 0x53, 0x20, 0x54, 0x58,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x04,
        0x00, 0x0C, 0x00, 0x74,
    ]
)


_passed = 0
_failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failed += 1
        print(f"  FAIL  {name}  {detail}")


def main() -> int:
    print("CRSF encoder self-check (vectors from Rust crsf/mod.rs tests)\n")

    # 1. CRC over [type, payload...] must equal the Rust test's final byte.
    check(
        "crc8(link-stats body) == 0xCD",
        crc8(LINK_STATS_FRAME[2:-1]) == 0xCD,
        f"got 0x{crc8(LINK_STATS_FRAME[2:-1]):02X}",
    )
    check(
        "crc8(device-info body) == 0x74",
        crc8(DEVICE_INFO_FRAME[2:-1]) == 0x74,
        f"got 0x{crc8(DEVICE_INFO_FRAME[2:-1]):02X}",
    )

    # 2. Full-frame byte-for-byte reproduction of the Rust vectors.
    ls = build_link_statistics(
        uplink_rssi_1=70,
        uplink_rssi_2=80,
        uplink_link_quality=100,
        uplink_snr=8,
        active_antenna=0,
        rf_mode=2,
        uplink_tx_power=3,
        downlink_rssi=60,
        downlink_link_quality=99,
        downlink_snr=-5,
    )
    check(
        "build_link_statistics reproduces LINK_STATS_FRAME",
        ls == LINK_STATS_FRAME,
        f"\n        got      {ls.hex(' ')}\n        expected {LINK_STATS_FRAME.hex(' ')}",
    )

    di = build_device_info(
        "ELRS TX",
        sync=0xC8,
        destination=0xEA,
        origin=0xEE,
        serial_number=0,
        hardware_version=1,
        firmware_major=3,
        firmware_minor=4,
        firmware_patch=0,
        field_count=12,
        parameter_version=0,
    )
    check(
        "build_device_info reproduces DEVICE_INFO_FRAME",
        di == DEVICE_INFO_FRAME,
        f"\n        got      {di.hex(' ')}\n        expected {DEVICE_INFO_FRAME.hex(' ')}",
    )

    # 3. Negative-SNR encoding (i8 two's complement on the wire).
    check(
        "downlink_snr -5 encodes as 0xFB",
        ls[12] == 0xFB,
        f"got 0x{ls[12]:02X}",
    )

    # 4. The app's Device Ping is recognised by our parser as type 0x28.
    p = Parser()
    frames = p.feed(DEVICE_PING)
    check(
        "parser decodes app DEVICE_PING as type 0x28",
        len(frames) == 1 and frames[0].frame_type == TYPE_DEVICE_PING,
        f"got {[(hex(f.frame_type)) for f in frames]}",
    )

    # 5. Round-trip: our own built frames parse back to the right types,
    #    including across a byte-split feed (mirrors the Rust split-feed test).
    p2 = Parser()
    out = []
    for b in ls + di:
        out.extend(p2.feed(bytes([b])))
    types = [f.frame_type for f in out]
    check(
        "split-feed round-trip yields [0x14, 0x29]",
        types == [TYPE_LINK_STATISTICS, TYPE_DEVICE_INFO],
        f"got {[hex(t) for t in types]}",
    )

    print(f"\n{_passed} passed, {_failed} failed")
    return 0 if _failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
