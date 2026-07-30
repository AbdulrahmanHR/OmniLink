import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@/stores/device";
import type { FlashRequestPayload } from "@/lib/tauri";

/**
 * CONN-11 / FLASH-12 — how a PORT-PRESERVING (WiFi OTA) flash settles the device
 * store, and what happens when the `flash://*` bridge itself fails.
 *
 * The store used to snapshot the device status before the flash and restore it
 * on completion. The snapshot lied in both directions:
 *  - started from "connecting" (StepReview had no gate, and a WiFi flash
 *    disconnects nothing) the handshake's failure event was swallowed as flash
 *    noise, so the restore put the bar back on a spinner with no reader behind
 *    it — permanently inert, because `canClaimPort("connecting")` is false;
 *  - unplugged mid-OTA it restored "connected" over a null identity: green dot,
 *    Disconnect button, no device chip, and a telemetry session that never
 *    receives a frame.
 * It also never touched `device`, so a successful upgrade left the bar (and the
 * next flash's `backupTarget`) reporting the PRE-flash firmware version.
 *
 * The rewrite then overshot in the other direction: it dropped the identity on
 * EVERY port-preserving outcome — success, failure and cancel alike, and
 * whether or not the OTA had anything to do with the connected device — while
 * leaving the status at "connected". That is the same green-dot/no-device-chip
 * lie, plus a silent disarming of the FR-FLASH-10 guards (the next flash sends
 * no `connectedDeviceType`, no `connectedTargetName` and no `backupTarget`).
 *
 * And `ensureFlashListeners` cached a rejected `Promise.all` forever: one
 * `listen()` failure and every later Start Flash threw before setting any state
 * — a silent dead click (the caller is `void startFlash(...)`) for the rest of
 * the session.
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

/**
 * Fresh module graph per test: both stores keep module-level state (the flash
 * listener cache, the device listener guard) that must not leak between cases.
 * The wizard store imports the device store, so importing device first hands
 * both tests the SAME instance.
 */
async function loadStores() {
  vi.resetModules();
  const device = await import("@/stores/device");
  const wizard = await import("@/stores/wizard");
  return {
    useDeviceStore: device.useDeviceStore,
    useWizardStore: wizard.useWizardStore,
  };
}

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

/**
 * A WiFi OTA: HTTP, so it never touches the serial port (CONN-1). Nothing in
 * this request links it to the device on the serial port — its
 * `connectedTargetName` is absent, so the connected radio is NOT the one being
 * written.
 */
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

/**
 * The same OTA, but aimed at the radio we are connected to: the request carries
 * the connected device's resolved target and it is the one being flashed.
 */
const WIFI_SAME_DEVICE: FlashRequestPayload = {
  ...WIFI,
  connectedDeviceType: "TX",
  connectedTargetName: "BETAFPV_2400_TX",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settleDeviceAfterFlash — port-preserving flash", () => {
  it("drops only what a completed OTA changed on the device it addressed", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI_SAME_DEVICE);
    expect(useDeviceStore.getState().status).toBe("flashing");
    tauri.onFlashDone.mock.calls[0][0]();

    // The link is still ours, so the status is — and so is the HARDWARE
    // identity: an OTA replaces firmware, not the radio, and that identity is
    // what the FR-FLASH-10 guards run on. What it DID invalidate is the version
    // word: the device runs 3.5.3 now, so the bar (plus the next flash's
    // `backupTarget`) must not keep reporting the 3.4.3 we handshook with. It
    // reads as unknown until a reconnect re-reads it.
    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().device).toEqual({
      ...CONNECTED,
      firmwareVersion: null,
    });
  });

  it("leaves the identity alone when the OTA addressed another device", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    // An OTA over HTTP to some device on the network. The serial CRSF reader was
    // never touched, so the radio on the desk is still exactly what it was —
    // dropping its identity here landed the store on "connected" with a null
    // device (green dot, no device chip) AND silently disarmed the next flash's
    // identity guards, which is the state this settle exists to prevent.
    await useWizardStore.getState().startFlash(WIFI);
    tauri.onFlashDone.mock.calls[0][0]();

    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);
  });

  it("leaves the identity alone when the OTA was cancelled", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    // Even for the connected device: a cancel means nothing was written, so the
    // identity the handshake read is still true in every field.
    await useWizardStore.getState().startFlash(WIFI_SAME_DEVICE);
    tauri.onFlashCancelled.mock.calls[0][0]();

    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);
  });

  it("leaves the identity alone when the OTA failed", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI_SAME_DEVICE);
    tauri.onFlashError.mock.calls[0][0]({
      category: "networkTimeout",
      summaryKey: "otaUploadFailed",
      detail: "timed out",
      recoverySteps: ["retry"],
      diagnostic: "timed out",
    });

    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);
  });

  it("settles to error with the cause when the link died mid-OTA", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    const dispose = await useDeviceStore.getState().init();
    const onDeviceError = tauri.onDeviceError.mock.calls[0][0];
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI);
    // The user unplugs the device: the flashing guard swallows the event so it
    // can't knock the status out of "flashing", but the reader IS gone.
    onDeviceError({ message: "Lost connection to /dev/ttyUSB0" });
    tauri.onFlashDone.mock.calls[0][0]();

    // No fake "connected": a green dot with no device chip and a telemetry
    // session that never receives a frame is worse than the truth.
    expect(useDeviceStore.getState().status).toBe("error");
    expect(useDeviceStore.getState().error).toBe(
      "Lost connection to /dev/ttyUSB0"
    );
    expect(useDeviceStore.getState().device).toBeNull();
    dispose();
  });

  it("lands on disconnected when nothing was connected to begin with", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "disconnected", device: null });

    await useWizardStore.getState().startFlash(WIFI);
    tauri.onFlashError.mock.calls[0][0]({
      category: "networkTimeout",
      summaryKey: "otaUploadFailed",
      detail: "timed out",
      recoverySteps: ["retry"],
      diagnostic: "timed out",
    });

    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useWizardStore.getState().flash.status).toBe("error");
  });

  it("settles once — a second call leaves the user's state alone", async () => {
    // `cancelFlash()` and the `flash://cancelled` event both settle.
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "connected", device: CONNECTED });

    await useWizardStore.getState().startFlash(WIFI);
    await useWizardStore.getState().cancelFlash();
    expect(useDeviceStore.getState().status).toBe("connected");

    // The user reconnects before the event arrives; the late settle must not
    // wipe the fresh identity.
    useDeviceStore.setState({ status: "connected", device: CONNECTED });
    tauri.onFlashCancelled.mock.calls[0][0]();
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);
  });
});

describe("startFlash — refuses to start on top of a handshake", () => {
  it("does not flash while the device status is connecting", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    // A CRSF connect is a ~4.5s baud sweep that owns the port; a WiFi flash
    // disconnects nothing, so the old code sailed straight past it and later
    // restored the "connecting" spinner with no reader behind it.
    useDeviceStore.setState({ status: "connecting", device: null });

    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).not.toHaveBeenCalled();
    // Never a silent no-op: the click is answered.
    expect(useWizardStore.getState().flash.status).toBe("error");
    expect(useWizardStore.getState().flash.error?.summaryKey).toBe(
      "startFailed"
    );
    // …and the handshake is left exactly as it was, still cancellable.
    expect(useDeviceStore.getState().status).toBe("connecting");
  });

  it("starts normally from every other status", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "disconnected", device: null });

    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).toHaveBeenCalledWith(WIFI);
    expect(useWizardStore.getState().flash.status).toBe("running");
  });
});

describe("ensureFlashListeners — a failed registration is not cached", () => {
  it("reports the failure and re-registers on the next attempt", async () => {
    const unProgress = vi.fn();
    const unLog = vi.fn();
    tauri.onFlashProgress.mockResolvedValueOnce(unProgress);
    tauri.onFlashLog.mockResolvedValueOnce(unLog);
    tauri.onFlashDone.mockRejectedValueOnce(new Error("bridge down"));

    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.setState({ status: "disconnected", device: null });

    await useWizardStore.getState().startFlash(WIFI);

    // A visible failure, not an unhandled rejection out of `void startFlash()`.
    expect(useWizardStore.getState().flash.status).toBe("error");
    expect(useWizardStore.getState().flash.error?.summaryKey).toBe(
      "startFailed"
    );
    // Nothing was started, and the device was never moved into "flashing".
    expect(tauri.startFlash).not.toHaveBeenCalled();
    expect(useDeviceStore.getState().status).toBe("disconnected");
    // The handles that DID land were released, so the retry starts from zero.
    expect(unProgress).toHaveBeenCalledTimes(1);
    expect(unLog).toHaveBeenCalledTimes(1);

    // The bridge is back: the same session can flash again.
    await useWizardStore.getState().startFlash(WIFI);

    expect(tauri.startFlash).toHaveBeenCalledTimes(1);
    expect(useWizardStore.getState().flash.status).toBe("running");
    // Exactly one live copy of each listener — the survivors were not doubled.
    expect(tauri.onFlashProgress).toHaveBeenCalledTimes(2);
    expect(tauri.onFlashDone).toHaveBeenCalledTimes(2);
  });
});
