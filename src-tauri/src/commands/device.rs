//! Device discovery and connection commands (FR-DISC-01 → 07).
//!
//! M6-API: real serial-port enumeration + a live CRSF handshake replacing the
//! Phase-1 frontend mock. The flow is:
//!
//! 1. [`list_serial_ports`] enumerates attached serial ports for the UI.
//! 2. [`connect_device`] opens the chosen port at the ELRS CRSF baud
//!    (420000 8N1), spawns a reader thread that drives the [`crate::crsf`]
//!    state machine, sends a CRSF *Device Ping* and waits for a *Device Info*
//!    reply to learn the target name + firmware version.
//! 3. On success a `device://connected` event carries a [`DeviceInfoDto`] to
//!    the frontend; failures emit `device://error`; teardown emits
//!    `device://disconnected`.
//! 4. [`disconnect_device`] signals the reader thread to stop and close the
//!    port.
//!
//! Telemetry (M7-API) plugs in at the `device://link-stats` emit below — the
//! CRSF parser already decodes Link Statistics; M7 only needs to add a
//! frontend listener + store.
//!
//! # Firmware / config scan
//!
//! The handshake's Device Info (0x29) reply already gives us the device's
//! display name, firmware version, hardware version, serial number and the
//! **parameter count** — all surfaced to the UI via [`DeviceInfoDto`]. That is
//! the "firmware scan": enough to identify the device and whether it is the
//! firmware/target you expect.
//!
//! Reading the *full* configuration (binding-phrase/model-match state, packet
//! rate, telemetry ratio, etc.) requires walking the CRSF **parameter
//! protocol**: for each field `1..=param_count`, send a Parameter Read
//! ([`crate::crsf::param_read_frame`], type 0x2C) and reassemble the device's
//! Parameter Entry replies ([`crate::crsf::decode_param_entry`], type 0x2B),
//! which arrive *chunked* (only the first chunk carries the name/type; later
//! chunks must be concatenated) and whose value bytes must be decoded per the
//! field's `data_type` (UINT8/INT8/FLOAT/TEXT_SELECTION/STRING/FOLDER/…).
//! Folders nest, so a complete read is a tree walk. The framing + single-chunk
//! decode primitives are implemented and unit-tested in [`crate::crsf`]; the
//! remaining work for a full read is the stateful multi-chunk reassembly, the
//! per-`data_type` value parsing, and a `read_device_config` command/event.
//! That is deferred to a dedicated pass because it cannot be validated without
//! hardware in the loop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::crsf::{address, device_ping_to, DeviceInfo, Frame, GpsData, Parser};

/// Candidate CRSF serial baud rates, tried in order during the handshake.
///
/// `420000` is the ExpressLRS default; `400000` is used by some TX modules,
/// `115200` is the Betaflight passthrough / CLI rate, `921600` appears on some
/// high-rate links, and `416666` on a few older targets. Probing the list (a)
/// fixes the common "wrong baud → silence" failure and (b) lets us report which
/// baud actually worked.
const CANDIDATE_BAUDS: [u32; 5] = [420_000, 400_000, 115_200, 921_600, 416_666];
/// Per-read serial timeout. Short so the reader loop stays responsive to the
/// stop flag and re-pings on schedule.
const READ_TIMEOUT: Duration = Duration::from_millis(100);
/// How long to ping + listen on a single baud before moving to the next one.
/// Worst-case handshake time is `CANDIDATE_BAUDS.len() * PROBE_WINDOW` (~4.5s).
const PROBE_WINDOW: Duration = Duration::from_millis(900);
/// How often to (re)send the Device Ping while probing a baud. At 200ms over a
/// 900ms window we emit ~5 pings, enough to cycle through every dest/origin ping
/// variant at least once per baud.
const PING_INTERVAL: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// DTOs shared with the frontend (camelCase to match `DeviceInfo` in TS).
// ---------------------------------------------------------------------------

/// A serial port presented to the UI port picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    /// OS path / name, e.g. `/dev/ttyUSB0` or `COM3`.
    pub path: String,
    /// USB vendor id, when the port is a USB device.
    pub vendor_id: Option<u16>,
    /// USB product id, when known.
    pub product_id: Option<u16>,
    /// USB manufacturer string, when known.
    pub manufacturer: Option<String>,
    /// USB product string, when known.
    pub product: Option<String>,
}

/// Device info pushed to the frontend on a successful handshake. Mirrors the
/// `DeviceInfo` interface in `src/stores/device.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfoDto {
    pub target_name: String,
    /// `"major.minor.patch"`, or `null` when the device reported no firmware
    /// word at all (CONN-5 discipline, see [`DeviceInfo::firmware_version`]).
    /// A Betaflight FC answering our ping on the shared CRSF UART reports an
    /// all-zero triple; announcing that as `v0.0.0` puts a fabricated version in
    /// front of the user, into the pre-flash backup, and into the profile-import
    /// compat check — which then warns forever instead of abstaining.
    pub firmware_version: Option<String>,
    /// `"TX"`, `"RX"`, or `null` when the CRSF origin does not resolve to a
    /// class (CONN-5/FWCHK-3). `null` is the honest answer and the SAFE one:
    /// it is what makes [`crate::flash::guard::check_target_compatibility`]
    /// abstain instead of comparing against a fabricated class. See
    /// [`classify_device_type`].
    pub device_type: Option<String>,
    pub port: String,
    /// Baud rate the handshake actually succeeded at (from [`CANDIDATE_BAUDS`]).
    pub baud: u32,
    /// Number of configuration parameters the device exposes (from Device Info).
    /// This is the entry point for a full config read — see the module note on
    /// the CRSF parameter protocol.
    pub param_count: u8,
    /// Device serial number (big-endian word from Device Info).
    pub serial_number: u32,
    /// Hardware version word from Device Info.
    pub hardware_version: u32,
    /// Which reader thread emitted this (see [`DeviceManager::connect`]). The
    /// frontend drops events from a superseded generation, so a reader that was
    /// torn down mid-handshake can never announce a connection the user already
    /// cancelled.
    pub generation: u64,
}

/// Payload for the `device://error` event.
#[derive(Debug, Clone, Serialize)]
struct DeviceErrorDto {
    message: String,
    /// Emitting reader's generation — see [`DeviceInfoDto::generation`].
    generation: u64,
}

// ---------------------------------------------------------------------------
// Serial-port claims.
// ---------------------------------------------------------------------------

/// What OmniLink is doing with a serial port it currently holds open.
///
/// The app has four serial openers — the CRSF reader, the three controller-
/// bridge commands (`probe_bridge` / `fetch_bridge_context` /
/// `run_passthrough_check`) and a serial flash — and until they all went through
/// [`DeviceManager::claim_port`] they opened the port behind each other's backs.
/// Naming the holder is the whole point of this enum: the second claimer must be
/// told OmniLink itself has the port (see [`port_in_use_message`]), not sent off
/// to close a third-party program that is not even running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortUse {
    /// The CRSF reader thread behind [`connect_device`].
    Connection,
    /// The read-only MSP bridge probe (`probe_bridge`).
    ControllerProbe,
    /// The read-only controller-context fetch (`fetch_bridge_context`).
    ControllerContext,
    /// The guided passthrough check (`run_passthrough_check`) — the longest
    /// hold on this surface, up to ~14s.
    PassthroughCheck,
    /// A serial firmware flash (`start_flash` → esptool / MSP passthrough).
    Flash,
}

impl PortUse {
    /// How the holder is named to the user in [`port_in_use_message`].
    fn label(self) -> &'static str {
        match self {
            PortUse::Connection => "device connection",
            PortUse::ControllerProbe => "controller probe",
            PortUse::ControllerContext => "controller context fetch",
            PortUse::PassthroughCheck => "passthrough check",
            PortUse::Flash => "firmware flash",
        }
    }
}

/// The refusal handed to a second claimer of a port OmniLink already holds.
///
/// DELIBERATELY distinct from [`describe_open_error`]'s busy-port copy, which
/// tells the user to close the ExpressLRS Configurator / a serial monitor /
/// Betaflight Configurator. That advice is a lie when it is OmniLink's own
/// controller probe holding the port, and it sends the user hunting for a
/// program that is not running; naming the actual holder is the only message
/// they can act on.
fn port_in_use_message(port: &str, holder: PortUse) -> String {
    format!(
        "OmniLink is already using {port} ({}). Wait for it to finish — or stop it — then try \
         again.",
        holder.label()
    )
}

/// An RAII hold on one serial port, released on drop.
///
/// Drop is the only release path on purpose: the reader thread carries its claim
/// into the thread body, so a reader that exits — cleanly, by error return, or by
/// panic — cannot leak the port. Same for the flash worker.
#[derive(Debug)]
pub struct PortClaim {
    claims: Arc<Mutex<HashMap<String, PortUse>>>,
    port: String,
}

impl Drop for PortClaim {
    fn drop(&mut self) {
        // Never panic in a drop: a poisoned registry would abort the process
        // while unwinding. Poisoning is *recovered from* rather than swallowed —
        // every claimer runs inside `spawn_blocking`, so a panic holding this
        // lock only fails one command instead of taking the app down, and a
        // release skipped here would strand the port as "in use" for the rest of
        // the process. None of the guarded data has a torn invariant: the whole
        // critical section is a single `HashMap` insert or remove.
        self.claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.port);
    }
}

// ---------------------------------------------------------------------------
// Managed connection state.
// ---------------------------------------------------------------------------

/// A live reader thread plus the flag that stops it.
struct Connection {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    /// Monotonic id of this reader, mirrored onto its `device://*` payloads.
    generation: u64,
}

/// Tauri-managed handle to the active connection's reader thread, and the
/// app-wide registry of which serial ports OmniLink is holding open.
///
/// Every lock below is taken with `unwrap_or_else(|e| e.into_inner())`, never
/// `unwrap()`. Each critical section is a `HashMap` op, an `Option::take` /
/// `replace`, or a `format!`, so none of the guarded data can be left torn — but
/// the commands that take these locks all run on the blocking pool, where a
/// panic becomes an `Err` string rather than an aborting process. Propagating
/// poison would therefore convert one recoverable failure into a permanent one:
/// no port could be claimed, released, or connected to again for the lifetime of
/// the app.
#[derive(Default)]
pub struct DeviceManager {
    active: Mutex<Option<Connection>>,
    /// Serialises the whole connect / disconnect / flash-takeover sequence.
    ///
    /// `#[tauri::command]` bodies each run as their own task, so
    /// take → spawn → store used to interleave with a `disconnect_device` from
    /// the bar's Cancel: the disconnect found an empty slot, reported "nothing
    /// to tear down", and the connect then installed a reader the user had
    /// already cancelled — alive, owning the port, and unreachable.
    connect_lock: Mutex<()>,
    /// Ports OmniLink currently holds, and what for. Shared with every live
    /// [`PortClaim`] so a claim releases itself on drop.
    claims: Arc<Mutex<HashMap<String, PortUse>>>,
    /// Highest reader generation issued so far (the first reader is `1`).
    generations: AtomicU64,
    /// How many explicit disconnects have run. Sampled by [`Self::connect`]
    /// *before* it queues on `connect_lock`, so a Cancel that lands while the
    /// connect is queued supersedes it instead of racing it.
    disconnects: AtomicU64,
}

impl DeviceManager {
    /// Claim `port` for `holder`, or refuse with a message naming the OmniLink
    /// subsystem that already holds it.
    ///
    /// EVERY serial opener in the app goes through this. Before it existed the
    /// bridge commands opened the port with no claim at all, so during a ~14s
    /// passthrough check a Connect failed with EBUSY and
    /// [`describe_open_error`] blamed a third-party program, while
    /// `start_flash`'s teardown found nothing to release and esptool's
    /// busy-port failure surfaced to the user as a *wiring* fault — after the
    /// flash had already passed the point of no return.
    ///
    /// Claims are per-port: holding `/dev/ttyUSB0` never blocks a probe on
    /// `/dev/ttyACM0`.
    pub(crate) fn claim_port(&self, port: &str, holder: PortUse) -> Result<PortClaim, String> {
        let mut claims = self.claims.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&current) = claims.get(port) {
            return Err(port_in_use_message(port, current));
        }
        claims.insert(port.to_string(), holder);
        Ok(PortClaim {
            claims: Arc::clone(&self.claims),
            port: port.to_string(),
        })
    }

    /// Stop the active reader thread **and join it** before returning, so the
    /// serial port is fully released. This is what lets a rapid
    /// disconnect→reconnect (or a port switch) reopen the same port without
    /// hitting an "access denied / busy" race against the dying thread.
    ///
    /// `serialport` opens POSIX ports with `TIOCEXCL` + `flock(LOCK_EX)` (and
    /// exclusively on Windows), so esptool / the passthrough handshake cannot
    /// open a port this reader still holds — and the reader's [`PortClaim`] is
    /// only dropped once the thread has exited, i.e. by the time this returns.
    ///
    /// Returns `true` when a live connection was actually torn down, so the
    /// caller can emit `device://disconnected` exactly when one is warranted.
    ///
    /// Callers must already hold `connect_lock` (Rust mutexes are not
    /// reentrant); the three entry points that do are [`Self::connect`],
    /// [`Self::disconnect`] and [`Self::claim_for_flash`].
    fn stop_and_join_locked(&self) -> bool {
        // Take the connection out from under the lock, then join with the lock
        // released (the reader never touches the manager, so this can't deadlock).
        let conn = self.active.lock().unwrap_or_else(|e| e.into_inner()).take();
        match conn {
            Some(conn) => {
                conn.stop.store(true, Ordering::SeqCst);
                if conn.handle.join().is_err() {
                    tracing::error!(target: "device", "crsf-reader thread panicked before exit");
                }
                true
            }
            None => false,
        }
    }

    /// Tear down the active connection for an explicit disconnect, and supersede
    /// any connect still queued behind this call.
    ///
    /// Returns the highest generation issued so far: the frontend raises its
    /// event floor above it, so nothing a torn-down reader emitted on its way
    /// out can resurrect a connection the user just cancelled.
    pub(crate) fn disconnect(&self) -> u64 {
        let _seq = self.connect_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        self.stop_and_join_locked();
        self.generations.load(Ordering::SeqCst)
    }

    /// Release the CRSF reader **and** claim `port` for a serial flash in ONE
    /// critical section, so a connect queued behind the flash cannot slip in
    /// between the two and take the port back (CONN-1/FLASH-3).
    ///
    /// Returns whether a live connection was torn down (the caller emits
    /// `device://disconnected` for it) plus the flash's claim, which must stay
    /// alive for the whole flash. `port` is `None` only for a request the engine
    /// will reject with its own categorised "no serial port" error.
    pub(crate) fn claim_for_flash(
        &self,
        port: Option<&str>,
    ) -> Result<(bool, Option<PortClaim>), String> {
        let _seq = self.connect_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        let released = self.stop_and_join_locked();
        let claim = match port {
            Some(port) => Some(self.claim_port(port, PortUse::Flash)?),
            None => None,
        };
        Ok((released, claim))
    }

    /// The disconnect count as of *now*, to be handed back to [`Self::connect`].
    ///
    /// Sampled by `connect_device` at command entry rather than inside its
    /// `spawn_blocking` closure: the blocking pool may not start that closure
    /// for some time, and a Cancel landing in the gap would already have bumped
    /// the counter by the time the closure read it. The epochs would then match,
    /// the supersede check would pass, and a reader the user had cancelled would
    /// be installed anyway.
    pub(crate) fn connect_epoch(&self) -> u64 {
        self.disconnects.load(Ordering::SeqCst)
    }

    /// Open `port` and install its reader as the active connection.
    ///
    /// `requested_at` is [`Self::connect_epoch`] sampled when the user asked, so
    /// everything a disconnect does happens under `connect_lock` and a bump seen
    /// once we hold it means the disconnect was requested after this connect —
    /// i.e. it is a Cancel for THIS attempt, and spawning now would undo it.
    ///
    /// Returns the new reader's generation, or `0` when an explicit disconnect
    /// landed while this connect was queued (the bar's Cancel) — nothing was
    /// opened and the caller must leave the disconnect's state alone.
    pub(crate) fn connect(
        &self,
        app: &AppHandle,
        requested_at: u64,
        port: String,
    ) -> Result<u64, String> {
        self.install_reader(requested_at, &port, |generation, stop, claim| {
            let app = app.clone();
            let port = port.clone();
            std::thread::Builder::new()
                .name("crsf-reader".into())
                .spawn(move || reader_loop(app, port, stop, generation, claim))
                .map_err(|e| e.to_string())
        })
    }

    /// The lock-protected connect core: supersede check → tear down → claim →
    /// generation → spawn → install, all inside `connect_lock` so no
    /// `disconnect_device` can interleave with it. `requested_at` is the
    /// disconnect count sampled before the caller queued on the lock.
    ///
    /// The spawn is a callback so the sequencing can be unit-tested with a
    /// stand-in reader thread, without a Tauri `AppHandle`.
    fn install_reader(
        &self,
        requested_at: u64,
        port: &str,
        spawn: impl FnOnce(u64, Arc<AtomicBool>, PortClaim) -> Result<JoinHandle<()>, String>,
    ) -> Result<u64, String> {
        let _seq = self.connect_lock.lock().unwrap_or_else(|e| e.into_inner());
        if self.disconnects.load(Ordering::SeqCst) != requested_at {
            tracing::info!(
                target: "device",
                "connect to {port} superseded by a disconnect that arrived first"
            );
            return Ok(0);
        }

        // Tear down any prior connection first — joins the old reader so the
        // port (and its claim) is released before we try to reopen it.
        self.stop_and_join_locked();
        let claim = self.claim_port(port, PortUse::Connection)?;
        let generation = self.generations.fetch_add(1, Ordering::SeqCst) + 1;
        let stop = Arc::new(AtomicBool::new(false));
        let handle = spawn(generation, Arc::clone(&stop), claim)?;
        self.install(Connection {
            stop,
            handle,
            generation,
        });
        Ok(generation)
    }

    /// Install `conn` as the active connection.
    ///
    /// Defensive by design: the slot is emptied by every path that can fill it,
    /// so finding it occupied here is a bug — but a blind overwrite would DROP
    /// the previous [`Connection`], detaching its `JoinHandle` and dropping its
    /// stop flag without ever setting it, leaving that reader looping forever on
    /// the port and unreachable by `disconnect_device`. Stop and join it instead.
    fn install(&self, conn: Connection) {
        let previous = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(conn);
        if let Some(previous) = previous {
            tracing::warn!(
                target: "device",
                "a reader (generation {}) was still installed at connect — stopping it",
                previous.generation
            );
            previous.stop.store(true, Ordering::SeqCst);
            if previous.handle.join().is_err() {
                tracing::error!(target: "device", "crsf-reader thread panicked before exit");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

/// Enumerate available serial ports (FR-DISC-01).
///
/// Blocking body on the BLOCKING pool (CONN-3): `serialport::available_ports()`
/// is a blocking udev/IOKit/SetupAPI enumeration, and the frontend runs it on a
/// ~2s hotplug timer while nothing is connected (CONN-4).
/// `#[tauri::command(async)]` on a synchronous body is *not* enough — that runs
/// it via `async_runtime::spawn`, occupying one of only `available_parallelism()`
/// tokio workers, so a couple of slow serial commands could starve every other
/// device command. `spawn_blocking` keeps the workers free.
#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    tauri::async_runtime::spawn_blocking(enumerate_serial_ports)
        .await
        .map_err(|e| e.to_string())?
}

fn enumerate_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (vendor_id, product_id, manufacturer, product) = match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    (Some(usb.vid), Some(usb.pid), usb.manufacturer, usb.product)
                }
                _ => (None, None, None, None),
            };
            SerialPortInfo {
                path: p.port_name,
                vendor_id,
                product_id,
                manufacturer,
                product,
            }
        })
        .collect())
}

/// Open `port` and run the CRSF handshake. Returns once the reader thread is
/// spawned; the actual connection result arrives via `device://*` events.
///
/// Resolves with the new reader's **generation**, which the frontend uses as the
/// floor for accepting `device://*` events, or `0` when a disconnect superseded
/// this connect before it opened anything (see [`DeviceManager::connect`]).
///
/// Runs on the BLOCKING pool (CONN-3): spawning the reader is quick, but the
/// teardown ahead of it joins the previous reader thread. The `DeviceManager` is
/// re-fetched from the app handle inside the closure because a `State<'_, T>`
/// borrow cannot cross into `spawn_blocking`.
#[tauri::command]
pub async fn connect_device(app: AppHandle, port: String) -> Result<u64, String> {
    // Sampled HERE, not inside the closure: the supersede epoch has to date from
    // when the USER asked, and the blocking pool gives no promise about when the
    // closure starts. Sampling in there reads the count *after* a Cancel's
    // `disconnect_device` has bumped it, the epochs match, and the Cancel is
    // silently lost (see [`DeviceManager::connect_epoch`]).
    let requested_at = app.state::<DeviceManager>().connect_epoch();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let manager = handle.state::<DeviceManager>();
        manager.connect(&handle, requested_at, port)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tear down the active connection.
///
/// Resolves with the highest reader generation issued so far: the frontend
/// raises its event floor above it, so a straggler event from the reader this
/// call just joined cannot resurrect the connection the user cancelled.
///
/// Runs on the BLOCKING pool (CONN-3): the teardown waits for the reader thread
/// to exit, and on a tokio worker that wait could sit behind — and starve —
/// every other queued device command.
#[tauri::command]
pub async fn disconnect_device(app: AppHandle) -> Result<u64, String> {
    let handle = app.clone();
    let generation =
        tauri::async_runtime::spawn_blocking(move || handle.state::<DeviceManager>().disconnect())
            .await
            .map_err(|e| e.to_string())?;
    // Sole emitter of `device://disconnected`: the reader thread no longer emits
    // it on exit, so an explicit disconnect fires exactly one event (and a
    // port-switch reconnect fires none, avoiding a spurious disconnect blip).
    emit_or_log(&app, "device://disconnected", ());
    Ok(generation)
}

// ---------------------------------------------------------------------------
// Reader thread.
// ---------------------------------------------------------------------------

/// Diagnostics gathered while probing the candidate bauds, used to build a
/// descriptive failure message that distinguishes "saw nothing" from "saw
/// non-CRSF bytes" from "saw valid CRSF but no Device Info reply".
#[derive(Default)]
struct ProbeDiag {
    /// Bauds we actually probed (a `set_baud_rate` failure skips one).
    tried: Vec<u32>,
    /// Any bytes at all arrived on the wire (rules out a totally silent device).
    saw_bytes: bool,
    /// At least one CRC-valid CRSF frame parsed (proves baud + protocol, just
    /// not a Device Info answer to our ping).
    saw_crsf: bool,
    /// Destination of the first Device Info reply [`reply_is_addressed_to_us`]
    /// rejected, if any. Without it a rejected 0x29 is indistinguishable from no
    /// 0x29 at all, and [`Self::failure_message`] tells the user the device
    /// "didn't reply to a configurator ping" — a message that explicitly rules
    /// out the true cause and sends them off to unplug a working FC.
    saw_foreign_device_info: Option<u8>,
}

impl ProbeDiag {
    fn failure_message(&self, port: &str) -> String {
        // Defensive: `tried` is empty only when NO candidate baud could even be
        // applied, which means the port went away under us. Every branch below
        // interpolates the list, so without this guard the user was told the
        // device stayed silent "at any tried baud []".
        if self.tried.is_empty() {
            return format!(
                "Opened {port} but no CRSF baud rate could be applied to it, so the handshake \
                 never ran — the device was most likely unplugged or reset. Replug it, refresh \
                 the port list, then reconnect."
            );
        }
        let bauds = self
            .tried
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        // Checked BEFORE `saw_crsf`: a rejected 0x29 implies valid CRSF, so the
        // branch below would fire and claim nothing answered the ping.
        if let Some(dest) = self.saw_foreign_device_info {
            format!(
                "Opened {port} and a device DID answer our Device Ping with Device Info (0x29) \
                 across bauds [{bauds}], but it addressed the reply to {dest:#04X} — not to any \
                 address we pinged from, so it could not be matched to our handshake. This is \
                 unusual firmware behaviour rather than a wiring fault: please report it with \
                 your device model and this address."
            )
        } else if self.saw_crsf {
            format!(
                "Opened {port} and decoded valid CRSF frames, but no device answered our \
                 Device Ping with Device Info (0x29) across bauds [{bauds}]. The device is \
                 talking CRSF (e.g. streaming telemetry to a flight controller) but didn't \
                 reply to a configurator ping — try disconnecting it from the FC/handset so it \
                 can answer, then reconnect."
            )
        } else if self.saw_bytes {
            format!(
                "Opened {port} and received serial data, but none of it parsed as CRSF at any \
                 tried baud [{bauds}]. The device is likely in bootloader/passthrough mode or \
                 speaks a different protocol — power-cycle it out of bootloader and retry."
            )
        } else {
            format!(
                "Opened {port} but the device stayed silent — no reply to a CRSF Device Ping \
                 at any tried baud [{bauds}]. A bare receiver only emits CRSF when wired to a \
                 powered flight controller (RX TX pad → FC RX pad, common ground); a TX module \
                 must be seated in a powered handset/bay. Check wiring and power, then retry."
            )
        }
    }
}

/// Message for a port that went away *during* the handshake (unplug / reset /
/// USB re-enumeration), as distinct from a device that was merely silent.
///
/// [`ProbeDiag::failure_message`]'s silent branch sends the user off to re-check
/// wiring and power on a bare receiver — a wild-goose chase when the real cause
/// is that the port no longer exists, and the fix is to replug and refresh.
fn port_lost_message(port: &str, cause: &dyn std::fmt::Display) -> String {
    format!(
        "Port {port} disappeared during the handshake ({cause}) — the device was unplugged or \
         reset. Replug it, refresh the port list, then reconnect."
    )
}

/// Wire `deviceType` for a handshaken device: `"TX"` / `"RX"`, or `None` when
/// [`DeviceInfo::is_transmitter`] cannot resolve the CRSF origin address.
///
/// CONN-5/FWCHK-3: this used to collapse `None` into `"TX"` ("the common case
/// for a configurator"), which is a guess dressed up as a fact. The value flows
/// through `device://connected` → `connectedDeviceType` →
/// [`crate::flash::guard::check_target_compatibility`], and that guard is built
/// to ABSTAIN on `None` and to block on a concrete mismatch — so asserting "TX"
/// for an origin we could not classify (e.g. `0xEF` `ELRS_LUA`, an address this
/// app itself pings) let a TX-target flash sail past the guard onto a receiver.
/// Unknown must stay unknown all the way to the guard; the UI renders its own
/// "unknown" label for display.
fn classify_device_type(info: &DeviceInfo) -> Option<&'static str> {
    info.is_transmitter()
        .map(|is_tx| if is_tx { "TX" } else { "RX" })
}

/// Open the port, run the baud-scanning CRSF handshake, then stream frames.
///
/// Handshake: open once, then for each candidate baud retune the port, flush
/// stale bytes, and ping + listen for [`PROBE_WINDOW`]. The first baud that
/// yields a Device Info (0x29) reply wins; we report which baud worked and then
/// stream Link Statistics until stopped.
///
/// `_claim` is this reader's hold on the port ([`DeviceManager::claim_port`]),
/// taken before the thread was spawned and released when this function returns —
/// so the claim covers the open below and outlives every path out of the loop.
fn reader_loop(
    app: AppHandle,
    port: String,
    stop: Arc<AtomicBool>,
    generation: u64,
    _claim: PortClaim,
) {
    // Open at the first candidate baud; open failures (permission/busy/missing)
    // are baud-independent, so classify and bail immediately rather than retry.
    let mut serial = match serialport::new(&port, CANDIDATE_BAUDS[0])
        .timeout(READ_TIMEOUT)
        .open()
    {
        Ok(s) => s,
        Err(e) => {
            // Log the raw cause (M10 structured logging) before mapping it to a
            // user-facing, actionable message — so the terse OS error is never
            // lost even when we rewrite it for the UI.
            tracing::warn!(
                target: "device",
                "open failed port={port} kind={:?} raw=\"{e}\"",
                e.kind
            );
            emit_error(&app, generation, describe_open_error(&port, &e));
            return;
        }
    };

    // --- Handshake: scan the candidate bauds for a Device Info reply. --------
    let mut diag = ProbeDiag::default();
    let mut found: Option<(u32, DeviceInfo)> = None;
    // Set when the port itself dies mid-sweep. Every remaining candidate would
    // then be probed against a dead fd and the sweep would end on the "the
    // device stayed silent — check wiring and power" branch, which is the wrong
    // thing to tell someone who just unplugged the device.
    let mut port_lost: Option<String> = None;

    for &baud in &CANDIDATE_BAUDS {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        if let Err(e) = serial.set_baud_rate(baud) {
            // A rate the driver merely refuses costs one candidate; a port that
            // has gone away refuses them all, and `failure_message`'s empty-list
            // guard reports that case as port loss.
            tracing::warn!(target: "device", "set_baud_rate {baud} failed on {port}: {e}");
            continue;
        }
        // Drop bytes buffered at the previous baud so the parser only sees data
        // sampled at the new rate.
        let _ = serial.clear(serialport::ClearBuffer::All);
        diag.tried.push(baud);

        match probe_baud(serial.as_mut(), &port, &stop, &mut diag) {
            ProbeOutcome::Found(info) => {
                found = Some((baud, info));
                break;
            }
            ProbeOutcome::Silent => {}
            ProbeOutcome::PortLost(e) => {
                port_lost = Some(port_lost_message(&port, &e));
                break;
            }
        }
    }

    let (baud, info) = match found {
        Some(v) => v,
        None => {
            // Silent stop (disconnect/reconnect) must not emit an error.
            if stop.load(Ordering::SeqCst) {
                return;
            }
            tracing::warn!(
                target: "device",
                "handshake failed port={port} bauds={:?} saw_bytes={} saw_crsf={} port_lost={}",
                diag.tried, diag.saw_bytes, diag.saw_crsf, port_lost.is_some()
            );
            emit_error(
                &app,
                generation,
                port_lost.unwrap_or_else(|| diag.failure_message(&port)),
            );
            return;
        }
    };

    // --- Connected: announce the device, then stream telemetry. --------------
    let device_type = classify_device_type(&info);
    let firmware_version = info.firmware_version();
    tracing::info!(
        target: "device",
        "connected port={port} baud={baud} name=\"{}\" fw={} type={} \
         params={}",
        info.name,
        firmware_version.as_deref().unwrap_or("unknown"),
        device_type.unwrap_or("unknown"),
        info.field_count
    );
    let dto = DeviceInfoDto {
        target_name: info.name.clone(),
        firmware_version,
        device_type: device_type.map(str::to_string),
        port: port.clone(),
        baud,
        param_count: info.field_count,
        serial_number: info.serial_number,
        hardware_version: info.hardware_version,
        generation,
    };
    emit_or_log(&app, "device://connected", dto);

    // --- Stream loop: forward Link Statistics until stopped/unplugged. -------
    let mut parser = Parser::new();
    let mut buf = [0u8; 256];
    // M11: GPS (0x02) frames arrive independently of, and slower than, Link
    // Statistics (0x14). Hold the most recent GPS fix and attach it to each
    // emitted link-stats payload as the optional `gps` sub-object, so a single
    // event stream carries both and non-GPS devices simply emit `gps: null`.
    let mut latest_gps: Option<GpsData> = None;
    while !stop.load(Ordering::SeqCst) {
        let n = match serial.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => n,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                tracing::warn!(
                    target: "device",
                    "read failed port={port} kind={:?} raw=\"{e}\"",
                    e.kind()
                );
                emit_error(
                    &app,
                    generation,
                    format!("Lost connection to {port}: {e} (device unplugged or reset?)"),
                );
                return;
            }
        };

        for frame in parser.feed(&buf[..n]) {
            match frame {
                Frame::Gps(gps) => latest_gps = Some(gps),
                Frame::LinkStatistics(stats) => {
                    // M7-API telemetry hook: the parser already decodes link
                    // statistics; emit them (plus any latest GPS) for the
                    // frontend listener.
                    emit_or_log(
                        &app,
                        "device://link-stats",
                        stats_payload(&stats, latest_gps.as_ref()),
                    );
                }
                _ => {}
            }
        }
    }

    // Exited because the stop flag was set. The trigger (disconnect_device, or a
    // reconnect replacing this reader) owns the `device://disconnected` emit, so
    // we deliberately emit nothing here — avoids a duplicate event and a
    // disconnect blip when switching ports. Error paths above already returned
    // early after emitting `device://error`.
}

/// Result of probing ONE candidate baud.
enum ProbeOutcome {
    /// A Device Info reply we can attribute to our own ping.
    Found(DeviceInfo),
    /// The window elapsed (or a stop was requested) with no usable reply.
    Silent,
    /// The port itself failed — the remaining candidates would all be probed
    /// against a dead fd, so the sweep must stop here rather than end on the
    /// "check wiring and power" message.
    PortLost(std::io::Error),
}

/// The `(destination, origin)` pairs this app pings with, in rotation order.
///
/// The SINGLE source of truth for both halves of the handshake: [`probe_baud`]
/// builds its ping table from this list, and [`reply_is_addressed_to_us`]
/// derives its accept-list from the origins in it. A hand-maintained accept-list
/// alongside the table would let a new ping variant be added whose replies are
/// all silently dropped — the handshake fails, and it is reported as "no device
/// answered", with the whole suite still green.
const PING_VARIANTS: [(u8, u8); 4] = [
    (address::BROADCAST, address::RADIO_TRANSMITTER),
    (address::CRSF_TRANSMITTER, address::RADIO_TRANSMITTER),
    (address::CRSF_RECEIVER, address::RADIO_TRANSMITTER),
    (address::BROADCAST, address::ELRS_LUA),
];

/// Whether `info` is plausibly a reply to one of our pings rather than someone
/// else's traffic on a shared CRSF bus.
fn reply_is_addressed_to_us(info: &DeviceInfo) -> bool {
    info.destination == address::BROADCAST
        || PING_VARIANTS
            .iter()
            .any(|&(_, origin)| origin == info.destination)
}

/// Preference among Device Info responders — LOWER wins.
///
/// On the wiring this app's own probe-failure text tells the user to build
/// ("RX TX pad → FC RX pad, common ground") BOTH the ELRS receiver (origin
/// `0xEC`) and the flight controller (`0xC8`) answer a Device Ping. Taking
/// whichever replied first let the FC become "the connected device": its name,
/// its all-zero firmware word, and — via `is_transmitter`'s
/// `FLIGHT_CONTROLLER => Some(false)` — a CONCRETE `deviceType: "RX"` the flash
/// guard then treats as real evidence instead of abstaining. An ELRS endpoint
/// therefore always outranks the FC.
fn responder_rank(origin: u8) -> u8 {
    match origin {
        // The devices this app exists to configure.
        address::CRSF_TRANSMITTER | address::CRSF_RECEIVER => 0,
        // A known bystander on the shared UART: accepted only if it is the only
        // thing that answered at all.
        address::FLIGHT_CONTROLLER => 2,
        // Not the FC, but not identifiable either — still better evidence than
        // the FC, because `classify_device_type` will honestly abstain on it.
        _ => 1,
    }
}

/// Best Device Info responder seen during one probe window.
#[derive(Default)]
struct ResponderPick {
    best: Option<DeviceInfo>,
}

impl ResponderPick {
    /// Offer a decoded reply. Frames not addressed to one of our ping origins
    /// are dropped — and *recorded* on `diag`, because a drop here is the one
    /// handshake failure the sweep would otherwise describe backwards. Returns
    /// whether the pick is now conclusive.
    fn offer(&mut self, info: DeviceInfo, diag: &mut ProbeDiag) -> bool {
        if !reply_is_addressed_to_us(&info) {
            // LOUD on purpose: this filter is young and unverified against the
            // full spread of ELRS firmware, and before it existed the first
            // 0x29 simply won. If it ever rejects a reply that really was ours,
            // the log line and the failure message are the only evidence a
            // field report can carry.
            tracing::debug!(
                target: "device",
                "dropping Device Info from {:#04X} addressed to {:#04X}: not one of our ping origins",
                info.origin,
                info.destination
            );
            diag.saw_foreign_device_info.get_or_insert(info.destination);
            return false;
        }
        let better = match &self.best {
            Some(best) => responder_rank(info.origin) < responder_rank(best.origin),
            None => true,
        };
        if better {
            self.best = Some(info);
        }
        self.is_conclusive()
    }

    /// An ELRS endpoint answered: nothing better can arrive, so stop listening.
    fn is_conclusive(&self) -> bool {
        self.best
            .as_ref()
            .is_some_and(|best| responder_rank(best.origin) == 0)
    }

    fn take(self) -> Option<DeviceInfo> {
        self.best
    }
}

/// Ping a single baud and listen for a Device Info reply for [`PROBE_WINDOW`].
///
/// Records on `diag` whether any bytes / any valid CRSF frames were seen, so the
/// caller can build a precise failure message if every baud comes up empty.
///
/// Replies are *selected*, not taken first-come: a shared RX↔FC CRSF UART
/// carries more than one responder, so frames addressed to nobody we pinged as
/// are ignored and the remainder are ranked by [`responder_rank`]. The window
/// runs to completion unless an ELRS endpoint answers.
fn probe_baud(
    serial: &mut dyn serialport::SerialPort,
    port: &str,
    stop: &Arc<AtomicBool>,
    diag: &mut ProbeDiag,
) -> ProbeOutcome {
    // Cycle through the dest/origin pairs in [`PING_VARIANTS`]: a broadcast ping
    // is the common case, but some firmware only answers a directly-addressed
    // ping or one whose origin is the ELRS Lua endpoint. Rotating per ping keeps
    // any single device from being missed just because it ignores the broadcast
    // variant. Built from the same list `reply_is_addressed_to_us` accepts, so
    // the two can never drift apart.
    let pings = PING_VARIANTS.map(|(dest, origin)| device_ping_to(dest, origin));
    let mut ping_idx = 0usize;
    let mut parser = Parser::new();
    let mut buf = [0u8; 256];
    let mut pick = ResponderPick::default();

    let start = Instant::now();
    // Force a ping on the first iteration.
    let mut last_ping = start.checked_sub(PING_INTERVAL).unwrap_or(start);

    while start.elapsed() < PROBE_WINDOW {
        if stop.load(Ordering::SeqCst) {
            return ProbeOutcome::Silent;
        }

        if last_ping.elapsed() >= PING_INTERVAL {
            let ping = &pings[ping_idx % pings.len()];
            ping_idx += 1;
            if let Err(e) = serial.write_all(ping).and_then(|()| serial.flush()) {
                // Non-fatal: a dropped ping just costs one PING_INTERVAL. Log so
                // a persistently unwritable port is visible.
                tracing::warn!(target: "device", "ping write failed on {port}: {e}");
            }
            last_ping = Instant::now();
        }

        let n = match serial.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => n,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(e) => {
                // NOT "the device stayed silent": the port itself failed, so the
                // caller must abort the sweep and say so.
                tracing::warn!(target: "device", "read failed during probe port={port} raw=\"{e}\"");
                return ProbeOutcome::PortLost(e);
            }
        };
        diag.saw_bytes = true;

        for frame in parser.feed(&buf[..n]) {
            diag.saw_crsf = true;
            if let Frame::DeviceInfo(info) = frame {
                pick.offer(info, diag);
            }
        }
        // An ELRS endpoint answered — nothing better can arrive, so don't burn
        // the rest of the window. Any other responder is kept provisionally and
        // only wins if the window ends with nothing better.
        if pick.is_conclusive() {
            break;
        }
    }

    match pick.take() {
        Some(info) => ProbeOutcome::Found(info),
        None => ProbeOutcome::Silent,
    }
}

/// Serializable Link Statistics payload for the `device://link-stats` event.
/// (Defined here rather than in `crsf` to keep that module dependency-free.)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkStatsPayload {
    uplink_rssi_1: u8,
    uplink_rssi_2: u8,
    uplink_link_quality: u8,
    uplink_snr: i8,
    active_antenna: u8,
    rf_mode: u8,
    uplink_tx_power: u8,
    downlink_rssi: u8,
    downlink_link_quality: u8,
    downlink_snr: i8,
    /// Latest GPS fix (M11), `None` on non-GPS devices. Optional so the existing
    /// link-stats contract is unchanged for hardware without a GPS module.
    #[serde(skip_serializing_if = "Option::is_none")]
    gps: Option<GpsPayload>,
}

/// Serializable GPS payload nested in [`LinkStatsPayload`]. Raw scaled-integer
/// wire values (see [`crate::crsf::GpsData`]); the frontend applies scaling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GpsPayload {
    /// Latitude, degrees × 1e7 (signed).
    latitude: i32,
    /// Longitude, degrees × 1e7 (signed).
    longitude: i32,
    /// Ground speed, km/h × 10.
    ground_speed: u16,
    /// Heading, degrees × 100.
    heading: u16,
    /// Altitude in metres, offset by +1000 (real metres = value − 1000).
    altitude: u16,
    /// Number of satellites in the fix.
    satellites: u8,
}

fn stats_payload(s: &crate::crsf::LinkStatistics, gps: Option<&GpsData>) -> LinkStatsPayload {
    LinkStatsPayload {
        uplink_rssi_1: s.uplink_rssi_1,
        uplink_rssi_2: s.uplink_rssi_2,
        uplink_link_quality: s.uplink_link_quality,
        uplink_snr: s.uplink_snr,
        active_antenna: s.active_antenna,
        rf_mode: s.rf_mode,
        uplink_tx_power: s.uplink_tx_power,
        downlink_rssi: s.downlink_rssi,
        downlink_link_quality: s.downlink_link_quality,
        downlink_snr: s.downlink_snr,
        gps: gps.map(|g| GpsPayload {
            latitude: g.latitude,
            longitude: g.longitude,
            ground_speed: g.ground_speed,
            heading: g.heading,
            altitude: g.altitude,
            satellites: g.satellites,
        }),
    }
}

/// Emit a Tauri event, logging (rather than silently discarding) a failure.
///
/// Event emission is still best-effort — a failed emit must not crash the
/// reader thread or abort a command — but a dropped `device://*` event means
/// the UI silently misses a connect/disconnect/telemetry update, so we surface
/// it on stderr instead of swallowing it with `let _ =`.
fn emit_or_log<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        tracing::warn!(target: "device", "failed to emit {event}: {e}");
    }
}

fn emit_error(app: &AppHandle, generation: u64, message: String) {
    emit_or_log(
        app,
        "device://error",
        DeviceErrorDto {
            message,
            generation,
        },
    );
}

/// Translate a serial-port open failure into a clear, actionable message.
///
/// The raw `serialport::Error` Display is terse (e.g. just "Permission denied")
/// and gives the user no idea how to fix it. We classify the common
/// ELRS-on-desktop failure modes and append concrete next steps — most
/// importantly the Linux dialout/udev permission case, which is the single most
/// common reason a freshly-plugged ExpressLRS device fails to open on Linux.
fn describe_open_error(port: &str, err: &serialport::Error) -> String {
    use serialport::ErrorKind;
    use std::io::ErrorKind as IoKind;

    match err.kind {
        ErrorKind::Io(IoKind::PermissionDenied) => permission_denied_message(port),
        ErrorKind::NoDevice | ErrorKind::Io(IoKind::NotFound) => format!(
            "Port {port} is no longer available — unplug/replug the device and refresh the \
             port list."
        ),
        // EBUSY / port held open by another program (ExpressLRS Configurator, a
        // serial monitor, Betaflight Configurator, a stale process, ...).
        ErrorKind::Io(IoKind::ResourceBusy) | ErrorKind::Io(IoKind::AddrInUse) => format!(
            "Port {port} is busy — another program is using it. Close the ExpressLRS \
             Configurator, any serial monitor, or Betaflight Configurator, then try again."
        ),
        _ => format!("Failed to open {port}: {err}"),
    }
}

/// Permission-denied guidance. On Linux this is almost always the user not being
/// in the `dialout` group (or a missing udev rule), so we spell out the fix.
fn permission_denied_message(port: &str) -> String {
    if cfg!(target_os = "linux") {
        format!(
            "Permission denied opening {port}. On Linux your user needs access to the serial \
             device. Fix it with:\n  \
             sudo usermod -aG dialout $USER\n\
             then log out and back in (or reboot). Alternatively install a udev rule for the \
             device. See the project README (Linux serial permissions / udev rules)."
        )
    } else {
        format!(
            "Permission denied opening {port}. The port may be held open by another program \
             (close any serial monitor / configurator) or require elevated permissions."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crsf::{crc8, LinkStatistics};

    /// Build a CRC-valid CRSF frame (`sync`,`len`,`type`,payload,`crc8`) the way
    /// the real device stream emits it, so [`Parser`] decodes it verbatim. The
    /// CRC covers `[type, payload...]`, exactly as [`Parser::feed`] recomputes.
    fn crsf_frame(frame_type: u8, payload: &[u8]) -> Vec<u8> {
        let len = (payload.len() + 2) as u8; // type + payload + crc
        let mut f = vec![address::FLIGHT_CONTROLLER, len, frame_type];
        f.extend_from_slice(payload);
        let crc = crc8(&f[2..]);
        f.push(crc);
        f
    }

    /// 15-byte big-endian GPS payload (lat/lon i32, gs/hdg/alt u16, sats u8).
    fn gps_payload(lat: i32, lon: i32, gs: u16, hdg: u16, alt: u16, sats: u8) -> Vec<u8> {
        let mut p = Vec::with_capacity(15);
        p.extend_from_slice(&lat.to_be_bytes());
        p.extend_from_slice(&lon.to_be_bytes());
        p.extend_from_slice(&gs.to_be_bytes());
        p.extend_from_slice(&hdg.to_be_bytes());
        p.extend_from_slice(&alt.to_be_bytes());
        p.push(sats);
        p
    }

    #[test]
    fn releasing_the_connection_reports_whether_the_port_was_taken() {
        // The serial port is released only once the reader thread is joined —
        // `start_flash` relies on that (and on the returned flag) to hand an
        // unlocked port to esptool / the passthrough handshake (CONN-1).
        let manager = DeviceManager::default();
        assert!(
            !manager.claim_for_flash(None).unwrap().0,
            "no connection -> nothing released"
        );

        // Stand-in for `reader_loop`'s stream loop: parks until the stop flag is
        // set, so a join that didn't signal would hang the test.
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let handle = std::thread::spawn(move || {
            while !stop_for_thread.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        *manager.active.lock().unwrap() = Some(Connection {
            stop,
            handle,
            generation: 1,
        });

        assert!(
            manager.claim_for_flash(None).unwrap().0,
            "the live reader was stopped + joined"
        );
        assert!(manager.active.lock().unwrap().is_none());
        // Idempotent: a second release (e.g. the frontend disconnect followed by
        // the server-side one in `start_flash`) is a silent no-op.
        assert!(!manager.claim_for_flash(None).unwrap().0);
    }

    /// Stand-in for `reader_loop`: parks until the stop flag is set, holding the
    /// port claim exactly as the real reader does (so the claim is released only
    /// once the thread has actually exited).
    fn park_until_stopped(stop: Arc<AtomicBool>, claim: PortClaim) -> JoinHandle<()> {
        std::thread::spawn(move || {
            let _claim = claim;
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    }

    #[test]
    fn a_second_claimer_is_told_omnilink_holds_the_port_not_a_third_party() {
        // FIX 2A. The bridge commands used to open the port with no claim at
        // all, so a Connect during a ~14s passthrough check failed with EBUSY
        // and `describe_open_error` sent the user off to close the ExpressLRS
        // Configurator / Betaflight Configurator — while OmniLink itself held
        // the port. The refusal must name the real holder.
        let manager = DeviceManager::default();
        let _held = manager
            .claim_port("/dev/ttyUSB0", PortUse::PassthroughCheck)
            .expect("the port is free");

        let refused = manager
            .claim_port("/dev/ttyUSB0", PortUse::Connection)
            .expect_err("a second claimer must be refused");
        assert!(refused.contains("OmniLink is already using /dev/ttyUSB0"));
        assert!(
            refused.contains("passthrough check"),
            "the refusal names which OmniLink operation holds the port: {refused}"
        );
        // Never the third-party text — that is the lie this fix exists to stop.
        assert!(!refused.contains("ExpressLRS Configurator"));
        assert!(!refused.contains("Betaflight Configurator"));
        assert!(!refused.contains("serial monitor"));
    }

    #[test]
    fn claims_are_per_port_and_released_on_drop() {
        let manager = DeviceManager::default();
        let held = manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("free");
        // A different port is untouched: probing an FC on ttyACM0 while ttyUSB0
        // is busy must not be false-blocked.
        let other = manager
            .claim_port("/dev/ttyACM0", PortUse::ControllerContext)
            .expect("a different port is still free");

        drop(held);
        // RAII: the release needs no explicit call, which is what makes a
        // panicking reader/worker thread unable to leak the port.
        manager
            .claim_port("/dev/ttyUSB0", PortUse::Flash)
            .expect("the dropped claim released the port");
        drop(other);
    }

    #[test]
    fn installing_over_a_straggler_stops_it_instead_of_dropping_it_on_the_floor() {
        // FIX 2B. A blind `*active.lock() = Some(...)` DROPPED the previous
        // `Connection`: its `JoinHandle` detached and its stop flag was dropped
        // without ever being set, so that reader looped forever on the port,
        // unreachable by `disconnect_device`.
        let manager = DeviceManager::default();
        let straggler_stop = Arc::new(AtomicBool::new(false));
        let straggler_claim = manager
            .claim_port("/dev/ttyUSB0", PortUse::Connection)
            .expect("free");
        let straggler = park_until_stopped(Arc::clone(&straggler_stop), straggler_claim);
        *manager.active.lock().unwrap() = Some(Connection {
            stop: Arc::clone(&straggler_stop),
            handle: straggler,
            generation: 7,
        });

        let stop = Arc::new(AtomicBool::new(false));
        let claim = manager
            .claim_port("/dev/ttyACM0", PortUse::Connection)
            .expect("free");
        manager.install(Connection {
            stop: Arc::clone(&stop),
            handle: park_until_stopped(Arc::clone(&stop), claim),
            generation: 8,
        });

        // The straggler was signalled and joined (the join would hang forever if
        // the flag had merely been dropped), so its port is free again.
        assert!(straggler_stop.load(Ordering::SeqCst));
        manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("the straggler released its claim on the way out");
        manager.disconnect();
        assert!(manager.active.lock().unwrap().is_none());
    }

    #[test]
    fn a_disconnect_cannot_interleave_between_the_spawn_and_the_install() {
        // FIX 2B, the reported race: connect took (None) → spawned reader A →
        // was preempted; disconnect took (still None), reported "nothing to tear
        // down" and told the UI it was disconnected; connect then stored A —
        // alive, owning the port, unreachable. The whole sequence is now one
        // critical section, so the cancel lands *after* the install and really
        // tears the reader down.
        let manager = Arc::new(DeviceManager::default());
        let inside = Arc::new(AtomicBool::new(false));

        let connector = {
            let manager = Arc::clone(&manager);
            let inside = Arc::clone(&inside);
            std::thread::spawn(move || {
                let requested_at = manager.connect_epoch();
                manager.install_reader(requested_at, "/dev/ttyUSB0", |_generation, stop, claim| {
                    inside.store(true, Ordering::SeqCst);
                    // Hold the old spawn→install window wide open, so a
                    // disconnect racing it has every chance to slip in.
                    std::thread::sleep(Duration::from_millis(50));
                    Ok(park_until_stopped(stop, claim))
                })
            })
        };

        while !inside.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let disconnector = {
            let manager = Arc::clone(&manager);
            std::thread::spawn(move || manager.disconnect())
        };

        let generation = connector.join().unwrap().expect("the reader was installed");
        // A hang here would mean the disconnect never reached the reader.
        disconnector.join().unwrap();

        assert_eq!(generation, 1, "the first reader is generation 1");
        assert!(
            manager.active.lock().unwrap().is_none(),
            "the cancel tore the installed reader down"
        );
        manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("no orphan reader is left holding the port");
    }

    #[test]
    fn a_disconnect_requested_while_the_connect_was_queued_supersedes_it() {
        // The other half of the same race: the Cancel is requested first but the
        // connect wins the lock. Spawning then would leave the user staring at a
        // "Disconnected" bar while a reader they cancelled owns the port.
        let manager = DeviceManager::default();
        let requested_at = manager.connect_epoch();
        manager.disconnect();

        let spawned = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&spawned);
        let generation = manager
            .install_reader(
                requested_at,
                "/dev/ttyUSB0",
                move |_generation, _stop, _claim| {
                    flag.store(true, Ordering::SeqCst);
                    unreachable!("a superseded connect must never spawn a reader");
                },
            )
            .expect("a supersede is not an error");

        assert_eq!(generation, 0, "0 = superseded, nothing was opened");
        assert!(!spawned.load(Ordering::SeqCst));
        assert!(manager.active.lock().unwrap().is_none());
        manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("the port was never claimed");
    }

    #[test]
    fn a_flash_takeover_releases_the_reader_and_claims_the_port_in_one_step() {
        // CONN-1/FLASH-3: `stop_and_join` then claim, as two separate critical
        // sections, lets a connect slip in between and take the port back before
        // esptool ever opens it. `claim_for_flash` does both under one lock.
        let manager = DeviceManager::default();
        let stop = Arc::new(AtomicBool::new(false));
        let claim = manager
            .claim_port("/dev/ttyUSB0", PortUse::Connection)
            .expect("free");
        *manager.active.lock().unwrap() = Some(Connection {
            stop: Arc::clone(&stop),
            handle: park_until_stopped(Arc::clone(&stop), claim),
            generation: 1,
        });

        let (released, flash_claim) = manager
            .claim_for_flash(Some("/dev/ttyUSB0"))
            .expect("the reader's claim is released before the flash claims it");
        assert!(released, "the live connection was torn down");
        assert!(flash_claim.is_some());
        // While the flash holds it, a bridge probe is refused by name…
        let refused = manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect_err("the flash owns the port");
        assert!(refused.contains("firmware flash"));
        // …and it is free again once the worker's claim drops.
        drop(flash_claim);
        manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("the flash released the port");
    }

    #[test]
    fn a_poisoned_lock_wedges_neither_claiming_nor_releasing_nor_connecting() {
        // FIX 9C: `PortClaim::drop` swallowed a poisoned `claims` ("the app is
        // already down") while `claim_port` did `.lock().unwrap()`. Since every
        // claimer moved into `spawn_blocking`, a panic under one of these locks
        // is an `Err` string, not an aborting process — so ONE poisoning event
        // meant releases stopped working AND every later claim panicked: no
        // serial port could be opened again for the life of the app. None of the
        // guarded data has a torn invariant (a `HashMap` op, an `Option`
        // take/replace, a `format!`), so poison is recovered from.
        let manager = Arc::new(DeviceManager::default());
        for poison in [0usize, 1, 2] {
            let m = Arc::clone(&manager);
            // Deliberate panic while holding each lock in turn.
            let _ = std::thread::spawn(move || match poison {
                0 => {
                    let _g = m.claims.lock().unwrap();
                    panic!("poison the claims registry");
                }
                1 => {
                    let _g = m.active.lock().unwrap();
                    panic!("poison the active slot");
                }
                _ => {
                    let _g = m.connect_lock.lock().unwrap();
                    panic!("poison the connect lock");
                }
            })
            .join();
        }
        assert!(manager.claims.lock().is_err(), "the test poisoned it");

        // Claim → release → claim again, all through poisoned locks.
        let claim = manager
            .claim_port("/dev/ttyUSB0", PortUse::ControllerProbe)
            .expect("a poisoned registry must not refuse (or panic on) a claim");
        assert!(manager
            .claim_port("/dev/ttyUSB0", PortUse::Connection)
            .is_err());
        drop(claim);
        let claim = manager
            .claim_port("/dev/ttyUSB0", PortUse::Connection)
            .expect("the release still ran, so the port is free again");
        drop(claim);

        // …and the connect/disconnect path is not wedged either.
        assert_eq!(manager.disconnect(), 0, "nothing was connected");
        manager
            .claim_for_flash(Some("/dev/ttyUSB0"))
            .expect("a flash can still take the port");
    }

    #[test]
    fn the_supersede_epoch_must_date_from_the_request_not_from_the_blocking_task() {
        // FIX 9D: `requested_at` was sampled INSIDE `connect_device`'s
        // `spawn_blocking` closure. The blocking pool gives no promise about
        // when that closure starts, so a Cancel landing in the gap bumped the
        // counter first, the late sample matched it, and the supersede check
        // passed — installing a reader the user had already cancelled.
        let manager = DeviceManager::default();
        let at_request = manager.connect_epoch();
        manager.disconnect(); // the user's Cancel, while the task is still queued
        let after_the_cancel = manager.connect_epoch();
        assert_ne!(
            at_request, after_the_cancel,
            "the Cancel is only visible to an epoch sampled after it"
        );

        // Sampled late (the old behaviour): the Cancel is invisible and a reader
        // gets installed anyway.
        let generation = manager
            .install_reader(after_the_cancel, "/dev/ttyUSB0", |_g, stop, claim| {
                Ok(park_until_stopped(stop, claim))
            })
            .expect("the late sample matches, so nothing supersedes this connect");
        assert_ne!(generation, 0, "this is the bug: the cancelled reader ran");
        manager.disconnect();

        // Sampled at command entry (what `connect_device` does now): superseded.
        assert_eq!(
            manager
                .install_reader(at_request, "/dev/ttyUSB0", |_g, _stop, _claim| {
                    unreachable!("a superseded connect must never spawn a reader")
                })
                .expect("a supersede is not an error"),
            0
        );
    }

    /// A decoded Device Info reply whose only interesting field here is the
    /// extended-header `origin` address.
    fn device_info_from(origin: u8) -> DeviceInfo {
        DeviceInfo {
            destination: address::RADIO_TRANSMITTER,
            origin,
            name: "ELRS Device".into(),
            serial_number: 0,
            hardware_version: 0,
            firmware_version_raw: 0x0003_0503,
            field_count: 12,
            parameter_version: 0,
        }
    }

    #[test]
    fn device_type_is_none_for_an_unclassifiable_origin_and_the_guard_abstains() {
        // CONN-5/FWCHK-3 regression marker. `is_transmitter()` resolves only
        // {0xEE, 0xEA, 0xEC, 0xC8}; every other origin — including 0xEF
        // (ELRS_LUA), an address this app itself pings during discovery — is
        // ambiguous. The old mapping collapsed that ambiguity to "TX", so an RX
        // answering from an unclassified address was ANNOUNCED as a transmitter
        // and a TX-firmware flash was allowed onto it. The wire value must stay
        // `None` …
        assert_eq!(
            classify_device_type(&device_info_from(address::ELRS_LUA)),
            None,
            "an origin the classifier cannot resolve must never be asserted as TX"
        );
        assert_eq!(classify_device_type(&device_info_from(0x00)), None);

        // … and `None` is exactly what makes the flash guard abstain instead of
        // comparing against a fabricated class (the guard's own unit tests pin
        // the concrete-mismatch behaviour).
        use crate::flash::DeviceType;
        assert!(
            crate::flash::guard::check_target_compatibility(None, DeviceType::Tx).is_ok(),
            "an unknown connected type must leave the guard undecided, not passing"
        );
        assert!(crate::flash::guard::check_target_compatibility(None, DeviceType::Rx).is_ok());
    }

    #[test]
    fn device_type_still_reports_the_classifiable_origins() {
        // The addresses we CAN resolve keep their concrete class, so the guard
        // still sees real evidence when there is any.
        assert_eq!(
            classify_device_type(&device_info_from(address::CRSF_TRANSMITTER)),
            Some("TX")
        );
        assert_eq!(
            classify_device_type(&device_info_from(address::RADIO_TRANSMITTER)),
            Some("TX")
        );
        assert_eq!(
            classify_device_type(&device_info_from(address::CRSF_RECEIVER)),
            Some("RX")
        );
        // A flight controller is the link's RX side.
        assert_eq!(
            classify_device_type(&device_info_from(address::FLIGHT_CONTROLLER)),
            Some("RX")
        );
    }

    #[test]
    fn unclassified_device_type_serializes_as_null() {
        // The seam the frontend reads: `deviceType` must arrive as JSON `null`
        // (→ `connectedDeviceType: null` in the flash request), not as the
        // string "unknown" and certainly not as "TX".
        let dto = DeviceInfoDto {
            target_name: "ELRS Device".into(),
            firmware_version: Some("3.5.3".into()),
            device_type: classify_device_type(&device_info_from(address::ELRS_LUA))
                .map(str::to_string),
            port: "/dev/ttyUSB0".into(),
            baud: 420_000,
            param_count: 12,
            serial_number: 0,
            hardware_version: 0,
            generation: 1,
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["deviceType"], serde_json::Value::Null);
        // The generation travels with the event so the frontend can drop a
        // superseded reader's announcement (FIX 2B).
        assert_eq!(json["generation"], 1);
    }

    #[test]
    fn an_unreported_firmware_version_serializes_as_null() {
        // The same seam, for the firmware word. A Betaflight FC answering our
        // ping on the shared CRSF UART sends an all-zero triple; the DTO must
        // carry JSON `null` so the UI can label it "unknown" instead of
        // rendering a fabricated `v0.0.0` as fact.
        let mut info = device_info_from(address::FLIGHT_CONTROLLER);
        info.firmware_version_raw = 0;
        let dto = DeviceInfoDto {
            target_name: info.name.clone(),
            firmware_version: info.firmware_version(),
            device_type: classify_device_type(&info).map(str::to_string),
            port: "/dev/ttyUSB0".into(),
            baud: 420_000,
            param_count: 0,
            serial_number: 0,
            hardware_version: 0,
            generation: 1,
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["firmwareVersion"], serde_json::Value::Null);
    }

    /// A Device Info reply from `origin`, addressed to `destination`.
    fn reply_from(origin: u8, destination: u8) -> DeviceInfo {
        DeviceInfo {
            destination,
            ..device_info_from(origin)
        }
    }

    #[test]
    fn a_reply_addressed_to_someone_else_is_not_our_handshake() {
        // On the shared RX↔FC UART the app tells users to wire, other
        // conversations are on the wire too. Only a frame addressed to an origin
        // we actually pinged as (or broadcast) is an answer to US.
        let mut pick = ResponderPick::default();
        let mut diag = ProbeDiag::default();
        assert!(!pick.offer(
            reply_from(address::CRSF_RECEIVER, address::FLIGHT_CONTROLLER),
            &mut diag
        ));
        assert!(pick.take().is_none(), "a reply to the FC is not ours");

        for &dest in &[
            address::BROADCAST,
            address::RADIO_TRANSMITTER,
            address::ELRS_LUA,
        ] {
            let mut pick = ResponderPick::default();
            pick.offer(reply_from(address::CRSF_RECEIVER, dest), &mut diag);
            assert!(
                pick.take().is_some(),
                "a reply addressed to {dest:#04X} is ours"
            );
        }
    }

    #[test]
    fn every_origin_we_ping_as_is_accepted_by_the_reply_filter() {
        // FIX 9B: the accept-list used to be a second, hand-maintained constant
        // beside the ping table. Adding a ping variant without editing it drops
        // every reply to that origin — the handshake fails, it is reported as
        // "no device answered", and the whole suite stays green. Both are now
        // derived from `PING_VARIANTS`; this pins that they cannot drift.
        for (dest, origin) in PING_VARIANTS {
            assert!(
                reply_is_addressed_to_us(&reply_from(address::CRSF_RECEIVER, origin)),
                "a reply to {origin:#04X} — an origin we ping as (dest {dest:#04X}) — must be \
                 accepted"
            );
        }
        // The filter is still a filter: an address we never ping as is not ours.
        assert!(!reply_is_addressed_to_us(&reply_from(
            address::CRSF_RECEIVER,
            address::FLIGHT_CONTROLLER
        )));
    }

    #[test]
    fn a_rejected_device_info_is_reported_as_an_answer_not_as_silence() {
        // FIX 9A: the destination filter is new and unverified against the full
        // spread of ELRS firmware. Pre-filter, the first 0x29 won and the device
        // connected; if the filter is ever wrong, the sweep must not tell the
        // user "no device answered our Device Ping … try disconnecting it from
        // the FC/handset" — advice that explicitly rules out the true cause.
        let mut pick = ResponderPick::default();
        let mut diag = ProbeDiag {
            tried: vec![420_000],
            saw_bytes: true,
            ..Default::default()
        };
        // A 0x29 implies valid CRSF, exactly as the reader records it.
        diag.saw_crsf = true;
        assert!(!pick.offer(
            reply_from(address::CRSF_RECEIVER, address::FLIGHT_CONTROLLER),
            &mut diag
        ));
        assert_eq!(
            diag.saw_foreign_device_info,
            Some(address::FLIGHT_CONTROLLER)
        );

        let message = diag.failure_message("/dev/ttyUSB0");
        assert!(
            message.contains("0xC8"),
            "the rejected destination must be in the message: {message}"
        );
        assert!(
            message.contains("DID answer"),
            "the message must say a device answered: {message}"
        );
        assert!(
            !message.contains("disconnecting it from the FC"),
            "must not suggest the remedy for a device that never answered: {message}"
        );
    }

    #[test]
    fn an_elrs_endpoint_outranks_the_flight_controller_whichever_answers_first() {
        // CONN: both answer DEVICE_PING on a shared bus. Taking the first frame
        // made the FC "the connected device" — its name, its zero firmware word,
        // and a CONCRETE `deviceType: "RX"` the flash guard trusts as evidence.
        for order in [
            [address::FLIGHT_CONTROLLER, address::CRSF_RECEIVER],
            [address::CRSF_RECEIVER, address::FLIGHT_CONTROLLER],
        ] {
            let mut pick = ResponderPick::default();
            let mut diag = ProbeDiag::default();
            for origin in order {
                pick.offer(reply_from(origin, address::RADIO_TRANSMITTER), &mut diag);
            }
            assert_eq!(
                pick.take().map(|info| info.origin),
                Some(address::CRSF_RECEIVER),
                "the receiver must win regardless of who replied first (order {order:?})"
            );
        }
    }

    #[test]
    fn an_elrs_reply_ends_the_probe_window_but_the_fc_alone_does_not() {
        // Only a rank-0 responder is conclusive: an FC-only answer is kept
        // provisionally so a receiver replying later in the SAME window can
        // still displace it.
        let mut pick = ResponderPick::default();
        let mut diag = ProbeDiag::default();
        assert!(
            !pick.offer(
                reply_from(address::FLIGHT_CONTROLLER, address::BROADCAST),
                &mut diag
            ),
            "the FC must not cut the window short"
        );
        assert!(pick.offer(
            reply_from(address::CRSF_TRANSMITTER, address::BROADCAST),
            &mut diag
        ));
        assert!(pick.is_conclusive());
        assert_eq!(
            pick.take().map(|i| i.origin),
            Some(address::CRSF_TRANSMITTER)
        );
    }

    #[test]
    fn an_unclassifiable_responder_still_beats_the_flight_controller() {
        // An origin `classify_device_type` abstains on is HONEST evidence; the
        // FC's is a concrete class about the wrong device. Neither is
        // conclusive, so the window runs to completion either way.
        let mut pick = ResponderPick::default();
        let mut diag = ProbeDiag::default();
        pick.offer(
            reply_from(address::FLIGHT_CONTROLLER, address::BROADCAST),
            &mut diag,
        );
        pick.offer(reply_from(address::ELRS_LUA, address::BROADCAST), &mut diag);
        assert!(!pick.is_conclusive());
        assert_eq!(pick.take().map(|i| i.origin), Some(address::ELRS_LUA));
    }

    #[test]
    fn an_unplug_is_not_reported_as_a_wiring_problem() {
        // Unplugging mid-sweep makes reads fail with BrokenPipe. The sweep used
        // to swallow that, probe the remaining bauds against a dead fd and end
        // on the silent-device branch — "check wiring and power" for an unplug.
        let cause =
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Broken pipe (os error 32)");
        let message = port_lost_message("/dev/ttyUSB0", &cause);
        assert!(message.contains("/dev/ttyUSB0"));
        assert!(message.contains("disappeared"));
        assert!(message.contains("Replug"));
        assert!(
            !message.contains("wiring"),
            "port loss must not send the user to re-check a working cable: {message}"
        );
    }

    #[test]
    fn a_sweep_that_tried_no_baud_never_renders_an_empty_baud_list() {
        // If the port vanishes before the first `set_baud_rate`, every candidate
        // is skipped and `tried` stays empty — which used to render as
        // "at any tried baud []".
        let message = ProbeDiag::default().failure_message("/dev/ttyUSB0");
        assert!(!message.contains("[]"), "empty baud list leaked: {message}");
        assert!(message.contains("unplugged or reset"));

        // With bauds actually tried, the normal diagnostics still list them.
        let diag = ProbeDiag {
            tried: vec![420_000, 115_200],
            ..Default::default()
        };
        assert!(diag
            .failure_message("/dev/ttyUSB0")
            .contains("420000, 115200"));
    }

    fn sample_link_stats() -> LinkStatistics {
        LinkStatistics {
            uplink_rssi_1: 70,
            uplink_rssi_2: 80,
            uplink_link_quality: 100,
            uplink_snr: 8,
            active_antenna: 0,
            rf_mode: 6,
            uplink_tx_power: 3,
            downlink_rssi: 60,
            downlink_link_quality: 99,
            downlink_snr: -5,
        }
    }

    #[test]
    fn stats_payload_attaches_gps_verbatim_and_omits_it_when_absent() {
        // The device ingestion mapping must forward the RAW scaled-integer wire
        // values unchanged (the frontend applies scaling), including the coordinate
        // extremes a real module can report. A naive re-scale here would corrupt
        // them.
        let gps = GpsData {
            latitude: 850_000_000,     // +85°
            longitude: -1_800_000_000, // −180°
            ground_speed: 150,
            heading: 18_000,
            altitude: 1_100,
            satellites: 9,
        };
        let with_gps = stats_payload(&sample_link_stats(), Some(&gps));
        let g = with_gps.gps.expect("gps attached");
        assert_eq!(g.latitude, 850_000_000);
        assert_eq!(g.longitude, -1_800_000_000);
        assert_eq!(g.altitude, 1_100);
        assert_eq!(g.satellites, 9);
        assert_eq!(with_gps.uplink_rssi_1, 70);

        // A non-GPS device: no GPS sub-object (so it serializes away entirely).
        assert!(stats_payload(&sample_link_stats(), None).gps.is_none());
    }

    #[test]
    fn gps_frame_before_link_stats_in_a_tick_is_attached() {
        // M11 ingestion contract: GPS (0x02) and Link Statistics (0x14) frames
        // arrive on the same stream; a GPS fix seen earlier in a read tick must be
        // held and attached to the link-stats payload emitted later in that tick.
        // Drive the REAL parser with a GPS frame followed by a link-stats frame in
        // ONE feed and fold exactly as the reader loop does.
        let mut bytes = crsf_frame(
            crate::crsf::frame_type::GPS,
            &gps_payload(377_749_000, -1_224_194_000, 150, 18_000, 1_100, 9),
        );
        bytes.extend_from_slice(&crsf_frame(
            crate::crsf::frame_type::LINK_STATISTICS,
            &[70, 80, 100, 8, 0, 6, 3, 60, 99, 0xFB],
        ));

        let mut parser = Parser::new();
        let frames = parser.feed(&bytes);
        // Order matters: the GPS fix is decoded before the link-stats frame.
        assert!(matches!(frames[0], Frame::Gps(_)));
        assert!(matches!(frames[1], Frame::LinkStatistics(_)));

        let mut latest_gps: Option<GpsData> = None;
        let mut emitted: Vec<LinkStatsPayload> = Vec::new();
        for frame in frames {
            match frame {
                Frame::Gps(g) => latest_gps = Some(g),
                Frame::LinkStatistics(s) => emitted.push(stats_payload(&s, latest_gps.as_ref())),
                _ => {}
            }
        }
        assert_eq!(emitted.len(), 1);
        let attached = emitted[0]
            .gps
            .as_ref()
            .expect("the earlier GPS fix is attached");
        assert_eq!(attached.latitude, 377_749_000);
        assert_eq!(attached.satellites, 9);
    }
}
