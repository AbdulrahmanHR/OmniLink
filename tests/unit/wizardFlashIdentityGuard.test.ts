import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "@/stores/device";
import type { FlashErrorPayload, FlashRequestPayload } from "@/lib/tauri";

/**
 * FR-FLASH-10 — the identity guards must survive the flash that consults them.
 *
 * Both device-identity guards (TX/RX class, and the connected target NAME) are
 * evaluated inside `run_flash`, i.e. AFTER the wizard has handed the serial port
 * over (CONN-1) and the store has dropped the connection. So the refusal was
 * shown on a screen where `device` was already null — and the "try again" the
 * refusal invites re-built the request from that empty store: no
 * `connectedDeviceType`, no `connectedTargetName`, both guards abstaining, and
 * the Ranger image the first click refused written to a BetaFPV Nano TX.
 *
 * Two things close it, and this file pins the store half of both:
 *  - the identity outlives the connection (`lastIdentity`, per port), so the
 *    retry still carries evidence;
 *  - the refusal itself is remembered (`identityRefusal`), so the second click
 *    is answered by the wizard instead of becoming another flash.
 */

const tauri = vi.hoisted(() => ({
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve("cancelled")),
  saveProfile: vi.fn(() => Promise.resolve()),
  onFlashProgress: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onFlashLog: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onFlashDone: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  onFlashError: vi.fn((_cb: (e: FlashErrorPayload) => void) =>
    Promise.resolve(() => {})
  ),
  onFlashCancelled: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  // Device-store seam.
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve(1)),
  disconnectDevice: vi.fn(() => Promise.resolve(1)),
  onDeviceConnected: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn((_cb: () => void) => Promise.resolve(() => {})),
  onDeviceError: vi.fn((_cb: unknown) => Promise.resolve(() => {})),
}));

vi.mock("@/lib/tauri", () => tauri);

/** Fresh module graph per test — both stores keep module-level state. */
async function loadStores() {
  vi.resetModules();
  const device = await import("@/stores/device");
  const wizard = await import("@/stores/wizard");
  return {
    useDeviceStore: device.useDeviceStore,
    useWizardStore: wizard.useWizardStore,
  };
}

/** The radio actually on the bench. */
const NANO_TX: DeviceInfo = {
  targetName: "BETAFPV_2400_TX",
  firmwareVersion: "3.4.3",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 42,
  serialNumber: 1,
  hardwareVersion: 1,
};

/** A UART flash of a DIFFERENT model — what the guard has to refuse. */
const RANGER_OVER_UART: FlashRequestPayload = {
  target: "RADIOMASTER_RANGER_2400",
  deviceType: "TX",
  mcu: "ESP32",
  version: "3.5.3",
  method: "uart",
  port: "/dev/ttyUSB0",
  connectedDeviceType: "TX",
  connectedTargetName: "BETAFPV_2400_TX",
  options: { bindingPhrase: "test", useTraditionalBinding: false },
};

const MISMATCH: FlashErrorPayload = {
  category: "firmwareMismatch",
  summaryKey: "connectedTargetMismatch",
  detail:
    "refusing to flash the selected target 'RADIOMASTER_RANGER_2400' onto a " +
    "connected device identified as 'BETAFPV_2400_TX'",
  recoverySteps: ["retry"],
  diagnostic: "",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("device store — the identity outlives the connection", () => {
  it("retains the last handshake through the disconnect a flash performs", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);

    // The port really was handed over — the live identity is gone (CONN-1)…
    expect(useDeviceStore.getState().device).toBeNull();
    // …but what the handshake read is still on record, tagged with the port it
    // was read from, so the retry can still be judged.
    expect(useDeviceStore.getState().lastIdentity).toEqual(NANO_TX);
  });

  it("keeps it through the post-flash settle, refusal or not", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0](MISMATCH);

    // `settleDeviceAfterFlash` resets the device store for a serial flash; that
    // reset is exactly the moment the old code lost the evidence.
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().device).toBeNull();
    expect(useDeviceStore.getState().lastIdentity).toEqual(NANO_TX);
  });

  it("replaces it only on a fresh handshake", async () => {
    const { useDeviceStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);

    // A cleared live identity is not a new one.
    useDeviceStore.getState().setDevice(null);
    expect(useDeviceStore.getState().lastIdentity).toEqual(NANO_TX);

    const ranger: DeviceInfo = {
      ...NANO_TX,
      targetName: "RADIOMASTER_RANGER_2400",
    };
    useDeviceStore.getState().setDevice(ranger);
    expect(useDeviceStore.getState().lastIdentity).toEqual(ranger);
  });
});

describe("wizard store — an identity refusal is sticky", () => {
  it("records the refused (port, target) pair", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0](MISMATCH);

    expect(useWizardStore.getState().identityRefusal).toEqual({
      port: "/dev/ttyUSB0",
      target: "RADIOMASTER_RANGER_2400",
    });
  });

  it("records the TX/RX guard's refusal too — same lost evidence", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0]({
      ...MISMATCH,
      summaryKey: "txRxMismatch",
    });

    expect(useWizardStore.getState().identityRefusal).not.toBeNull();
  });

  it("survives Start Over — nothing about the hardware changed", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0](MISMATCH);
    useWizardStore.getState().reset();
    // …and the error screen's own "try again", which only clears the slice.
    useWizardStore.getState().resetFlash();

    expect(useWizardStore.getState().identityRefusal).toEqual({
      port: "/dev/ttyUSB0",
      target: "RADIOMASTER_RANGER_2400",
    });
  });

  it("is not raised by a failure that is not about the device's identity", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0]({
      ...MISMATCH,
      category: "networkTimeout",
      summaryKey: "firmwareDownloadFailed",
    });

    expect(useWizardStore.getState().identityRefusal).toBeNull();
  });

  it("is cleared by a flash that ran all the way through", async () => {
    const { useDeviceStore, useWizardStore } = await loadStores();
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");

    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashError.mock.calls[0][0](MISMATCH);
    expect(useWizardStore.getState().identityRefusal).not.toBeNull();

    // The user reconnects the matching radio and the flash is allowed through:
    // the refusal has been answered, so it must not outlive it and block the
    // next legitimate flash of the same model on the same port.
    useDeviceStore.getState().setDevice(NANO_TX);
    useDeviceStore.getState().setStatus("connected");
    await useWizardStore.getState().startFlash(RANGER_OVER_UART);
    tauri.onFlashDone.mock.calls[0][0]();

    expect(useWizardStore.getState().identityRefusal).toBeNull();
  });
});
