/**
 * Rule: `tx-power-saturation` (category `power`).
 *
 * Flags the link running out of TX-power headroom: `tx_power` pinned at the
 * **max** step (`>= maxStepMw`, the top of `TX_POWER_STEPS` = 500 mW) for a
 * sustained run (`>= minSamples`) **while the signal is poor** over that run —
 * mean `rssi1` at-or-below `poorRssiDbm`, OR mean `link_quality` at-or-below
 * `degradedLq`. One **warning** finding per saturated-and-poor run, spanning it.
 *
 * The dual signal-poor gate is what keeps this clean: a healthy session never
 * pairs 500 mW with a good link, and a session that sits at 500 mW with a *fine*
 * link (e.g. `failsafe/failsafe-after-warning-05`, mean rssi1 ≈ −83 / LQ ≈ 83)
 * is **not** flagged — it's saturated but not signal-limited.
 *
 * ## Fixtures (per fixtures-manifest.json)
 * Fires (warning): `warning/warning-tx-saturation-06` (500 mW throughout, rssi
 * −92…−98, LQ ~72) and `failsafe/failsafe-tx-max-06` (500 mW while the link
 * fails).
 * Silent on: all `healthy/*` (none use 500 mW) and `failsafe/failsafe-after-warning-05`
 * (500 mW but the mean link stays healthy).
 *
 * ## Safety
 * Reads only TX-power, rssi1, and link-quality channels; `detail` carries
 * `{ txPower, avgRssi }` (a mW level and a mean dBm). `avgRssi` is the mean of
 * the FINITE rssi samples in the run; when the run has none (absent/all-gap
 * channel) it falls back to the floor sentinel (no fabricated `0 dBm`) and the
 * finding rests on the link-quality gate alone.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { RSSI_FLOOR_DBM } from "@/lib/telemetry-crsf";
import type { DiagnosticConfig, DiagnosticFinding, DiagnosticRule } from "../types";
import { CHANNEL_CANDIDATES, clamp, clamp01, isFiniteNumber, meanFinite, resolveChannelValues, round2 } from "../util";

/** Rule id constant. */
export const TX_POWER_SATURATION_RULE_ID = "tx-power-saturation";
/** i18n explanation key emitted by this rule. */
export const TX_POWER_SATURATION_EXPLANATION = "diagnostics.finding.txPowerSaturation";

/**
 * Confidence: how far below the poor-signal gates the run's means sit. When the
 * window has NO finite RSSI samples (`hasRssi` false), the RSSI severity term is
 * dropped and the confidence rests on the LQ severity alone — we never invent an
 * RSSI margin from a fabricated reading.
 */
function confidenceFor(
  meanRssi: number,
  meanLq: number,
  poorRssi: number,
  degradedLq: number,
  hasRssi: boolean
): number {
  const lqSeverity = clamp01((degradedLq - meanLq) / 30);
  if (!hasRssi) return round2(clamp01(0.5 + 0.5 * lqSeverity));
  const rssiSeverity = clamp01((poorRssi - meanRssi) / 15);
  return round2(clamp01(0.5 + 0.5 * Math.max(rssiSeverity, lqSeverity)));
}

/** Evaluate the `tx-power-saturation` rule over a parsed session. */
function evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[] {
  const tx = resolveChannelValues(log, CHANNEL_CANDIDATES.txPower);
  if (!tx) return [];
  const rssi = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1);
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);

  const { maxStepMw, minSamples, poorRssiDbm, degradedLq } = config.rules.txPowerSaturation;
  const n = log.sampleCount;
  const maxIdx = n - 1;
  const out: DiagnosticFinding[] = [];

  let runStart = -1;

  const flush = (endExclusive: number): void => {
    if (runStart !== -1) {
      const start = runStart;
      const end = endExclusive - 1;
      if (end - start + 1 >= minSamples) {
        // avgRssi is computed over FINITE rssi samples only — never a fabricated
        // 0 dBm. With no finite samples in the window the mean is undefined, so
        // the rule rests on the LQ gate and reports the floor sentinel.
        const finiteRssi = rssi
          ? rssi.slice(start, end + 1).filter(isFiniteNumber)
          : [];
        const hasRssi = finiteRssi.length > 0;
        const meanRssi = hasRssi
          ? finiteRssi.reduce((a, b) => a + b, 0) / finiteRssi.length
          : NaN;
        const meanLq = lq ? meanFinite(lq.slice(start, end + 1), 100) : 100;
        if ((hasRssi && meanRssi <= poorRssiDbm) || meanLq <= degradedLq) {
          out.push({
            ruleId: TX_POWER_SATURATION_RULE_ID,
            category: "power",
            severity: "warning",
            confidence: confidenceFor(meanRssi, meanLq, poorRssiDbm, degradedLq, hasRssi),
            evidenceWindow: { startIndex: clamp(start, 0, maxIdx), endIndex: clamp(end, 0, maxIdx) },
            explanation: TX_POWER_SATURATION_EXPLANATION,
            detail: {
              txPower: round2(maxStepMw),
              avgRssi: hasRssi ? round2(meanRssi) : RSSI_FLOOR_DBM,
            },
          });
        }
      }
      runStart = -1;
    }
  };

  for (let i = 0; i < n; i++) {
    const v = tx[i];
    if (isFiniteNumber(v) && v >= maxStepMw) {
      if (runStart === -1) runStart = i;
    } else {
      flush(i);
    }
  }
  flush(n);
  return out;
}

/** The `tx-power-saturation` diagnostic rule. */
export const txPowerSaturationRule: DiagnosticRule = {
  id: TX_POWER_SATURATION_RULE_ID,
  name: "TX-power saturation",
  category: "power",
  evaluate,
};
