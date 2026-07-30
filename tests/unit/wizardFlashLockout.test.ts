import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@/stores/device";
import type { FlashRequestPayload } from "@/lib/tauri";

/**
 * Two things the flash path got wrong around its own boundaries.
 *
 * 1. `device.error` was never scoped to a flash. The settle reads it to choose
 *    between "error" and "disconnected", but only the SERIAL path ever cleared
 *    it — as a side effect of `disconnect()`. A WiFi OTA therefore inherited
 *    whatever was left over: a "Permission denied on /dev/ttyUSB0" from a failed
 *    connect, or the previous session's "Lost connection to …", presented as the
 *    outcome of a flash that SUCCEEDED — the wizard's success screen next to a
 *    red error chip carrying a message from before the flash began.
 *    And the disconnect handler then threw the genuine cause away: a link that
 *    dies mid-OTA reports `device://error` AND `device://disconnected`, and the
 *    second event cleared the message the first one retained.
 *
 * 2. The re-entry guard was read at the top of `startFlash` but `flash.status`
 *    only reaches "running" after four awaits — one of them a real IPC round
 *    trip (`disconnect()` joins the reader thread). A second click landed inside
 *    that window, ran the whole preamble again and reached `start_flash`; the
 *    backend refused it, and the refusal's `catch` settled — consuming the
 *    module-global port flag and running `device.reset()` while the FIRST flash
 *    was still writing. That dropped the store to "disconnected", where
 *    `canClaimPort` re-enables the picker, Connect and the bridge probe over the
 *    port esptool owns, and made the later `flash://done` a no-op.
 */

const tauri = vi.hoisted(() => ({
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve("cancelled")),
  saveProfile: vi.fn(() => Promise.resolve()),
  onFlashProgress: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onFlashLog: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onFlashDone: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  onFlashError: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onFlashCancelled: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  // Device-store seam.
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve(1)),
  disconnectDevice: vi.fn(() => Promise.resolve(1)),
  onDeviceConnected: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  onDeviceError: vi.fn((_cb: (p: { message: string }) => void) =>
    Promise.resolve(() => {})
  ),
}));

vi.mock("@/lib/tauri", () => tauri);

/** Fresh module graph per test — the flash lockout is module state. */
async function loadStores() {
  vi.resetModules();
  const device = await import("@/stores/device");
  const wizard = await import("@/stores/wizard");
  return {
    useDeviceStore: device.useDeviceStore,
    useWizardStore: wizard.useWizardStore,
  };
}

/** Let every queued microtask (and the IPC mocks' promises) drain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const CONNECTED: DeviceInfo = {
  targetName: "BETAFPV_2400_TX",
  firmwareVersion: "3.4.3",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 42,
  serialNumber: 1,
  hardwareVersion: 1,
};

/** A WiFi OTA: HTTP, so it never touches the serial port (CONN-1). */
const WIFI: FlashRequestPayload = {
  target: "BETAFPV_2400_TX",
  deviceType: "TX",
  mcu: "ESP32",
  version: "3.5.3",
  method: "wifi",
  port: null,
  deviceIp: "10.0.0.1",
  options: { bindingPhrase: "test", useTraditionalBinding: false },
};

/** A UART flash: it hands the serial port over before the worker starts. */
const UART: FlashRequestPayload = {
  ...WIFI,
  method: "uart",
  port: "/dev/ttyUSB0",
  deviceIp: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startFlash — device.error is scoped to the flash", () => {
  it("does not present a pre-flash error as this flash's outcome", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    // A serial connect failed; the user gives up on the cable and flashes over
    // WiFi instead. The OTA never goes near the port that refused to open.
    useDeviceStore.setState({
      status: "error",
      device: null,
      error: "Permission denied on /dev/ttyUSB0",
    });

    await useWizardStore.getState().startFlash(WIFI);
    // Cleared on the way in, so the retained-error channel can only ever carry
    // something the flashing guard captured during THIS flash.
    expect(useDeviceStore.getState().error).toBeNull();

    tauri.onFlashDone.mock.calls[0][0]();

    expect(useWizardStore.getState().flash.status).toBe("done");
    // Nothing was connected and nothing failed during the flash: "disconnected"
    // is the truth. It used to be "error", wearing the pre-flash message.
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().error).toBeNull();
  });

  it("does not re-present the previous session's cause on the next OTA", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    const dispose = await useDeviceStore.getState().init();
    const onDeviceError = tauri.onDeviceError.mock.calls[0][0];
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    // Session 1: the device is unplugged mid-OTA. The message is retained and
    // the settle reports it — that part is the point of the retention.
    await useWizardStore.getState().startFlash(WIFI);
    onDeviceError({ message: "Lost connection to /dev/ttyUSB0" });
    tauri.onFlashDone.mock.calls[0][0]();
    expect(useDeviceStore.getState().status).toBe("error");
    expect(useDeviceStore.getState().error).toBe(
      "Lost connection to /dev/ttyUSB0"
    );

    // Session 2: the user replugs, reconnects and flashes again — successfully.
    useDeviceStore.setState({ status: "connected", device: CONNECTED });
    await useWizardStore.getState().startFlash(WIFI);
    expect(useDeviceStore.getState().error).toBeNull();
    tauri.onFlashDone.mock.calls[0][0]();

    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().error).toBeNull();
    dispose();
  });

  it("keeps the retained cause when the link also reports a clean disconnect", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    const dispose = await useDeviceStore.getState().init();
    const onDeviceError = tauri.onDeviceError.mock.calls[0][0];
    const onDeviceDisconnected = tauri.onDeviceDisconnected.mock.calls[0][0];
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI);
    // A dying CRSF reader reports both, in either order. The disconnect handler
    // used to null `error` even in the flashing branch, so the settle landed on
    // a bare "disconnected" — the cause the retention exists to preserve, gone.
    onDeviceError({ message: "Lost connection to /dev/ttyUSB0" });
    onDeviceDisconnected();
    expect(useDeviceStore.getState().error).toBe(
      "Lost connection to /dev/ttyUSB0"
    );

    tauri.onFlashDone.mock.calls[0][0]();

    expect(useDeviceStore.getState().status).toBe("error");
    expect(useDeviceStore.getState().error).toBe(
      "Lost connection to /dev/ttyUSB0"
    );
    dispose();
  });
});

describe("startFlash — the one-flash lockout", () => {
  it("refuses a second call inside the pre-'running' window", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({
      status: "connected",
      device: CONNECTED,
      selectedPort: "/dev/ttyUSB0",
    });
    // Park the first call on the disconnect IPC — the widest part of the window
    // the old guard left open (it joins the CRSF reader thread).
    let releaseDisconnect!: () => void;
    tauri.disconnectDevice.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releaseDisconnect = () => resolve(1);
        })
    );

    const first = useWizardStore.getState().startFlash(UART);
    const second = useWizardStore.getState().startFlash(UART);
    await second;
    await flush();

    // The first flash has not reached the backend yet and `flash.status` is not
    // "running" — exactly the state the old guard read as "free".
    expect(useWizardStore.getState().flash.status).not.toBe("running");
    expect(tauri.startFlash).not.toHaveBeenCalled();

    releaseDisconnect();
    await first;

    // One flash, one worker — and the second call settled nothing: the device is
    // still owned by the flash rather than reset to "disconnected", where the
    // picker, Connect and the bridge probe would be live over esptool's port.
    expect(tauri.startFlash).toHaveBeenCalledTimes(1);
    expect(useWizardStore.getState().flash.status).toBe("running");
    expect(useDeviceStore.getState().status).toBe("flashing");
  });

  it("is not re-armed by Start Over mid-flash", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI);
    // The header's Start Over button is never disabled, so this IS reachable
    // while a worker runs. Clearing the flash slice must not hand the user a
    // second `start_flash` over a device that is being written.
    useWizardStore.getState().reset();
    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).toHaveBeenCalledTimes(1);
    expect(useDeviceStore.getState().status).toBe("flashing");
  });

  it("releases the lockout on every failure to start", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    // CONN-11: refused because a handshake owns the port. The claim taken at the
    // top of `startFlash` has to be given back on this path, or the wizard is
    // dead for the rest of the session.
    useDeviceStore.setState({ status: "connecting", device: null });
    await useWizardStore.getState().startFlash(WIFI);
    expect(useWizardStore.getState().flash.error?.summaryKey).toBe(
      "startFailed"
    );

    useDeviceStore.setState({ status: "disconnected", device: null });
    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).toHaveBeenCalledTimes(1);
    expect(useWizardStore.getState().flash.status).toBe("running");
  });

  it("releases it when the flash finishes, so the next one can start", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI);
    tauri.onFlashDone.mock.calls[0][0]();
    useWizardStore.getState().resetFlash();
    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).toHaveBeenCalledTimes(2);
    expect(useWizardStore.getState().flash.status).toBe("running");
  });
});
