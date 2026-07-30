/**
 * The diagnostic engine entry point (M36).
 *
 * {@link evaluateSession} runs every enabled rule over a parsed session,
 * concatenates their findings in registry order, sorts them by severity then
 * position, and pairs them with the session health score + per-window gauge data
 * into a {@link DiagnosticReport}.
 *
 * Pure & deterministic: same `(log, config)` ⇒ identical report. No `Date.now`,
 * no `Math.random`, no I/O, and `log.gps` is never read.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { DEFAULT_DIAGNOSTIC_CONFIG } from "./config";
import { computeSessionHealthScore } from "./health-score";
import { ALL_RULES } from "./rules";
import type {
  DiagnosticConfig,
  DiagnosticFinding,
  DiagnosticReport,
  DiagnosticSeverity,
} from "./types";

export { ALL_RULES } from "./rules";

/** Sort rank for a severity (critical first). */
function severityRank(severity: DiagnosticSeverity): number {
  return severity === "critical" ? 0 : severity === "warning" ? 1 : 2;
}

/**
 * Evaluate a whole session into a {@link DiagnosticReport}.
 *
 * Runs each rule whose `category` is enabled in
 * `config.enabledCategories`, concatenates the findings, and sorts them by
 * severity (critical → warning → info) then ascending `evidenceWindow.startIndex`
 * (stable for ties, preserving registry order). The health score and per-window
 * gauge come from {@link computeSessionHealthScore}. An empty/zero-sample log
 * yields no findings and a neutral `healthScore` of 100.
 */
export function evaluateSession(
  log: ParsedLog,
  config: DiagnosticConfig = DEFAULT_DIAGNOSTIC_CONFIG
): DiagnosticReport {
  const countsBySeverity: Record<DiagnosticSeverity, number> = { info: 0, warning: 0, critical: 0 };

  if (log.sampleCount === 0) {
    return {
      findings: [],
      healthScore: 100,
      sessionSummary: {
        sampleCount: 0,
        durationMs: log.durationMs,
        countsBySeverity,
        perWindowHealth: [],
      },
    };
  }

  const findings: DiagnosticFinding[] = [];
  for (const rule of ALL_RULES) {
    if (!config.enabledCategories[rule.category]) continue;
    findings.push(...rule.evaluate(log, config));
  }

  // Stable sort: severity first, then window start. Array.sort is stable
  // (ES2019+), so equal-key findings keep registry concatenation order.
  findings.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.evidenceWindow.startIndex - b.evidenceWindow.startIndex;
  });

  for (const f of findings) countsBySeverity[f.severity]++;

  const { overall, perWindow } = computeSessionHealthScore(log, config.healthScore);

  return {
    findings,
    healthScore: Math.round(overall),
    sessionSummary: {
      sampleCount: log.sampleCount,
      durationMs: log.durationMs,
      countsBySeverity,
      perWindowHealth: perWindow,
    },
  };
}
