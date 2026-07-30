import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASSTHROUGH_BAUDS,
  PASSTHROUGH_STEPS,
  PASSTHROUGH_WIRING_KEYS,
  passthroughStepLabelKey,
  passthroughFailureLabelKey,
  passthroughStepStatus,
  isPassthroughSuccess,
} from "@/lib/bridge";
import type {
  PassthroughCheckReportDto,
  PassthroughFailureDto,
  PassthroughStepDto,
} from "@/lib/tauri";

/**
 * Coverage for the M64 passthrough-diagnostics seam:
 *  - the non-persisted `stores/passthrough.ts` check lifecycle (idle → running →
 *    done / error), the bounded diagnostic event log, and baud-override wiring,
 *    mirroring the `device.test.ts` mock + dynamic-import pattern; and
 *  - the pure `lib/bridge.ts` mappers: failure-category → display key for all
 *    FIVE categories, step → key, and the step-status/ success predicates.
 */

// Controllable mock of the Tauri seam the passthrough store imports.
const tauri = vi.hoisted(() => ({
  runPassthroughCheck: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  runPassthroughCheck: tauri.runPassthroughCheck,
}));

// Fresh module per test so the store starts from its initial state.
async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/passthrough");
  return mod.usePassthroughStore;
}

const ALL_FAILURES: PassthroughFailureDto[] = [
  "controllerNotResponding",
  "passthroughUnavailable",
  "rxNotPowered",
  "rxNotWired",
  "crsfTimeout",
];

/** Build a minimal report. `null` failure ⇒ all four steps pass. */
function makeReport(
  failure: PassthroughFailureDto | null,
  baud = 420000
): PassthroughCheckReportDto {
  const order: PassthroughStepDto[] = ["handshake", "uart", "receiver", "crsf"];
  const failIndex = failure
    ? failure === "controllerNotResponding"
      ? 0
      : failure === "passthroughUnavailable"
        ? 1
        : failure === "crsfTimeout"
          ? 3
          : 2
    : -1;
  const steps = order.map((step, i) => ({
    step,
    status:
      failIndex < 0 || i < failIndex
        ? ("pass" as const)
        : i === failIndex
          ? ("fail" as const)
          : ("skipped" as const),
  }));
  return {
    steps,
    failure,
    category: failure ? "wiring" : null,
    summaryKey: failure,
    baud,
    uart: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePassthroughStore.runCheck", () => {
  it("flows idle → running → done and appends the attempt to the log", async () => {
    const report = makeReport(null);
    let resolve!: (v: PassthroughCheckReportDto) => void;
    tauri.runPassthroughCheck.mockReturnValueOnce(
      new Promise<PassthroughCheckReportDto>((r) => {
        resolve = r;
      })
    );

    const useStore = await loadStore();
    expect(useStore.getState().status).toBe("idle");

    const pending = useStore.getState().runCheck("/dev/ttyACM0");
    // `runCheck` moves to "running" synchronously, before awaiting the invoke.
    expect(useStore.getState().status).toBe("running");
    expect(useStore.getState().port).toBe("/dev/ttyACM0");

    resolve(report);
    await pending;

    const state = useStore.getState();
    expect(state.status).toBe("done");
    expect(state.report).toEqual(report);
    expect(isPassthroughSuccess(state.report)).toBe(true);
    // The attempt was appended to the diagnostic event log.
    expect(state.log).toHaveLength(1);
    expect(state.log[0]).toMatchObject({
      port: "/dev/ttyACM0",
      report,
      error: null,
    });
    expect(typeof state.log[0].timestamp).toBe("number");
  });

  it("wires the baud override through to runPassthroughCheck", async () => {
    tauri.runPassthroughCheck.mockResolvedValueOnce(makeReport("crsfTimeout"));

    const useStore = await loadStore();
    await useStore.getState().runCheck("/dev/ttyACM0", 230400);

    expect(tauri.runPassthroughCheck).toHaveBeenCalledWith(
      "/dev/ttyACM0",
      230400,
      undefined
    );
    // The chosen override is recorded on the logged attempt.
    expect(useStore.getState().log[0].baudOverride).toBe(230400);
  });

  it("records each failure category on the report and the log", async () => {
    for (const failure of ALL_FAILURES) {
      tauri.runPassthroughCheck.mockResolvedValueOnce(makeReport(failure));
      const useStore = await loadStore();
      await useStore.getState().runCheck("/dev/ttyACM0");

      const state = useStore.getState();
      expect(state.status).toBe("done");
      expect(state.report?.failure).toBe(failure);
      // The display-key mapping the UI uses for this category.
      expect(passthroughFailureLabelKey(failure)).toBe(
        `bridge.passthrough.failure.${failure}`
      );
      expect(state.log[0].report?.failure).toBe(failure);
    }
  });

  it("lands on error (and still logs) when the invoke rejects (off-Tauri/busy)", async () => {
    tauri.runPassthroughCheck.mockRejectedValueOnce(new Error("not in tauri"));

    const useStore = await loadStore();
    await useStore.getState().runCheck("/dev/ttyUSB0");

    const state = useStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("not in tauri");
    expect(state.report).toBeNull();
    // A failed attempt is still recorded for the diagnostic log.
    expect(state.log).toHaveLength(1);
    expect(state.log[0].report).toBeNull();
    expect(state.log[0].error).toContain("not in tauri");
  });

  it("caps the log newest-first and clearLog()/reset() empty it", async () => {
    tauri.runPassthroughCheck.mockResolvedValue(makeReport(null));
    const { PASSTHROUGH_LOG_CAP } = await import("@/stores/passthrough");
    const useStore = await loadStore();

    for (let i = 0; i < PASSTHROUGH_LOG_CAP + 5; i += 1) {
      await useStore.getState().runCheck(`/dev/tty${i}`);
    }
    const log = useStore.getState().log;
    expect(log).toHaveLength(PASSTHROUGH_LOG_CAP);
    // Newest-first: the most recent attempt is at index 0.
    expect(log[0].port).toBe(`/dev/tty${PASSTHROUGH_LOG_CAP + 4}`);

    useStore.getState().clearLog();
    expect(useStore.getState().log).toEqual([]);
    // clearLog keeps the report; reset wipes everything back to idle.
    expect(useStore.getState().status).toBe("done");
    useStore.getState().reset();
    expect(useStore.getState()).toMatchObject({
      status: "idle",
      report: null,
      error: null,
      port: null,
      log: [],
    });
  });
});

describe("passthrough labeling model (lib/bridge)", () => {
  it("exposes the common bauds with 420000 first", () => {
    expect(PASSTHROUGH_BAUDS).toEqual([420000, 115200, 230400, 460800]);
  });

  it("exposes the four ordered steps and their label keys", () => {
    expect(PASSTHROUGH_STEPS).toEqual(["handshake", "uart", "receiver", "crsf"]);
    expect(passthroughStepLabelKey("handshake")).toBe(
      "bridge.passthrough.step.handshake"
    );
    expect(passthroughStepLabelKey("crsf")).toBe("bridge.passthrough.step.crsf");
  });

  it("maps every failure category to its display key", () => {
    for (const failure of ALL_FAILURES) {
      expect(passthroughFailureLabelKey(failure)).toBe(
        `bridge.passthrough.failure.${failure}`
      );
    }
  });

  it("derives per-step status from a report (pending before one lands)", () => {
    const report = makeReport("rxNotPowered");
    expect(passthroughStepStatus(report, "handshake")).toBe("pass");
    expect(passthroughStepStatus(report, "uart")).toBe("pass");
    expect(passthroughStepStatus(report, "receiver")).toBe("fail");
    expect(passthroughStepStatus(report, "crsf")).toBe("skipped");
    // No report ⇒ every step is pending.
    expect(passthroughStepStatus(null, "handshake")).toBe("pending");
  });

  it("treats only a failure-free report as success", () => {
    expect(isPassthroughSuccess(makeReport(null))).toBe(true);
    expect(isPassthroughSuccess(makeReport("crsfTimeout"))).toBe(false);
    expect(isPassthroughSuccess(null)).toBe(false);
  });

  it("exposes the four generic wiring guidance keys", () => {
    expect(PASSTHROUGH_WIRING_KEYS).toEqual([
      "bridge.passthrough.wiring.tx",
      "bridge.passthrough.wiring.rx",
      "bridge.passthrough.wiring.power",
      "bridge.passthrough.wiring.uart",
    ]);
  });
});
