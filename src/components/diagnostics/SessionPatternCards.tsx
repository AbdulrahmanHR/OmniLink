import { useTranslation } from "react-i18next";
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticSeverity, SessionPattern } from "@/lib/diagnostics";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSessionStore } from "@/stores/session";
import { Badge } from "@/components/ui/badge";
import { camel } from "./util";

/** Severity → status badge variant (info→good, warning→warning, critical→critical). */
const SEVERITY_VARIANT: Record<DiagnosticSeverity, "good" | "warning" | "critical"> = {
  info: "good",
  warning: "warning",
  critical: "critical",
};

interface SessionPatternCardsProps {
  log: ParsedLog;
}

/**
 * Post-flight session-pattern summary (M38).
 *
 * Reads the store's already-computed {@link import("@/lib/diagnostics").SessionPatternReport}
 * (no detection here) and renders the "most likely issue" as three labelled blocks
 * — Most likely issue / Evidence / What to check first — plus a compact list of any
 * secondary patterns. Clicking the Evidence block (or a secondary pattern) seeks
 * the single shared session cursor to that pattern's first evidence window.
 *
 * Honest empty states: an inline muted "not enough evidence" note for sessions too
 * short to analyze, and a "no recurring patterns" note when the detector ran but
 * found nothing.
 */
export function SessionPatternCards({ log }: SessionPatternCardsProps) {
  const { t } = useTranslation();
  const report = useDiagnosticsStore((s) => s.sessionPatternReport);

  const seekTo = (pattern: SessionPattern): void => {
    const first = pattern.evidenceWindows[0];
    if (first) useSessionStore.getState().seek(first.startIndex);
  };

  // Not enough evidence (session too short) — or no report computed yet.
  if (!report || !report.hasEnoughEvidence) {
    return (
      <p
        data-testid="diagnostics-patterns"
        className="py-6 text-center text-sm text-muted-foreground"
      >
        {t("diagnostics.patterns.notEnough")}
      </p>
    );
  }

  // The detector ran but nothing recurring stood out.
  if (report.patterns.length === 0) {
    return (
      <p
        data-testid="diagnostics-patterns"
        className="py-6 text-center text-sm text-muted-foreground"
      >
        {t("diagnostics.patterns.none")}
      </p>
    );
  }

  const mostLikely = report.patterns[0];
  const secondary = report.patterns.slice(1);
  const patternName = (p: SessionPattern): string =>
    t(`diagnostics.pattern.${camel(p.patternId)}`);

  // Suppress the unused-parameter lint while keeping the documented prop contract
  // (the log is the analyzed session this summary belongs to).
  void log;

  return (
    <div className="flex flex-col gap-3" data-testid="diagnostics-patterns">
      {/* Most likely issue */}
      <div
        data-testid="diagnostics-pattern-mostlikely"
        className="flex flex-col gap-1.5 rounded-md border border-border p-3"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[mostLikely.severity]}>
            {t(`diagnostics.severity.${mostLikely.severity}`)}
          </Badge>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("diagnostics.patterns.mostLikely")}
          </span>
          <span className="text-sm font-medium text-foreground">
            {patternName(mostLikely)}
          </span>
        </span>
        <span className="text-sm text-foreground/90">
          {t(mostLikely.summaryKey, mostLikely.detail)}
        </span>
      </div>

      {/* Evidence — click to seek to the first evidence window. */}
      <button
        type="button"
        data-testid="diagnostics-pattern-evidence"
        onClick={() => seekTo(mostLikely)}
        aria-label={t("diagnostics.patterns.jumpAria", {
          pattern: patternName(mostLikely),
        })}
        className="flex flex-col gap-1 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("diagnostics.patterns.evidence")}
        </span>
        <span className="text-sm text-foreground/90">
          {t(mostLikely.evidenceKey, mostLikely.detail)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("diagnostics.patterns.windows", {
            count: mostLikely.evidenceWindows.length,
          })}
        </span>
      </button>

      {/* What to check first */}
      <div
        data-testid="diagnostics-pattern-checkfirst"
        className="flex flex-col gap-1 rounded-md border border-border p-3"
      >
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("diagnostics.patterns.checkFirst")}
        </span>
        <span className="text-sm text-foreground/90">
          {t(mostLikely.checkFirstKey)}
        </span>
      </div>

      {/* Secondary patterns — compact, click-to-seek. */}
      {secondary.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("diagnostics.patterns.secondary")}
          </span>
          <ul className="flex flex-col gap-1.5">
            {secondary.map((p) => (
              <li key={p.patternId}>
                <button
                  type="button"
                  data-testid="diagnostics-pattern"
                  onClick={() => seekTo(p)}
                  aria-label={t("diagnostics.patterns.jumpAria", {
                    pattern: patternName(p),
                  })}
                  className="flex w-full flex-col gap-0.5 rounded-md border border-border p-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={SEVERITY_VARIANT[p.severity]}>
                      {t(`diagnostics.severity.${p.severity}`)}
                    </Badge>
                    <span className="text-sm font-medium text-foreground">
                      {patternName(p)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(p.summaryKey, p.detail)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
