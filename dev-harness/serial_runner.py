#!/usr/bin/env python3
"""Virtual-serial CRSF device simulator for the OmniLink ExpressLRS config app.

Creates a Linux PTY pair with socat, then plays the role of a connected
ExpressLRS module on ONE end:

  (a) answers the app's CRSF Device Ping (0x28) with a Device Info (0x29) reply
      carrying a fake target name + firmware version, and
  (b) continuously streams Link Statistics (0x14) frames at ~25 Hz with smoothly
      varying RSSI / LQ / SNR / TX-power / packet-rate values.

The app connects to the OTHER end of the pair (path printed at startup).

This is a standalone dev/test tool. It lives OUTSIDE the app source on purpose
and is never imported by or bundled into the app.

Requirements: python3 (stdlib only) and socat.
  Install socat:  sudo apt-get install -y socat

Usage:
    python3 serial_runner.py [--name "OMNI SIM TX"] [--rate-hz 25]
                             [--device-type tx|rx] [--socat /path/to/socat]

If socat is not installed, you can instead create the pair yourself and point
the runner at an existing PTY:
    socat -d -d pty,raw,echo=0 pty,raw,echo=0      # in terminal A
    python3 serial_runner.py --port /dev/pts/N     # the OTHER end, terminal B
Then connect the app to the FIRST end socat printed.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import subprocess
import sys
import time

from crsf_encoder import (
    ADDR_CRSF_RECEIVER,
    ADDR_CRSF_TRANSMITTER,
    ADDR_FLIGHT_CONTROLLER,
    ADDR_RADIO_TRANSMITTER,
    TYPE_DEVICE_PING,
    Parser,
    build_device_info,
    build_link_statistics,
)

PTY_RE = re.compile(r"PTY is (\S+)")


def spawn_socat(socat_bin: str):
    """Launch socat and return (process, [pathA, pathB])."""
    proc = subprocess.Popen(
        [socat_bin, "-d", "-d", "pty,raw,echo=0", "pty,raw,echo=0"],
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        bufsize=1,
        universal_newlines=True,
    )
    paths: list[str] = []
    deadline = time.time() + 10
    while len(paths) < 2 and time.time() < deadline:
        line = proc.stderr.readline()
        if not line:
            if proc.poll() is not None:
                break
            continue
        m = PTY_RE.search(line)
        if m:
            paths.append(m.group(1))
    if len(paths) < 2:
        proc.terminate()
        raise RuntimeError(
            "Could not parse two PTY paths from socat output. "
            "Is socat installed and working?"
        )
    return proc, paths


def open_raw(path: str) -> int:
    """Open a PTY in raw, non-blocking-friendly mode and return its fd."""
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    try:
        import termios
        import tty

        tty.setraw(fd)
        # Make reads return immediately with whatever is available.
        attrs = termios.tcgetattr(fd)
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except Exception:
        # Best effort; socat already set the line discipline to raw.
        pass
    return fd


def smooth_link_stats(t: float, origin: int) -> bytes:
    """Produce a Link Statistics frame with values that vary smoothly over time.

    `t` is seconds since start. Values stay within realistic ELRS ranges.
    """
    # RSSI magnitudes oscillate roughly -45..-95 dBm (wire 45..95).
    rssi1 = int(70 + 20 * math.sin(t * 0.7))
    rssi2 = int(72 + 18 * math.sin(t * 0.7 + 1.1))
    # Link quality dips occasionally but mostly high.
    lq = int(92 + 8 * math.sin(t * 0.33))
    lq = max(0, min(100, lq))
    snr = int(8 + 6 * math.sin(t * 0.5))  # -ish 2..14 dB, signed
    active = 0 if math.sin(t * 0.9) >= 0 else 1
    rf_mode = 2  # ~50 Hz in the app's best-effort table
    # TX power index walks slowly through a few common steps: 2(25mW),3(100),4(500).
    tx_power = [2, 3, 4][int(t / 5) % 3]
    dl_rssi = int(60 + 10 * math.sin(t * 0.6 + 0.5))
    dl_lq = max(0, min(100, int(95 + 5 * math.sin(t * 0.4))))
    dl_snr = int(6 + 5 * math.sin(t * 0.45))

    return build_link_statistics(
        sync=ADDR_FLIGHT_CONTROLLER,
        uplink_rssi_1=rssi1,
        uplink_rssi_2=rssi2,
        uplink_link_quality=lq,
        uplink_snr=snr,
        active_antenna=active,
        rf_mode=rf_mode,
        uplink_tx_power=tx_power,
        downlink_rssi=dl_rssi,
        downlink_link_quality=dl_lq,
        downlink_snr=dl_snr,
    )


def run(fd: int, args, app_port_hint: str) -> None:
    parser = Parser()
    origin = ADDR_CRSF_TRANSMITTER if args.device_type == "tx" else ADDR_CRSF_RECEIVER

    period = 1.0 / args.rate_hz
    start = time.time()
    next_tick = start
    have_pinged_info = False
    last_status = 0.0

    print(f"[runner] simulating a '{args.device_type.upper()}' named "
          f"{args.name!r} at {args.rate_hz} Hz")
    print(f"[runner] CONNECT THE APP TO:  {app_port_hint}")
    print("[runner] waiting for the app's Device Ping... (Ctrl-C to stop)\n")

    while True:
        # Drain inbound bytes and answer any Device Ping.
        try:
            data = os.read(fd, 256)
        except BlockingIOError:
            data = b""
        except OSError:
            data = b""
        if data:
            for frame in parser.feed(data):
                if frame.frame_type == TYPE_DEVICE_PING:
                    info = build_device_info(
                        args.name,
                        sync=ADDR_FLIGHT_CONTROLLER,
                        destination=ADDR_RADIO_TRANSMITTER,
                        origin=origin,
                        firmware_major=args.fw_major,
                        firmware_minor=args.fw_minor,
                        firmware_patch=args.fw_patch,
                    )
                    os.write(fd, info)
                    if not have_pinged_info:
                        print("[runner] got Device Ping -> sent Device Info "
                              f"({args.name}, fw {args.fw_major}.{args.fw_minor}.{args.fw_patch})")
                        have_pinged_info = True

        # Stream Link Statistics at the configured rate.
        now = time.time()
        if now >= next_tick:
            frame = smooth_link_stats(now - start, origin)
            try:
                os.write(fd, frame)
            except OSError:
                pass
            next_tick += period
            # If we fell behind, don't spin: resync the schedule.
            if next_tick < now:
                next_tick = now + period

        if now - last_status >= 2.0 and have_pinged_info:
            print(f"[runner] streaming link-stats... t={now - start:6.1f}s", end="\r")
            last_status = now

        time.sleep(0.001)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default="OMNI SIM TX",
                    help="fake target name reported in Device Info")
    ap.add_argument("--rate-hz", type=float, default=25.0,
                    help="Link Statistics stream rate (default 25)")
    ap.add_argument("--device-type", choices=["tx", "rx"], default="tx",
                    help="report as a TX module (origin 0xEE) or RX (0xEC)")
    ap.add_argument("--fw-major", type=int, default=3)
    ap.add_argument("--fw-minor", type=int, default=4)
    ap.add_argument("--fw-patch", type=int, default=0)
    ap.add_argument("--socat", default=None,
                    help="path to socat (default: found on PATH)")
    ap.add_argument("--port", default=None,
                    help="use an EXISTING PTY/serial device instead of spawning "
                         "socat (you connect the app to the OTHER end yourself)")
    args = ap.parse_args()

    socat_proc = None
    try:
        if args.port:
            fd = open_raw(args.port)
            print(f"[runner] using existing device {args.port}")
            print("[runner] connect the app to the OTHER end of your socat pair.")
            run(fd, args, app_port_hint="<the other end of your socat pair>")
        else:
            socat_bin = args.socat or shutil.which("socat")
            if socat_bin and not (os.path.isfile(socat_bin) and os.access(socat_bin, os.X_OK)):
                # An explicit --socat path that isn't a runnable binary: treat it
                # the same as "not found" so the user gets the friendly hint.
                socat_bin = None
            if not socat_bin:
                print(
                    "ERROR: socat not found on PATH.\n"
                    "  Install it:   sudo apt-get install -y socat\n"
                    "  Or run socat yourself and use --port:\n"
                    "    socat -d -d pty,raw,echo=0 pty,raw,echo=0\n"
                    "    python3 serial_runner.py --port /dev/pts/N\n",
                    file=sys.stderr,
                )
                return 2
            socat_proc, paths = spawn_socat(socat_bin)
            harness_end, app_end = paths[0], paths[1]
            print(f"[runner] socat PTY pair: {paths[0]}  <->  {paths[1]}")
            fd = open_raw(harness_end)
            run(fd, args, app_port_hint=app_end)
    except KeyboardInterrupt:
        print("\n[runner] stopping.")
    finally:
        if socat_proc is not None:
            socat_proc.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
