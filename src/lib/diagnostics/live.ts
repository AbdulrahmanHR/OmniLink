/**
 * Live diagnostic evaluator (M36) — frame-by-frame, reusing the M26 pattern.
 *
 * Where {@link import("./engine").evaluateSession} diagnoses a complete imported
 * session after the fact, this module raises the same five diagnostic findings
 * *live* over the running telemetry stream, one {@link TelemetryFrame} at a time.
 * It reuses the M26 {@link AlarmRuntime} two-phase debounce/hysteresis machine
 * (`ok ⇄ alarming`, `badStreak`/`goodStreak`) so a hovering value can't flap and
 * a sustained problem fires EXACTLY ONCE until it recovers.
 *
 * ## Pure & deterministic
 * `evaluateFrame(frame, state, config) → { newState, findings, healthScore }` is
 * pure: it never mutates `state` (the ring buffers and runtimes are rebuilt) and
 * uses no `Date.now`/`Math.random`/DOM/network. Threading `newState` back through
 * a frame sequence is fully reproducible.
 *
 * ## Hysteresis + debounce
 * Each rule is a debounced alarm: it trips only after `minFrames` consecutive bad
 * frames and clears only after `minFrames` consecutive recovered frames, with a
 * deliberate band between the trip and clear conditions so a value sitting near
 * the limit neither re-fires nor clears. SNR-noise and packet-instability keep
 * small rolling ring buffers (sized to the rule window) and alarm on the buffer's
 * stddev / change-count; TX-saturation alarms on the instantaneous max-power +
 * poor-signal condition.
 *
 * ## Safety
 * Findings carry only non-identifying numbers in `detail`; `log.gps` / fixes are
 * never read here.
 */

import type { AlarmRuntime } from "@/lib/liveAlerts";
import type { TelemetryFrame } from "@/stores/telemetry";
import { computeHealthScore } from "./health-score";
import type { DiagnosticConfig, DiagnosticFinding } from "./types";
import {
  LQ_COLLAPSE_RULE_ID,
  LQ_COLLAPSE_EXPLANATION,
  RSSI_FLOOR_RULE_ID,
  RSSI_FLOOR_EXPLANATION,
  SNR_NOISE_RULE_ID,
  SNR_NOISE_EXPLANATION,
  PACKET_INSTABILITY_RULE_ID,
  PACKET_INSTABILITY_EXPLANATION,
  TX_POWER_SATURATION_RULE_ID,
  TX_POWER_SATURATION_EXPLANATION,
} from "./rules";
import { clamp01, isFiniteNumber, round2, stdDev } from "./util";

/**
 * Per-rule live debounce windows (consecutive frames required to flip phase).
 * The link/signal rules mirror their offline sample counts; the
 * rolling-buffer/instantaneous rules use a small fixed debounce (their window or
 * the saturation condition already provides smoothing).
 */
export const LIVE_MIN_FRAMES = {
  lqCollapse: 5,
  rssiFloor: 3,
  snrNoise: 3,
  packetInstability: 3,
  txSaturation: 5,
} as const;

/** Full live evaluator state: per-rule debounce + rolling buffers + frame index. */
export interface LiveDiagnosticState {
  /** Monotonic frame counter; anchors each finding's evidence window. */
  frameIndex: number;
  /** Debounce runtime for `lq-collapse`. */
  lqCollapse: AlarmRuntime;
  /** Debounce runtime for `rssi-floor`. */
  rssiFloor: AlarmRuntime;
  /** Debounce runtime for `snr-noise`. */
  snrNoise: AlarmRuntime;
  /** Debounce runtime for `packet-instability`. */
  packetInstability: AlarmRuntime;
  /** Debounce runtime for `tx-power-saturation`. */
  txSaturation: AlarmRuntime;
  /** Trailing SNR ring buffer (length ≤ snrNoise.window). */
  snrWindow: number[];
  /** Trailing packet-rate ring buffer (length ≤ packetInstability.window). */
  packetWindow: number[];
}

/** Result of evaluating one live frame. */
export interface LiveEvaluateResult {
  /** Next state to thread into the following frame. */
  newState: LiveDiagnosticState;
  /** Findings newly raised on this frame (registry order). */
  findings: DiagnosticFinding[];
  /** This frame's signal-health score, 0–100. */
  healthScore: number;
}

/** A fresh runtime in the healthy (`ok`) phase. */
function freshRuntime(): AlarmRuntime {
  return { phase: "ok", badStreak: 0, goodStreak: 0 };
}

/** A fresh, all-healthy live evaluator state (call on connect / after a reset). */
export function initialLiveDiagnosticState(): LiveDiagnosticState {
  return {
    frameIndex: -1,
    lqCollapse: freshRuntime(),
    rssiFloor: freshRuntime(),
    snrNoise: freshRuntime(),
    packetInstability: freshRuntime(),
    txSaturation: freshRuntime(),
    snrWindow: [],
    packetWindow: [],
  };
}

/** Step result for one alarm's runtime on one frame. */
interface StepResult {
  next: AlarmRuntime;
  fired: boolean;
  cleared: boolean;
}

/**
 * Advance one alarm's two-phase machine by a single frame — the boolean-driven
 * twin of the M26 `stepAlarm`. An unavailable metric (`!available`) is a gap:
 * it holds the phase and resets streaks. `isBad`/`isRecovered` are distinct
 * conditions (the band between them is what stops chattering): in `ok` only
 * `minFrames` consecutive bad frames fire; in `alarming` only `minFrames`
 * consecutive recovered frames clear.
 */
function stepAlarm(
  rt: AlarmRuntime,
  available: boolean,
  isBad: boolean,
  isRecovered: boolean,
  minFrames: number
): StepResult {
  if (!available) {
    return { next: { ...rt, badStreak: 0, goodStreak: 0 }, fired: false, cleared: false };
  }
  const need = Math.max(1, Math.floor(minFrames));

  if (rt.phase === "ok") {
    if (isBad) {
      const badStreak = rt.badStreak + 1;
      if (badStreak >= need) {
        return { next: { phase: "alarming", badStreak: 0, goodStreak: 0 }, fired: true, cleared: false };
      }
      return { next: { phase: "ok", badStreak, goodStreak: 0 }, fired: false, cleared: false };
    }
    return { next: { phase: "ok", badStreak: 0, goodStreak: 0 }, fired: false, cleared: false };
  }

  // phase === "alarming"
  if (isRecovered) {
    const goodStreak = rt.goodStreak + 1;
    if (goodStreak >= need) {
      return { next: { phase: "ok", badStreak: 0, goodStreak: 0 }, fired: false, cleared: true };
    }
    return { next: { phase: "alarming", badStreak: 0, goodStreak }, fired: false, cleared: false };
  }
  return { next: { phase: "alarming", badStreak: 0, goodStreak: 0 }, fired: false, cleared: false };
}

/** Push `value` onto a trailing ring buffer of max length `cap` (immutably). */
function pushWindow(buffer: number[], value: number, cap: number): number[] {
  if (!isFiniteNumber(value)) return buffer.slice();
  const next = buffer.length >= cap ? buffer.slice(buffer.length - cap + 1) : buffer.slice();
  next.push(value);
  return next;
}

/** Count adjacent value changes in `values`. */
function changeCount(values: readonly number[]): number {
  let changes = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) changes++;
  }
  return changes;
}

/**
 * Evaluate a single live frame, threading `state` through to the returned
 * `newState`. Pure: `state` is never mutated. Each newly-tripped rule yields one
 * {@link DiagnosticFinding} whose `evidenceWindow` is anchored to the current
 * frame index (back to the start of the bad streak). The per-frame
 * {@link computeHealthScore} is included for the live gauge.
 */
export function evaluateFrame(
  frame: TelemetryFrame,
  state: LiveDiagnosticState,
  config: DiagnosticConfig
): LiveEvaluateResult {
  const frameIndex = state.frameIndex + 1;
  const findings: DiagnosticFinding[] = [];
  const r = config.rules;

  const lq = frame.linkQuality;
  const rssi1 = frame.rssi1;
  const snrBuf = pushWindow(state.snrWindow, frame.snr, Math.max(2, Math.floor(r.snrNoise.window)));
  const packetBuf = pushWindow(
    state.packetWindow,
    frame.packetRate,
    Math.max(2, Math.floor(r.packetInstability.window))
  );

  const windowFor = (need: number): { startIndex: number; endIndex: number } => ({
    startIndex: Math.max(0, frameIndex - Math.max(1, need) + 1),
    endIndex: frameIndex,
  });

  // --- lq-collapse: LQ sustained below the absolute floor ---
  const lqAvail = isFiniteNumber(lq);
  const lqStep = stepAlarm(
    state.lqCollapse,
    lqAvail,
    lqAvail && lq < r.lqCollapse.absThreshold,
    lqAvail && lq > r.lqCollapse.absThreshold + r.lqCollapse.recoverMargin,
    LIVE_MIN_FRAMES.lqCollapse
  );
  if (lqStep.fired && lqAvail) {
    findings.push({
      ruleId: LQ_COLLAPSE_RULE_ID,
      category: "link",
      severity: lq <= r.lqCollapse.criticalTo ? "critical" : "warning",
      confidence: round2(clamp01(0.5 + 0.5 * clamp01((r.lqCollapse.absThreshold - lq) / r.lqCollapse.absThreshold))),
      evidenceWindow: windowFor(LIVE_MIN_FRAMES.lqCollapse),
      explanation: LQ_COLLAPSE_EXPLANATION,
      detail: { to: round2(lq) },
    });
  }

  // --- rssi-floor: rssi1 sustained at/below the floor ---
  const rssiAvail = isFiniteNumber(rssi1);
  const rssiStep = stepAlarm(
    state.rssiFloor,
    rssiAvail,
    rssiAvail && rssi1 <= r.rssiFloor.floorDbm,
    rssiAvail && rssi1 > r.rssiFloor.floorDbm + 5,
    LIVE_MIN_FRAMES.rssiFloor
  );
  if (rssiStep.fired && rssiAvail) {
    findings.push({
      ruleId: RSSI_FLOOR_RULE_ID,
      category: "signal",
      severity: "critical",
      confidence: round2(clamp01(0.6 + 0.4 * clamp01((r.rssiFloor.floorDbm - rssi1) / 20))),
      evidenceWindow: windowFor(LIVE_MIN_FRAMES.rssiFloor),
      explanation: RSSI_FLOOR_EXPLANATION,
      detail: { rssi: round2(rssi1) },
    });
  }

  // --- snr-noise: rolling-buffer stddev over the threshold ---
  const snrStdNow = stdDev(snrBuf);
  const snrAvail = snrBuf.length >= 2;
  const snrStep = stepAlarm(
    state.snrNoise,
    snrAvail,
    snrAvail && snrStdNow > r.snrNoise.stdThreshold,
    snrAvail && snrStdNow <= r.snrNoise.stdThreshold * 0.7,
    LIVE_MIN_FRAMES.snrNoise
  );
  if (snrStep.fired) {
    findings.push({
      ruleId: SNR_NOISE_RULE_ID,
      category: "signal",
      severity: "warning",
      confidence: round2(clamp01(0.5 + 0.5 * clamp01((snrStdNow - r.snrNoise.stdThreshold) / Math.max(0.001, r.snrNoise.stdThreshold)))),
      evidenceWindow: windowFor(snrBuf.length),
      explanation: SNR_NOISE_EXPLANATION,
      detail: { stdDev: round2(snrStdNow), window: snrBuf.length },
    });
  }

  // --- packet-instability: rolling-buffer change count over the threshold ---
  const packetChanges = changeCount(packetBuf);
  const packetAvail = packetBuf.length >= 2;
  const packetStep = stepAlarm(
    state.packetInstability,
    packetAvail,
    packetAvail && packetChanges >= r.packetInstability.jitterThreshold,
    packetAvail && packetChanges <= Math.max(0, r.packetInstability.jitterThreshold - 2),
    LIVE_MIN_FRAMES.packetInstability
  );
  if (packetStep.fired) {
    findings.push({
      ruleId: PACKET_INSTABILITY_RULE_ID,
      category: "stability",
      severity: "warning",
      confidence: round2(clamp01(0.5 + 0.5 * clamp01((packetChanges - r.packetInstability.jitterThreshold) / Math.max(1, packetBuf.length - 1)))),
      evidenceWindow: windowFor(packetBuf.length),
      explanation: PACKET_INSTABILITY_EXPLANATION,
      detail: { changes: packetChanges, window: packetBuf.length },
    });
  }

  // --- tx-power-saturation: pinned at max while signal poor (instantaneous) ---
  const txAvail = isFiniteNumber(frame.txPower);
  const txSat = txAvail && frame.txPower >= r.txPowerSaturation.maxStepMw;
  const signalPoor =
    (isFiniteNumber(rssi1) && rssi1 <= r.txPowerSaturation.poorRssiDbm) ||
    (isFiniteNumber(lq) && lq <= r.txPowerSaturation.degradedLq);
  const signalClearlyGood =
    (!isFiniteNumber(rssi1) || rssi1 > r.txPowerSaturation.poorRssiDbm + 3) &&
    (!isFiniteNumber(lq) || lq > r.txPowerSaturation.degradedLq + 3);
  const txStep = stepAlarm(
    state.txSaturation,
    txAvail,
    txSat && signalPoor,
    !txSat || signalClearlyGood,
    LIVE_MIN_FRAMES.txSaturation
  );
  if (txStep.fired) {
    findings.push({
      ruleId: TX_POWER_SATURATION_RULE_ID,
      category: "power",
      severity: "warning",
      confidence: round2(clamp01(0.5 + 0.5 * clamp01((r.txPowerSaturation.poorRssiDbm - (isFiniteNumber(rssi1) ? rssi1 : r.txPowerSaturation.poorRssiDbm)) / 15))),
      evidenceWindow: windowFor(LIVE_MIN_FRAMES.txSaturation),
      explanation: TX_POWER_SATURATION_EXPLANATION,
      detail: { txPower: round2(frame.txPower), avgRssi: round2(isFiniteNumber(rssi1) ? rssi1 : r.txPowerSaturation.poorRssiDbm) },
    });
  }

  const newState: LiveDiagnosticState = {
    frameIndex,
    lqCollapse: lqStep.next,
    rssiFloor: rssiStep.next,
    snrNoise: snrStep.next,
    packetInstability: packetStep.next,
    txSaturation: txStep.next,
    snrWindow: snrBuf,
    packetWindow: packetBuf,
  };

  return { newState, findings, healthScore: computeHealthScore(frame, config.healthScore) };
}

/**
 * Fold {@link evaluateFrame} over a sequence of frames, returning the final state
 * plus every finding raised along the way and the per-frame health scores.
 * Convenience for the live runner's warm-up and for deterministic tests.
 */
export function evaluateFrames(
  frames: readonly TelemetryFrame[],
  config: DiagnosticConfig,
  initial: LiveDiagnosticState = initialLiveDiagnosticState()
): { finalState: LiveDiagnosticState; findings: DiagnosticFinding[]; healthScores: number[] } {
  let state = initial;
  const findings: DiagnosticFinding[] = [];
  const healthScores: number[] = [];
  for (const frame of frames) {
    const res = evaluateFrame(frame, state, config);
    state = res.newState;
    findings.push(...res.findings);
    healthScores.push(res.healthScore);
  }
  return { finalState: state, findings, healthScores };
}
