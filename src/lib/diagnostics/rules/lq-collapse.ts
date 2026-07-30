/**
 * Rule: `lq-collapse` (category `link`).
 *
 * Generalises the M15 `detectLqDrop` primitive. Flags a sharp link-quality drop:
 * a finite sample that either falls `>= slopeDrop` below the max LQ in the
 * preceding `window` samples, OR crosses below `absThreshold` from an in-window
 * high that was at-or-above it. The drop is anchored to the bottom (the lowest LQ
 * reached) and debounced — at most one finding per drop, re-arming only once LQ
 * recovers above `absThreshold + recoverMargin` (a hysteresis band that keeps a
 * dip whose floor sits *above* `absThreshold`, e.g. ~55, from re-firing every
 * sample while the pre-drop high is still in the look-back window).
 *
 * Severity: **critical** when the bottom is `<= criticalTo` (≈0/12/14 collapses),
 * else **warning** (dips into the 30s–50s). Unlike `anomaly.ts`, this rule
 * **owns** an LQ→0 collapse and grades it `critical` — there is no separate
 * failsafe rule in this engine to cede it to.
 *
 * ## Fixtures (per fixtures-manifest.json)
 * Fires: `warning/warning-lq-dips-*` (warning), `warning/warning-marginal-rssi-04`
 * (warning), `warning/warning-recurring-dips-07` (3× warning),
 * `antenna/antenna-null-*` & `antenna/antenna-*-arc/sector/narrow-*` (warning or
 * critical by depth), `failsafe/*` (critical, twice for `failsafe-double`),
 * `failsafe/failsafe-after-warning-05` (warning then critical),
 * `wiring/*` (critical, 4× for `wiring-multi-drop-04`).
 * Silent on every `healthy/*` fixture (LQ stays ≥ 90, never a 30-fall nor a
 * sub-50 crossing).
 *
 * ## Safety
 * Reads only the link-quality channel; `detail` carries `{ from, to }` LQ
 * percentages only.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticConfig, DiagnosticFinding, DiagnosticRule } from "../types";
import { CHANNEL_CANDIDATES, clamp, clamp01, isFiniteNumber, resolveChannelValues, round2 } from "../util";

/** Rule id constant (single source of truth for the registry + manifest). */
export const LQ_COLLAPSE_RULE_ID = "lq-collapse";
/** i18n explanation key emitted by this rule. */
export const LQ_COLLAPSE_EXPLANATION = "diagnostics.finding.lqCollapse";

/**
 * Confidence for an LQ drop: deeper (larger fall) and longer dips score higher.
 * `0.5` baseline + up to `0.35` for full-depth + `0.15` for a long dip.
 */
function confidenceFor(from: number, to: number, lengthSamples: number): number {
  const depthFrac = from > 0 ? clamp01((from - to) / from) : 1;
  const lengthFrac = clamp01(lengthSamples / 20);
  return round2(clamp01(0.5 + 0.35 * depthFrac + 0.15 * lengthFrac));
}

/** Evaluate the `lq-collapse` rule over a parsed session. */
function evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[] {
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);
  if (!lq) return [];

  const { absThreshold, slopeDrop, window, criticalTo, recoverMargin } = config.rules.lqCollapse;
  const recoverLevel = absThreshold + recoverMargin;
  const n = log.sampleCount;
  const maxIdx = n - 1;
  const out: DiagnosticFinding[] = [];

  let armed = true;
  let inDrop = false;
  let preHighIdx = -1;
  let preHighVal = NaN;
  let bottomIdx = -1;
  let bottomVal = NaN;

  const emit = (endIdx: number): void => {
    const severity = bottomVal <= criticalTo ? "critical" : "warning";
    const startIndex = clamp(preHighIdx, 0, maxIdx);
    const endIndex = clamp(Math.max(endIdx, bottomIdx), 0, maxIdx);
    out.push({
      ruleId: LQ_COLLAPSE_RULE_ID,
      category: "link",
      severity,
      confidence: confidenceFor(preHighVal, bottomVal, endIndex - startIndex + 1),
      evidenceWindow: { startIndex, endIndex },
      explanation: LQ_COLLAPSE_EXPLANATION,
      detail: { from: round2(preHighVal), to: round2(bottomVal) },
    });
    inDrop = false;
    armed = true;
  };

  for (let i = 0; i < n; i++) {
    const v = lq[i];
    if (!isFiniteNumber(v)) continue;

    if (inDrop) {
      if (v < bottomVal) {
        bottomVal = v;
        bottomIdx = i;
      }
      if (v > recoverLevel) emit(i); // recovered past the hysteresis band
      continue;
    }

    // Find the max finite LQ in the preceding `window` samples (the pre-drop high).
    let mx = -Infinity;
    let mxIdx = -1;
    for (let j = i - 1; j >= 0 && j >= i - window; j--) {
      const pv = lq[j];
      if (isFiniteNumber(pv) && pv > mx) {
        mx = pv;
        mxIdx = j;
      }
    }
    if (armed && mxIdx !== -1) {
      const slopeHit = mx - v >= slopeDrop;
      const absCross = v < absThreshold && mx >= absThreshold;
      if (slopeHit || absCross) {
        inDrop = true;
        armed = false;
        preHighIdx = mxIdx;
        preHighVal = mx;
        bottomIdx = i;
        bottomVal = v;
      }
    }
  }
  if (inDrop) emit(bottomIdx); // never recovered before the session ended
  return out;
}

/** The `lq-collapse` diagnostic rule. */
export const lqCollapseRule: DiagnosticRule = {
  id: LQ_COLLAPSE_RULE_ID,
  name: "Link-quality collapse",
  category: "link",
  evaluate,
};
