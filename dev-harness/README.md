# OmniLink dev-harness — work on the serial path with no radio

A small, dependency-free Python harness that lets you exercise OmniLink's **real**
serial and CRSF code path — serial enumeration, the Device Ping / Device Info
handshake, and Link Statistics telemetry — **without owning any ExpressLRS
hardware**.

It plays the role of a connected ELRS module on one end of a virtual serial
port: it answers the app's CRSF Device Ping with a Device Info reply and streams
realistic Link Statistics at ~25 Hz. You point OmniLink at the other end.

## Why this exists, and why it is in the repository

**OmniLink's single structural blocker is that its maintainer has no ELRS
hardware.** On-hardware acceptance is deferred for M6, M7, M8, M11, M13, M18,
M29 and M67 for exactly that reason, and it is the most honest thing in the
project's status blocks (`../docs/deferred_features_backlog.md` §2.1).

This harness does not solve that. **What it does is make the hardware gap much
narrower than it looks**, because a surprising amount of the serial path can be
proven without a radio:

- **Frame encoding and CRC** — provable against the Rust parser's own test
  vectors, with nothing attached and nothing installed.
- **The encode → tty → decode round trip** — provable over a real kernel PTY.
- **The app's handshake, telemetry ingestion, reconnect and error handling** —
  drivable end to end against a simulated device.

What it **cannot** prove is anything that depends on real silicon: actual baud
behaviour, real timing jitter, a real bootloader, a real flash write, real GPS,
or a real radio's WiFi AP. Those stay hardware-gated, and no amount of
simulation changes that. **The harness is a way to contribute usefully, not a
substitute for verification.**

The harness lived outside the repository until v3.0.0. **Decision D42 reversed
that and moved it in**: for a project whose bottleneck is hardware access, this
is the highest-leverage file set outside `src/`. An earlier version of this
README stated as a hard rule that it must *never* be committed here. That rule
is superseded — this is now its home.

## Requirements

- **Python 3.8 or newer.** Standard library only — **no `pip install`, ever**.
  (3.8 is the floor because the scripts use `bytes.hex(sep)`. Developed and
  verified on 3.12.)
- **`socat`** — optional, and only for the full device simulation in Step 3.
  Steps 1 and 2 need nothing but Python.

  ```sh
  sudo apt-get update && sudo apt-get install -y socat   # Debian / Ubuntu
  ```

- **Linux or macOS.** The harness uses POSIX pseudo-terminals. On **Windows, use
  WSL** — `os.openpty()` and `socat` have no native Windows equivalent.

## The four scripts

| File | What it is | Needs socat? | Needs the app? |
|------|-----------|:---:|:---:|
| `crsf_encoder.py` | The library the other three import. A byte-correct CRSF frame encoder (Device Info `0x29`, Link Statistics `0x14`) plus a minimal incremental parser. CRC-8/DVB-S2, poly `0xD5`, matching the Rust parser exactly. | no | no |
| `selfcheck.py` | Proves the encoder is right, against the **known-good vectors hardcoded in the Rust parser's own unit tests**. Seven assertions, no I/O. | no | no |
| `loopback_smoke.py` | Proves the transport is right. Opens a real PTY pair with `os.openpty()`, writes encoded frames into the "device" end, reads them back through the parser on the "app" end, and asserts the frames survive intact. | no | no |
| `serial_runner.py` | The actual device simulator. Spawns a `socat` PTY pair, answers Device Ping, and streams smooth Link Statistics at a configurable rate. | **yes** | yes |

**Read them in that order.** Each one only trusts what the previous one proved.

## Step 1 — prove the frame bytes (30 seconds, nothing installed)

```sh
cd dev-harness
python3 selfcheck.py
```

Expected: `7 passed, 0 failed`. This asserts the CRC and the full frame bytes
match the app's Rust parser test vectors (Link Statistics CRC `0xCD`, Device
Info CRC `0x74`). If it passes, the app will parse what the harness sends.

**If it fails, that is a real finding — please open an issue.** It means the
harness and `../src-tauri/src/crsf/mod.rs` have drifted apart, and one of them
is wrong.

## Step 2 — prove the transport (still nothing installed)

```sh
python3 loopback_smoke.py
```

Expected: `PASS  encode -> pty -> decode round-trip intact`, after decoding 11
frames (1 device-info, 10 link-stats). This exercises encode → real terminal
device → decode, which is exactly what the app's `serialport` reader does: it
opens a path and reads bytes.

**Steps 1 and 2 are the useful ones for a contributor with no hardware and no
setup.** Run them before and after any change to the CRSF parser — they catch a
wire-format regression that the Rust unit tests alone can miss, because they
check the format from the *outside*.

## Step 3 — simulate a connected device and drive the real app

Needs `socat`. The runner spawns the PTY pair for you:

```sh
python3 serial_runner.py
```

It prints something like:

```
[runner] socat PTY pair: /dev/pts/3  <->  /dev/pts/4
[runner] CONNECT THE APP TO:  /dev/pts/4
[runner] waiting for the app's Device Ping...
```

Start OmniLink (`npm run tauri dev` from the repository root), **type the
"CONNECT THE APP TO" path into the port field**, and connect. The runner prints
`got Device Ping -> sent Device Info` and begins streaming. The app should show
the simulated target name and firmware version, and live telemetry.

> The app's port picker lists known serial devices, so `/dev/pts/*` usually will
> not appear — type the path manually. The app opens it directly via
> `serialport::new(path, ...)`.

> PTYs ignore the 420000 baud rate the app requests. That is expected and
> harmless: baud is meaningless for a pseudo-terminal and the bytes pass through
> unchanged. It is also one of the things this harness therefore **cannot**
> verify.

### Options

```sh
python3 serial_runner.py \
  --name "BetaFPV Nano TX" \
  --device-type tx \          # tx (origin 0xEE) or rx (origin 0xEC)
  --rate-hz 25 \
  --fw-major 3 --fw-minor 5 --fw-patch 1
```

### Driving socat yourself

```sh
socat -d -d pty,raw,echo=0 pty,raw,echo=0
```

It prints two `PTY is /dev/pts/N` lines. Give one end to the runner and the
other to the app:

```sh
python3 serial_runner.py --port /dev/pts/3
# app: connect to /dev/pts/4
```

## Good first contributions here

- **Extend the encoder** to more CRSF frame types — Battery Sensor (`0x08`),
  Attitude (`0x1E`), GPS (`0x02`) — mirroring `../src-tauri/src/crsf/mod.rs`.
  GPS in particular would let someone exercise the map and flight-path code
  (M11 / M13) with no receiver.
- **Add failure modes** to `serial_runner.py`: link-degradation ramps, a
  mid-stream disconnect, truncated frames, CRC corruption. The app's error and
  reconnect handling is far easier to test against a device that misbehaves on
  purpose. Degradation ramps touch a genuinely blocked item — see
  `../docs/deferred_features_backlog.md` §2.5.
- **Port the PTY setup to native Windows**, if that turns out to be sensible.

## Wire-format reference (copied from the app, not invented)

All formats mirror `../src-tauri/src/crsf/mod.rs`. **That file is authoritative;
if the two disagree, the Rust side is right and this harness has a bug.**

- Frame: `[sync][length][type][payload...][crc8]`, where `length = type +
  payload + crc`, so the total on the wire is `length + 2`.
- CRC-8/DVB-S2, poly `0xD5`, init `0x00`, computed over `[type, payload...]`.
- **Device Info** (`0x29`, extended): `dest, origin, name\0, serial(4 BE),
  hw(4 BE), fw(4 BE), field_count, param_version`. The fw word `0x00MMmmpp`
  renders as `MM.mm.pp`.
- **Link Statistics** (`0x14`): 10 bytes — `uplinkRssi1, uplinkRssi2, uplinkLQ,
  uplinkSnr(i8), activeAntenna, rfMode, uplinkTxPower, downlinkRssi, downlinkLQ,
  downlinkSnr(i8)`. RSSI is a positive magnitude on the wire (`70` ⇒ −70 dBm).
- **Device Ping** (`0x28`) is sent by the app as `C8 04 28 00 EA 54`; the runner
  answers it.

## Notes

- `__pycache__/` and `*.pyc` are gitignored. Nothing here is bundled into the
  application, imported by application code, or shipped to users — it is a
  developer tool that happens to live in the same repository.
- Licence: GPL-3.0-or-later, the same as the rest of OmniLink. See `../LICENSE`.
