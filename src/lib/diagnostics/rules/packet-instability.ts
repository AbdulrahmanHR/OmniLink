/**
 * Rule: `packet-instability` (category `stability`).
 *
 * Quantifies packet-rate jitter via a **rolling change count**: over a trailing
 * `window` of samples it counts adjacent packet-rate transitions, and any sample
 * whose count reaches `jitterThreshold` is "jittery". Contiguous jittery samples
 * are merged into one **warning** finding spanning the unstable span (the start
 * is widened back by `window − 1` to include the window's lead-in). A span
 * shorter than `minSpan` is ignored.
 *
 * A constant packet rate has zero in-window changes, so a healthy session never
 * trips; an oscillating rate (e.g. 150/250/500 Hz) racks up many changes per
 * window, far above the threshold — a clean separation.
 *
 * ## Fixtures (per fixtures-manifest.json)
 * Fires (warning): `warning/warning-packet-jitter-03`, the packet half of
 * `warning/warning-mixed-05`, and the flaky-connection jitter in
 * `wiring/wiring-intermittent-01`, `wiring/wiring-jitter-03`,
 * `wiring/wiring-loose-antenna-05`.
 * Silent on: every `healthy/*` (single constant rate) and all other fixtures
 * whose packet rate never changes.
 *
 * ## Safety
 * Reads only the packet-rate channel; `detail` carries `{ changes, window }`
 * (both sample counts).
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticConfig, DiagnosticFinding, DiagnosticRule } from "../types";
import { CHANNEL_CANDIDATES, clamp, clamp01, resolveChannelValues, rollingChangeCount, round2 } from "../util";

/** Rule id constant. */
export const PACKET_INSTABILITY_RULE_ID = "packet-instability";
/** i18n explanation key emitted by this rule. */
export const PACKET_INSTABILITY_EXPLANATION = "diagnostics.finding.packetInstability";

/** Confidence: how far the peak in-window change count overshoots the threshold. */
function confidenceFor(maxChanges: number, threshold: number, window: number): number {
  const ceiling = Math.max(1, window - 1 - threshold);
  const overshoot = (maxChanges - threshold) / ceiling;
  return round2(clamp01(0.5 + 0.5 * clamp01(overshoot)));
}

/** Evaluate the `packet-instability` rule over a parsed session. */
function evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[] {
  const packet = resolveChannelValues(log, CHANNEL_CANDIDATES.packetRate);
  if (!packet) return [];

  const { window, jitterThreshold, minSpan } = config.rules.packetInstability;
  const n = log.sampleCount;
  const maxIdx = n - 1;
  const counts = rollingChangeCount(packet, window);
  const out: DiagnosticFinding[] = [];

  let runStart = -1;
  let runPeak = 0;

  const flush = (endExclusive: number): void => {
    if (runStart !== -1) {
      const start = Math.max(0, runStart - window + 1);
      const end = endExclusive - 1;
      if (end - start + 1 >= minSpan) {
        out.push({
          ruleId: PACKET_INSTABILITY_RULE_ID,
          category: "stability",
          severity: "warning",
          confidence: confidenceFor(runPeak, jitterThreshold, window),
          evidenceWindow: { startIndex: clamp(start, 0, maxIdx), endIndex: clamp(end, 0, maxIdx) },
          explanation: PACKET_INSTABILITY_EXPLANATION,
          detail: { changes: runPeak, window },
        });
      }
      runStart = -1;
      runPeak = 0;
    }
  };

  for (let i = 0; i < n; i++) {
    if (counts[i] >= jitterThreshold) {
      if (runStart === -1) runStart = i;
      if (counts[i] > runPeak) runPeak = counts[i];
    } else {
      flush(i);
    }
  }
  flush(n);
  return out;
}

/** The `packet-instability` diagnostic rule. */
export const packetInstabilityRule: DiagnosticRule = {
  id: PACKET_INSTABILITY_RULE_ID,
  name: "Packet-rate instability",
  category: "stability",
  evaluate,
};
