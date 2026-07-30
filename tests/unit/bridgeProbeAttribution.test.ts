import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStaleBridgeResult } from "@/lib/bridge";
import type { BridgeClassificationDto, BridgeContextDto } from "@/lib/tauri";

/**
 * M63: closing the bridge popover mid-probe used to CLEAR the probe.
 *
 * The port-change effect was given an in-flight guard ("never clear an operation
 * that is still in flight"); `close()` was not, and called `reset()`
 * unconditionally. Dismissing a popover is not a cancel, so that did two things
 * at once:
 *  - dropped `status: "probing"` while the BACKEND still held the port, so
 *    `useSerialPortBusyReasonKey` went quiet and Connect / Start Flash came back
 *    to life over a port OmniLink was still driving; and
 *  - nulled `bridge.port`, so the probe resolved into a `classified` state with
 *    no port on it — and `isStaleBridgeResult(null, anyPort)` is FALSE, so
 *    ttyUSB0's flight-controller label and its passthrough-check offer were
 *    rendered for whatever port the picker moved to next. That re-attribution is
 *    precisely what `isStaleBridgeResult` was added to prevent.
 *
 * Fixed on both sides: the guard is one shared predicate both call sites use,
 * and the probe re-states its port with the result so nothing can orphan it.
 */

const tauri = vi.hoisted(() => ({
  probeBridge: vi.fn(),
  fetchBridgeContext: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  probeBridge: tauri.probeBridge,
  fetchBridgeContext: tauri.fetchBridgeContext,
}));

async function loadStore() {
  vi.resetModules();
  return await import("@/stores/bridge");
}

const USB0 = "/dev/ttyUSB0";
const ACM0 = "/dev/ttyACM0";

const BTFL: BridgeClassificationDto = {
  kind: "bridge",
  family: "betaflight",
  fcVariant: "BTFL",
  apiVersion: "1.46",
  fcVersion: "4.5.1",
};

const CONTEXT: BridgeContextDto = {
  fcVariant: "BTFL",
  fcVersion: "4.5.1",
  serialPorts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useBridgeStore — a result belongs to the port it was taken on", () => {
  it("re-states the probed port with the classification", async () => {
    const { useBridgeStore } = await loadStore();
    let resolve!: (v: BridgeClassificationDto) => void;
    tauri.probeBridge.mockReturnValueOnce(
      new Promise<BridgeClassificationDto>((r) => {
        resolve = r;
      })
    );

    const probing = useBridgeStore.getState().probe(USB0);
    // Anything that clears the store while the backend is still working: the
    // popover's close button was the one that actually did it.
    useBridgeStore.getState().reset();
    resolve(BTFL);
    await probing;

    expect(useBridgeStore.getState().port).toBe(USB0);
    // …so the ttyUSB0 result is still refused to every other port. A null port
    // is stale for NOTHING, which is how it reached the next selection.
    expect(isStaleBridgeResult(useBridgeStore.getState().port, ACM0)).toBe(true);
    expect(isStaleBridgeResult(useBridgeStore.getState().port, USB0)).toBe(
      false
    );
  });

  it("does the same on the probe's failure path", async () => {
    const { useBridgeStore } = await loadStore();
    let reject!: (e: unknown) => void;
    tauri.probeBridge.mockReturnValueOnce(
      new Promise<BridgeClassificationDto>((_r, rj) => {
        reject = rj;
      })
    );

    const probing = useBridgeStore.getState().probe(USB0);
    useBridgeStore.getState().reset();
    reject(new Error("port busy"));
    await probing;

    expect(useBridgeStore.getState().status).toBe("error");
    expect(useBridgeStore.getState().port).toBe(USB0);
    expect(isStaleBridgeResult(useBridgeStore.getState().port, ACM0)).toBe(true);
  });

  it("re-states it for the READ-ONLY context fetch too", async () => {
    const { useBridgeStore } = await loadStore();
    let resolve!: (v: BridgeContextDto) => void;
    tauri.fetchBridgeContext.mockReturnValueOnce(
      new Promise<BridgeContextDto>((r) => {
        resolve = r;
      })
    );

    const fetching = useBridgeStore.getState().fetchContext(USB0);
    useBridgeStore.getState().reset();
    resolve(CONTEXT);
    await fetching;

    expect(useBridgeStore.getState().context).toEqual(CONTEXT);
    expect(useBridgeStore.getState().port).toBe(USB0);
  });
});

describe("isBridgeOperationInFlight", () => {
  it("names the two states in which the backend still holds the port", async () => {
    const { isBridgeOperationInFlight } = await loadStore();

    expect(isBridgeOperationInFlight("probing", "idle")).toBe(true);
    expect(isBridgeOperationInFlight("idle", "fetching")).toBe(true);
    // Both at once is not a state the store produces, but the predicate must
    // still refuse to clear it.
    expect(isBridgeOperationInFlight("probing", "fetching")).toBe(true);
  });

  it("treats every settled state as clearable", async () => {
    const { isBridgeOperationInFlight } = await loadStore();

    for (const status of ["idle", "classified", "error"] as const) {
      for (const contextStatus of ["idle", "ready", "error"] as const) {
        expect(isBridgeOperationInFlight(status, contextStatus)).toBe(false);
      }
    }
  });

  it("holds through a probe, and lets go once it lands", async () => {
    const { useBridgeStore, isBridgeOperationInFlight } = await loadStore();
    let resolve!: (v: BridgeClassificationDto) => void;
    tauri.probeBridge.mockReturnValueOnce(
      new Promise<BridgeClassificationDto>((r) => {
        resolve = r;
      })
    );

    const probing = useBridgeStore.getState().probe(USB0);
    const inFlight = () => {
      const s = useBridgeStore.getState();
      return isBridgeOperationInFlight(s.status, s.contextStatus);
    };
    expect(inFlight()).toBe(true);

    resolve(BTFL);
    await probing;
    expect(inFlight()).toBe(false);
  });
});
