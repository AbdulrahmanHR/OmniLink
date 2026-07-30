/**
 * Shared pure helpers for the diagnostics UI (M37). Kept in a plain `.ts` module
 * (no JSX) so the rule label + timestamp helpers can be imported by both the
 * components and the pure chart-marker builder without tripping React Fast Refresh.
 */
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticReport } from "@/lib/diagnostics";

/** Kebab rule id → camelCase i18n segment (`"lq-collapse"` → `"lqCollapse"`). */
export function camel(ruleId: string): string {
  return ruleId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Relative seconds (1 dp) of a sample index against the log's first timestamp. */
export function relSeconds(log: ParsedLog, index: number): string {
  const t0 = log.time[0] ?? 0;
  return (((log.time[index] ?? t0) - t0) / 1000).toFixed(1);
}

/**
 * Build the plain-text, identifier-free diagnostic summary for the clipboard.
 * Pure + deterministic (no `Date.now`/`Math.random`): the overall health score
 * followed by one line per finding —
 * `[SEVERITY] <rule> @ <start>–<end>s: <localized explanation>`. Only localized
 * copy + non-identifying numbers leave the app; no GPS, no ids.
 */
export function buildDiagnosticSummary(
  report: DiagnosticReport,
  log: ParsedLog,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const lines: string[] = [
    t("diagnostics.findings.copyTitle"),
    t("diagnostics.findings.copyHealth", {
      score: Math.round(report.healthScore),
    }),
  ];
  for (const f of report.findings) {
    const sev = t(`diagnostics.severity.${f.severity}`).toUpperCase();
    const rule = t(`diagnostics.rule.${camel(f.ruleId)}`);
    const start = relSeconds(log, f.evidenceWindow.startIndex);
    const end = relSeconds(log, f.evidenceWindow.endIndex);
    const explanation = t(f.explanation, f.detail);
    lines.push(`[${sev}] ${rule} @ ${start}–${end}s: ${explanation}`);
  }
  return lines.join("\n");
}
