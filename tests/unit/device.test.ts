import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the device store's `init()` guard.
 *
 * Outside Tauri (browser/dev) the `device://*` listener registration rejects
 * via the `__TAURI_INTERNALS__.transformCallback` path. The init IIFE must
 * mirror `stores/wifi.ts`: swallow that rejection, reset the idempotency guard
 * and hand back a no-op cleanup, so `init()` never surfaces an unhandled
 * promise rejection (App.tsx wires it with only a `.then`).
 *
 * Plus the three connection-robustness defects around it:
 *  - CONN-4: nothing ever re-enumerated the port list, so an unplug left a dead
 *    path selected and a replug (often on a NEW path) showed nothing;
 *  - CONN-8: a partial registration leaked the handles that DID resolve, and
 *    the retry then registered a second copy of each survivor;
 *  - CONN-9: the cached init promise outlived its own dispose, so a re-mount
 *    got an already-spent cleanup and the app went deaf to `device://*`.
 */

// Controllable mocks of the Tauri seam the device store imports. Defaults are
// the happy-path (Tauri available); individual tests override per-call.
const tauri = vi.hoisted(() => ({
  // The callbacks are captured (not just counted) so a test can drive the real
  // registered handler, exactly as a `device://*` event would.
  onDeviceConnected: vi.fn(
    (_cb: (p: Record<string, unknown> & { generation?: number }) => void) =>
      Promise.resolve(() => {})
  ),
  onDeviceDisconnected: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  onDeviceError: vi.fn(
    (_cb: (p: { message: string; generation?: number }) => void) =>
      Promise.resolve(() => {})
  ),
  listSerialPorts: vi.fn(
    (): Promise<{ path: string; product?: string | null }[]> =>
      Promise.resolve([])
  ),
  // Both commands answer with a reader GENERATION (FIX 2B): `connect_device`
  // with the reader it installed, `disconnect_device` with the highest one the
  // backend has issued.
  connectDevice: vi.fn(() => Promise.resolve(1)),
  disconnectDevice: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("@/lib/tauri", () => ({
  onDeviceConnected: tauri.onDeviceConnected,
  onDeviceDisconnected: tauri.onDeviceDisconnected,
  onDeviceError: tauri.onDeviceError,
  listSerialPorts: tauri.listSerialPorts,
  connectDevice: tauri.connectDevice,
  disconnectDevice: tauri.disconnectDevice,
}));

// Fresh module per test so the module-level `listenersReady` guard, refcount
// and hotplug timer all reset.
async function loadModule() {
  vi.resetModules();
  return import("@/stores/device");
}

async function loadStore() {
  const mod = await loadModule();
  return mod.useDeviceStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // The hotplug watcher (CONN-4) is a real interval; never let one outlive its
  // test and perturb another test's `listSerialPorts` call count.
  vi.useRealTimers();
});

describe("useDeviceStore.init", () => {
  it("resolves to a no-op cleanup (no unhandled rejection) when the event bridge rejects", async () => {
    // Simulate running outside Tauri: `listen()` rejects.
    tauri.onDeviceConnected.mockRejectedValueOnce(
      new Error("transformCallback is not a function")
    );

    const useDeviceStore = await loadStore();
    // Without the `.catch`, this promise rejects and the await throws.
    const dispose = await useDeviceStore.getState().init();

    expect(dispose).toBeTypeOf("function");
    expect(() => dispose()).not.toThrow();
  });

  it("resets the init guard after a failure so a later init can retry", async () => {
    tauri.onDeviceConnected.mockRejectedValueOnce(new Error("bridge down"));

    const useDeviceStore = await loadStore();
    await useDeviceStore.getState().init(); // first attempt fails, guard reset

    // Bridge is back: a second init re-registers the listeners.
    const dispose = await useDeviceStore.getState().init();

    expect(dispose).toBeTypeOf("function");
    expect(tauri.onDeviceConnected).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("returns a cleanup that removes all registered listeners when Tauri is available", async () => {
    const un = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(un);
    tauri.onDeviceDisconnected.mockResolvedValueOnce(un);
    tauri.onDeviceError.mockResolvedValueOnce(un);

    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    dispose();

    expect(un).toHaveBeenCalledTimes(3);
  });

  it("unlistens the handlers that DID register when a later listen() rejects", async () => {
    // CONN-8: `Promise.all` resolved-then-discarded these two handles — never
    // collected, never called — leaving two live listeners nobody could remove.
    const unConnected = vi.fn();
    const unError = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(unConnected);
    tauri.onDeviceDisconnected.mockRejectedValueOnce(new Error("bridge down"));
    tauri.onDeviceError.mockResolvedValueOnce(unError);

    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();

    expect(unConnected).toHaveBeenCalledTimes(1);
    expect(unError).toHaveBeenCalledTimes(1);
    // The caller still gets a safe, inert cleanup.
    expect(() => dispose()).not.toThrow();
    expect(unConnected).toHaveBeenCalledTimes(1);
  });

  it("does not double-register the survivors when the retry succeeds", async () => {
    const leaked = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(leaked);
    tauri.onDeviceDisconnected.mockRejectedValueOnce(new Error("bridge down"));
    tauri.onDeviceError.mockResolvedValueOnce(leaked);

    const useDeviceStore = await loadStore();
    await useDeviceStore.getState().init();
    expect(leaked).toHaveBeenCalledTimes(2); // both released before the retry

    const fresh = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(fresh);
    tauri.onDeviceDisconnected.mockResolvedValueOnce(fresh);
    tauri.onDeviceError.mockResolvedValueOnce(fresh);
    const dispose = await useDeviceStore.getState().init();
    dispose();

    // Exactly one live copy of each listener, removed exactly once…
    expect(fresh).toHaveBeenCalledTimes(3);
    // …and the failed attempt's handles were not touched a second time.
    expect(leaked).toHaveBeenCalledTimes(2);
  });

  it("re-registers after its own dispose instead of handing back a spent cleanup", async () => {
    // CONN-9: `listenersReady` used to survive dispose, so the next init()
    // returned the same cached promise — and the same already-called cleanup —
    // while every `device://*` event silently stopped arriving.
    const first = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(first);
    tauri.onDeviceDisconnected.mockResolvedValueOnce(first);
    tauri.onDeviceError.mockResolvedValueOnce(first);

    const useDeviceStore = await loadStore();
    const disposeFirst = await useDeviceStore.getState().init();
    disposeFirst();
    expect(first).toHaveBeenCalledTimes(3);

    const second = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(second);
    tauri.onDeviceDisconnected.mockResolvedValueOnce(second);
    tauri.onDeviceError.mockResolvedValueOnce(second);
    const disposeSecond = await useDeviceStore.getState().init();

    expect(tauri.onDeviceConnected).toHaveBeenCalledTimes(2);
    // The re-mounted app really is listening again: the freshly registered
    // handler still drives the store.
    const onDisconnected = tauri.onDeviceDisconnected.mock.calls[1][0];
    useDeviceStore.setState({ status: "connected" });
    onDisconnected();
    expect(useDeviceStore.getState().status).toBe("disconnected");

    disposeSecond();
    expect(second).toHaveBeenCalledTimes(3);
    // The spent first cleanup neither ran again nor tore down the new set.
    expect(first).toHaveBeenCalledTimes(3);
  });

  it("keeps the listeners while a second init() still holds them", async () => {
    // React StrictMode double-mounts (and HMR) call init() twice before either
    // dispose; the first release must not deafen the still-mounted second.
    const un = vi.fn();
    tauri.onDeviceConnected.mockResolvedValueOnce(un);
    tauri.onDeviceDisconnected.mockResolvedValueOnce(un);
    tauri.onDeviceError.mockResolvedValueOnce(un);

    const useDeviceStore = await loadStore();
    const disposeA = await useDeviceStore.getState().init();
    const disposeB = await useDeviceStore.getState().init();

    // One shared registration…
    expect(tauri.onDeviceConnected).toHaveBeenCalledTimes(1);
    disposeA();
    expect(un).not.toHaveBeenCalled();
    // …and a repeated release must not consume the other holder's ref.
    disposeA();
    expect(un).not.toHaveBeenCalled();

    disposeB();
    expect(un).toHaveBeenCalledTimes(3);
  });
});

/**
 * CONN-2: nothing may open the serial port while a flash owns it. The reader
 * thread and esptool cannot share the port (`TIOCEXCL` + `flock` on POSIX,
 * exclusive open on Windows), so a `connect()` landing mid-write is the app's
 * highest brick-risk path.
 */
describe("canClaimPort", () => {
  it("is true only for the states in which the port is genuinely free", async () => {
    vi.resetModules();
    const { canClaimPort } = await import("@/stores/device");

    expect(canClaimPort("disconnected")).toBe(true);
    expect(canClaimPort("error")).toBe(true);
    // We already hold the port…
    expect(canClaimPort("connecting")).toBe(false);
    expect(canClaimPort("connected")).toBe(false);
    // …or a firmware write does.
    expect(canClaimPort("flashing")).toBe(false);
    expect(canClaimPort("bootloader")).toBe(false);
  });
});

describe("useDeviceStore.connect — port-ownership guard", () => {
  it("opens the port from the free states", async () => {
    const useDeviceStore = await loadStore();
    useDeviceStore.setState({ status: "disconnected", selectedPort: "/dev/ttyUSB0" });

    await useDeviceStore.getState().connect();

    expect(tauri.connectDevice).toHaveBeenCalledWith("/dev/ttyUSB0");
    expect(useDeviceStore.getState().status).toBe("connecting");
  });

  it("refuses to open the port while a flash owns it", async () => {
    const useDeviceStore = await loadStore();
    // A UART/Betaflight flash is in progress on this very port.
    useDeviceStore.setState({ status: "flashing", selectedPort: "/dev/ttyUSB0" });

    await useDeviceStore.getState().connect();
    await useDeviceStore.getState().connect("/dev/ttyUSB0");

    expect(tauri.connectDevice).not.toHaveBeenCalled();
    // …and the flash keeps owning the status.
    expect(useDeviceStore.getState().status).toBe("flashing");
  });

  it("refuses while flashing even with no port selected — never flips to error", async () => {
    // The "no port selected" branch must sit BEHIND the guard: flipping a
    // flashing device to "error" would re-enable the whole action cluster.
    const useDeviceStore = await loadStore();
    useDeviceStore.setState({ status: "flashing", selectedPort: null });

    await useDeviceStore.getState().connect();

    expect(tauri.connectDevice).not.toHaveBeenCalled();
    expect(useDeviceStore.getState().status).toBe("flashing");
    expect(useDeviceStore.getState().error).toBeNull();
  });

  it("refuses in the bootloader state, and while already connected/connecting", async () => {
    const useDeviceStore = await loadStore();
    for (const status of ["bootloader", "connecting", "connected"] as const) {
      useDeviceStore.setState({ status, selectedPort: "/dev/ttyUSB0" });
      await useDeviceStore.getState().connect();
      expect(useDeviceStore.getState().status).toBe(status);
    }
    expect(tauri.connectDevice).not.toHaveBeenCalled();
  });
});

describe("useDeviceStore — device:// events during a flash", () => {
  it("keeps the flash in charge when a device:// event lands mid-flash", async () => {
    // Releasing the port before a serial flash makes the backend emit
    // `device://disconnected`; the dying reader can also emit `device://error`.
    // Neither may move the status off "flashing" — that would re-enable the
    // connect / bridge-probe affordances during a firmware write. Both still
    // clear the now-stale identity.
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onDisconnected = tauri.onDeviceDisconnected.mock.calls[0][0];
    const onError = tauri.onDeviceError.mock.calls[0][0];

    useDeviceStore.setState({ status: "flashing" });
    onDisconnected();
    expect(useDeviceStore.getState().status).toBe("flashing");
    expect(useDeviceStore.getState().device).toBeNull();

    onError({ message: "Lost connection to /dev/ttyUSB0" });
    expect(useDeviceStore.getState().status).toBe("flashing");
    // The message is RETAINED, not shown: nothing renders `error` outside the
    // "error" status, and `settleDeviceAfterFlash` needs it to land on "error"
    // with a cause instead of pretending the link survived (CONN-11).
    expect(useDeviceStore.getState().error).toBe("Lost connection to /dev/ttyUSB0");

    // Outside a flash both events still apply normally.
    useDeviceStore.setState({ status: "connected" });
    onError({ message: "boom" });
    expect(useDeviceStore.getState().status).toBe("error");
    expect(useDeviceStore.getState().error).toBe("boom");
    onDisconnected();
    expect(useDeviceStore.getState().status).toBe("disconnected");
    dispose();
  });

  it("does not let a late device://connected take the status mid-flash", async () => {
    // The third handler used to be the ONLY one without the guard: a connected
    // event landing during a write flipped the status to "connected", the bar
    // rendered Disconnect, and one click on it landed on "disconnected" — where
    // `canClaimPort` re-opens the picker, Connect and the bridge probe on the
    // port esptool is mid-write on.
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onConnected = tauri.onDeviceConnected.mock.calls[0][0];
    const identity = {
      targetName: "BETAFPV_2400_TX",
      firmwareVersion: "3.5.3",
      deviceType: "TX",
      port: "/dev/ttyUSB0",
      baud: 420000,
      paramCount: 42,
      serialNumber: 1,
      hardwareVersion: 1,
    };

    useDeviceStore.setState({ status: "flashing", device: null });
    onConnected({ ...identity, generation: 3 });

    expect(useDeviceStore.getState().status).toBe("flashing");
    // The identity is still recorded — the flash owns the STATUS, not the fact
    // that a reader answered.
    expect(useDeviceStore.getState().device).toEqual(identity);

    // Outside a flash the same event connects as before.
    useDeviceStore.setState({ status: "disconnected", device: null });
    onConnected({ ...identity, generation: 4 });
    expect(useDeviceStore.getState().status).toBe("connected");
    dispose();
  });
});

/**
 * CONN-10: `refreshPorts` re-pointed `selectedPort` at `ports[0]` whenever the
 * selected path was momentarily absent — and the hotplug watcher runs that every
 * 2s. A just-flashed board IS absent for a second or two (esptool resets the
 * MCU, so the port re-enumerates), and `selectedPort` is what the flash request
 * falls back to when nothing is connected: with an FC on `/dev/ttyACM0` and the
 * ELRS RX on `/dev/ttyUSB0`, the retry / "Flash another" after a UART flash
 * wrote ELRS firmware to the FLIGHT CONTROLLER.
 */
describe("useDeviceStore — pinned port selection", () => {
  const ACM0 = { path: "/dev/ttyACM0", product: "Flight controller" };
  const USB0 = { path: "/dev/ttyUSB0", product: "CP2102 USB UART" };

  it("keeps a user-picked port selected while its path is missing", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0, USB0]);
    await useDeviceStore.getState().refreshPorts();

    useDeviceStore.getState().setSelectedPort(USB0.path);

    // The flashed board re-enumerates: its path is gone for a poll or two.
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);

    // …and when it comes back, the selection is still the user's, not a re-pick.
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0, USB0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
  });

  it("never substitutes another device for the port a flash just wrote to", async () => {
    // Exactly what `settleDeviceAfterFlash` leaves behind: the flashed port
    // pinned, the status reset to "disconnected" so polling resumes.
    const useDeviceStore = await loadStore();
    useDeviceStore.getState().setSelectedPort(USB0.path);
    useDeviceStore.getState().reset();

    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();

    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
    expect(useDeviceStore.getState().ports).toEqual([ACM0]);
  });

  it("still auto-picks the first port while the selection is the default", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(ACM0.path);

    // Nothing was ever chosen, so following the enumeration is the whole point
    // of the watcher (CONN-4): plug a different device in and it is selected.
    tauri.listSerialPorts.mockResolvedValueOnce([USB0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
  });

  it("hands the picker back to the default when the user clears the selection", async () => {
    const useDeviceStore = await loadStore();
    useDeviceStore.getState().setSelectedPort(USB0.path);
    useDeviceStore.getState().setSelectedPort(null);

    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();

    expect(useDeviceStore.getState().selectedPort).toBe(ACM0.path);
  });

  it("pins the port a connect aimed at, even a failed one", async () => {
    const useDeviceStore = await loadStore();
    useDeviceStore.setState({ status: "disconnected" });
    await useDeviceStore.getState().connect(USB0.path);
    // The handshake fails and the device drops off the bus.
    useDeviceStore.setState({ status: "error" });

    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();

    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
  });
});

/**
 * FIX 2B: `connect_device`'s take → spawn → store sequence was three separate
 * steps, so the bar's Cancel could land between them: the disconnect found an
 * empty slot, told the UI it was disconnected, and the connect then installed a
 * reader nobody had cancelled — alive, owning the port, and free to announce
 * itself as `device://connected` (or raise a scary `device://error`) seconds
 * later. The Rust side now installs atomically and stamps every reader with a
 * generation; this is the frontend half — events from a superseded reader are
 * dropped instead of being allowed to resurrect the connection.
 */
describe("useDeviceStore — superseded reader generations", () => {
  it("ignores a cancelled reader's connect/error events", async () => {
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onConnected = tauri.onDeviceConnected.mock.calls[0][0];
    const onError = tauri.onDeviceError.mock.calls[0][0];

    // Connect, then Cancel: the disconnect answers with the highest generation
    // the backend has issued, so the floor lands above reader 1.
    useDeviceStore.setState({ status: "disconnected", selectedPort: "/dev/ttyUSB0" });
    await useDeviceStore.getState().connect();
    expect(useDeviceStore.getState().generation).toBe(1);
    await useDeviceStore.getState().disconnect();
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().generation).toBe(2);

    // Reader 1's straggler events, emitted on its way out.
    onConnected({
      targetName: "ELRS RX",
      firmwareVersion: "3.5.3",
      deviceType: "RX",
      port: "/dev/ttyUSB0",
      baud: 420000,
      paramCount: 12,
      serialNumber: 0,
      hardwareVersion: 0,
      generation: 1,
    });
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().device).toBeNull();

    onError({ message: "Lost connection to /dev/ttyUSB0", generation: 1 });
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().error).toBeNull();
    dispose();
  });

  it("accepts the live reader's events, and the generation it announces", async () => {
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onConnected = tauri.onDeviceConnected.mock.calls[0][0];

    // Reconnect after the cancel above: the backend issues a HIGHER generation.
    tauri.connectDevice.mockResolvedValueOnce(5);
    useDeviceStore.setState({
      status: "disconnected",
      selectedPort: "/dev/ttyUSB0",
      generation: 2,
    });
    await useDeviceStore.getState().connect();

    onConnected({
      targetName: "ELRS RX",
      firmwareVersion: "3.5.3",
      deviceType: "RX",
      port: "/dev/ttyUSB0",
      baud: 420000,
      paramCount: 12,
      serialNumber: 0,
      hardwareVersion: 0,
      generation: 5,
    });

    expect(useDeviceStore.getState().status).toBe("connected");
    // The generation is a transport concern: it must not leak into the stored
    // identity, which travels into the flash request.
    expect(useDeviceStore.getState().device).toEqual({
      targetName: "ELRS RX",
      firmwareVersion: "3.5.3",
      deviceType: "RX",
      port: "/dev/ttyUSB0",
      baud: 420000,
      paramCount: 12,
      serialNumber: 0,
      hardwareVersion: 0,
    });
    dispose();
  });

  it("leaves the floor alone when the backend reports a superseded connect", async () => {
    // `0` = the backend refused to open anything because the Cancel arrived
    // first. Raising the floor from it would re-admit the reader it tore down.
    const useDeviceStore = await loadStore();
    tauri.connectDevice.mockResolvedValueOnce(0);
    useDeviceStore.setState({
      status: "disconnected",
      selectedPort: "/dev/ttyUSB0",
      generation: 4,
    });

    await useDeviceStore.getState().connect();

    expect(useDeviceStore.getState().generation).toBe(4);
  });
});

/**
 * CONN-4: an unplug IS detected backend-side (POLLHUP → `BrokenPipe` →
 * `device://error`), but the store then sat at `status:"error"` with the dead
 * path still in `ports`/`selectedPort` and nothing ever re-enumerated. A replug
 * — usually on a NEW path (`/dev/ttyUSB1`, a different COM number) — showed
 * nothing until the user found the small refresh icon in the device bar.
 */
describe("useDeviceStore — hotplug re-enumeration (CONN-4)", () => {
  it("re-enumerates when the device drops off the bus", async () => {
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onDisconnected = tauri.onDeviceDisconnected.mock.calls[0][0];
    const onError = tauri.onDeviceError.mock.calls[0][0];
    // init() enumerates once up front.
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(1);

    useDeviceStore.setState({ status: "connected" });
    onError({ message: "Lost connection to /dev/ttyUSB0" });
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(2);

    useDeviceStore.setState({ status: "connected" });
    onDisconnected();
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("never re-enumerates from a device:// event mid-flash", async () => {
    // Re-enumerating mid-write can move `selectedPort` off the port being
    // written (the rebooting device drops off the bus), losing the
    // pre-selection the post-flash reconnect needs.
    const useDeviceStore = await loadStore();
    const dispose = await useDeviceStore.getState().init();
    const onDisconnected = tauri.onDeviceDisconnected.mock.calls[0][0];
    const onError = tauri.onDeviceError.mock.calls[0][0];
    tauri.listSerialPorts.mockClear();

    useDeviceStore.setState({ status: "flashing" });
    onDisconnected();
    onError({ message: "reader torn down" });

    expect(tauri.listSerialPorts).not.toHaveBeenCalled();
    dispose();
  });

  it("polls the port list while the port is free, and stops on dispose", async () => {
    vi.useFakeTimers();
    const { useDeviceStore, PORT_POLL_INTERVAL_MS } = await loadModule();
    const dispose = await useDeviceStore.getState().init();
    tauri.listSerialPorts.mockClear();

    useDeviceStore.setState({ status: "disconnected" });
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(1);
    // …and it keeps watching (a replug can land many seconds later).
    useDeviceStore.setState({ status: "error" });
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS * 2);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(3);

    dispose();
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS * 5);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(3);
  });

  it("stays off the bus while connected, connecting, flashing or in bootloader", async () => {
    vi.useFakeTimers();
    const { useDeviceStore, PORT_POLL_INTERVAL_MS } = await loadModule();
    const dispose = await useDeviceStore.getState().init();
    tauri.listSerialPorts.mockClear();

    for (const status of [
      "connected",
      "connecting",
      "flashing",
      "bootloader",
    ] as const) {
      useDeviceStore.setState({ status });
      await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS * 2);
      expect(tauri.listSerialPorts).not.toHaveBeenCalled();
    }

    // Back to a free port: the same timer resumes, no re-init needed.
    useDeviceStore.setState({ status: "disconnected" });
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("runs a single timer across a StrictMode double-mount", async () => {
    vi.useFakeTimers();
    const { useDeviceStore, PORT_POLL_INTERVAL_MS } = await loadModule();
    const disposeA = await useDeviceStore.getState().init();
    const disposeB = await useDeviceStore.getState().init();
    tauri.listSerialPorts.mockClear();

    useDeviceStore.setState({ status: "disconnected" });
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS);
    // One tick ⇒ one enumeration, not one per init() call.
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(1);

    // The still-mounted holder keeps the watcher alive.
    disposeA();
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(2);

    disposeB();
    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS * 3);
    expect(tauri.listSerialPorts).toHaveBeenCalledTimes(2);
  });

  it("does not poll when the event bridge is unavailable (outside Tauri)", async () => {
    vi.useFakeTimers();
    tauri.onDeviceConnected.mockRejectedValueOnce(new Error("no tauri"));
    const { useDeviceStore, PORT_POLL_INTERVAL_MS } = await loadModule();
    await useDeviceStore.getState().init();
    tauri.listSerialPorts.mockClear();

    await vi.advanceTimersByTimeAsync(PORT_POLL_INTERVAL_MS * 3);
    expect(tauri.listSerialPorts).not.toHaveBeenCalled();
  });
});
