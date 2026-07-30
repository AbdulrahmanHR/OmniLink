import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeFamilyLabelKey,
  bridgePortFunctionLabelKey,
  isBridgeCandidate,
  isBridgeContextEmpty,
  isLabeledBridge,
  isStaleBridgeResult,
  BRIDGE_PORT_FUNCTIONS,
  BRIDGE_RECOVERY_KEYS,
} from "@/lib/bridge";
import type { BridgeClassificationDto, BridgeContextDto } from "@/lib/tauri";

/**
 * Coverage for the M63 controller-bridge discovery seam:
 *  - the non-persisted `stores/bridge.ts` probe lifecycle (idle → probing →
 *    classified, plus the error and non-controller paths), mirroring the
 *    `device.test.ts` mock + dynamic-import pattern; and
 *  - the pure classification → label mapping in `lib/bridge.ts`, including the
 *    ZERO-false-positive guarantee: a `notAController` is never a bridge candidate.
 */

// Controllable mock of the Tauri seam the bridge store imports.
const tauri = vi.hoisted(() => ({
  probeBridge: vi.fn(),
  fetchBridgeContext: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  probeBridge: tauri.probeBridge,
  fetchBridgeContext: tauri.fetchBridgeContext,
}));

// Fresh module per test so the store starts from its initial state.
async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/bridge");
  return mod.useBridgeStore;
}

const BTFL: BridgeClassificationDto = {
  kind: "bridge",
  family: "betaflight",
  fcVariant: "BTFL",
  apiVersion: "1.46",
  fcVersion: "4.5.1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBridgeStore.probe", () => {
  it("flows idle → probing → classified for a recognized bridge", async () => {
    // A deferred resolution so we can observe the intermediate "probing" state.
    let resolve!: (v: BridgeClassificationDto) => void;
    tauri.probeBridge.mockReturnValueOnce(
      new Promise<BridgeClassificationDto>((r) => {
        resolve = r;
      })
    );

    const useBridgeStore = await loadStore();
    expect(useBridgeStore.getState().status).toBe("idle");

    const pending = useBridgeStore.getState().probe("/dev/ttyACM0");
    // `probe` moves to "probing" synchronously, before awaiting the invoke.
    expect(useBridgeStore.getState().status).toBe("probing");
    expect(useBridgeStore.getState().port).toBe("/dev/ttyACM0");
    expect(tauri.probeBridge).toHaveBeenCalledWith("/dev/ttyACM0");

    resolve(BTFL);
    await pending;

    const state = useBridgeStore.getState();
    expect(state.status).toBe("classified");
    expect(state.classification).toEqual(BTFL);
    expect(isBridgeCandidate(state.classification)).toBe(true);
  });

  it("never classifies a non-controller as a bridge candidate (zero false positives)", async () => {
    // The ELRS-RX-on-CRSF outcome: the Rust probe returns `notAController`.
    tauri.probeBridge.mockResolvedValueOnce({ kind: "notAController" });

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().probe("/dev/ttyUSB0");

    const state = useBridgeStore.getState();
    expect(state.status).toBe("classified");
    expect(state.classification).toEqual({ kind: "notAController" });
    // The gate the label UI uses must reject it — it is NEVER a bridge.
    expect(isBridgeCandidate(state.classification)).toBe(false);
    expect(isLabeledBridge(state.classification)).toBe(false);
  });

  it("classifies an unsupported variant as a labeled, non-candidate bridge", async () => {
    tauri.probeBridge.mockResolvedValueOnce({
      kind: "unsupportedBridge",
      reason: "QUAD",
    });

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().probe("/dev/ttyACM0");

    const state = useBridgeStore.getState();
    expect(state.status).toBe("classified");
    // Labeled (so the user sees why) but not a usable candidate.
    expect(isLabeledBridge(state.classification)).toBe(true);
    expect(isBridgeCandidate(state.classification)).toBe(false);
  });

  it("lands on error when the probe invoke rejects (busy/missing port, off-Tauri)", async () => {
    tauri.probeBridge.mockRejectedValueOnce(new Error("Port busy"));

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().probe("/dev/ttyACM0");

    const state = useBridgeStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("Port busy");
    expect(state.classification).toBeNull();
  });

  it("reset() returns to idle and clears the classification + port", async () => {
    tauri.probeBridge.mockResolvedValueOnce(BTFL);

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().probe("/dev/ttyACM0");
    expect(useBridgeStore.getState().status).toBe("classified");

    useBridgeStore.getState().reset();
    expect(useBridgeStore.getState()).toMatchObject({
      status: "idle",
      classification: null,
      port: null,
      error: null,
    });
  });
});

describe("bridge classification → label mapping", () => {
  it("maps each family to its i18n label key", () => {
    expect(bridgeFamilyLabelKey("betaflight")).toBe("bridge.family.betaflight");
    expect(bridgeFamilyLabelKey("inav")).toBe("bridge.family.inav");
    // An unknown variant maps to the "unsupported bridge" copy, not a mislabel.
    expect(bridgeFamilyLabelKey("unknown")).toBe("bridge.family.unsupported");
  });

  it("treats only a recognized bridge as a candidate", () => {
    expect(isBridgeCandidate(BTFL)).toBe(true);
    expect(isBridgeCandidate({ kind: "unsupportedBridge", reason: "QUAD" })).toBe(
      false
    );
    expect(isBridgeCandidate({ kind: "notAController" })).toBe(false);
    expect(isBridgeCandidate(null)).toBe(false);
  });

  it("labels supported and unsupported bridges, but not a non-controller", () => {
    expect(isLabeledBridge(BTFL)).toBe(true);
    expect(isLabeledBridge({ kind: "unsupportedBridge", reason: "ARDU" })).toBe(
      true
    );
    expect(isLabeledBridge({ kind: "notAController" })).toBe(false);
    expect(isLabeledBridge(null)).toBe(false);
  });

  it("exposes the four recovery hint keys", () => {
    expect(BRIDGE_RECOVERY_KEYS).toEqual([
      "bridge.recovery.wrongPort",
      "bridge.recovery.busyPort",
      "bridge.recovery.wrongBaud",
      "bridge.recovery.noMspResponse",
    ]);
  });

  it("never re-attributes one port's result to another port", () => {
    // The probe control is re-rendered with a new `port` as soon as the picker
    // selection (or the hotplug watcher) moves, while the single store still
    // holds the previous port's classification: without this gate the popover
    // labelled the NEW device with the OLD device's result — and offered it
    // that result's passthrough check.
    expect(isStaleBridgeResult("/dev/ttyACM0", "/dev/ttyUSB0")).toBe(true);
    // Same port ⇒ the result is genuinely this port's.
    expect(isStaleBridgeResult("/dev/ttyUSB0", "/dev/ttyUSB0")).toBe(false);
    // Nothing probed yet ⇒ nothing to be stale.
    expect(isStaleBridgeResult(null, "/dev/ttyUSB0")).toBe(false);
    expect(isStaleBridgeResult(undefined, "/dev/ttyUSB0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M65: read-only controller-context store flow + context-surface display logic.
// ---------------------------------------------------------------------------

const CTX: BridgeContextDto = {
  family: "betaflight",
  fcVariant: "BTFL",
  apiVersion: "1.46",
  fcVersion: "4.5.1",
  serialPorts: [
    { identifier: "UART1", function: "msp" },
    { identifier: "UART2", function: "serialRx" },
  ],
};

describe("useBridgeStore.fetchContext (M65)", () => {
  it("flows idle → fetching → ready for a fetched context", async () => {
    let resolve!: (v: BridgeContextDto) => void;
    tauri.fetchBridgeContext.mockReturnValueOnce(
      new Promise<BridgeContextDto>((r) => {
        resolve = r;
      })
    );

    const useBridgeStore = await loadStore();
    expect(useBridgeStore.getState().contextStatus).toBe("idle");

    const pending = useBridgeStore.getState().fetchContext("/dev/ttyACM0");
    // Moves to "fetching" synchronously, before awaiting the invoke.
    expect(useBridgeStore.getState().contextStatus).toBe("fetching");
    expect(useBridgeStore.getState().port).toBe("/dev/ttyACM0");
    expect(tauri.fetchBridgeContext).toHaveBeenCalledWith("/dev/ttyACM0");

    resolve(CTX);
    await pending;

    const state = useBridgeStore.getState();
    expect(state.contextStatus).toBe("ready");
    expect(state.context).toEqual(CTX);
    // A populated context is NOT empty → the surface renders fields, not EmptyState.
    expect(isBridgeContextEmpty(state.context)).toBe(false);
  });

  it("lands on error when the fetch invoke rejects (no controller, busy, off-Tauri)", async () => {
    tauri.fetchBridgeContext.mockRejectedValueOnce(new Error("noControllerContext"));

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().fetchContext("/dev/ttyUSB0");

    const state = useBridgeStore.getState();
    expect(state.contextStatus).toBe("error");
    expect(state.contextError).toContain("noControllerContext");
    expect(state.context).toBeNull();
    // No context → the surface shows the "not enough controller context" state.
    expect(isBridgeContextEmpty(state.context)).toBe(true);
  });

  it("clearContext() resets just the context state, leaving the probe intact", async () => {
    tauri.fetchBridgeContext.mockResolvedValueOnce(CTX);

    const useBridgeStore = await loadStore();
    await useBridgeStore.getState().fetchContext("/dev/ttyACM0");
    expect(useBridgeStore.getState().contextStatus).toBe("ready");

    useBridgeStore.getState().clearContext();
    const state = useBridgeStore.getState();
    expect(state.context).toBeNull();
    expect(state.contextStatus).toBe("idle");
    expect(state.contextError).toBeNull();
  });
});

describe("bridge context-surface display logic (M65)", () => {
  it("treats a null/undefined or all-empty context as the empty state", () => {
    expect(isBridgeContextEmpty(null)).toBe(true);
    expect(isBridgeContextEmpty(undefined)).toBe(true);
    expect(
      isBridgeContextEmpty({ family: "unknown", serialPorts: [] })
    ).toBe(true);
  });

  it("treats a context with a variant, version, or any serial port as non-empty", () => {
    expect(isBridgeContextEmpty(CTX)).toBe(false);
    expect(
      isBridgeContextEmpty({ family: "unknown", fcVariant: "QUAD", serialPorts: [] })
    ).toBe(false);
    expect(
      isBridgeContextEmpty({
        family: "unknown",
        serialPorts: [{ identifier: "UART1", function: null }],
      })
    ).toBe(false);
  });

  it("maps each known coarse port function to its i18n key, and drops the rest", () => {
    for (const fn of BRIDGE_PORT_FUNCTIONS) {
      expect(bridgePortFunctionLabelKey(fn)).toBe(`bridge.context.function.${fn}`);
    }
    // Absent or unrecognized → null (no missing-key render).
    expect(bridgePortFunctionLabelKey(null)).toBeNull();
    expect(bridgePortFunctionLabelKey(undefined)).toBeNull();
    expect(bridgePortFunctionLabelKey("pilot@example.com")).toBeNull();
  });
});
