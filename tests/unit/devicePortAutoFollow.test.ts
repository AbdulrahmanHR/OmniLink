import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONN-10, the other half: the port pin was effectively PERMANENT.
 *
 * `setSelectedPort(null)` is the only thing that releases it, and the only UI
 * that emitted `null` was the picker's "Select a port" placeholder — which
 * renders ONLY while nothing is selected, i.e. never again once anything is. On
 * top of that `connect()` pinned unconditionally, including the first-port
 * default the hotplug watcher filled in and the user never touched: one click on
 * Connect and auto-follow was dead for the rest of the session, with no way back.
 *
 * The pin still has to survive a flashed board's path disappearing (that is what
 * it is FOR — see `device.test.ts`), so the fix is a way out, not a weaker pin.
 */

const tauri = vi.hoisted(() => ({
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve(1)),
  disconnectDevice: vi.fn(() => Promise.resolve(1)),
  onDeviceConnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/tauri", () => tauri);

async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/device");
  return mod.useDeviceStore;
}

const ACM0 = { path: "/dev/ttyACM0", product: "Flight controller" };
const USB0 = { path: "/dev/ttyUSB0", product: "CP2102 USB UART" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useDeviceStore — the way back to auto-follow", () => {
  it("adopts the first enumerated port at once when the pin is released", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0, USB0]);
    await useDeviceStore.getState().refreshPorts();
    useDeviceStore.getState().setSelectedPort(USB0.path);
    expect(useDeviceStore.getState().portPinned).toBe(true);

    useDeviceStore.getState().setSelectedPort(null);

    // Not an empty picker with Connect inert until the next 2s poll: releasing
    // the pin IS choosing the default, so the default applies immediately.
    expect(useDeviceStore.getState().selectedPort).toBe(ACM0.path);
    expect(useDeviceStore.getState().portPinned).toBe(false);
  });

  it("follows the enumeration again once released", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();
    useDeviceStore.getState().setSelectedPort(ACM0.path);

    // Pinned: the watcher must not move it, even to a port that IS present.
    tauri.listSerialPorts.mockResolvedValueOnce([USB0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(ACM0.path);

    useDeviceStore.getState().setSelectedPort(null);
    tauri.listSerialPorts.mockResolvedValueOnce([USB0]);
    await useDeviceStore.getState().refreshPorts();

    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
  });
});

describe("useDeviceStore.connect — what counts as a deliberate destination", () => {
  it("does not pin a first-port default the user never touched", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(ACM0.path);

    await useDeviceStore.getState().connect();

    expect(tauri.connectDevice).toHaveBeenCalledWith(ACM0.path);
    expect(useDeviceStore.getState().portPinned).toBe(false);
    // …so hotplug auto-follow is still alive after the first Connect.
    useDeviceStore.setState({ status: "disconnected" });
    tauri.listSerialPorts.mockResolvedValueOnce([USB0]);
    await useDeviceStore.getState().refreshPorts();
    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
  });

  it("pins a port it was NAMED, so a failed attempt stays on target", async () => {
    const useDeviceStore = await loadStore();
    useDeviceStore.setState({ status: "disconnected" });

    await useDeviceStore.getState().connect(USB0.path);

    expect(useDeviceStore.getState().selectedPort).toBe(USB0.path);
    expect(useDeviceStore.getState().portPinned).toBe(true);
  });

  it("keeps a pin the user already made", async () => {
    const useDeviceStore = await loadStore();
    tauri.listSerialPorts.mockResolvedValueOnce([ACM0, USB0]);
    await useDeviceStore.getState().refreshPorts();
    useDeviceStore.getState().setSelectedPort(USB0.path);

    await useDeviceStore.getState().connect();

    expect(tauri.connectDevice).toHaveBeenCalledWith(USB0.path);
    expect(useDeviceStore.getState().portPinned).toBe(true);
  });
});
