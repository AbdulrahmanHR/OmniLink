import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlashErrorPayload,
  FlashLogPayload,
  FlashProgressPayload,
  FlashRequestPayload,
} from "@/lib/tauri";

// Capture the event handlers the wizard store registers so the test can drive
// the `flash://*` event lifecycle without a real Tauri backend.
const handlers = vi.hoisted(() => ({
  progress: null as null | ((p: FlashProgressPayload) => void),
  log: null as null | ((l: FlashLogPayload) => void),
  done: null as null | (() => void),
  error: null as null | ((e: FlashErrorPayload) => void),
  cancelled: null as null | (() => void),
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve()),
  // CONN-1: the wizard must hand the serial port over before a serial flash.
  disconnectDevice: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  startFlash: handlers.startFlash,
  cancelFlash: handlers.cancelFlash,
  onFlashProgress: (h: (p: FlashProgressPayload) => void) => {
    handlers.progress = h;
    return Promise.resolve(() => {});
  },
  onFlashLog: (h: (l: FlashLogPayload) => void) => {
    handlers.log = h;
    return Promise.resolve(() => {});
  },
  onFlashDone: (h: () => void) => {
    handlers.done = h;
    return Promise.resolve(() => {});
  },
  onFlashError: (h: (e: FlashErrorPayload) => void) => {
    handlers.error = h;
    return Promise.resolve(() => {});
  },
  onFlashCancelled: (h: () => void) => {
    handlers.cancelled = h;
    return Promise.resolve(() => {});
  },
  // M25: the wizard store persists a best-effort recovery profile before a
  // local-file flash. Unused on these release-flash paths, but the module must
  // export it so the store's import resolves under the mock.
  saveProfile: vi.fn(() => Promise.resolve()),
  // Device-store imports (unused here, but the module must export them).
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve()),
  disconnectDevice: handlers.disconnectDevice,
  onDeviceConnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceError: vi.fn(() => Promise.resolve(() => {})),
  onLinkStats: vi.fn(() => Promise.resolve(() => {})),
}));

import {
  canCancelFlash,
  isPointOfNoReturn,
  useWizardStore,
  type FlashStage,
} from "@/stores/wizard";
import { useDeviceStore, type DeviceInfo } from "@/stores/device";

const REQUEST: FlashRequestPayload = {
  target: "BETAFPV_2400_TX",
  deviceType: "TX",
  // The MCU family travels with the request so the engine can pick esptool's
  // `--chip` + write offset (ESP32 app images at 0x10000, never 0x0).
  mcu: "ESP32",
  version: "3.5.3",
  method: "uart",
  port: "/dev/ttyUSB0",
  options: { bindingPhrase: "test", useTraditionalBinding: false },
};

/** The pre-flash CRSF identity — stale the moment the device reboots (CONN-6). */
const CONNECTED: DeviceInfo = {
  targetName: "BETAFPV_2400_TX",
  firmwareVersion: "3.4.0",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 42,
  serialNumber: 1,
  hardwareVersion: 1,
};

describe("wizard store — real flash flow", () => {
  beforeEach(() => {
    // Settle whatever a previous case left in flight. The store's one-flash
    // lockout is module state and is deliberately NOT released by `reset()`:
    // "Start Over" is reachable mid-write (the header button is never disabled),
    // and clearing the flash slice there must not re-arm Start Flash over a port
    // esptool still owns. A terminal `flash://*` event is what ends a flash.
    handlers.cancelled?.();
    useWizardStore.getState().reset();
    useDeviceStore.setState({
      status: "connected",
      device: CONNECTED,
      error: null,
      selectedPort: CONNECTED.port,
    });
    handlers.startFlash.mockClear();
    handlers.disconnectDevice.mockClear();
  });

  it("invokes the backend and moves to running", async () => {
    await useWizardStore.getState().startFlash(REQUEST);
    expect(handlers.startFlash).toHaveBeenCalledWith(REQUEST);
    expect(useWizardStore.getState().flash.status).toBe("running");
    // The connected device is put into the flashing state for the duration.
    expect(useDeviceStore.getState().status).toBe("flashing");
  });

  it("drives progress + log + done from flash:// events", async () => {
    await useWizardStore.getState().startFlash(REQUEST);

    handlers.progress?.({ stage: "write", percent: 60, etaSeconds: 12 });
    handlers.log?.({ line: "Writing at 0x10000", isError: false });

    let flash = useWizardStore.getState().flash;
    expect(flash.stage).toBe("write");
    expect(flash.percent).toBe(60);
    expect(flash.etaSeconds).toBe(12);
    expect(flash.log).toContain("Writing at 0x10000");

    handlers.done?.();
    flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("done");
    expect(flash.percent).toBe(100);
    // CONN-6: the device rebooted into new firmware, so it is NOT still the
    // connected device it was — the port was handed to esptool and the cached
    // identity is stale.
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().device).toBeNull();
  });

  it("surfaces a categorized error from flash://error", async () => {
    await useWizardStore.getState().startFlash(REQUEST);
    handlers.error?.({
      category: "wiring",
      summaryKey: "toolFailed",
      detail: "Failed to connect to ESP32",
      recoverySteps: ["checkUsb", "reconnect"],
      diagnostic: "diag block",
    });
    const flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("error");
    expect(flash.error?.category).toBe("wiring");
    expect(flash.error?.recoverySteps).toEqual(["checkUsb", "reconnect"]);
    // A failed serial flash also leaves the port released + the identity cleared:
    // the device may be half-written or sitting in the bootloader.
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().device).toBeNull();
  });

  it("treats cancel as a distinct outcome, never an error", async () => {
    await useWizardStore.getState().startFlash(REQUEST);
    expect(useWizardStore.getState().flash.status).toBe("running");

    // The backend emits flash://cancelled (not flash://error) on a user cancel.
    handlers.cancelled?.();

    const flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("idle");
    expect(flash.error).toBeNull();
    // Settled, not left in "flashing" — the port was already released.
    expect(useDeviceStore.getState().status).toBe("disconnected");
    expect(useDeviceStore.getState().device).toBeNull();
  });

  it("cancelFlash() signals the backend and resets to idle", async () => {
    await useWizardStore.getState().startFlash(REQUEST);
    await useWizardStore.getState().cancelFlash();
    expect(handlers.cancelFlash).toHaveBeenCalled();
    const flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("idle");
    expect(flash.error).toBeNull();
  });

  it("keeps the flash running when the backend REFUSES the cancel", async () => {
    // FLASH-4: past the point of no return the backend answers
    // `writeInProgress` and lets the flash finish — the UI must not pretend it
    // stopped (a false "idle" would invite the user to unplug mid-write).
    await useWizardStore.getState().startFlash(REQUEST);
    handlers.progress?.({ stage: "erase", percent: 30, etaSeconds: 5 });
    handlers.cancelFlash.mockResolvedValueOnce("writeInProgress");

    await useWizardStore.getState().cancelFlash();

    const flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("running");
    expect(flash.error).toBeNull();
    // The refusal reason is reflected locally, so the control disappears at
    // once instead of on the next progress event.
    expect(flash.stage).toBe("write");
    expect(canCancelFlash(flash.status, flash.stage)).toBe(false);
    // The device is still mid-flash, not settled back to a connectable state.
    expect(useDeviceStore.getState().status).toBe("flashing");
  });
  it("releases the serial port BEFORE the flash worker starts (CONN-1/FLASH-3)", async () => {
    await useWizardStore.getState().startFlash(REQUEST);

    // The CRSF reader owns the port exclusively; esptool cannot open it while
    // we stay connected, so the disconnect has to happen first — not after.
    expect(handlers.disconnectDevice).toHaveBeenCalled();
    expect(
      handlers.disconnectDevice.mock.invocationCallOrder[0]
    ).toBeLessThan(handlers.startFlash.mock.invocationCallOrder[0]);

    // The store stops claiming a live connection, but keeps the flashed port
    // pre-selected for the post-flash reconnect.
    expect(useDeviceStore.getState().device).toBeNull();
    expect(useDeviceStore.getState().selectedPort).toBe("/dev/ttyUSB0");
    expect(useDeviceStore.getState().status).toBe("flashing");
  });

  it("does NOT touch the serial connection for a WiFi OTA flash", async () => {
    // WiFi OTA goes over HTTP and never opens the port, so a live CRSF
    // connection must survive the flash untouched.
    const wifi: FlashRequestPayload = {
      ...REQUEST,
      method: "wifi",
      port: null,
      deviceIp: "10.0.0.1",
    };
    await useWizardStore.getState().startFlash(wifi);

    expect(handlers.disconnectDevice).not.toHaveBeenCalled();
    expect(useDeviceStore.getState().status).toBe("flashing");
    // The identity is still ours — it was never released.
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);

    handlers.done?.();
    // The link is still ours — and so is the identity behind it. Nothing in
    // this request says the OTA addressed the device on the serial port
    // (`connectedTargetName` is absent), so wiping its identity would report a
    // link with no device on it AND leave the next flash's FR-FLASH-10 guards
    // with nothing to compare against.
    expect(useDeviceStore.getState().status).toBe("connected");
    expect(useDeviceStore.getState().device).toEqual(CONNECTED);
  });

  it("resetFlash returns the slice to idle", async () => {
    await useWizardStore.getState().startFlash(REQUEST);
    handlers.error?.({
      category: "unknown",
      summaryKey: "startFailed",
      detail: "x",
      recoverySteps: ["retry"],
      diagnostic: "x",
    });
    useWizardStore.getState().resetFlash();
    const flash = useWizardStore.getState().flash;
    expect(flash.status).toBe("idle");
    expect(flash.log).toEqual([]);
    expect(flash.error).toBeNull();
  });
});

/**
 * FLASH-11: the cancel control is reachable, but ONLY while a cancel is still
 * safe. The gate is the stage — the same instant the Rust uploader takes the
 * point of no return (`FlashCancel::enter_write`), after which `cancel_flash`
 * returns `writeInProgress` — so a control that survived past `write` would be
 * one that silently does nothing (or, before this fix, killed esptool mid-erase
 * and bricked the device).
 */
describe("flash cancel gating by stage", () => {
  const STAGES: FlashStage[] = ["fetch", "erase", "write", "verify", "done"];

  it("allows cancelling only before the write begins", () => {
    const allowed = STAGES.filter((stage) => canCancelFlash("running", stage));
    expect(allowed).toEqual(["fetch", "erase"]);
  });

  it("treats write/verify/done as the point of no return", () => {
    expect(STAGES.filter(isPointOfNoReturn)).toEqual([
      "write",
      "verify",
      "done",
    ]);
  });

  it("offers no cancel unless a flash is actually running", () => {
    for (const status of ["idle", "done", "error"] as const) {
      for (const stage of STAGES) {
        expect(canCancelFlash(status, stage)).toBe(false);
      }
    }
  });
});
