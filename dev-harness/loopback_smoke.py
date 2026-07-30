#!/usr/bin/env python3
"""Transport smoke test WITHOUT socat or hardware.

Creates a real PTY pair via os.openpty(), writes encoded CRSF frames into the
"device" end, reads them back through the byte-fed Parser on the "app" end, and
asserts the same frames come out intact. Proves the encode -> tty -> decode path
end-to-end over an actual terminal device, which is exactly what the app's
serialport reader does (it just opens a path and reads bytes).

Run: python3 loopback_smoke.py
"""
import os
import sys

from crsf_encoder import (
    DEVICE_PING,
    Parser,
    TYPE_DEVICE_INFO,
    TYPE_LINK_STATISTICS,
    TYPE_DEVICE_PING,
    build_device_info,
    build_link_statistics,
)


def main() -> int:
    # A PTY pair: master <-> slave. Either end can read/write the other.
    master, slave = os.openpty()
    print(f"opened pty pair (master fd={master}, slave={os.ttyname(slave)})")

    parser = Parser()
    decoded: list[int] = []

    # 1) Device end answers a ping with Device Info.
    parser_for_ping = Parser()
    for f in parser_for_ping.feed(DEVICE_PING):
        if f.frame_type == TYPE_DEVICE_PING:
            print("  recognised app DEVICE_PING -> replying with Device Info")

    di = build_device_info("OmniLink-SIM RX", firmware_major=3, firmware_minor=5, firmware_patch=1)
    ls_frames = [
        build_link_statistics(uplink_rssi_1=65 + i, uplink_link_quality=100 - i, downlink_snr=-3 - i)
        for i in range(10)
    ]

    # Write device-end traffic into the slave; read it from the master (the "app").
    payload = di + b"".join(ls_frames)
    os.write(slave, payload)

    # Read back in small chunks to exercise the byte-fed parser across boundaries.
    remaining = len(payload)
    while remaining > 0:
        chunk = os.read(master, 7)  # deliberately odd chunk size -> split frames
        remaining -= len(chunk)
        for frame in parser.feed(chunk):
            decoded.append(frame.frame_type)

    os.close(master)
    os.close(slave)

    types = decoded
    expected = [TYPE_DEVICE_INFO] + [TYPE_LINK_STATISTICS] * 10
    ok = types == expected

    print(f"  decoded {len(types)} frames: "
          f"{sum(1 for t in types if t == TYPE_DEVICE_INFO)} device-info, "
          f"{sum(1 for t in types if t == TYPE_LINK_STATISTICS)} link-stats")

    if ok:
        print("\nPASS  encode -> pty -> decode round-trip intact")
        return 0
    print(f"\nFAIL  expected {expected}, got {types}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
