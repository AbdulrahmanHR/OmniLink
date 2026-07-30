/**
 * Live telemetry alerts & thresholds (M26).
 *
 * Where M15 ({@link import("@/lib/anomaly")}) scans a complete, imported
 * {@link import("@/lib/blackbox").ParsedLog} after the fact, this module raises
 * *live* alarms frame-by-frame over the running telemetry stream
 * ({@link import("@/stores/telemetry").useTelemetryStore}). It reuses the M15
 * primitives — {@link AnomalySeverity}, the {@link AnomalyType} names, and the
 * pinned default thresholds in {@link DEFAULT_ANOMALY_CONFIG} — rather than
 * reinventing them.
 *
 * ## Pure & deterministic
 * Every function here is pure: `(frame, config, priorState) -> { newState,
 * firedAlerts, clearedKinds }`. There is no `Date.now`, no `Math.random`, no DOM
 * and no store access — the runner ({@link import("@/components/alerts")}) feeds
 * frames in and threads the returned state back. That keeps a multi-frame
 * sequence fully reproducible in a unit test.
 *
 * ## Hysteresis + debounce (why a hovering value can't flap)
 * Each alarm is a tiny two-phase state machine (`ok` ⇄ `alarming`) driven by a
 * generic single-channel evaluator. Two guards stop a value sitting near the
 * limit from chattering:
 *  - **Hysteresis band** — the *trip* threshold and the *clear* threshold are
 *    deliberately distinct (e.g. RSSI trips at -100 dBm but only clears once it
 *    recovers to -95 dBm). A value bouncing inside the band neither re-fires nor
 *    clears.
 *  - **Debounce** — a transition requires `minFrames` *consecutive* frames on
 *    the new side of the threshold. A single bad sample (or a brief recovery
 *    blip) is ignored.
 * Together they guarantee a stream crossing a limit raises EXACTLY ONE alarm,
 * clears once on sustained recovery, and never fires on a healthy link.
 *
 * ## Safety — no GPS coordinate / identifier ever leaves this module
 * Like M15, every `detail` value an alert carries is a non-identifying physical
 * quantity (RSSI in dBm, link quality %, distance in metres). The GPS-distance
 * alarm reads the live fix only to compute a *scalar distance from home*; the
 * raw latitude/longitude live in the internal {@link LiveAlertState.home} and
 * are never copied into an emitted {@link LiveAlert}.
 */

import {
  type AnomalySeverity,
  type AnomalyType,
  DEFAULT_ANOMALY_CONFIG,
} from "@/lib/anomaly";
import type { TelemetryFrame } from "@/stores/telemetry";

// Re-export the reused M15 severity type so live-alert consumers (store, UI)
// import it from one place rather than reaching back into the anomaly module.
export type { AnomalySeverity } from "@/lib/anomaly";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * The configurable live-alarm kinds. The first three reuse the M15
 * {@link AnomalyType} names (so the UI can share the existing `anomaly.type.*`
 * labels and severities); `gpsDistance` is the M26-only optional alarm.
 */
export type AlertKind = Extract<AnomalyType, "signalLoss" | "lqDrop" | "failsafe"> | "gpsDistance";

/** Fixed evaluation order — keeps `firedAlerts`/`clearedKinds` deterministic. */
export const ALERT_KINDS: readonly AlertKind[] = ["signalLoss", "lqDrop", "failsafe", "gpsDistance"];

/** The subset of a {@link TelemetryFrame} the evaluator actually reads. */
export type AlertFrame = Pick<TelemetryFrame, "t" | "rssi1" | "rssi2" | "linkQuality" | "gps">;

/**
 * One raised live alarm. Mirrors the shape of an M15
 * {@link import("@/lib/anomaly").AnomalyEvent}: a reused {@link AnomalySeverity},
 * an i18n `messageKey`, and a `detail` bag of non-identifying numbers only.
 */
export interface LiveAlert {
  kind: AlertKind;
  severity: AnomalySeverity;
  /** Capture timestamp of the frame on which the alarm tripped (ms). */
  t: number;
  /** i18n key, always `alerts.message.<kind>`. */
  messageKey: string;
  /** Interpolation values for the i18n string — only non-identifying numbers. */
  detail: Record<string, number>;
}

/**
 * Per-alarm tuning. For the "low is bad" alarms (`rssi`, `lq`) the value trips
 * at-or-below `trip` and only clears at-or-above `clear`, with `clear > trip`.
 * For the "high is bad" alarm (`gpsDistance`) it trips at-or-above `trip` and
 * clears at-or-below `clear`, with `clear < trip`. `minFrames` is the debounce
 * window (consecutive frames required to flip phase).
 */
export interface RangeAlarmConfig {
  enabled: boolean;
  trip: number;
  clear: number;
  minFrames: number;
}

/**
 * Link-loss alarm tuning. Link loss is the sustained failsafe condition —
 * link quality pinned at `0` — so it needs no tunable band, only an enable flag
 * and a debounce window.
 */
export interface LinkLossAlarmConfig {
  enabled: boolean;
  minFrames: number;
}

/** Full live-alert configuration (one entry per {@link AlertKind}). */
export interface LiveAlertConfig {
  /** Low-RSSI floor (dBm). Reuses M15 `signalLoss`. */
  signalLoss: RangeAlarmConfig;
  /** Low link-quality floor (%). Reuses M15 `lqDrop`. */
  lqDrop: RangeAlarmConfig;
  /** Sustained link loss (LQ pinned at 0). Reuses M15 `failsafe`. */
  failsafe: LinkLossAlarmConfig;
  /** Optional distance-from-home limit (metres). M26-only; off by default. */
  gpsDistance: RangeAlarmConfig;
}

/**
 * Default live-alert thresholds, derived from the pinned M15
 * {@link DEFAULT_ANOMALY_CONFIG} so the two engines agree on what "bad" means.
 * The hysteresis bands add a small recovery margin on top of each M15 limit.
 */
export const DEFAULT_LIVE_ALERT_CONFIG: LiveAlertConfig = {
  signalLoss: {
    enabled: true,
    trip: DEFAULT_ANOMALY_CONFIG.signalLoss.rssiFloorDbm, // -100 dBm
    clear: DEFAULT_ANOMALY_CONFIG.signalLoss.rssiFloorDbm + 5, // recover to -95 dBm
    minFrames: DEFAULT_ANOMALY_CONFIG.signalLoss.minSamples, // 3 frames
  },
  lqDrop: {
    enabled: true,
    trip: DEFAULT_ANOMALY_CONFIG.lqDrop.absThreshold, // 50 %
    clear: DEFAULT_ANOMALY_CONFIG.lqDrop.absThreshold + 10, // recover to 60 %
    minFrames: DEFAULT_ANOMALY_CONFIG.lqDrop.window, // 5 frames
  },
  failsafe: {
    enabled: true,
    minFrames: DEFAULT_ANOMALY_CONFIG.failsafe.lqZeroSamples, // 2 frames
  },
  gpsDistance: {
    enabled: false,
    trip: 500, // metres from home
    clear: 450, // recover within 450 m
    minFrames: 5,
  },
};

/** A single alarm's runtime state (one two-phase debounced machine). */
export interface AlarmRuntime {
  phase: "ok" | "alarming";
  /** Consecutive bad frames seen while `ok` (arming the trip). */
  badStreak: number;
  /** Consecutive recovered frames seen while `alarming` (arming the clear). */
  goodStreak: number;
}

/**
 * Full evaluator state across every alarm, plus the GPS distance origin. `home`
 * is internal only — it is the first fix seen and is NEVER copied into a
 * {@link LiveAlert}.
 */
export interface LiveAlertState {
  signalLoss: AlarmRuntime;
  lqDrop: AlarmRuntime;
  failsafe: AlarmRuntime;
  gpsDistance: AlarmRuntime;
  home: { latitude: number; longitude: number } | null;
}

/** Result of evaluating one frame. */
export interface EvaluateResult {
  newState: LiveAlertState;
  /** Alarms newly raised on this frame (in {@link ALERT_KINDS} order). */
  firedAlerts: LiveAlert[];
  /** Alarms that recovered (cleared) on this frame (in {@link ALERT_KINDS} order). */
  clearedKinds: AlertKind[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh runtime in the healthy (`ok`) phase. */
function freshRuntime(): AlarmRuntime {
  return { phase: "ok", badStreak: 0, goodStreak: 0 };
}

/** A fresh, all-healthy evaluator state (called on connect / after a reset). */
export function initialAlertState(): LiveAlertState {
  return {
    signalLoss: freshRuntime(),
    lqDrop: freshRuntime(),
    failsafe: freshRuntime(),
    gpsDistance: freshRuntime(),
    home: null,
  };
}

/** Best (least-negative) of the two antenna RSSIs, or `null` if neither is finite. */
function bestRssi(frame: AlertFrame): number | null {
  const candidates = [frame.rssi1, frame.rssi2].filter((v) => Number.isFinite(v));
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** Great-circle distance between two lat/lon points, in metres (haversine). */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const R = 6_371_000; // Earth radius (m)
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Which way a metric goes "bad": below the trip, or above it. */
type Direction = "below" | "above";

/** Step result for one alarm's runtime on one frame. */
interface StepResult {
  next: AlarmRuntime;
  fired: boolean;
  cleared: boolean;
}

/**
 * Advance one alarm's two-phase machine by a single frame. This is the heart of
 * the hysteresis + debounce contract:
 *  - a `null`/`NaN` value (metric unavailable, or alarm disabled) is a *gap*: it
 *    holds the current phase and resets the in-progress streak, exactly like
 *    M15 treats a missing sample;
 *  - in `ok`, only `minFrames` consecutive *bad* frames flip to `alarming`
 *    (firing once); any non-bad frame resets the bad streak (debounce);
 *  - in `alarming`, only `minFrames` consecutive *recovered* frames (value past
 *    the distinct `clear` threshold) flip back to `ok` (clearing once); a value
 *    inside the hysteresis band neither re-fires nor clears.
 */
function stepAlarm(
  rt: AlarmRuntime,
  value: number | null,
  enabled: boolean,
  trip: number,
  clear: number,
  minFrames: number,
  direction: Direction
): StepResult {
  if (!enabled || value === null || !Number.isFinite(value)) {
    // Gap / disabled: keep phase, drop any partial streak so a resumed stream
    // must re-satisfy the full debounce window before flipping.
    return { next: { ...rt, badStreak: 0, goodStreak: 0 }, fired: false, cleared: false };
  }

  const isBad = direction === "below" ? value <= trip : value >= trip;
  const isRecovered = direction === "below" ? value >= clear : value <= clear;
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
  // Still bad, or sitting inside the hysteresis band: hold the alarm, reset the
  // recovery streak so a recovery must be sustained for `minFrames`.
  return { next: { phase: "alarming", badStreak: 0, goodStreak: 0 }, fired: false, cleared: false };
}

/** Severity for the low-LQ alarm: critical once it reaches the M15 critical floor. */
function lqSeverity(lq: number): AnomalySeverity {
  return lq <= DEFAULT_ANOMALY_CONFIG.lqDrop.criticalTo ? "critical" : "warning";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a single live frame against `config`, threading `prior` state through
 * to the returned `newState`. Pure: same inputs → same outputs, no side effects.
 */
export function evaluateFrame(
  frame: AlertFrame,
  config: LiveAlertConfig,
  prior: LiveAlertState
): EvaluateResult {
  const firedAlerts: LiveAlert[] = [];
  const clearedKinds: AlertKind[] = [];

  // --- Distance-from-home: latch the first finite fix as the origin ----------
  let home = prior.home;
  const fix = frame.gps;
  const hasFix =
    config.gpsDistance.enabled &&
    fix != null &&
    Number.isFinite(fix.latitude) &&
    Number.isFinite(fix.longitude);
  if (hasFix && home === null) {
    home = { latitude: fix!.latitude, longitude: fix!.longitude };
  }
  const distance =
    hasFix && home !== null
      ? haversineMeters(home, { latitude: fix!.latitude, longitude: fix!.longitude })
      : null;

  // --- Low RSSI (reuses signalLoss) -----------------------------------------
  const rssi = bestRssi(frame);
  const rssiStep = stepAlarm(
    prior.signalLoss,
    rssi,
    config.signalLoss.enabled,
    config.signalLoss.trip,
    config.signalLoss.clear,
    config.signalLoss.minFrames,
    "below"
  );
  if (rssiStep.fired && rssi !== null) {
    firedAlerts.push({
      kind: "signalLoss",
      severity: "critical",
      t: frame.t,
      messageKey: "alerts.message.signalLoss",
      detail: { rssi: Math.round(rssi) },
    });
  }
  if (rssiStep.cleared) clearedKinds.push("signalLoss");

  // --- Low link quality (reuses lqDrop) -------------------------------------
  const lq = Number.isFinite(frame.linkQuality) ? frame.linkQuality : null;
  const lqStep = stepAlarm(
    prior.lqDrop,
    lq,
    config.lqDrop.enabled,
    config.lqDrop.trip,
    config.lqDrop.clear,
    config.lqDrop.minFrames,
    "below"
  );
  if (lqStep.fired && lq !== null) {
    firedAlerts.push({
      kind: "lqDrop",
      severity: lqSeverity(lq),
      t: frame.t,
      messageKey: "alerts.message.lqDrop",
      detail: { lq: Math.round(lq) },
    });
  }
  if (lqStep.cleared) clearedKinds.push("lqDrop");

  // --- Link loss (reuses failsafe): sustained LQ pinned at 0 -----------------
  // Trip at LQ <= 0, clear once LQ recovers to >= 1 (a built-in 1-point band).
  const linkLossStep = stepAlarm(
    prior.failsafe,
    lq,
    config.failsafe.enabled,
    0,
    1,
    config.failsafe.minFrames,
    "below"
  );
  if (linkLossStep.fired) {
    firedAlerts.push({
      kind: "failsafe",
      severity: "critical",
      t: frame.t,
      messageKey: "alerts.message.failsafe",
      detail: { lq: 0 },
    });
  }
  if (linkLossStep.cleared) clearedKinds.push("failsafe");

  // --- GPS distance from home (optional) ------------------------------------
  const gpsStep = stepAlarm(
    prior.gpsDistance,
    distance,
    config.gpsDistance.enabled,
    config.gpsDistance.trip,
    config.gpsDistance.clear,
    config.gpsDistance.minFrames,
    "above"
  );
  if (gpsStep.fired && distance !== null) {
    firedAlerts.push({
      kind: "gpsDistance",
      severity: "warning",
      t: frame.t,
      messageKey: "alerts.message.gpsDistance",
      detail: { distance: Math.round(distance) },
    });
  }
  if (gpsStep.cleared) clearedKinds.push("gpsDistance");

  const newState: LiveAlertState = {
    signalLoss: rssiStep.next,
    lqDrop: lqStep.next,
    failsafe: linkLossStep.next,
    gpsDistance: gpsStep.next,
    home,
  };

  return { newState, firedAlerts, clearedKinds };
}

/**
 * Fold {@link evaluateFrame} over a sequence of frames, returning the final
 * state plus the flattened list of every alarm fired/cleared along the way.
 * Convenience for the runner's warm-up and for driving deterministic tests.
 */
export function evaluateFrames(
  frames: readonly AlertFrame[],
  config: LiveAlertConfig,
  initial: LiveAlertState = initialAlertState()
): { finalState: LiveAlertState; firedAlerts: LiveAlert[]; clearedKinds: AlertKind[] } {
  let state = initial;
  const firedAlerts: LiveAlert[] = [];
  const clearedKinds: AlertKind[] = [];
  for (const frame of frames) {
    const res = evaluateFrame(frame, config, state);
    state = res.newState;
    firedAlerts.push(...res.firedAlerts);
    clearedKinds.push(...res.clearedKinds);
  }
  return { finalState: state, firedAlerts, clearedKinds };
}
