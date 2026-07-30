import { create } from "zustand";
import {
  connectDevice,
  disconnectDevice,
  listSerialPorts,
  onDeviceConnected,
  onDeviceDisconnected,
  onDeviceError,
  type SerialPortInfo,
} from "@/lib/tauri";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "bootloader"
  | "flashing"
  | "error";

/** Whether a device is a transmitter or receiver. */
export type DeviceType = "TX" | "RX";

/**
 * Whether it is safe for the UI (or `connect()`) to claim the serial port in
 * this state (CONN-2).
 *
 * Only "disconnected" and "error" leave the port free. "connecting"/"connected"
 * mean we already hold it, and "flashing"/"bootloader" mean a firmware write
 * owns it — opening the port (or writing MSP bridge-probe frames to it) during
 * an in-progress write is the highest brick-risk path in the app, so every
 * port-claiming affordance is gated on this predicate rather than on
 * `!isConnected` (which is TRUE while flashing).
 */
export function canClaimPort(status: ConnectionStatus): boolean {
  return status === "disconnected" || status === "error";
}

export interface DeviceInfo {
  targetName: string;
  /**
   * Firmware version the CRSF handshake reported, or `null` when the device
   * reported none at all.
   *
   * `null` must be preserved for the same reason as {@link deviceType}: a
   * Betaflight FC answers our Device Ping on the shared RX↔FC CRSF UART with an
   * all-zero serial/hardware/firmware triple, and the backend used to format
   * that as a concrete `"0.0.0"`. That fabrication was rendered as fact in the
   * device bar, written into the pre-flash `.elrsp` snapshot, and fed to
   * `firmwareCompat()` — which returned "warn" against every profile forever
   * instead of "unknown". UI that needs something to render shows its own
   * "unknown" label instead of defaulting the value here.
   */
  firmwareVersion: string | null;
  /**
   * TX/RX class from the CRSF handshake, or `null` when the backend could not
   * resolve the device's origin address (CONN-5/FWCHK-3).
   *
   * `null` must be preserved, never defaulted: it travels to the Rust flash
   * guard as `connectedDeviceType`, and the guard is built to ABSTAIN when the
   * connected class is unknown and to BLOCK on a concrete mismatch. Substituting
   * a guess here (the backend used to assume "TX") makes the guard compare
   * against a fabrication and lets TX firmware be written to a receiver. UI that
   * needs something to render shows its own "unknown" label instead.
   */
  deviceType: DeviceType | null;
  port: string;
  /** Baud rate the CRSF handshake actually succeeded at. */
  baud: number;
  /** Number of configuration parameters the device exposes (Device Info). */
  paramCount: number;
  /** Device serial number word from Device Info. */
  serialNumber: number;
  /** Hardware version word from Device Info. */
  hardwareVersion: number;
}

interface DeviceState {
  status: ConnectionStatus;
  device: DeviceInfo | null;
  /**
   * Identity of the last device that completed a CRSF handshake, RETAINED after
   * the link drops. `lastIdentity.port` records which port it was read from, so
   * a consumer can tell whether it still describes what it is about to talk to.
   *
   * FR-FLASH-10: the flash guards compare the wizard's selection against the
   * connected device — but a serial flash DISCONNECTS that device before the
   * engine ever evaluates them, so by the time a refusal is on screen `device`
   * is already null. The retry the refusal invites then carried no identity at
   * all, both guards abstained, and the second click wrote the very image the
   * first one refused. The evidence therefore has to outlive the connection it
   * came from.
   *
   * Deliberately NOT cleared by `disconnect()`/`reset()` (they are what the
   * flash calls) nor by a completed flash: a write replaces the firmware, not
   * the hardware, and "no connection" is never proof that a DIFFERENT device is
   * on the port. Only a fresh handshake replaces it — which is also the user's
   * one-click way out if they really did swap boards (see
   * `wizard.review.identityBlocked`).
   */
  lastIdentity: DeviceInfo | null;
  error: string | null;
  /** Serial ports enumerated from the Rust backend. */
  ports: SerialPortInfo[];
  /** Port path the user has selected in the picker. */
  selectedPort: string | null;
  /**
   * Whether {@link selectedPort} is a DELIBERATE choice (a pick in the picker, a
   * connect against a named port, or the port a flash was just written to)
   * rather than the first-port default `refreshPorts` fills in.
   *
   * CONN-10: the hotplug watcher used to re-point `selectedPort` at `ports[0]`
   * the moment the selected path was momentarily absent — and a just-flashed
   * board IS absent for a second or two while esptool's reset re-enumerates it.
   * With an FC on `/dev/ttyACM0` and the ELRS RX on `/dev/ttyUSB0`, the retry /
   * "Flash another" after a UART flash then wrote ELRS firmware to the FLIGHT
   * CONTROLLER, because `selectedPort` is what the flash request falls back to
   * when nothing is connected. A pinned selection is therefore kept even while
   * its path is missing (the bar renders it as absent and Connect stays inert)
   * and is only ever replaced by an explicit user re-pick — or released outright
   * by the bar's "follow the first port" option, the one way back to auto-follow.
   */
  portPinned: boolean;
  /**
   * Lowest reader generation whose `device://*` events the store still accepts.
   *
   * The Rust `DeviceManager` stamps every reader with a monotonic generation and
   * mirrors it onto `device://connected` / `device://error`. A reader that has
   * been torn down (Cancel, port switch, flash takeover) can still have an event
   * in flight, and honouring it would resurrect a connection the user already
   * cancelled — so `disconnect()` raises this floor above every generation the
   * backend has issued and anything below it is dropped.
   */
  generation: number;

  setStatus: (status: ConnectionStatus) => void;
  /**
   * Record the live identity. A non-null value is also kept as
   * {@link lastIdentity}; clearing `device` never clears that.
   */
  setDevice: (device: DeviceInfo | null) => void;
  setError: (error: string | null) => void;
  /**
   * Select `port` as the flash/connect destination. An explicit choice, so it
   * PINS the selection ({@link portPinned}) — passing `null` releases the pin
   * and adopts the first enumerated port, handing the picker back to hotplug
   * auto-follow. That `null` is the ONLY way back, so a surface that offers
   * pinning has to offer it too (the device bar's "follow the first port"
   * option): the picker's placeholder renders only while nothing is selected,
   * which is unreachable once anything has been picked.
   */
  setSelectedPort: (port: string | null) => void;

  /**
   * Register the `device://*` Tauri event listeners and start the hotplug
   * watcher (CONN-4). Idempotent — safe to call once on app start, and safe to
   * call again from a re-mount: concurrent callers share one registration.
   *
   * Returns a cleanup that releases THIS caller's hold; the last one out
   * removes the listeners, stops the watcher and clears the cache, so a later
   * `init()` registers a live set again instead of handing back a spent
   * cleanup (CONN-9).
   */
  init: () => Promise<() => void>;
  /** Re-enumerate serial ports (e.g. when opening the picker). */
  refreshPorts: () => Promise<void>;
  /**
   * Open `port` and run the CRSF handshake. Moves to "connecting"; the final
   * "connected"/"error" status arrives via Tauri events. Falls back to the
   * currently selected port when none is passed. A no-op unless
   * {@link canClaimPort} allows it — i.e. when we already hold the port or a
   * flash owns it (CONN-2).
   */
  connect: (port?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  reset: () => void;
}

/** Guards against registering the event listeners more than once. */
let listenersReady: Promise<() => void> | null = null;

/**
 * How many live `init()` callers share {@link listenersReady} (CONN-9).
 *
 * Reset whenever a fresh registration is created, so a count left behind by a
 * failed or fully-disposed one is never carried forward.
 */
let listenerRefs = 0;

/**
 * How often the serial port list is re-enumerated while the port is free
 * (CONN-4). Modest on purpose: the enumeration is a udev/IOKit syscall, and a
 * couple of seconds is well inside "I plugged it in and it appeared".
 */
export const PORT_POLL_INTERVAL_MS = 2000;

/** The single hotplug timer, or null while it is not running. */
let portPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start watching for hotplug (CONN-4).
 *
 * Nothing used to re-enumerate ports after startup: an unplug was detected
 * backend-side (POLLHUP → `device://error`) but left the store sitting on a
 * dead path, and a replug — usually on a NEW path (`/dev/ttyUSB1`, a different
 * COM number) — showed nothing until the user found the small refresh icon.
 *
 * Idempotent by design: one module-level timer, so React StrictMode's
 * double-mount (two `init()` calls before any dispose) cannot start a second.
 */
function startPortPolling(get: () => DeviceState): void {
  if (portPollTimer !== null) return;
  portPollTimer = setInterval(() => {
    // The same gate every other port-claiming affordance uses (CONN-2). While a
    // flash owns the port, re-enumerating can move `selectedPort` off the port
    // being written (a rebooting device drops off the bus) and lose the
    // pre-selection for the post-flash reconnect; while we hold a live
    // connection there is nothing to watch for.
    if (!canClaimPort(get().status)) return;
    void get().refreshPorts();
  }, PORT_POLL_INTERVAL_MS);
}

/**
 * Whether a `device://*` event came from a reader the store has moved past.
 *
 * Defensive about a missing generation: an untagged payload (an older backend,
 * or a test double) is never treated as superseded, so the worst case is the
 * pre-fix behaviour rather than a UI that silently ignores a real connection.
 */
function isSuperseded(
  generation: number | undefined,
  get: () => DeviceState
): boolean {
  return typeof generation === "number" && generation < get().generation;
}

/** Stop the hotplug watcher. Safe to call when it is not running. */
function stopPortPolling(): void {
  if (portPollTimer === null) return;
  clearInterval(portPollTimer);
  portPollTimer = null;
}

/**
 * Build the per-caller cleanup `init()` hands back.
 *
 * CONN-9: `listenersReady` used to survive its own dispose, so a later `init()`
 * returned the cached promise — and with it an ALREADY-SPENT cleanup — while the
 * app silently stopped receiving every `device://*` event. The cleanup is
 * refcounted instead: the last holder to let go removes the listeners, stops the
 * hotplug watcher and clears the cache, so the next `init()` registers a live
 * set again.
 *
 * Extra calls are no-ops (`released`), and a cleanup belonging to a PREVIOUS
 * registration is inert (the identity check) so it can never tear down or
 * un-cache the current one.
 */
function makeDispose(
  owned: Promise<() => void>,
  unlistenAll: () => void
): () => void {
  let released = false;
  return () => {
    if (released || listenersReady !== owned) return;
    released = true;
    listenerRefs -= 1;
    if (listenerRefs > 0) return;
    unlistenAll();
    listenersReady = null;
    stopPortPolling();
  };
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  status: "disconnected",
  device: null,
  lastIdentity: null,
  error: null,
  ports: [],
  selectedPort: null,
  portPinned: false,
  // Generations start at 1 backend-side, so 0 accepts every real reader.
  generation: 0,

  setStatus: (status) => set({ status }),
  setDevice: (device) =>
    set(device === null ? { device } : { device, lastIdentity: device }),
  setError: (error) => set({ error }),
  setSelectedPort: (port) =>
    set((s) =>
      port === null
        ? // Back to auto-follow, and back to a concrete port in the same breath:
          // leaving the selection empty until the next hotplug tick would put the
          // picker on its placeholder with Connect inert for up to
          // PORT_POLL_INTERVAL_MS, which is not what "auto-select" should look
          // like.
          { selectedPort: s.ports[0]?.path ?? null, portPinned: false }
        : { selectedPort: port, portPinned: true }
    ),

  init: () => {
    if (!listenersReady) {
      // A fresh registration owns a fresh refcount; whatever a failed or
      // fully-disposed predecessor left behind is dead.
      listenerRefs = 0;
      listenersReady = (async () => {
        // CONN-8: `allSettled`, never `all`. With `all`, a rejection from the
        // 2nd/3rd `listen()` discarded the handles that HAD resolved — never
        // collected, never removed — and the `.catch` below then reset the guard
        // so the next `init()` registered a SECOND copy of each survivor.
        const results = await Promise.allSettled([
          onDeviceConnected(({ generation, ...device }) => {
            // A reader the user already cancelled must not announce itself as
            // connected on its way out (the generation is stripped here so the
            // stored identity stays exactly `DeviceInfo`).
            if (isSuperseded(generation, get)) return;
            // Same guard as the other two handlers (CONN-2): while a flash owns
            // the status, a late `connected` would render Disconnect over a
            // running write — and one click on it lands on "disconnected",
            // where `canClaimPort` re-opens the picker, Connect and the bridge
            // probe on the port esptool is mid-write on. Record the identity,
            // leave the status to the flash.
            // The handshake is the only thing that establishes an identity, so
            // it is also the only thing that replaces the retained one
            // (FR-FLASH-10).
            set(
              get().status === "flashing"
                ? { device, lastIdentity: device, error: null }
                : {
                    status: "connected",
                    device,
                    lastIdentity: device,
                    error: null,
                  }
            );
          }),
          // While a flash runs, the wizard owns the device status: it drops the
          // CRSF connection on purpose before a serial flash (CONN-1), and the
          // backend releases the port too. Neither resulting event may knock the
          // status out of "flashing" — that would re-enable the connect/probe
          // controls mid-write. The stale identity is still cleared.
          onDeviceDisconnected(() => {
            const flashing = get().status === "flashing";
            set(
              flashing
                ? // Only the identity. `error` is the RETAINED cause the settle
                  // reads (see the `device://error` handler below), and a link
                  // that dies mid-OTA reports both events: clearing it here threw
                  // the message away and left `settleDeviceAfterFlash` landing on
                  // a bare "disconnected" — exactly the cause the retention
                  // exists to preserve. It is scoped to this flash: `startFlash`
                  // clears it on the way into "flashing".
                  { device: null }
                : { status: "disconnected", device: null, error: null }
            );
            // CONN-4: the device we were talking to may have just been
            // unplugged, so its path is gone from the OS. Re-enumerate at once
            // rather than leaving a dead path in the picker until the next tick
            // of the watcher (and never mid-flash — see `startPortPolling`).
            if (!flashing) void get().refreshPorts();
          }),
          onDeviceError((payload) => {
            // Same floor as `device://connected`: a torn-down reader complaining
            // on its way out must not raise a scary error on a bar the user has
            // already taken back to "Disconnected".
            if (isSuperseded(payload.generation, get)) return;
            const flashing = get().status === "flashing";
            set(
              flashing
                ? // The reader we deliberately tore down complaining on its way
                  // out is noise; `flash://error` is the authoritative failure
                  // channel for a flash. The MESSAGE is still retained (it is
                  // invisible while the status is "flashing"): for a
                  // port-preserving flash it is the only record that the CRSF
                  // link died mid-write, and `settleDeviceAfterFlash` settles to
                  // "error" with it rather than restoring a status that is no
                  // longer true (CONN-11).
                  { device: null, error: payload.message }
                : { status: "error", error: payload.message, device: null }
            );
            // An unplug reaches us as POLLHUP → `BrokenPipe` → this event, so
            // this is the primary hotplug-removal signal (CONN-4).
            if (!flashing) void get().refreshPorts();
          }),
        ]);
        const unlisteners = results.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );
        const failure = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        if (failure) {
          // Partial registration: remove what DID land before failing, so the
          // retry in the `.catch` starts from zero listeners.
          unlisteners.forEach((un) => un());
          throw failure.reason;
        }
        return () => unlisteners.forEach((un) => un());
      })().catch(() => {
        // `listen()` rejects outside Tauri (browser/dev). Reset the guard so a
        // later real attempt can retry, and hand back a no-op cleanup so the
        // store init never produces an unhandled rejection.
        listenersReady = null;
        return () => {};
      });
    }

    const owned = listenersReady;
    listenerRefs += 1;
    // Enumerate ports up front so the picker is populated on first open.
    void get().refreshPorts();
    return owned.then((unlistenAll) => {
      // Only watch for hotplug once the event bridge is actually live: when
      // `listen()` rejected (outside Tauri) the guard was cleared by the
      // `.catch`, and `list_serial_ports` cannot answer there either — a timer
      // would poll a dead seam forever.
      if (listenersReady === owned) startPortPolling(get);
      return makeDispose(owned, unlistenAll);
    });
  },

  refreshPorts: async () => {
    try {
      const ports = await listSerialPorts();
      set((state) => {
        // Keep the current selection if it still exists.
        if (ports.some((p) => p.path === state.selectedPort)) return { ports };
        // CONN-10: a DELIBERATE selection is never silently re-pointed at a
        // different device just because its path went missing — a flashed board
        // re-enumerates for a second or two after esptool resets the MCU, and
        // substituting `ports[0]` there aims the next flash at whatever else is
        // plugged in. The path stays selected (the bar renders it as absent and
        // Connect stays inert) until it comes back or the user picks another.
        if (state.portPinned && state.selectedPort !== null) return { ports };
        // Only the first-port default follows the enumeration.
        return { ports, selectedPort: ports[0]?.path ?? null };
      });
    } catch {
      // Backend unavailable (e.g. running outside Tauri) — no ports.
      set({ ports: [] });
    }
  },

  connect: async (port) => {
    // Safety guard FIRST (CONN-2): while we already hold the port, or while a
    // flash owns it, a connect attempt is a no-op — including the "no port
    // selected" branch below, which would otherwise flip a flashing device into
    // the "error" status and re-enable the port controls mid-write.
    if (!canClaimPort(get().status)) return;

    const target = port ?? get().selectedPort;
    if (!target) {
      set({ status: "error", error: "No serial port selected" });
      return;
    }

    // Connecting to a port the user NAMED is as deliberate as picking it, so it
    // pins the selection too (CONN-10): a failed attempt must leave them looking
    // at the port they aimed at, not at whatever the watcher enumerated first.
    //
    // Connecting to the first-port default they never touched is not deliberate,
    // and pinning it killed hotplug auto-follow on the very first Connect —
    // permanently, since nothing else in the UI emits the `null` that releases a
    // pin. A bare `connect()` therefore inherits whatever pin state the current
    // selection already carries.
    set((s) => ({
      status: "connecting",
      error: null,
      device: null,
      selectedPort: target,
      portPinned: port !== undefined || s.portPinned,
    }));
    try {
      const generation = await connectDevice(target);
      // 0 = the backend refused to open anything because a disconnect (the
      // bar's Cancel) landed while this connect was queued. That disconnect owns
      // the resulting state; raising the floor from 0 here would only re-admit
      // the reader it just tore down.
      if (generation > 0) {
        set((s) => ({ generation: Math.max(s.generation, generation) }));
      }
    } catch (e) {
      set({ status: "error", error: String(e), device: null });
    }
  },

  disconnect: async () => {
    let issued = 0;
    try {
      const latest = await disconnectDevice();
      // Guarded rather than trusted: an older backend (or a test double) that
      // resolves with nothing must not poison the floor with NaN.
      if (Number.isFinite(latest)) issued = latest;
    } catch {
      // Ignore — fall through to a clean local state regardless.
    }
    set((s) => ({
      status: "disconnected",
      device: null,
      error: null,
      // Above EVERY generation the backend has issued: the reader this call
      // joined may already have queued a `connected`/`error` event, and the next
      // connect is guaranteed a higher generation than `issued`.
      generation: Math.max(s.generation, issued + 1),
    }));
  },

  reset: () => {
    set({ status: "disconnected", device: null, error: null });
  },
}));
