/**
 * M59 — the predictive failsafe warning experiment.
 *
 * ## READ THIS FIRST: on the real corpus, this predictor finds nothing, and that is
 * ## the milestone's headline finding — not a bug in the predictor.
 *
 * M59 asks whether OmniLink can warn a pilot **before** the link dies. Its acceptance
 * is a **≥ {@link PREDICTIVE_LEAD_TIME_TARGET_MS} ms median lead** while holding the
 * false-alarm rate at or below the M56 FP ceiling. On the frozen 36-fixture corpus that
 * acceptance is **UNMET, and structurally unmeasurable** — and the proof is not "our
 * predictor scored badly", it is an **oracle bound** that no predictor of any kind can
 * beat: see {@link measureCorpusLeadCeiling}. In the 8 `failsafe`-class onsets link
 * quality is flat at ~90 until **2 samples** before the failsafe (90 → 60 → 30 → 0); in
 * the 9 `wiring`-class onsets it goes from ≥ 86 to 0 in a **single** sample. The
 * earliest observable downward movement in link quality therefore sits **0 ms (median) /
 * 80 ms (max)** ahead of the event, against a 2000 ms target. There is no signal to
 * find. This module is built to find it anyway, honestly, and to report that it is not
 * there.
 *
 * Nothing in this file is tuned to make that number look better, and nothing in it may
 * be. A predictor that "works" on this corpus would be fitting a 2-sample edge.
 *
 * ## The risk model: one derived quantity, zero free knobs
 * The score is a **projected time to link loss** (`ttlMs`), and the warning threshold is
 * the frozen product target itself:
 *
 * > *Fit a line to the last {@link PREDICTIVE_WINDOW_SAMPLES} samples of link quality and
 * > of best-antenna RSSI. If either channel, continuing at its current fitted decay rate,
 * > reaches its own floor (LQ = 0; RSSI = {@link FEATURE_RSSI_FLOOR_DBM} dBm) within
 * > {@link PREDICTIVE_LEAD_TIME_TARGET_MS} ms — the pilot's reaction window — raise a
 * > warning.*
 *
 * That is the whole model. It is deliberately *derived* rather than *fitted*: the trip
 * point is not a number someone chose by looking at scores, it is the restatement of the
 * product requirement ("a pilot needs ~2 s to react") in the units the telemetry actually
 * provides. {@link PREDICTIVE_RISK_THRESHOLD} and {@link PREDICTIVE_RISK_HORIZON_MS} exist
 * only to express that same rule as a bounded confidence in `[0, 1]`, and
 * `tests/unit/ml/predictive.test.ts` asserts the identity
 * `riskFromTtl(PREDICTIVE_LEAD_TIME_TARGET_MS) === PREDICTIVE_RISK_THRESHOLD` so the two
 * cannot drift apart into an independently-tunable pair.
 *
 * ## It requires a TREND. This is what forecloses M58's artifact.
 * A channel that is **not falling** contributes an infinite time-to-loss and therefore
 * **zero** risk — no matter how bad its absolute level is. A `wiring` session whose RSSI
 * imbalance is present from sample 0, or a link sitting flat at a terrible-but-stable
 * LQ 30, produces **no warning at all** from this module.
 *
 * That is a deliberate structural property, not an oversight. M58's early-warning probe
 * produced an unbounded-horizon "median lead 4920 ms" by flagging a **standing fault** at
 * the very first prefix of a wiring session and then crediting that flag with having
 * "predicted" a failsafe seconds later. M58 correctly disbelieved its own number and
 * labelled it (`modelEval.ts` → `earlyWarning.caveats`). This module cannot produce that
 * artifact, because a standing fault has zero slope and a zero-slope channel cannot trip
 * it. Detecting a fault that is already there is **detection**, which the shipped v2.0
 * rules and the M26 live alerts already do; this module only ever claims **prediction**.
 * Asserted by the standing-fault test.
 *
 * ## Built ON the M26 live-alert pipeline, not beside it
 * The input type is `liveAlerts.ts`'s own {@link AlertFrame} — the exact frame shape the
 * shipped M26 evaluator consumes. There is no second frame type, no second telemetry
 * seam, and no fork of the live pipeline.
 *
 * ⚠️ The entry point here is named {@link evaluateRiskFrame}, **not** `evaluateFrame`.
 * `evaluateFrame` already exists twice in this codebase (`lib/liveAlerts.ts` and
 * `lib/diagnostics/live.ts`) and both are barrel-exported; a third would make the import
 * surface genuinely ambiguous.
 *
 * ## Distinct from M26 — it does not replace, reorder, or suppress anything
 * The deterministic v2.0 diagnostics and the M26 measured alerts remain the production
 * path and are untouched. A {@link PredictiveWarning} is a *forecast* about a link that
 * is still up; an M26 `LiveAlert` is a *measurement* of a link that is already bad. They
 * are different claims, they are rendered as different states, and this module emits its
 * own type so the two can never be conflated in code either.
 *
 * ## Safety — advisory only, numeric only, zero identifiers
 * {@link PredictiveWarning.advisory} is the literal `true`: there is no representable
 * output with `advisory: false`. The `detail` bag is `Record<string, number>` — numbers
 * only, so there is nowhere to put a coordinate, a UID, a MAC, an IP, a serial, a binding
 * phrase, or a sentence. This module imports nothing from the flash, config, profile, or
 * Tauri layers, so its output has no field a hardware writer could read.
 *
 * **GPS is actively excluded, not merely absent.** {@link AlertFrame} *does* carry a
 * `gps` field (M26's distance-from-home alarm reads it). {@link extractWindowFeatures}
 * never touches it, and `tests/unit/ml/predictive.test.ts` proves it by extracting
 * features from two windows identical except that one carries a GPS track, and asserting
 * the feature vectors are deep-equal — the same discipline, and the same test shape,
 * `dataset.ts` established.
 *
 * ## Purity
 * Every export is pure: no `Date.now`, no `Math.random`, no I/O, no network, no store
 * access. State is threaded by the caller, exactly as `liveAlerts.ts` does. Same frames ⇒
 * byte-identical warnings, on every machine and in every run order.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { EvidenceWindow } from "@/lib/diagnostics";
import { CHANNEL_CANDIDATES, resolveChannelValues } from "@/lib/diagnostics/util";
import type { AlertFrame } from "@/lib/liveAlerts";
import { FEATURE_LQ_LOW_PCT, FEATURE_RSSI_FLOOR_DBM } from "./dataset";
import { PREDICTIVE_LEAD_TIME_TARGET_MS } from "./mlConsts";
import { isFiniteNumber, round6 } from "./stats";

// ---------------------------------------------------------------------------
// Identity + schema
// ---------------------------------------------------------------------------

/** Stable predictor id. Appears in every warning and in the checked-in artifact. */
export const PREDICTOR_ID = "m59-ttl-trend";

/**
 * Semantic version of the {@link PredictiveWarning} + {@link PredictiveFeatures} shapes.
 * Bump on any breaking change; a consumer that does not recognise the version must reject
 * the artifact rather than coerce it — the discipline `ML_DATASET_SCHEMA_VERSION` and
 * `ANOMALY_MODEL_SCHEMA_VERSION` already follow.
 */
export const PREDICTIVE_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Frozen constants — each one derived, and each one saying where it came from
// ---------------------------------------------------------------------------

/**
 * Trailing window length, in samples: **25** = **1 second** at the canonical 40 ms
 * telemetry cadence.
 *
 * Not a new number: it is `anomalyModel.ts`'s `EVIDENCE_WINDOW_SAMPLES`, chosen there for
 * the same reason and re-derived here rather than imported so the predictor's window and
 * the model's evidence window can be reasoned about independently. One second is the
 * shortest span over which a decay *rate* is estimable at 25 Hz without the estimate being
 * dominated by single-sample noise, and the longest that still lets a warning arrive inside
 * a 2-second reaction budget.
 */
export const PREDICTIVE_WINDOW_SAMPLES = 25;

/**
 * Minimum finite samples a window needs before a slope may be fitted at all: **5**.
 *
 * A least-squares slope through 2 points is a line through 2 points, and through 3–4 noisy
 * points it is mostly noise. Below this count the predictor reports **zero risk** rather
 * than a confident-looking number derived from nothing — it fails **closed**, and a
 * just-connected link therefore cannot be warned about until it has been observed for
 * 200 ms.
 */
export const PREDICTIVE_MIN_WINDOW_SAMPLES = 5;

/**
 * The risk horizon: **2 × {@link PREDICTIVE_LEAD_TIME_TARGET_MS}**.
 *
 * Purely a normalising constant — it maps a projected time-to-loss onto a bounded
 * confidence in `[0, 1]` (see {@link riskFromTtl}) — and it is *derived* from the product
 * target rather than picked, precisely so that it and {@link PREDICTIVE_RISK_THRESHOLD}
 * cannot be quietly re-tuned as an independent pair. The factor of 2 is what makes the trip
 * point land on a round 0.5; nothing else depends on it.
 */
export const PREDICTIVE_RISK_HORIZON_MS = 2 * PREDICTIVE_LEAD_TIME_TARGET_MS;

/**
 * The trip threshold: **0.5**.
 *
 * **This is not a free parameter.** By construction of {@link riskFromTtl},
 * `risk >= 0.5` is *exactly* the statement `ttlMs <= PREDICTIVE_LEAD_TIME_TARGET_MS` — the
 * link, at its currently-fitted decay rate, is projected to be gone within the pilot's
 * reaction window. The threshold IS the product requirement, restated. There is no version
 * of this predictor with a different trip point that is still the same claim, and
 * `tests/unit/ml/predictive.test.ts` pins the identity so it cannot become one.
 */
export const PREDICTIVE_RISK_THRESHOLD = 0.5;

/**
 * The clear threshold: **0.25**, i.e. a projected time-to-loss of **3000 ms** — 1.5× the
 * reaction window. A link projected to survive half again as long as the pilot needs is no
 * longer in the warning state.
 *
 * A hysteresis band, in the M26 idiom (`DEFAULT_LIVE_ALERT_CONFIG` trips low and clears
 * higher) so a link hovering at the trip point cannot chatter.
 *
 * ## It cannot affect any number this milestone reports, and that is on purpose
 * Every M59 metric is a function of **first emission** (lead time) or of **fired at least
 * once** (false-alarm rate). Neither can be moved by a threshold that only governs when a
 * standing warning *stops*. The band is a UI-quality choice, it is the one number in this
 * file that is a choice rather than a derivation, and it is isolated where it can do no
 * evidential harm.
 */
export const PREDICTIVE_CLEAR_THRESHOLD = 0.25;

/**
 * Consecutive frames at or above {@link PREDICTIVE_RISK_THRESHOLD} required to raise a
 * warning (and, symmetrically, at or below {@link PREDICTIVE_CLEAR_THRESHOLD} to clear it):
 * **3**.
 *
 * Reused verbatim from M26's `signalLoss.minFrames` (`DEFAULT_ANOMALY_CONFIG.signalLoss
 * .minSamples`), because it answers the identical question — *how many consecutive bad
 * frames before we believe the link and not the noise?* — and the project has already
 * answered it once. Copying the answer is right; inventing a second one would mean the app
 * held two different beliefs about the same physics.
 *
 * It costs 3 samples (**120 ms**) of lead. On the real corpus that is immaterial: the
 * corpus offers at most 80 ms of lead to *any* predictor (see
 * {@link measureCorpusLeadCeiling}), so a zero-frame debounce would not rescue the null —
 * it would only add false alarms.
 */
export const PREDICTIVE_TRIP_FRAMES = 3;

/**
 * Creditability horizon for lead-time scoring: **10 000 ms**.
 *
 * Passed to `runMlEval`'s `leadTimeHorizonMs`, it says: a warning fired more than 10 s
 * before an onset is **not credited** with having predicted that onset.
 *
 * ## Why a horizon at all
 * `baseline.ts` and `modelEval.ts` both explain the failure it prevents: with an unbounded
 * horizon, a warning fired in the *aftermath* of event *k* (or in the mere presence of a
 * standing fault) is the nearest preceding prediction for event *k+1*, and gets credited
 * with a multi-second "lead" it never had. Timestamps alone cannot distinguish "warning
 * about the next failure" from "reporting the last one".
 *
 * ## Why 10 s specifically, and why it does not matter
 * It is the longest degradation ramp {@link import("./syntheticCorpus")} draws (8 s) plus a
 * margin, so a warning fired at the very start of the longest ramp the pipeline is designed
 * to catch remains creditable, while anything earlier than any ramp cannot be responding to
 * one.
 *
 * **The real-corpus null result does not depend on this number.** `predictiveEval.ts` scores
 * the real corpus at 2000 ms, at 10 000 ms, and **unbounded**, and reports all three: the
 * median lead is 0 ms under every one of them, because there is nothing in that corpus to
 * credit under any horizon. The sensitivity table is in the artifact so a reader does not
 * have to take that on trust.
 */
export const PREDICTIVE_CREDIT_HORIZON_MS = 10_000;

// ---------------------------------------------------------------------------
// Window features — numeric only, GPS actively excluded
// ---------------------------------------------------------------------------

/**
 * The frozen, ordered predictive feature names.
 *
 * Ten numbers extracted from a trailing window of {@link AlertFrame}s. Every one of them is
 * a **physical quantity of the radio link** — a level, a rate of change, a spread, or a
 * count. There is no identifier, no coordinate, and no free text in this vocabulary, and
 * the type below makes that structural rather than aspirational.
 *
 * Justification, feature by feature (they are not a grab-bag — the first six *are* the
 * model, and the last four are the evidence a human needs to check it):
 *  - `lqFit` / `lqSlopePctPerSec` — the fitted current link quality and its rate of change.
 *    Together they are the LQ time-to-loss, which is the primary term of the risk score.
 *  - `rssiFit` / `rssiSlopeDbPerSec` — the same two quantities for best-antenna RSSI, whose
 *    time-to-floor is the secondary term. RSSI is included because it is the *physical*
 *    channel: link quality is a packet-success statistic and can collapse for reasons other
 *    than range, whereas an eroding RSSI margin is the signature of the link budget actually
 *    running out. A predictor with only one of the two would be blind to half of the ways a
 *    link dies.
 *  - `ttlMs` — the derived projected time to link loss: `min` of the two above. **This is
 *    the score.**
 *  - `risk` — `ttlMs` mapped to a bounded confidence in `[0, 1]` (see {@link riskFromTtl}).
 *  - `lqMin` / `lqStd` / `rssiMin` — window extremes and spread. Not inputs to the score:
 *    they are the *evidence* shown beside a warning, so a pilot (or a reviewer) can see what
 *    the window actually contained rather than only what the model concluded from it.
 *  - `sampleCount` — how many finite samples the window held. It is the honesty term: a
 *    slope fitted from 5 samples and one fitted from 25 are not the same claim, and the
 *    number that distinguishes them travels with the warning.
 */
export const PREDICTIVE_FEATURE_NAMES = [
  "lqFit",
  "lqSlopePctPerSec",
  "rssiFit",
  "rssiSlopeDbPerSec",
  "ttlMs",
  "risk",
  "lqMin",
  "lqStd",
  "rssiMin",
  "sampleCount",
] as const;

/** One predictive feature name. */
export type PredictiveFeatureName = (typeof PREDICTIVE_FEATURE_NAMES)[number];

/** Number of predictive features (10). */
export const PREDICTIVE_FEATURE_COUNT = PREDICTIVE_FEATURE_NAMES.length;

/**
 * A trailing window's features: **numeric only, zero identifiers**. The type is the first
 * line of the privacy guarantee — there is nowhere in this shape to put a coordinate.
 */
export type PredictiveFeatures = Readonly<Record<PredictiveFeatureName, number>>;

/** A finite `(t, v)` observation pair drawn out of a window. */
interface Point {
  t: number;
  v: number;
}

/**
 * Ordinary-least-squares fit of `v` against `t`, returning the slope (per ms) and the
 * value the fitted line takes at the window's **last** timestamp.
 *
 * The fitted endpoint is used rather than the raw last sample because it is the linear
 * model's own estimate of the current level, and it is the estimate that is *consistent
 * with the slope the same fit produced*. Mixing a noisy raw endpoint with a smoothed slope
 * would make `level / rate` a ratio of two things that do not describe the same line.
 *
 * Returns `null` when there are fewer than {@link PREDICTIVE_MIN_WINDOW_SAMPLES} finite
 * points, or when every point shares one timestamp (a vertical fit is not a rate). **Fails
 * closed**: a caller that gets `null` reports no risk, never a default one.
 */
function fitLine(points: readonly Point[]): { slopePerMs: number; fitAtEnd: number } | null {
  const n = points.length;
  if (n < PREDICTIVE_MIN_WINDOW_SAMPLES) return null;

  let sumT = 0;
  let sumV = 0;
  for (const p of points) {
    sumT += p.t;
    sumV += p.v;
  }
  const meanT = sumT / n;
  const meanV = sumV / n;

  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const dt = p.t - meanT;
    sxx += dt * dt;
    sxy += dt * (p.v - meanV);
  }
  if (!(sxx > 0)) return null;

  const slopePerMs = sxy / sxx;
  const tEnd = points[n - 1].t;
  return { slopePerMs, fitAtEnd: meanV + slopePerMs * (tEnd - meanT) };
}

/**
 * Projected time (ms) for a falling channel to reach its floor: `margin / (−slope)`.
 *
 * `Infinity` when the channel is **not falling** (`slope >= 0`) — which is the structural
 * property that makes this predictor blind to standing faults, and the reason it cannot
 * reproduce M58's artifact. See the module header.
 *
 * `0` when the channel is already at or past its floor **and still falling** — the link is
 * gone; the "prediction" is a report, and the lead-time scorer will (correctly) count it as
 * a miss rather than as a 0 ms lead.
 */
function timeToFloorMs(marginToFloor: number, slopePerMs: number): number {
  if (!isFiniteNumber(marginToFloor) || !isFiniteNumber(slopePerMs)) return Infinity;
  if (slopePerMs >= 0) return Infinity;
  return Math.max(0, marginToFloor) / -slopePerMs;
}

/**
 * Map a projected time-to-loss onto a bounded confidence in `[0, 1]`.
 *
 * `risk = clamp01(1 − ttlMs / PREDICTIVE_RISK_HORIZON_MS)`, so:
 *  - `ttl = 0`      ⇒ risk 1.00 (the link is going now);
 *  - `ttl = 2000`   ⇒ risk **0.50** — *exactly* {@link PREDICTIVE_RISK_THRESHOLD}, because
 *    the horizon is twice the target. **This identity is the model**: tripping at 0.5 and
 *    "projected to be gone inside the pilot's reaction window" are the same sentence;
 *  - `ttl >= 4000`  ⇒ risk 0.00 (no projected loss within the horizon at all);
 *  - `ttl = ∞`      ⇒ risk 0.00 (not falling).
 */
export function riskFromTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 0;
  const r = 1 - ttlMs / PREDICTIVE_RISK_HORIZON_MS;
  return round6(Math.min(1, Math.max(0, r)));
}

/** Best (least-negative) of the two antenna RSSIs on a frame, or `null` if neither is finite. */
function bestRssi(frame: AlertFrame): number | null {
  const a = isFiniteNumber(frame.rssi1) ? frame.rssi1 : null;
  const b = isFiniteNumber(frame.rssi2) ? frame.rssi2 : null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Population standard deviation of a finite list (`0` when empty). */
function stdOf(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return Math.sqrt(acc / n);
}

/**
 * Extract a trailing window's {@link PredictiveFeatures}.
 *
 * **Pure and deterministic.** `frame.gps` is **never read** — pass a window whose frames
 * carry a GPS track and one whose frames do not, and the two feature vectors are
 * deep-equal. That is asserted in `tests/unit/ml/predictive.test.ts`, against frames that
 * actually have coordinates, because the guarantee is worthless if it is only tested where
 * there was nothing to leak.
 *
 * Non-finite samples are **gaps**, never zeros: they are dropped from the fit rather than
 * dragging a slope toward an imaginary floor. That is the same rule every other module in
 * this project follows, and it matters here — reading a dropped-telemetry gap as `LQ = 0`
 * would manufacture a catastrophic decay rate out of a missing packet.
 *
 * A window with too few finite samples yields **zero risk and an infinite time-to-loss**,
 * not a guess. Fails closed.
 */
export function extractWindowFeatures(window: readonly AlertFrame[]): PredictiveFeatures {
  const lqPoints: Point[] = [];
  const rssiPoints: Point[] = [];
  const lqValues: number[] = [];
  const rssiValues: number[] = [];

  for (const frame of window) {
    // `frame.gps` is deliberately not read. See the module header.
    const t = frame.t;
    if (!isFiniteNumber(t)) continue;

    if (isFiniteNumber(frame.linkQuality)) {
      lqPoints.push({ t, v: frame.linkQuality });
      lqValues.push(frame.linkQuality);
    }
    const rssi = bestRssi(frame);
    if (rssi !== null) {
      rssiPoints.push({ t, v: rssi });
      rssiValues.push(rssi);
    }
  }

  const lqFit = fitLine(lqPoints);
  const rssiFit = fitLine(rssiPoints);

  // LQ falls to a floor of 0 %. RSSI falls to the v2.0 noise floor (−100 dBm) — reused from
  // `dataset.ts::FEATURE_RSSI_FLOOR_DBM`, which is itself the v2.0 `rssi-floor` rule's
  // threshold in all three sensitivity presets, i.e. the app already treats it as a physical
  // constant rather than a tunable. No new number is invented here.
  const ttlLq = lqFit ? timeToFloorMs(lqFit.fitAtEnd, lqFit.slopePerMs) : Infinity;
  const ttlRssi = rssiFit
    ? timeToFloorMs(rssiFit.fitAtEnd - FEATURE_RSSI_FLOOR_DBM, rssiFit.slopePerMs)
    : Infinity;
  const ttlMs = Math.min(ttlLq, ttlRssi);

  return {
    lqFit: round6(lqFit?.fitAtEnd ?? 0),
    lqSlopePctPerSec: round6((lqFit?.slopePerMs ?? 0) * 1000),
    rssiFit: round6(rssiFit?.fitAtEnd ?? 0),
    rssiSlopeDbPerSec: round6((rssiFit?.slopePerMs ?? 0) * 1000),
    // `Infinity` is not representable in JSON and would poison an artifact. A window with
    // no projected loss reports the horizon itself — the largest ttl that still means
    // anything to `riskFromTtl`, and one that maps to a risk of exactly 0.
    ttlMs: Number.isFinite(ttlMs) ? round6(ttlMs) : PREDICTIVE_RISK_HORIZON_MS,
    risk: riskFromTtl(ttlMs),
    lqMin: lqValues.length > 0 ? Math.min(...lqValues) : 0,
    lqStd: round6(stdOf(lqValues)),
    rssiMin: rssiValues.length > 0 ? Math.min(...rssiValues) : 0,
    sampleCount: Math.max(lqPoints.length, rssiPoints.length),
  };
}

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

/**
 * One predictive warning. **Advisory only, numeric only, zero identifiers.**
 *
 * A *forecast*, and the type says so: it is not an `AnomalyEvent` (M15), not a `LiveAlert`
 * (M26), and not a `DiagnosticFinding` (v2.0). Those three report what the link **is
 * doing**; this reports what it is **projected to do**, which is a weaker claim and must
 * stay in a shape that cannot be mistaken for one of theirs.
 *
 * There is deliberately nothing here a hardware-writing path could consume: no setting key,
 * no value, no target, no firmware field, no free text. `advisory: true` is a **literal
 * type** — there is no representable warning with `advisory: false`.
 */
export interface PredictiveWarning {
  predictorId: typeof PREDICTOR_ID;
  schemaVersion: typeof PREDICTIVE_SCHEMA_VERSION;
  /** Advisory, always. The type has no other inhabitant. */
  advisory: true;
  /** Session-axis timestamp (ms) of the frame the warning was raised on. */
  t: number;
  /** Sample index of that frame — the `endIndex` of {@link evidence}. */
  index: number;
  /**
   * Confidence in `[0, 1]`: the {@link riskFromTtl} risk at the moment of firing. `0.5`
   * means "projected to be gone in exactly the pilot's reaction window"; `1.0` means "now".
   *
   * **It is a confidence in the projection, not a probability of a crash.** It says how far
   * inside the reaction window the *current fitted decay rate* puts the link — nothing
   * about how likely that rate is to continue, which this predictor has no way to know and
   * does not claim to.
   */
  confidence: number;
  /** Projected ms until link loss at the fitted decay rate, at the moment of firing. */
  ttlMs: number;
  /** The trailing window the warning was computed over. Same shape a `DiagnosticFinding` uses. */
  evidence: EvidenceWindow;
  /** The window's features — the numbers behind the confidence. */
  features: PredictiveFeatures;
  /**
   * A stable **machine-readable code**, not a sentence and not an i18n key.
   *
   * `src/lib/ml` contains **zero user-facing strings** and does not know what a UI namespace
   * is — the discipline `evalHarness.ts` states in its own header ("every code here is a
   * stable machine-readable identifier *shaped to double as an i18n key suffix*… nothing in
   * this module is a sentence intended for a human UI") and that `DiagnosticFinding
   * .explanation` already follows. The lab-flagged UI composes the full key from this code at
   * the render boundary; the library never names one.
   */
  code: typeof PREDICTIVE_WARNING_CODE;
  /**
   * Non-identifying **numbers only** — stricter than `DiagnosticFinding.detail`, which also
   * permits strings. Nothing here can be a coordinate, a UID, a MAC, an IP, a serial, a
   * binding phrase, or a sentence, because nothing here can be anything but a number.
   */
  detail: Record<string, number>;
}

/**
 * The one warning this predictor can emit, as a stable code. The UI maps it to a translated
 * string; this module has no opinion about how.
 */
export const PREDICTIVE_WARNING_CODE = "predictedLinkLoss";

// ---------------------------------------------------------------------------
// The frame-by-frame evaluator
// ---------------------------------------------------------------------------

/**
 * The evaluator's state across frames. Threaded by the caller (the `liveAlerts.ts` idiom),
 * never held in module scope — so a multi-frame sequence is fully reproducible in a test and
 * two concurrent sessions cannot contaminate each other.
 */
export interface PredictiveState {
  /** Trailing window, oldest → newest, at most {@link PREDICTIVE_WINDOW_SAMPLES} frames. */
  window: readonly AlertFrame[];
  /** 0-based index of the next frame. A sample counter, never a timestamp, never an id. */
  nextIndex: number;
  /** Consecutive frames at or above the trip threshold (arming a warning). */
  riskStreak: number;
  /** Consecutive frames at or below the clear threshold (arming a recovery). */
  calmStreak: number;
  phase: "quiet" | "warning";
}

/** A fresh, quiet state. Called on connect / at the start of a session. */
export function initialPredictiveState(): PredictiveState {
  return { window: [], nextIndex: 0, riskStreak: 0, calmStreak: 0, phase: "quiet" };
}

/** The result of evaluating one frame. */
export interface PredictiveResult {
  newState: PredictiveState;
  /** The warning raised on this frame, or `null`. At most one — this is a single alarm. */
  warning: PredictiveWarning | null;
  /** `true` when a standing warning recovered on this frame. */
  cleared: boolean;
  /** The window's features on this frame (for a live risk readout). Always present. */
  features: PredictiveFeatures;
}

/**
 * Advance the predictor by one {@link AlertFrame}.
 *
 * **Named `evaluateRiskFrame`, not `evaluateFrame`** — see the module header: two functions
 * called `evaluateFrame` already exist in this codebase and both are barrel-exported.
 *
 * Pure: same `(frame, prior)` ⇒ same result, no side effects, no clock, no RNG.
 *
 * Fires **once** per trip, after {@link PREDICTIVE_TRIP_FRAMES} consecutive frames at or
 * above {@link PREDICTIVE_RISK_THRESHOLD}, and clears only after the same number of frames
 * at or below {@link PREDICTIVE_CLEAR_THRESHOLD}. A risk hovering inside the hysteresis band
 * neither re-fires nor clears — the M26 contract, reused rather than reinvented.
 */
export function evaluateRiskFrame(
  frame: AlertFrame,
  prior: PredictiveState = initialPredictiveState()
): PredictiveResult {
  const index = prior.nextIndex;
  const window = [...prior.window, frame].slice(-PREDICTIVE_WINDOW_SAMPLES);
  const features = extractWindowFeatures(window);
  const risk = features.risk;

  let { riskStreak, calmStreak, phase } = prior;
  let warning: PredictiveWarning | null = null;
  let cleared = false;

  if (phase === "quiet") {
    if (risk >= PREDICTIVE_RISK_THRESHOLD) {
      riskStreak += 1;
      if (riskStreak >= PREDICTIVE_TRIP_FRAMES) {
        phase = "warning";
        riskStreak = 0;
        calmStreak = 0;
        warning = {
          predictorId: PREDICTOR_ID,
          schemaVersion: PREDICTIVE_SCHEMA_VERSION,
          advisory: true,
          t: frame.t,
          index,
          confidence: risk,
          ttlMs: features.ttlMs,
          evidence: {
            startIndex: Math.max(0, index - (window.length - 1)),
            endIndex: index,
          },
          features,
          code: PREDICTIVE_WARNING_CODE,
          detail: {
            confidence: risk,
            ttlMs: features.ttlMs,
            targetMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
            lqFit: features.lqFit,
            lqSlopePctPerSec: features.lqSlopePctPerSec,
            rssiFit: features.rssiFit,
            rssiSlopeDbPerSec: features.rssiSlopeDbPerSec,
            windowSamples: features.sampleCount,
          },
        };
      }
    } else {
      riskStreak = 0;
    }
  } else {
    // phase === "warning"
    if (risk <= PREDICTIVE_CLEAR_THRESHOLD) {
      calmStreak += 1;
      if (calmStreak >= PREDICTIVE_TRIP_FRAMES) {
        phase = "quiet";
        riskStreak = 0;
        calmStreak = 0;
        cleared = true;
      }
    } else {
      calmStreak = 0;
    }
  }

  return {
    newState: { window, nextIndex: index + 1, riskStreak, calmStreak, phase },
    warning,
    cleared,
    features,
  };
}

/**
 * Fold {@link evaluateRiskFrame} over a sequence of frames, returning every warning it
 * raised. The `evaluateFrames` convenience `liveAlerts.ts` provides, for the same reason.
 */
export function runPredictor(frames: readonly AlertFrame[]): PredictiveWarning[] {
  return runPredictorIntervals(frames).map((i) => i.warning);
}

/**
 * A warning and the span over which the predictor **stood behind it**.
 *
 * ## Why an interval, and not just a timestamp — this is the crux of M59's measurement
 * A warning that the predictor later **withdrew** is not a prediction of anything that
 * happens after the withdrawal. If the predictor warns at t = 5 s, the link then **fully
 * recovers** to LQ 91 and the warning clears, and a *separate* collapse kills the link at
 * t = 9 s — the 5 s warning did **not** predict the 9 s failsafe. It predicted a collapse
 * that did not happen. Crediting it with a "4-second lead" is precisely the fraud this
 * release exists to prevent.
 *
 * This is not hypothetical. `failsafe-after-warning-05.csv` in the real corpus contains
 * exactly that shape: an LQ dip to 40 about 4.3 s before the failsafe, which **recovers to
 * LQ 91** first. The same dip shape appears in the 7 `warning` fixtures, **which never
 * failsafe at all**. A scorer that credits withdrawn warnings reports a multi-second median
 * lead on this corpus — and it is an artifact, provably, because the corpus's own oracle
 * ceiling ({@link measureCorpusLeadCeiling}) is **80 ms**. The two numbers cannot both be
 * true, and the oracle bound is the one with no knobs in it.
 *
 * It is also the generalisation of the incoherence M58 found and correctly disbelieved: *"a
 * detector whose early verdict contradicts its own final verdict is not warning early; it is
 * oscillating across its threshold, and the first crossing of an oscillation is a timestamp,
 * not a prediction."*
 *
 * So the predictor reports **when it started warning and when it stopped**, and the eval
 * credits a warning to an event only if the predictor was **still standing behind it** when
 * the event arrived. The predictor's own hysteresis state machine — not a scoring convention
 * invented after the fact — is what decides.
 */
export interface PredictiveWarningInterval {
  warning: PredictiveWarning;
  /** Session-axis ms the warning was raised. */
  startMs: number;
  /**
   * Session-axis ms the predictor **withdrew** it (risk fell back below the clear threshold
   * for {@link PREDICTIVE_TRIP_FRAMES} frames), or `null` if it was **still standing** when
   * the session ended.
   *
   * A warning is creditable to an event at `onsetMs` iff `startMs < onsetMs` **and**
   * (`endMs === null || onsetMs <= endMs`) — see {@link coversOnset}.
   */
  endMs: number | null;
}

/** Fold the predictor over a sequence of frames, returning warning **intervals**. */
export function runPredictorIntervals(
  frames: readonly AlertFrame[]
): PredictiveWarningInterval[] {
  let state = initialPredictiveState();
  const intervals: PredictiveWarningInterval[] = [];
  let open: PredictiveWarningInterval | null = null;

  for (const frame of frames) {
    const result = evaluateRiskFrame(frame, state);
    state = result.newState;

    if (result.warning) {
      open = { warning: result.warning, startMs: result.warning.t, endMs: null };
      intervals.push(open);
    }
    if (result.cleared && open) {
      open.endMs = frame.t;
      open = null;
    }
  }
  return intervals;
}

/**
 * Was the predictor **still standing behind** this warning when the event at `onsetMs`
 * arrived? The creditability test, and the whole reason {@link PredictiveWarningInterval}
 * exists. See its docblock.
 */
export function coversOnset(interval: PredictiveWarningInterval, onsetMs: number): boolean {
  if (!(interval.startMs < onsetMs)) return false;
  return interval.endMs === null || onsetMs <= interval.endMs;
}

// ---------------------------------------------------------------------------
// Replaying a stored session through the live frame pipeline
// ---------------------------------------------------------------------------

/**
 * Project a {@link ParsedLog} onto the {@link AlertFrame}s the live pipeline would have
 * seen, so a *recorded* session can be replayed through **the same predictor** a live link
 * runs through. There is no offline variant of the predictor and no second code path: the
 * eval harness and a live telemetry stream both call {@link evaluateRiskFrame}.
 *
 * `gps` is set to `null` unconditionally. The predictor never reads it (asserted), so this
 * is belt-and-braces rather than the guarantee itself — but it does mean that even a caller
 * who replays a GPS-bearing log cannot get a coordinate anywhere near this module.
 */
export function alertFramesFromLog(log: ParsedLog): AlertFrame[] {
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality) ?? [];
  const rssi1 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1) ?? [];
  const rssi2 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi2) ?? [];

  const frames: AlertFrame[] = new Array(log.sampleCount);
  for (let i = 0; i < log.sampleCount; i++) {
    frames[i] = {
      t: log.time[i],
      rssi1: rssi1[i] ?? NaN,
      rssi2: rssi2[i] ?? NaN,
      linkQuality: lq[i] ?? NaN,
      gps: null,
    };
  }
  return frames;
}

/** Run the predictor over a whole recorded session. Pure; the live path, replayed. */
export function predictOverLog(log: ParsedLog): PredictiveWarning[] {
  return runPredictor(alertFramesFromLog(log));
}

// ---------------------------------------------------------------------------
// The oracle bound — the number that proves the null result
// ---------------------------------------------------------------------------

/**
 * One ground-truth onset, and the **maximum lead any predictor could possibly have had** on
 * it — under each of two independent definitions of "the link first showed something".
 */
export interface LeadCeilingCase {
  sessionId: string;
  /** Sample index of the failsafe onset (the frozen `findFailsafeOnsetIndices` event set). */
  onsetIndex: number;
  onsetMs: number;
  /**
   * Lead under the **materiality** definition: the first sample of the run of
   * `LQ < {@link FEATURE_LQ_LOW_PCT}` (the v2.0 `lq-collapse` rule's own threshold) that
   * ends at the onset. **This is the headline ceiling.**
   */
  thresholdCeilingMs: number;
  /**
   * Lead under the **maximally generous** definition: the first sample of the maximal
   * strictly-decreasing LQ run ending at the onset — which credits even a single-point noise
   * wiggle as a precursor. Reported so a reader can see the null does not depend on the
   * stricter definition.
   */
  anyMovementCeilingMs: number;
}

/** One definition's corpus-wide bound. */
export interface LeadCeilingBound {
  /** How this bound defines "the earliest a predictor could have emitted". */
  definition: string;
  medianMs: number;
  maxMs: number;
  minMs: number;
  /** Events giving **literally zero** warning under this definition. */
  zeroLeadEvents: number;
  /** `false` on the real corpus, under **both** definitions. */
  targetReachable: boolean;
}

/**
 * The corpus-wide **oracle bound** on lead time: the ceiling on what **any** predictor — this
 * one, a trained model, or a perfect oracle — could extract from the corpus.
 */
export interface LeadCeilingReport {
  channel: "linkQuality";
  source: "src/lib/ml/predictive.ts::measureCorpusLeadCeiling";
  eventCount: number;
  /** The frozen product target both bounds are compared against. **2000 ms.** */
  targetMs: number;
  /**
   * **The headline bound.** Uses the app's own threshold for "low link quality"
   * ({@link FEATURE_LQ_LOW_PCT} = 50, the v2.0 `lq-collapse` `absThreshold`), so it is not a
   * number invented for this measurement.
   */
  threshold: LeadCeilingBound;
  /**
   * The **maximally generous** bound: any downward movement in LQ at all counts, including a
   * 1-point noise wiggle no real detector could act on. It exists to foreclose the objection
   * that the headline bound was defined stingily. It is **larger**, and it is **still ~17×
   * short of the target**.
   */
  anyMovement: LeadCeilingBound;
  /**
   * `false`. **This is the finding.** The corpus's own ceiling is below the target under
   * **both** definitions, so no predictor can meet M59's acceptance on this data. The
   * shortfall is a property of the corpus, not of any model.
   */
  targetReachable: boolean;
  cases: LeadCeilingCase[];
}

/** Median of a numeric list (`0` when empty). */
function medianOf(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Summarise one definition's per-event leads into a bound. */
function summariseBound(leads: readonly number[], definition: string): LeadCeilingBound {
  const sorted = [...leads].sort((a, b) => a - b);
  const median = medianOf(sorted);
  return {
    definition,
    medianMs: round6(median),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
    minMs: sorted.length === 0 ? 0 : sorted[0],
    zeroLeadEvents: leads.filter((v) => v <= 0).length,
    targetReachable: sorted.length > 0 && median >= PREDICTIVE_LEAD_TIME_TARGET_MS,
  };
}

/**
 * Measure the **oracle bound** on lead time — the number that proves M59's null result.
 *
 * ## What it is for
 * The obvious objection to a null result is *"your predictor was simply bad"*. This function
 * answers that **without reference to any predictor**. A predictor cannot react to a fall it
 * has not yet observed, so the first sample at which link quality has departed from health is
 * the earliest instant **any causal detector could possibly emit**. The lead measured from it
 * is an upper bound that a perfect oracle attains and nothing exceeds.
 *
 * ## Two definitions, because one of them would be a knob
 * The bound depends on what counts as "departed from health", and that choice could be used to
 * make the answer come out any way one liked. So **both** ends of the plausible range are
 * computed, and the null survives both:
 *
 *  1. **`threshold` (headline).** The first sample of the run of `LQ < FEATURE_LQ_LOW_PCT`
 *     (= 50) that ends at the onset. The threshold is **not invented here** — it is the v2.0
 *     `lq-collapse` rule's own `absThreshold`, frozen in `dataset.ts`, i.e. the app's existing
 *     definition of "low link quality". Reusing the app's own notion is the same discipline
 *     `findFailsafeOnsetIndices` follows for "the link was gone".
 *
 *     On the real corpus: **median 0 ms, max 80 ms** — and the 80 ms independently reproduces
 *     `MEASURED_MAX_FIXTURE_LEAD_MS`, which was frozen in `mlConsts.ts` before this function
 *     existed. Two derivations, one number. The test asserts they agree.
 *
 *  2. **`anyMovement` (maximally generous).** The first sample of the maximal
 *     *strictly-decreasing* LQ run ending at the onset. This credits a **single-point noise
 *     wiggle** — a `91 → 90` step in a channel that jitters ±1 all session — as a precursor.
 *     No real detector could act on it without firing continuously on healthy links. It is
 *     computed anyway, because it is the most generous bound anyone could argue for, and
 *     because the null must not depend on my having picked the stricter one.
 *
 *     On the real corpus this yields **median 40 ms, max 120 ms**. Still **17× short** of the
 *     2000 ms target.
 *
 * ## What the numbers mean
 * A `failsafe` fixture reads `… 90, 90, 90, 60, 30, 0` — two samples of warning. A `wiring`
 * fixture reads `… 94, 95, 94, 93, 93, 0` — link quality goes from healthy to **zero in a
 * single sample**. There is no precursor. There is nothing to fit a line to. **No predictor,
 * however good, can warn about an event that the data does not announce.**
 *
 * Pure. `onsets` must come from `baseline.ts::findFailsafeOnsetIndices` — M59 inherits the
 * frozen event set and does not define its own.
 */
export function measureCorpusLeadCeiling(
  sessions: readonly { sessionId: string; log: ParsedLog; onsets: readonly number[] }[]
): LeadCeilingReport {
  const cases: LeadCeilingCase[] = [];

  for (const s of sessions) {
    const lq = resolveChannelValues(s.log, CHANNEL_CANDIDATES.linkQuality) ?? [];
    for (const onsetIndex of s.onsets) {
      // (1) Materiality: walk back over the run of LQ below the v2.0 "low LQ" threshold.
      let thresholdStart = onsetIndex;
      for (let i = onsetIndex; i >= 0; i--) {
        const v = lq[i];
        if (!isFiniteNumber(v) || !(v < FEATURE_LQ_LOW_PCT)) break;
        thresholdStart = i;
      }

      // (2) Maximally generous: walk back over the maximal strictly-decreasing run. This
      //     credits a 1-point noise downtick, which is why it is not the headline.
      let movementStart = onsetIndex;
      for (let i = onsetIndex; i >= 1; i--) {
        const cur = lq[i];
        const prev = lq[i - 1];
        if (!isFiniteNumber(cur) || !isFiniteNumber(prev)) break;
        if (!(cur < prev)) break;
        movementStart = i;
      }

      const onsetMs = s.log.time[onsetIndex];
      cases.push({
        sessionId: s.sessionId,
        onsetIndex,
        onsetMs,
        thresholdCeilingMs: round6(onsetMs - s.log.time[thresholdStart]),
        anyMovementCeilingMs: round6(onsetMs - s.log.time[movementStart]),
      });
    }
  }

  const threshold = summariseBound(
    cases.map((c) => c.thresholdCeilingMs),
    `first sample of the run of LQ < ${FEATURE_LQ_LOW_PCT} (the v2.0 lq-collapse absThreshold, from dataset.ts::FEATURE_LQ_LOW_PCT) ending at the onset`
  );
  const anyMovement = summariseBound(
    cases.map((c) => c.anyMovementCeilingMs),
    "first sample of the maximal strictly-decreasing LQ run ending at the onset (credits a single-point noise wiggle; the most generous bound anyone could argue for)"
  );

  return {
    channel: "linkQuality",
    source: "src/lib/ml/predictive.ts::measureCorpusLeadCeiling",
    eventCount: cases.length,
    targetMs: PREDICTIVE_LEAD_TIME_TARGET_MS,
    threshold,
    anyMovement,
    // Reachable only if BOTH bounds clear the target — i.e. fails closed.
    targetReachable: threshold.targetReachable && anyMovement.targetReachable,
    cases,
  };
}
