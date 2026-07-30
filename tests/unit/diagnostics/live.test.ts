/**
 * Live evaluator tests: debounce, hysteresis, re-arm, and determinism — built on
 * inline TelemetryFrame sequences (liveAlerts.test.ts style).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  evaluateFrame,
  evaluateFrames,
  initialLiveDiagnosticState,
  LIVE_MIN_FRAMES,
  type LiveDiagnosticState,
} from "@/lib/diagnostics";
import type { TelemetryFrame } from "@/stores/telemetry";

/** A healthy live frame; override only the metric under test. */
function frame(over: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t: 0,
    rssi1: -60,
    rssi2: -64,
    linkQuality: 96,
    snr: 9,
    txPower: 100,
    packetRate: 250,
    antennas: [],
    ...over,
  };
}

/** Fold frames through the evaluator, capturing each frame's result. */
function run(frames: TelemetryFrame[]) {
  let state = initialLiveDiagnosticState();
  const perFrame = frames.map((f) => {
    const res = evaluateFrame(f, state, DEFAULT_DIAGNOSTIC_CONFIG);
    state = res.newState;
    return res;
  });
  return { perFrame, findings: perFrame.flatMap((r) => r.findings), finalState: state };
}

/** N frames with a given link quality (everything else healthy). */
const lq = (value: number, n: number): TelemetryFrame[] =>
  Array.from({ length: n }, () => frame({ linkQuality: value }));

/** N frames with a given rssi1 (everything else healthy). */
const rssi = (value: number, n: number): TelemetryFrame[] =>
  Array.from({ length: n }, () => frame({ rssi1: value }));

describe("live evaluator — debounce", () => {
  it("a single bad LQ frame does NOT fire", () => {
    const { findings } = run([...lq(96, 3), ...lq(40, 1), ...lq(96, 5)]);
    expect(findings.filter((f) => f.ruleId === "lq-collapse")).toHaveLength(0);
  });

  it("N sustained bad LQ frames fire EXACTLY once (no spam)", () => {
    const need = LIVE_MIN_FRAMES.lqCollapse;
    const { perFrame, findings } = run([...lq(96, 3), ...lq(40, need + 4)]);
    const lqFindings = findings.filter((f) => f.ruleId === "lq-collapse");
    expect(lqFindings).toHaveLength(1);
    expect(lqFindings[0].severity).toBe("warning"); // 40 > criticalTo (20)
    // Fires on exactly the Nth consecutive bad frame, never earlier.
    const firstFireIdx = perFrame.findIndex((r) => r.findings.some((f) => f.ruleId === "lq-collapse"));
    expect(firstFireIdx).toBe(3 + need - 1);
  });

  it("an LQ collapse to 0 fires critical", () => {
    const { findings } = run([...lq(96, 3), ...lq(0, LIVE_MIN_FRAMES.lqCollapse + 1)]);
    const lqFindings = findings.filter((f) => f.ruleId === "lq-collapse");
    expect(lqFindings).toHaveLength(1);
    expect(lqFindings[0].severity).toBe("critical");
  });

  it("RSSI floor fires once after minFrames consecutive sub-floor frames", () => {
    const need = LIVE_MIN_FRAMES.rssiFloor;
    const { findings } = run([...rssi(-60, 3), ...rssi(-105, need + 3)]);
    const rssiFindings = findings.filter((f) => f.ruleId === "rssi-floor");
    expect(rssiFindings).toHaveLength(1);
    expect(rssiFindings[0].severity).toBe("critical");
  });
});

describe("live evaluator — hysteresis & re-arm", () => {
  it("recovery clears the alarm and a later relapse re-fires", () => {
    const need = LIVE_MIN_FRAMES.lqCollapse;
    const frames = [
      ...lq(96, 2),
      ...lq(40, need), // fire #1
      ...lq(80, need), // sustained recovery (> 50 + 15 band) → clear
      ...lq(40, need), // fire #2
    ];
    const { findings } = run(frames);
    expect(findings.filter((f) => f.ruleId === "lq-collapse")).toHaveLength(2);
  });

  it("a value bouncing inside the hysteresis band does not clear and does not re-fire", () => {
    const need = LIVE_MIN_FRAMES.lqCollapse;
    // Trip at 40, then sit at 55 (below the 65 clear line, above the 50 trip) forever.
    const frames = [...lq(96, 2), ...lq(40, need), ...lq(55, need * 3)];
    const { findings } = run(frames);
    // Exactly one fire; never clears (so never re-arms / re-fires).
    expect(findings.filter((f) => f.ruleId === "lq-collapse")).toHaveLength(1);
  });

  it("intermittent single bad frames separated by good frames never fire", () => {
    const frames: TelemetryFrame[] = [];
    for (let i = 0; i < 6; i++) frames.push(...lq(40, 1), ...lq(96, 1));
    expect(run(frames).findings.filter((f) => f.ruleId === "lq-collapse")).toHaveLength(0);
  });
});

describe("live evaluator — frame index, health score & determinism", () => {
  it("threads a monotonic frame index and a per-frame health score", () => {
    const frames = lq(96, 5);
    const { perFrame, finalState } = run(frames);
    expect(finalState.frameIndex).toBe(4);
    for (const r of perFrame) {
      expect(r.healthScore).toBeGreaterThanOrEqual(0);
      expect(r.healthScore).toBeLessThanOrEqual(100);
    }
  });

  it("evidence windows anchor at the current frame index", () => {
    const need = LIVE_MIN_FRAMES.lqCollapse;
    const { findings } = run([...lq(96, 2), ...lq(10, need + 1)]);
    const f = findings.find((x) => x.ruleId === "lq-collapse");
    expect(f).toBeDefined();
    // First fire at frame index 2 + need - 1.
    expect(f!.evidenceWindow.endIndex).toBe(2 + need - 1);
    expect(f!.evidenceWindow.startIndex).toBeLessThanOrEqual(f!.evidenceWindow.endIndex);
  });

  it("does not mutate the input state", () => {
    const state = initialLiveDiagnosticState();
    const snapshot: LiveDiagnosticState = JSON.parse(JSON.stringify(state));
    evaluateFrame(frame({ linkQuality: 0 }), state, DEFAULT_DIAGNOSTIC_CONFIG);
    expect(state).toEqual(snapshot);
  });

  it("evaluateFrames is deterministic (deep-equal across two runs)", () => {
    const frames = [...lq(96, 3), ...lq(20, 6), ...lq(96, 4), ...rssi(-110, 4)];
    expect(evaluateFrames(frames, DEFAULT_DIAGNOSTIC_CONFIG)).toEqual(
      evaluateFrames(frames, DEFAULT_DIAGNOSTIC_CONFIG)
    );
  });

  it("a long healthy stream fires nothing", () => {
    const { findings } = run(lq(96, 60));
    expect(findings).toEqual([]);
  });

  it("live findings carry only non-identifying numeric detail", () => {
    const { findings } = run([...lq(96, 2), ...lq(0, 8), ...rssi(-110, 8)]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      for (const [key, value] of Object.entries(f.detail)) {
        expect(key).not.toMatch(/lat|lon|lng|gps|coord|geo|uid|mac|email/i);
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value as number)).toBe(true);
      }
    }
  });
});
