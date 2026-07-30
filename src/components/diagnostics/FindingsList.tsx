import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Sparkles } from "lucide-react";
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticSeverity, SessionPatternReport } from "@/lib/diagnostics";
import { buildDiagnosticExport } from "@/lib/diagnostics";
import { diagnosticsContextFromExport } from "@/lib/aiContext";
import { useAssistantStore } from "@/stores/assistant";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useSessionStore } from "@/stores/session";
import { Button } from "@/components/ui/button";
import { FindingCard } from "./FindingCard";
import { buildDiagnosticSummary } from "./util";

/** Shared classes for the native <select> filter (mirrors AnomalyPanel). */
const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Severities for the filter dropdown, most-severe first. */
const SEVERITIES: readonly DiagnosticSeverity[] = ["critical", "warning", "info"];

/**
 * Below this sample count a session is too short for the rolling-window rules to
 * yield meaningful findings (the widest rule window is 20 samples).
 */
const MIN_SAMPLES_FOR_FINDINGS = 20;

/** A stable per-finding key (rule + window start) for selection + React keys. */
function findingKey(ruleId: string, startIndex: number): string {
  return `${ruleId}:${startIndex}`;
}

interface FindingsListProps {
  log: ParsedLog;
}

/**
 * The diagnostic findings panel (M37): the analyzed session's findings, already
 * sorted (critical → warning → info, then start index). Renders a count header,
 * an optional severity filter, a "Copy Diagnostic Summary" action, and one
 * scrub-to {@link FindingCard} per finding. Clicking a finding seeks the single
 * shared session cursor to its evidence-window start. Surfaces an honest empty
 * state and a distinct "not enough evidence" state for very short sessions.
 */
export function FindingsList({ log }: FindingsListProps) {
  const { t } = useTranslation();
  const report = useDiagnosticsStore((s) => s.sessionReport);
  const sessionPatternReport = useDiagnosticsStore((s) => s.sessionPatternReport);

  const [severityFilter, setSeverityFilter] = useState<"all" | DiagnosticSeverity>(
    "all"
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const findings = report?.findings ?? [];
  const visible = useMemo(() => {
    const all = report?.findings ?? [];
    return severityFilter === "all"
      ? all
      : all.filter((f) => f.severity === severityFilter);
  }, [report, severityFilter]);

  const handleSelect = useCallback((ruleId: string, startIndex: number) => {
    setSelectedKey(findingKey(ruleId, startIndex));
    useSessionStore.getState().seek(startIndex);
  }, []);

  const handleCopy = useCallback(() => {
    if (!report) return;
    const text = buildDiagnosticSummary(report, log, t);
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [report, log, t]);

  // BYOK AI "ask Omnia about this session" (M39a): build the deterministic M38
  // export (with an empty pattern report when none was computed), stage the
  // sanitized session-scope aggregate as one-shot evidence, prefill the composer,
  // and open the assistant — NOT auto-send, so preview-before-send stays usable.
  const handleAsk = useCallback(() => {
    if (!report) return;
    const patternReport: SessionPatternReport = sessionPatternReport ?? {
      patterns: [],
      mostLikely: null,
      hasEnoughEvidence: false,
      sampleCount: report.sessionSummary.sampleCount,
      durationMs: report.sessionSummary.durationMs,
    };
    const exp = buildDiagnosticExport(report, patternReport, log);
    const assistant = useAssistantStore.getState();
    assistant.setPendingDiagnostics(diagnosticsContextFromExport(exp));
    assistant.setDraft(t("diagnostics.ai.askSessionPrompt"));
    assistant.open();
  }, [report, sessionPatternReport, log, t]);

  // No report yet, or a session too short for the windowed rules.
  const sampleCount = report?.sessionSummary.sampleCount ?? log.sampleCount;
  if (!report || findings.length === 0) {
    const message =
      sampleCount < MIN_SAMPLES_FOR_FINDINGS
        ? t("diagnostics.findings.notEnoughData")
        : t("diagnostics.findings.empty");
    return (
      <p
        data-testid="diagnostics-findings-list"
        className="py-6 text-center text-sm text-muted-foreground"
      >
        {message}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="diagnostics-findings-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t("diagnostics.findings.count", { count: findings.length })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as "all" | DiagnosticSeverity)
            }
            aria-label={t("diagnostics.findings.filterSeverity")}
          >
            <option value="all">{t("diagnostics.findings.allSeverities")}</option>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`diagnostics.severity.${severity}`)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="diagnostics-copy-summary"
            onClick={handleCopy}
            aria-label={
              copied
                ? t("diagnostics.findings.copied")
                : t("diagnostics.findings.copyAria")
            }
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied
              ? t("diagnostics.findings.copied")
              : t("diagnostics.findings.copy")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="diagnostics-ask-session"
            onClick={handleAsk}
            aria-label={t("diagnostics.findings.askAria")}
          >
            <Sparkles aria-hidden />
            {t("diagnostics.findings.ask")}
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {visible.map((finding) => {
          const key = findingKey(
            finding.ruleId,
            finding.evidenceWindow.startIndex
          );
          return (
            <li key={key}>
              <FindingCard
                finding={finding}
                log={log}
                selected={key === selectedKey}
                onSelect={() =>
                  handleSelect(
                    finding.ruleId,
                    finding.evidenceWindow.startIndex
                  )
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
