/**
 * Rule: `rssi-floor` (category `signal`).
 *
 * Generalises the M15 `detectSignalLoss` primitive. Reads the **primary** antenna
 * (`rssi1`) only and flags every maximal run of finite samples at-or-below the
 * configured floor (`floorDbm`, default −100 dBm) whose length reaches
 * `minSamples` (default 3). Each such run is a **critical** finding spanning the
 * run; `detail.rssi` is the run's minimum (most-negative) RSSI.
 *
 * Reading `rssi1` (not the best of both, and never `rssi2`) is deliberate: a weak
 * second diversity antenna is normal and must not raise signal loss, while a
 * primary-antenna floor is a real link problem.
 *
 * ## Fixtures (per fixtures-manifest.json)
 * Fires (critical): every `failsafe/*` (RSSI pinned at/below the floor during the
 * loss), every `wiring/*` abrupt complete drop, and the deep directional nulls
 * `antenna/antenna-null-deep-02` & `antenna/antenna-narrow-null-04`.
 * Silent on: all `healthy/*`; the chronically-marginal `warning/warning-marginal-rssi-04`
 * (−90…−98, above the floor); the noisy/jitter/tx warnings (rssi1 never reaches
 * −100); and the shallow antenna nulls (mild/sector/wide, rssi1 ≥ −97).
 *
 * ## Safety
 * Reads only `rssi1`; `detail` carries a single RSSI in dBm.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticConfig, DiagnosticFinding, DiagnosticRule } from "../types";
import { CHANNEL_CANDIDATES, clamp, clamp01, isFiniteNumber, resolveChannelValues, round2 } from "../util";

/** Rule id constant. */
export const RSSI_FLOOR_RULE_ID = "rssi-floor";
/** i18n explanation key emitted by this rule. */
export const RSSI_FLOOR_EXPLANATION = "diagnostics.finding.rssiFloor";

/**
 * Confidence for a floor run: a longer run and a deeper minimum (further below
 * the floor) score higher. `0.6` baseline + up to `0.2` length + `0.2` depth.
 */
function confidenceFor(lengthSamples: number, minRssi: number, floor: number): number {
  const lengthFrac = clamp01(lengthSamples / 12);
  const depthFrac = clamp01((floor - minRssi) / 20);
  return round2(clamp01(0.6 + 0.2 * lengthFrac + 0.2 * depthFrac));
}

/** Evaluate the `rssi-floor` rule over a parsed session. */
function evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[] {
  const rssi = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1);
  if (!rssi) return [];

  const { floorDbm, minSamples } = config.rules.rssiFloor;
  const n = log.sampleCount;
  const maxIdx = n - 1;
  const out: DiagnosticFinding[] = [];

  let runStart = -1;
  let minVal = Infinity;

  const flush = (endExclusive: number): void => {
    if (runStart !== -1) {
      const length = endExclusive - runStart;
      if (length >= minSamples) {
        out.push({
          ruleId: RSSI_FLOOR_RULE_ID,
          category: "signal",
          severity: "critical",
          confidence: confidenceFor(length, minVal, floorDbm),
          evidenceWindow: {
            startIndex: clamp(runStart, 0, maxIdx),
            endIndex: clamp(endExclusive - 1, 0, maxIdx),
          },
          explanation: RSSI_FLOOR_EXPLANATION,
          detail: { rssi: round2(minVal) },
        });
      }
      runStart = -1;
      minVal = Infinity;
    }
  };

  for (let i = 0; i < n; i++) {
    const v = rssi[i];
    if (isFiniteNumber(v) && v <= floorDbm) {
      if (runStart === -1) runStart = i;
      if (v < minVal) minVal = v;
    } else {
      flush(i);
    }
  }
  flush(n);
  return out;
}

/** The `rssi-floor` diagnostic rule. */
export const rssiFloorRule: DiagnosticRule = {
  id: RSSI_FLOOR_RULE_ID,
  name: "RSSI at floor",
  category: "signal",
  evaluate,
};
