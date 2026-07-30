# Hardware validation protocols

**OmniLink has never been connected to a real ExpressLRS device.** Not once. The
serial path, the CRSF parser, the flash engine, the GPS decoder, the WiFi scanner
and the flight-controller bridge are all real code with real tests — but every
test runs against a mock, a fixture, or a fake device, because the maintainer owns
no ELRS hardware and cannot buy any.

That is the single biggest structural gap in this project, and it is the one gap
you can close in **thirty minutes with a radio you already own.**

This document is eight self-contained protocols. Pick one. Follow the numbered
steps. Paste the report block back into a
[hardware report issue](https://github.com/AbdulrahmanHR/OmniLink/issues/new?template=hardware_report.yml).
You do not need to read anything else first, and you do not need to understand
the codebase.

---

## Contents

| # | Protocol | Needs | Time |
|---|----------|-------|------|
| [HW-1](#hw-1--serial-connection-and-crsf-handshake) | Serial connection and CRSF handshake | Any ELRS TX or RX + USB cable | 10 min |
| [HW-2](#hw-2--live-telemetry-and-session-persistence) | Live telemetry and session persistence | A bound TX↔RX link | 20 min |
| [HW-3](#hw-3--firmware-flashing-and-the-safety-guards) | Firmware flashing and the safety guards | A flashable ELRS device you can re-flash | 30 min |
| [HW-4](#hw-4--gps-readout) | GPS readout | RX with GPS, outdoors | 20 min |
| [HW-5](#hw-5--live-flight-path-map) | Live flight-path map | HW-4 passing | 15 min |
| [HW-6](#hw-6--wifi-and-backpack-discovery) | WiFi and Backpack discovery | Device in WiFi mode | 15 min |
| [HW-7](#hw-7--session-recording-to-csv-round-trip) | Session recording → CSV round-trip | HW-2 passing | 15 min |
| [HW-8](#hw-8--flight-controller-bridge-read-only) | Flight-controller bridge (read-only) | Betaflight/iNav FC + RX | 30 min |

Also here:

- [Before you start](#before-you-start) — install, permissions, where the logs are
- [How to report](#how-to-report) — the three verdicts and why `blocked` is welcome
- [Safety](#safety) — read this if any protocol energizes a flight controller
- [For maintainers](#for-maintainers--the-developer-facing-companion) — the
  `file:line` companion document

---

## Before you start

### 1. Get a build

Either install a release from
[Releases](https://github.com/AbdulrahmanHR/OmniLink/releases), or build from
source with [`../CONTRIBUTING.md`](../CONTRIBUTING.md#building-omnilink) and run
the **native** shell:

```bash
npm run tauri dev
```

`npm run dev` (browser only) **cannot talk to hardware** — every device call
rejects gracefully and you will see honest empty states. If you are validating
hardware, you need `npm run tauri dev` or an installed build.

Record which you used. "Built from source at commit `abc1234`" and "installed the
3.0.0 `.deb`" are different environments and bugs differ between them.

### 2. Linux only — serial permissions

**This is the wall almost every first-time Linux user hits.** Opening
`/dev/ttyUSB*` or `/dev/ttyACM*` needs permission, and without it OmniLink
reports `Permission denied` on connect. Install the shipped udev rule:

```bash
sudo cp src-tauri/resources/linux/60-omnilink-elrs.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# then unplug and replug the device
```

If you installed the `.deb`, this is already done — just replug. For the
AppImage the rule ships beside the app at
`resources/linux/60-omnilink-elrs.rules`.

Blunter fallback, if you would rather not install a rule:

```bash
sudo usermod -aG dialout "$USER"   # then log out and back in
```

The rule covers Silicon Labs CP210x, WCH CH340/CH341, FTDI FT-series and
Espressif native-USB (ESP32-S2/S3/C3). **If your device is not covered, that is
itself a finding worth reporting** — paste the output of:

```bash
udevadm info -a -n /dev/ttyUSB0 | grep -E 'idVendor|idProduct' | head -4
```

### 3. Know where the logs are

Several protocols ask for log excerpts. OmniLink writes a daily-rotating
`omnilink-app.<date>.log` and, after a crash, `omnilink-crash.log`:

| OS | Location |
|----|----------|
| Linux | `~/.local/share/com.omnilink.app/logs/` |
| macOS | `~/Library/Logs/com.omnilink.app/` |
| Windows | `%APPDATA%\com.omnilink.app\logs\` |

Errors also surface in the app: click the red **Error** chip in the top bar to
expand the full message.

### 4. Scrub before you paste

**A binding phrase is a shared secret. Never paste one.** Also scrub GPS
coordinates of anywhere you care about, MAC addresses, IP addresses on your LAN,
and API keys. OmniLink's exports are scrubbed automatically; screenshots and log
excerpts are not.

---

## How to report

One issue per protocol, using the
[hardware report template](https://github.com/AbdulrahmanHR/OmniLink/issues/new?template=hardware_report.yml).
Each protocol below ends with a **Report** block — copy it, fill it in, paste it.

Three verdicts, and only three:

- **PASS** — you ran every step and observed what the protocol said you would.
- **FAIL** — you ran it and something differed. **This is the most valuable
  outcome.** Say exactly what you saw instead.
- **blocked** — you could not run it (missing gear, could not get a fix, ran out
  of time). Also genuinely useful: it tells the project which protocols need
  which hardware, and it costs you nothing to say.

**Do not report a PASS you did not observe.** A fabricated pass is worse than no
report at all, because it closes a gap that is still open on somebody's radio.
Partial is fine — "steps 1–4 PASS, step 5 blocked, no Backpack" is a great
report.

If you own the hardware and it worked, please also add a row to the
[compatibility matrix](../README.md#hardware-compatibility-matrix) in the same or
a follow-up pull request. That matrix is the project's only public evidence that
any of this runs.

---

## Safety

Three protocols can energize hardware. Read this once.

- **Props off. Always.** HW-3 and HW-8 power a flight controller and can reset a
  receiver. If a motor spins with a propeller attached, someone gets hurt.
- **Bench, not aircraft.** Put the craft on a bench, LiPo disconnected where the
  protocol allows it.
- **Flashing rewrites config.** HW-3 overwrites your device's options, including
  the bound UID. Note your current settings first, or expect to rebind. OmniLink
  writes a `.elrsp` backup before every flash, but do not rely on an unproven
  path to save you — that is what you are testing.
- **Do not transmit on a band you are not licensed for.** The regulatory domain
  is a legal setting, not a preference. If you are unsure, use the domain your
  device already had.
- **A failed flash can leave a device needing a manual recovery** (boot button,
  or a passthrough re-flash). Do not run HW-3 on hardware you cannot afford to
  recover.

---

## HW-1 — Serial connection and CRSF handshake

**What this proves.** That OmniLink can enumerate real serial ports, open the
right one, complete a CRSF handshake with a real ExpressLRS device, and read back
its true target name and firmware version. Everything else depends on this.

**You need:** any ExpressLRS TX module, handset with an internal module, or
receiver that presents a USB serial port. A USB cable. No link, no RX, no props.

**Time:** 10 minutes.

### Steps

1. Start OmniLink (native shell — see [Before you start](#before-you-start)).
   Leave the device unplugged.
2. Look at the top bar. It should offer **no** serial ports, or only ports
   belonging to other hardware. Note what it shows.
3. Plug the ELRS device in over USB. Within a couple of seconds a new port should
   appear in the port list **without you refreshing anything**.
4. Select the new port and click **Connect**.
5. Watch the device card. It should move through connecting to connected, then
   show the device's **target name** and **firmware version**.
6. Compare both against ground truth — the ExpressLRS Configurator, the device's
   own WiFi page, or the handset's ELRS Lua script. Write down both values.
7. Click **Disconnect**. The card should return to a clean disconnected state.
8. Reconnect. It should connect again with no restart and no stuck state.
9. **Unplug while connected.** OmniLink should notice the device is gone and
   surface an honest error or disconnected state — not sit on a stale "connected".
10. **Busy-port check.** With OmniLink disconnected, open the ExpressLRS
    Configurator (or any serial monitor) on the same port, then try to Connect in
    OmniLink. You should get a clear "port busy" message naming the problem — not
    a generic failure, and not a hang.

### What to observe

- The port appears on plug-in and disappears on unplug, without a manual refresh.
- The target name matches your device. **Read this one carefully:** the CRSF
  handshake reports a free-form *display* name ("BetaFPV 2400 TX"), which is not
  the same string as the build target (`BETAFPV_2400_TX`). Report exactly what the
  device card showed, character for character.
- The firmware version matches what the Configurator reports.
- No fabricated values. A firmware version of `0.0.0` is a known failure signature
  worth reporting verbatim — it means something answered the probe that was not
  the device you meant.
- Errors are specific: permission, busy port, or handshake timeout — never a bare
  "failed".

### Report

```
Protocol: HW-1 (serial + CRSF handshake)
Verdict: PASS / FAIL / blocked

Device:            (e.g. RadioMaster TX16S internal, ELRS 3.5.3)
Host OS + build:   (e.g. Ubuntu 24.04, built from source @ abc1234)
Serial port:       (e.g. /dev/ttyACM0, CP2102)

Target name shown by OmniLink:     ...
Target name per ExpressLRS Config: ...
Firmware shown by OmniLink:        ...
Firmware per ExpressLRS Config:    ...

Hotplug appear/disappear:  yes / no
Reconnect after disconnect: worked / failed
Unplug while connected:     what happened
Busy-port message:          what it said

Anything unexpected:
Log excerpt (omnilink-app.<date>.log, scrubbed):
```

---

## HW-2 — Live telemetry and session persistence

**What this proves.** That real CRSF Link Statistics frames off a real radio
decode into the right physical units, drive the dashboard, and persist to the
local SQLite database as a session — and that the numbers are *right*, not merely
present.

**You need:** a bound TX↔RX pair with telemetry enabled, the TX connected to the
host over USB. No props, no GPS needed.

**Time:** 20 minutes.

### Steps

1. Complete HW-1 first — you need a working connection.
2. Power the RX. Confirm the link is up on the radio itself (the handset shows a
   live LQ).
3. In OmniLink open **Telemetry**. RSSI, Link Quality, SNR, TX Power and Packet
   Rate should all be updating live.
4. **Cross-check against ground truth.** Read RSSI and LQ off your handset's own
   telemetry screen at the same moment. They should agree within a point or two.
   Write down both pairs.
5. **Check the packet rate.** OmniLink's Packet Rate reading should match the rate
   configured on the radio (50 / 150 / 250 / 500 Hz…). **This one is explicitly
   unverified in code** — the rate table is firmware-dependent and has never been
   checked against real hardware. If it disagrees, that is a real finding: report
   the configured rate and the displayed rate.
6. **Walk the link down.** Carry the RX away, or put your hand over the antenna,
   until LQ drops and RSSI falls. Watch the sparklines and the antenna polar plot
   respond. Both antennas (RSSI Ant 1 / Ant 2) should move if your RX has two.
7. **Push it to failsafe** if you safely can (RX out of range or powered off).
   Confirm OmniLink surfaces a link-loss alert rather than freezing on the last
   good value.
8. Bring the link back. Confirm the readings recover and any alert clears.
9. **Disconnect** in OmniLink. This closes the recording — a session is written
   automatically for every connection; there is no record button.
10. Open **Session Analysis** (`/analysis`) and find the session in the picker.
    Confirm its frame count and duration are plausible for how long you were
    connected, and that it is labelled with your device's target and firmware.
11. **Restart OmniLink.** The session must still be listed — that is the
    persistence half of this protocol.

### What to observe

- Values are physically sensible: RSSI negative dBm (roughly −20 to −130), LQ
  0–100 %, SNR in dB, TX power in mW matching your configured power.
- OmniLink agrees with the handset. A constant offset or a scaling error is
  exactly the class of bug this protocol exists to find.
- The polar plot responds to real antenna orientation, not just to noise.
- Nothing freezes on the last good frame when the link dies.
- The session survives an app restart with a sane frame count.

### Report

```
Protocol: HW-2 (live telemetry + session persistence)
Verdict: PASS / FAIL / blocked

TX / RX:            ...
ELRS firmware:      TX ......  RX ......
Configured rate:    ...... Hz     Displayed rate: ...... Hz
Configured power:   ...... mW     Displayed power: ...... mW

Simultaneous readings:
  Handset  RSSI ...... dBm   LQ ...... %
  OmniLink RSSI ...... dBm   LQ ...... %

Both antennas moved:        yes / no / single-antenna RX
Link-loss handling:         what you saw
Recovery:                   clean / stuck
Session frame count:        ......   duration: ......
Survived app restart:       yes / no

Anything unexpected:
```

---

## HW-3 — Firmware flashing and the safety guards

**Read [Safety](#safety) first.** This protocol writes firmware to your device
and rewrites its config.

**What this proves.** That the staged flash pipeline reaches real hardware, that a
config backup is written *before* the write stage, and — most importantly — that
the pre-flash guards refuse the flashes that would brick or mis-flash a device.
**The guard half matters more than the happy path.**

**You need:** a flashable ELRS device over USB that you can afford to re-flash and
rebind. Optionally a pre-built `firmware.bin` for that exact target, and
optionally an ExpressLRS Backpack in WiFi mode.

**Time:** 30 minutes.

### Steps

1. **Write down your current config first** — packet rate, power, regulatory
   domain, and the fact that you will need to rebind. Flashing overwrites options.
2. Connect the device (HW-1). Confirm OmniLink identifies it.
3. Open the flashing wizard and step Brand → Model → Frequency → Binding →
   Review, selecting the **correct** target for your connected device.
4. **Check the firmware list provenance.** The Frequency step should indicate the
   version list came live from ExpressLRS GitHub. Disconnect your network and
   reopen it: it should say honestly that it could not reach GitHub and is showing
   bundled versions. Reconnect.
5. Start the flash. Watch the staged progress: fetch → patch → erase → write →
   verify → done. Note where it fails if it fails.
6. On completion, confirm the device reboots on the new firmware and reconnects.
7. **Confirm the backup exists.** A timestamped `.elrsp` backup should have been
   written *before* the write stage — look in OmniLink's app-config directory
   under `backups/`. Note its filename and timestamp.
8. **Guard check 1 — TX/RX cross-class.** With a **TX** connected, deliberately
   select an **RX** target and start the flash. **It must be refused before
   anything is erased**, with a message about a TX/RX mismatch. Confirm your device
   still works afterwards.
9. **Guard check 2 — wrong model, same class.** Select a *different TX* target
   than the one connected. Report whether it is refused, allowed, or allowed with
   a warning. (This guard resolves the device's reported name against the
   catalogue; if the name is unresolvable it deliberately abstains rather than
   block a legitimate flash — so "allowed" may be correct. Report what happened
   either way.)
10. **Guard check 3 — retry stickiness.** After a refusal, click Start Flash
    again immediately. It must still be refused. (A refusal that evaporates on the
    second click was a real, fixed bug; this confirms it stays fixed on hardware.)
11. **Local-file path**, if you have a `.bin`: pick the known-good file for the
    connected target and flash. It should validate, then write verbatim.
12. **Local-file mismatch:** pick a `.bin` for the wrong class. It must be refused
    **before any write**.
13. **Backpack**, if you have one: put it in WiFi mode, select it, flash. Note
    what happens. **Expect this to fail or produce non-working firmware** — the
    Backpack image OmniLink ships is a documented placeholder, not a real binary.
    Reporting exactly how it fails is still useful.
14. **Backpack cross-type guard**, if you have one: select a TX-Backpack image
    against a VRX-Backpack device (or the reverse). It must be refused.

### What to observe

- Every stage transition appears, in order, with progress that moves.
- The backup file exists, is timestamped, and predates the write.
- **Every guard blocks before the device is touched.** A guard that fires *after*
  an erase has begun is a serious bug — report it immediately and stop.
- A refusal stays refused on retry.
- The device is still usable after each refused attempt.

### Report

```
Protocol: HW-3 (flashing + safety guards)
Verdict: PASS / FAIL / blocked

Device + target:      ...
Firmware flashed:     from ...... to ......
Connection:           UART / WiFi / Betaflight passthrough

Happy path:           reached which stage, completed yes/no
Device rebooted on new firmware: yes / no
Backup file:          path + timestamp (or "not found")
Backup predates write: yes / no / could not tell

Guard 1 TX/RX cross-class:   refused before erase / not refused / n/a
Guard 2 wrong model:         refused / allowed / warned  — and the message
Guard 3 refusal on retry:    still refused / allowed on 2nd click
Local .bin correct target:   validated + written / failed
Local .bin wrong class:      refused before write / not refused / n/a
Backpack flash:              what happened / n/a
Backpack cross-type guard:   refused / not refused / n/a

Device still usable at the end: yes / no — if no, what recovered it
Log excerpt (scrubbed):
```

---

## HW-4 — GPS readout

**What this proves.** That a real GPS fix arriving over CRSF decodes into correct
human units — coordinates, altitude in metres, ground speed, heading, satellite
count — and that the pre-fix state is honest rather than a fake `0,0` position.

**You need:** a bound TX↔RX link with a GPS module wired to the RX (or a flight
controller forwarding GPS over CRSF), and **a clear view of the sky**. This one
cannot be done indoors.

**Time:** 20 minutes, most of it waiting for a fix.

### Steps

1. Complete HW-2 — you need live telemetry first.
2. Take the RX + GPS outdoors, power everything, and open **Telemetry** with the
   TX connected to your laptop.
3. **Before the fix lands**, look at the GPS section. It should show an
   *acquiring* state with a satellite count climbing — **not** a location at
   latitude 0, longitude 0.
4. Wait for lock (a cold start can take several minutes).
5. After lock, read off latitude, longitude, altitude, ground speed, heading and
   satellites. Write them down.
6. **Cross-check the coordinates against a phone GPS** standing in the same spot.
   They should agree to a few metres.
7. **Cross-check the altitude.** It should be plausible metres above sea level for
   where you are. A reading offset by roughly +1000 m, or stuck at 0, is a
   specific known-risk failure — the CRSF wire format carries a +1000 m bias that
   OmniLink removes. Report the number either way.
8. Walk 50–100 m and confirm ground speed and heading respond sensibly. Walking
   speed should read a few km/h, not tens.
9. If you also have a **non-GPS** receiver, connect it and confirm the GPS section
   is absent or honestly empty — not showing stale values from the other device.

### What to observe

- Pre-fix: an acquiring state, no bogus `0,0`.
- Post-fix: coordinates matching a phone within a few metres.
- Altitude in real metres — not +1000 m off, not pinned at 0.
- Speed and heading move with you and have sane magnitudes.
- No GPS module ⇒ no GPS section, and no leftovers from a previous device.

### Report

```
Protocol: HW-4 (GPS readout)
Verdict: PASS / FAIL / blocked

RX + GPS module:      ...
ELRS firmware:        TX ......  RX ......

Pre-fix display:      what it showed
Satellites at lock:   ......

Altitude (OmniLink):  ...... m    Altitude (expected):  ...... m
Ground speed walking: ...... km/h
Heading responded:    yes / no

Coordinates matched a phone GPS: yes / no / off by ......
  (round or omit the coordinates themselves — do not publish somewhere you care about)

Non-GPS RX shows no GPS section: yes / no / n/a
Anything unexpected:
```

---

## HW-5 — Live flight-path map

**What this proves.** That a real GPS track drives the live flight-path map — the
last unproven link in the telemetry chain.

**You need:** HW-4 passing, plus room to move 50–100 m.

**Time:** 15 minutes.

### Steps

1. With a GPS fix live (HW-4), open **Telemetry** and find the **Flight Path**
   panel.
2. Confirm a marker appears at your actual position once the fix is valid, and
   **not** before it.
3. Walk a distinctive shape — an L, or a loop around a building.
4. Confirm the drawn path follows your real track, with the right shape and
   roughly the right scale.
5. Toggle the path's colour metric between RSSI and link quality. Confirm the
   colouring changes and corresponds to where your signal actually got worse.
6. **Expect the map background to be wrong.** The bundled offline tiles are
   **solid-colour placeholders, not real geography** — the framework is real, the
   tile data is not. A blank or flat-coloured backdrop is correct behaviour today.
   What matters is whether the *path* is right.
7. Note whether the view follows you or has to be panned manually.

### What to observe

- No marker at `(0,0)` before the fix.
- The path's shape and scale match what you walked.
- Metric colouring corresponds to real signal changes.
- A placeholder backdrop degrades gracefully — no error, no broken tiles.

### Report

```
Protocol: HW-5 (live flight-path map)
Verdict: PASS / FAIL / blocked

Shape walked:            (e.g. 80 m L-shape around a building)
Path shape correct:      yes / no — describe any distortion
Scale plausible:         yes / no
Marker before fix:       none / appeared at 0,0 / other
Metric colouring:        worked / no visible change
Tile backdrop:           placeholder as expected / error / other

Screenshot attached (crop out anything locating your home):  yes / no
Anything unexpected:
```

---

## HW-6 — WiFi and Backpack discovery

**What this proves.** That a real ExpressLRS device broadcasting its own WiFi
access point, or advertising over mDNS on your LAN, is found, correctly classified
as TX / RX / Backpack, and probed for its identity over HTTP.

**You need:** an ELRS device that can enter WiFi mode, a working WiFi adapter on
the host, and optionally an ExpressLRS Backpack.

**Time:** 15 minutes.

### Steps

1. Put the ELRS device into WiFi mode (usually a triple-press of the button, or
   the handset's ELRS menu). Confirm from your phone that an `ExpressLRS …` SSID
   is being broadcast.
2. In OmniLink, open the wizard's frequency/discovery step and start a scan.
3. Confirm the device appears, with the correct **kind** (TX or RX) and an address
   — typically `10.0.0.1` for a self-AP.
4. Note the **source label** the entry carries (self-AP versus mDNS).
5. If your device joins your home network in WiFi mode, confirm it is also found
   over **mDNS**, with its resolved LAN IPv4.
6. **Probe** the discovered device. The identity card should show its real name,
   type and firmware version.
7. Power the device **off** and probe again. It must degrade to "not reachable" —
   not throw an error, not hang.
8. **Backpack**, if you have one: power it in WiFi mode and rescan. It must appear
   as a **distinct** Backpack kind (`Backpack (TX)` / `Backpack (VRX)`).
9. **Non-leak check**, if you have both: confirm the Backpack does **not** appear
   in the plain TX/RX list, and the plain device does **not** appear as a
   Backpack. This boundary is deliberate and load-bearing.
10. If your host has no WiFi adapter, or WiFi is off, confirm OmniLink says so
    gracefully instead of failing obscurely.
11. **Serial-attached Backpack**, if you have a handset with an internal Backpack:
    connect over USB and check whether the Backpack is detected on the serial
    pass. **This path has never run with hardware attached** and currently returns
    an empty list; whether it works is genuinely unknown.

### What to observe

- The device is discovered with the right kind and address.
- Source labels distinguish self-AP from mDNS.
- A live probe returns the device's real identity; an absent device returns "not
  reachable" quietly.
- Backpacks and plain ELRS devices never leak into each other's lists.
- One device resolving on two addresses shows as **one** entry, not two.

### Report

```
Protocol: HW-6 (WiFi + Backpack discovery)
Verdict: PASS / FAIL / blocked

Device + how it entered WiFi mode:  ...
Host OS + WiFi adapter:             ...

SSID broadcast (phone-confirmed):   ...
Found by OmniLink:                  yes / no
Kind shown:                         TX / RX / Backpack (TX) / Backpack (VRX) / wrong
Address shown:                      ......    Source label: self-AP / mDNS
Also found over mDNS:               yes / no / n/a

Probe of live device:               identity shown — name/type/firmware
Probe of powered-off device:        "not reachable" / error / hang

Backpack appeared distinctly:       yes / no / n/a
Non-leak both directions:           held / leaked (describe) / n/a
Duplicate addresses collapsed:      yes / no / n/a
Serial-attached Backpack detected:  yes / no / n/a
No-adapter behaviour:               graceful / obscure / n/a

Anything unexpected:
```

---

## HW-7 — Session recording to CSV round-trip

**What this proves.** That a real recorded session — real link statistics, ideally
a real GPS track — exports to CSV correctly and re-imports to reproduce itself.
This is the path anyone uses to send you a recording of a problem, so if it is
lossy, every future bug report is degraded.

**You need:** HW-2 passing. GPS (HW-4) makes it a stronger test.

**Time:** 15 minutes.

### Steps

1. Connect the device and fly, walk, or wave the RX around for at least a minute
   so the session contains real variation — ideally a link dropout and, if you
   have GPS, a real track. Recording is automatic for the duration of the
   connection.
2. Disconnect to close the session.
3. Open **Session Analysis** and confirm the session lists with a plausible
   duration, frame count, and device label.
4. **Export** it to CSV. Open the file in a text editor — not a spreadsheet, which
   will reformat numbers.
5. Check the header row and the first few data rows. Timestamps should be integer
   milliseconds. GPS columns should hold real values where you had a fix and be
   **empty** where you had none.
6. **Re-import** the CSV into OmniLink and load it.
7. Scrub through it. The charts should reproduce what you recorded; if you had
   GPS, the path should match HW-5's track.
8. Play it back as a replay. Confirm a clear **SIMULATED** badge is shown
   throughout, so replayed data can never be mistaken for live.
9. Rename the session, then delete it. Confirm the list reflects both, and that a
   deleted session's data is really gone (restart the app and check).

### What to observe

- Duration and frame count match reality.
- The CSV is plain, readable, integer-millisecond timestamps.
- Empty GPS cells where there was no fix — not `0`, not `null` text.
- Export → re-import is lossless: the same shapes, the same dropout in the same
  place.
- The SIMULATED badge is present for the whole replay.

### Report

```
Protocol: HW-7 (session → CSV round-trip)
Verdict: PASS / FAIL / blocked

Session length:      ...... s     frames: ......
Contained a dropout: yes / no     GPS track: yes / no

CSV header row (paste the first line):
First two data rows (paste — scrub coordinates):

Timestamps integer ms:        yes / no
Empty GPS cells where no fix: yes / no / n/a
Re-import reproduced charts:  yes / no — describe any difference
GPS path matched:             yes / no / n/a
SIMULATED badge throughout:   yes / no
Rename + delete reflected:    yes / no
Delete survived restart:      yes / no

Anything unexpected:
```

---

## HW-8 — Flight-controller bridge (read-only)

**Read [Safety](#safety) first. Props off — this energizes a flight controller.**

**What this proves.** That a real Betaflight or iNav flight controller can be used
as a read-only passthrough bridge to an ELRS receiver: probed over MSP, asked for
UART passthrough, and read for troubleshooting context — **without ever being
configured by OmniLink.**

**The boundary is the point.** OmniLink is not a flight-controller configurator.
It issues exactly one write, `MSP_SET_PASSTHROUGH`, and nothing else. If you see
OmniLink change any FC setting, that is a serious bug — report it immediately.

**You need:** a Betaflight or iNav flight controller, an ELRS receiver wired to
one of its UARTs, USB to the FC. **Props off. On a bench. LiPo disconnected if the
FC powers from USB.**

**Time:** 30 minutes.

### Steps

1. Props off. Confirm it out loud. Put the craft on a bench.
2. Connect the flight controller to your host over USB. **Close Betaflight or iNav
   Configurator** — it holds the port exclusively.
3. In OmniLink's top bar, find the flight-controller bridge surface. Note the
   safety warning it shows before any probing action, and that it labels the
   device unmistakably as a **bridge**, not a managed device.
4. **Probe** the FC's port. Confirm OmniLink identifies the family (Betaflight or
   iNav), a firmware version, and an MSP API version. Cross-check the firmware
   version against the Configurator.
5. **Probe the wrong port** — the receiver's port, or an unrelated one. Confirm
   you get a specific "no flight controller responded" message, not a generic
   failure.
6. **Probe with the Configurator still open**, deliberately. Confirm you get a
   clear "port busy" message naming the cause.
7. Run the **guided passthrough check**. Watch its four steps: controller
   handshake → UART passthrough → receiver response → CRSF response. Note which
   step each stage reaches and its verdict.
8. If it succeeds, confirm the message says a valid CRSF frame was seen from the
   receiver.
9. If it fails, note the **specific failure category** offered — controller not
   responding, passthrough unavailable, RX not powered, RX not wired, CRSF
   timeout — and whether it matches reality. Then check the wiring hints it
   shows.
10. **Deliberately induce a failure:** unplug the receiver's power and rerun.
    OmniLink should say the receiver sent nothing back, i.e. it is probably not
    powered — not a generic timeout.
11. Try the **manual baud override** if auto-detection failed.
12. **Fetch the read-only controller context.** Confirm it shows the FC family,
    firmware, MSP API version and UART function assignments (Serial RX, MSP, GPS,
    Telemetry, Blackbox).
13. **Check the redaction.** Export the support report and read it before pasting
    anywhere. It must contain no serial numbers, no MAC addresses, and no
    identifiers — sanitisation is claimed and has never been checked against a
    real controller's response.
14. **THE BOUNDARY CHECK — the most important step.** Open Betaflight/iNav
    Configurator afterwards and confirm **nothing changed**: no altered UART
    assignments, no changed features, no modified settings. OmniLink must have
    written nothing except the passthrough request. Compare a settings diff if you
    can.
15. Confirm there is no "Controllers" section anywhere in OmniLink, no FC settings
    editor, and no FC firmware-flash option. Their absence is deliberate.

### What to observe

- A hardware-safety warning before every energizing action.
- The FC is labelled a bridge, never a managed device.
- The family and firmware match the Configurator.
- Failure categories are **specific** and match the fault you induced.
- The exported report carries no identifiers.
- **The FC's configuration is byte-identical afterwards.**

### Report

```
Protocol: HW-8 (flight-controller bridge, read-only)
Verdict: PASS / FAIL / blocked

Flight controller:      (board + Betaflight/iNav version)
Receiver + UART:        (e.g. EP1 on UART2)
Props off confirmed:    yes

Probe result:           family ......  firmware ......  MSP API ......
Matches Configurator:   yes / no
Wrong-port message:     what it said
Busy-port message:      what it said

Passthrough check:      which step reached, verdict per step
Success message:        ...
Induced RX-unpowered failure → category offered: ...
  Category matched reality:  yes / no
Manual baud override:   needed? worked?

Context fetch:          fields shown
UART functions correct: yes / no
Export contained identifiers: none / found (say which KIND, not the value)

BOUNDARY: FC config unchanged afterwards:   yes / NO  ← if NO, say so first
No Controllers section / settings editor / FC flash option:  confirmed / found one

Anything unexpected:
```

---

## Coverage map — which protocol closes which deferred acceptance

Eight areas of OmniLink are **code-complete with on-hardware acceptance
deferred**, because no radio was ever available to accept them. Each is described
below in its own terms, so this table stands alone: the internal identifiers are
included only because the issue tracker and changelog use them.

| Area (internal id) | What was built, and what is unproven | Protocol |
|---|---|---|
| Serial enumeration + CRSF handshake (**M6**) | Real serial port enumeration and a real CRSF handshake that reads the device's target name and firmware. Never run against a physical device. | [HW-1](#hw-1--serial-connection-and-crsf-handshake) |
| Telemetry engine + SQLite persistence (**M7**) | CRSF Link Statistics decoded to physical units, streamed to the dashboard and persisted as a session. Units and the packet-rate table are unverified against real firmware. | [HW-2](#hw-2--live-telemetry-and-session-persistence) |
| Firmware flashing engine (**M8**) | Staged flash pipeline with a pre-flash config backup and the TX/RX + target guards. No firmware has ever been written to a real device by this code. | [HW-3](#hw-3--firmware-flashing-and-the-safety-guards) |
| GPS telemetry + session CSV (**M11**) | GPS frames decoded from CRSF into coordinates, altitude, speed and heading; sessions exportable as CSV and re-importable. No real fix has ever been decoded. | [HW-4](#hw-4--gps-readout), [HW-7](#hw-7--session-recording-to-csv-round-trip) |
| Live flight-path map (**M13**) | A live track drawn from the telemetry store's GPS history. Never driven by real coordinates. | [HW-5](#hw-5--live-flight-path-map) |
| WiFi + Backpack discovery (**M18**, and the Backpack extension) | Self-AP SSID classification, mDNS browse, HTTP identity probe, and a distinct Backpack device class. No real device has ever broadcast to it. | [HW-6](#hw-6--wifi-and-backpack-discovery) |
| The v1.6 hardening pass (**M29**) | Not a feature: a hardening milestone that added mock and pure tests across all of the above and shipped the first manual acceptance script. Its acceptance is the union of HW-1 to HW-7. | [HW-1](#hw-1--serial-connection-and-crsf-handshake)–[HW-7](#hw-7--session-recording-to-csv-round-trip) |
| Flight-controller bridge (**M67**) | Read-only Betaflight/iNav MSP probe, guided passthrough diagnostics, sanitised context and a support-report export. Hardened against a fake controller only. | [HW-8](#hw-8--flight-controller-bridge-read-only) |

No deferred area is without a protocol, and no protocol is without an area.

## For maintainers — the developer-facing companion

[`v1.6.4_HW_VALIDATION.md`](v1.6.4_HW_VALIDATION.md) is the earlier, narrower
version of this document: four protocols written for someone who has the source
open, each listing the exact **code under test** as `file:line`, the
`HARDWARE-PENDING` markers it exercises, and the automated coverage that already
backs it without a device.

The two are deliberately different documents, not duplicates:

| | This file | `v1.6.4_HW_VALIDATION.md` |
|---|---|---|
| Audience | anyone with a radio | someone reading the source |
| Coverage | eight protocols | four (GPS/map, flash, WiFi, CSV) |
| Says where a failure lives | no | yes — `file:line` |
| Needs the codebase | no | yes |

If you are triaging a FAIL from this document, cross-reference the corresponding
section there for the seam to look at:

| This file | Companion section |
|-----------|-------------------|
| HW-4, HW-5 | §(a) GPS readout + live map track |
| HW-3 | §(b) Firmware flash incl. Backpack |
| HW-6 | §(c) WiFi / Backpack discovery + probe |
| HW-7 | §(d) Record → session browse → CSV export |
| HW-1, HW-2, HW-8 | no companion section — added here first |

Neither document has ever been executed on hardware. Both should be updated as
reports arrive: a protocol that turns out to be unclear or wrong is a defect in
the protocol.
