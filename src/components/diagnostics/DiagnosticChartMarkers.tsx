import type { ReactElement } from "react";
import { ReferenceArea, ReferenceDot } from "recharts";
import type { ParsedLog } from "@/lib/blackbox";
import type {
  DiagnosticFinding,
  DiagnosticSeverity,
  SessionPattern,
} from "@/lib/diagnostics";
import { camel } from "./util";

/** Severity → Signal Lab status token (info→good, warning→warning, critical→critical). */
const SEVERITY_COLOR: Record<DiagnosticSeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

/** Options for {@link buildDiagnosticMarkers}. */
export interface DiagnosticMarkerOptions {
  /** `<ruleId>:<startIndex>` of the selected finding (drives the emphasis). */
  selectedKey?: string;
  /** Scrub-to handler invoked with the finding's evidence-window start index. */
  onSelect?: (startIndex: number) => void;
  /** Y position for the clickable dot — a chart's top (its data max). */
  y?: number;
  /** Translator for the dot's accessible name; falls back to the raw key. */
  t?: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Build the diagnostic evidence-window markers for a timeline chart (M37).
 *
 * Returns a flat, KEYED array of Recharts reference elements — a translucent
 * {@link ReferenceArea} band over each finding's evidence window plus a clickable
 * {@link ReferenceDot} at the chart top. Recharts only renders reference elements
 * that are LITERAL children of the chart, so this returns an array to spread
 * inside `<LineChart>` rather than a wrapper component.
 *
 * Pure + deterministic: seconds are derived from `log.time`; no `Date.now`,
 * `Math.random`, store, or DOM access. The dot's click stops propagation so
 * selecting a finding never also re-scrubs the cursor (mirrors anomaly markers).
 */
export function buildDiagnosticMarkers(
  findings: readonly DiagnosticFinding[],
  log: ParsedLog,
  opts: DiagnosticMarkerOptions = {}
): ReactElement[] {
  const { selectedKey, onSelect, y, t } = opts;
  const t0 = log.time[0] ?? 0;
  const sec = (i: number) => ((log.time[i] ?? t0) - t0) / 1000;
  const label = (key: string, params?: Record<string, unknown>): string =>
    t ? t(key, params) : key;

  const elements: ReactElement[] = [];
  for (const f of findings) {
    const color = SEVERITY_COLOR[f.severity];
    const startSec = sec(f.evidenceWindow.startIndex);
    const endSec = sec(f.evidenceWindow.endIndex);
    const key = `${f.ruleId}:${f.evidenceWindow.startIndex}`;
    const selected = key === selectedKey;

    elements.push(
      <ReferenceArea
        key={`diag-area-${key}`}
        x1={startSec}
        x2={endSec}
        fill={color}
        fillOpacity={selected ? 0.22 : 0.12}
        ifOverflow="extendDomain"
      />
    );
    elements.push(
      <ReferenceDot
        key={`diag-dot-${key}`}
        x={startSec}
        y={y ?? 0}
        r={selected ? 5 : 3.5}
        fill={color}
        stroke="var(--color-background)"
        strokeWidth={1}
        ifOverflow="extendDomain"
        cursor="pointer"
        data-testid="diagnostics-chart-marker"
        role="button"
        aria-label={label("diagnostics.marker.aria", {
          rule: label(`diagnostics.rule.${camel(f.ruleId)}`),
          time: `${startSec.toFixed(1)}s`,
        })}
        onClick={(_props: unknown, e: React.MouseEvent) => {
          // Don't let the click bubble to the LineChart's onClick (which would
          // scrub to the nearest decimated point) — mirrors the anomaly dots.
          e.stopPropagation();
          onSelect?.(f.evidenceWindow.startIndex);
        }}
      />
    );
  }
  return elements;
}

/**
 * Build the SESSION-PATTERN evidence markers for a timeline chart (M38).
 *
 * A sibling of {@link buildDiagnosticMarkers} for the post-flight patterns: each
 * pattern's `evidenceWindows` become a translucent {@link ReferenceArea} band plus
 * a clickable {@link ReferenceDot}. They read as visually DISTINCT from the M37
 * finding markers — the band is dashed and fainter — so a pattern's span (which
 * can cover several windows) is not confused with a single finding's window.
 *
 * Same purity/click contract as {@link buildDiagnosticMarkers}: seconds derive from
 * `log.time`, the dot's click stops propagation, and the returned array is spread
 * as literal chart children.
 */
export function buildPatternMarkers(
  patterns: readonly SessionPattern[],
  log: ParsedLog,
  opts: DiagnosticMarkerOptions = {}
): ReactElement[] {
  const { onSelect, y, t } = opts;
  const t0 = log.time[0] ?? 0;
  const sec = (i: number) => ((log.time[i] ?? t0) - t0) / 1000;
  const label = (key: string, params?: Record<string, unknown>): string =>
    t ? t(key, params) : key;

  const elements: ReactElement[] = [];
  for (const p of patterns) {
    const color = SEVERITY_COLOR[p.severity];
    p.evidenceWindows.forEach((w, wi) => {
      const startSec = sec(w.startIndex);
      const endSec = sec(w.endIndex);
      const key = `pat-${p.patternId}-${wi}`;
      elements.push(
        <ReferenceArea
          key={`pat-area-${key}`}
          x1={startSec}
          x2={endSec}
          fill={color}
          fillOpacity={0.07}
          stroke={color}
          strokeOpacity={0.5}
          strokeDasharray="4 3"
          ifOverflow="extendDomain"
        />
      );
      elements.push(
        <ReferenceDot
          key={`pat-dot-${key}`}
          x={startSec}
          y={y ?? 0}
          r={3}
          fill="var(--color-background)"
          stroke={color}
          strokeWidth={1.5}
          ifOverflow="extendDomain"
          cursor="pointer"
          data-testid="diagnostics-pattern-marker"
          role="button"
          aria-label={label("diagnostics.patternMarker.aria", {
            pattern: label(`diagnostics.pattern.${camel(p.patternId)}`),
            time: `${startSec.toFixed(1)}s`,
          })}
          onClick={(_props: unknown, e: React.MouseEvent) => {
            e.stopPropagation();
            onSelect?.(w.startIndex);
          }}
        />
      );
    });
  }
  return elements;
}
