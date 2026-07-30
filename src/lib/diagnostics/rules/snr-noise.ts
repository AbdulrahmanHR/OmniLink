/**
 * Rule: `snr-noise` (category `signal`).
 *
 * Quantifies a noisy link via the **rolling standard deviation** of SNR: over a
 * trailing `window` of samples it computes the population stddev, and any sample
 * whose rolling stddev exceeds `stdThreshold` (dB) is "noisy". Contiguous noisy
 * samples are merged into one **warning** finding spanning the noisy span (the
 * window's lead-in is included by widening the start back by `window − 1`, since
 * a trailing-window stddev only peaks once the noise has filled the window).
 * A span shorter than `minSpan` is ignored.
 *
 * The threshold sits well between the corpus's healthy/structured fixtures
 * (rolling stddev ≤ ~1.9 dB, including the antenna nulls) and the genuinely noisy
 * ones (≥ ~7 dB), so it is a clean separator.
 *
 * ## Fixtures (per fixtures-manifest.json)
 * Fires (warning): `warning/warning-snr-noise-02` and the SNR half of
 * `warning/warning-mixed-05`.
 * Silent on: all `healthy/*` (stddev ≤ 0.4 dB) and every other class — including
 * the antenna/wiring fixtures whose SNR varies only mildly.
 *
 * ## Safety
 * Reads only the SNR channel; `detail` carries `{ stdDev, window }` (a dB figure
 * and a sample count).
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticConfig, DiagnosticFinding, DiagnosticRule } from "../types";
import { CHANNEL_CANDIDATES, clamp, clamp01, resolveChannelValues, rollingStdDev, round2 } from "../util";

/** Rule id constant. */
export const SNR_NOISE_RULE_ID = "snr-noise";
/** i18n explanation key emitted by this rule. */
export const SNR_NOISE_EXPLANATION = "diagnostics.finding.snrNoise";

/** Confidence: how far the peak rolling stddev overshoots the threshold. */
function confidenceFor(maxStd: number, threshold: number): number {
  const overshoot = threshold > 0 ? (maxStd - threshold) / threshold : 1;
  return round2(clamp01(0.5 + 0.5 * clamp01(overshoot)));
}

/** Evaluate the `snr-noise` rule over a parsed session. */
function evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[] {
  const snr = resolveChannelValues(log, CHANNEL_CANDIDATES.snr);
  if (!snr) return [];

  const { window, stdThreshold, minSpan } = config.rules.snrNoise;
  const n = log.sampleCount;
  const maxIdx = n - 1;
  const rolling = rollingStdDev(snr, window);
  const out: DiagnosticFinding[] = [];

  let runStart = -1;
  let runPeak = 0;

  const flush = (endExclusive: number): void => {
    if (runStart !== -1) {
      const start = Math.max(0, runStart - window + 1);
      const end = endExclusive - 1;
      if (end - start + 1 >= minSpan) {
        out.push({
          ruleId: SNR_NOISE_RULE_ID,
          category: "signal",
          severity: "warning",
          confidence: confidenceFor(runPeak, stdThreshold),
          evidenceWindow: { startIndex: clamp(start, 0, maxIdx), endIndex: clamp(end, 0, maxIdx) },
          explanation: SNR_NOISE_EXPLANATION,
          detail: { stdDev: round2(runPeak), window },
        });
      }
      runStart = -1;
      runPeak = 0;
    }
  };

  for (let i = 0; i < n; i++) {
    if (rolling[i] > stdThreshold) {
      if (runStart === -1) runStart = i;
      if (rolling[i] > runPeak) runPeak = rolling[i];
    } else {
      flush(i);
    }
  }
  flush(n);
  return out;
}

/** The `snr-noise` diagnostic rule. */
export const snrNoiseRule: DiagnosticRule = {
  id: SNR_NOISE_RULE_ID,
  name: "SNR noise",
  category: "signal",
  evaluate,
};
