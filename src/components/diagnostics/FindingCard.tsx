import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Sparkles } from "lucide-react";
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticFinding, DiagnosticSeverity } from "@/lib/diagnostics";
import { diagnosticsContextFromFinding } from "@/lib/aiContext";
import { useAssistantStore } from "@/stores/assistant";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { camel, relSeconds } from "./util";

/** Severity → status badge variant (info→good, warning→warning, critical→critical). */
const SEVERITY_VARIANT: Record<DiagnosticSeverity, "good" | "warning" | "critical"> = {
  info: "good",
  warning: "warning",
  critical: "critical",
};

/** Severity → Signal Lab status token for the left accent border. */
const SEVERITY_COLOR: Record<DiagnosticSeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

interface FindingCardProps {
  finding: DiagnosticFinding;
  /** Whether this finding is the currently-selected (scrubbed) one. */
  selected?: boolean;
  /** Select / scrub-to handler (the whole card is the control). */
  onSelect?: () => void;
  /** The loaded session (for the evidence-window timestamps). */
  log: ParsedLog;
}

/**
 * One diagnostic finding as an expandable, scrub-to card (M37).
 *
 * The card itself is the select control (click / Enter / Space → `onSelect`,
 * which scrubs the shared cursor to the evidence window). It shows a
 * severity-coloured left accent + badge, the localised rule name, the evidence
 * window timestamp range, the engine's localised explanation, and a plain-language
 * "why this matters" line. A separate disclosure button reveals the raw
 * (non-identifying) measurements and the detector confidence.
 */
export function FindingCard({ finding, selected, onSelect, log }: FindingCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const ruleName = t(`diagnostics.rule.${camel(finding.ruleId)}`);
  const start = relSeconds(log, finding.evidenceWindow.startIndex);
  const end = relSeconds(log, finding.evidenceWindow.endIndex);
  const confidencePct = Math.round(finding.confidence * 100);
  const detailEntries = Object.entries(finding.detail);

  // BYOK AI "explain this finding" (M39a): stage the sanitized aggregate as
  // one-shot evidence, prefill the composer with a short localized question, and
  // open the assistant — NOT auto-send, so preview-before-send stays usable. The
  // finding itself stays fully visible regardless of key state.
  const handleExplain = () => {
    const assistant = useAssistantStore.getState();
    assistant.setPendingDiagnostics(diagnosticsContextFromFinding(finding, log));
    assistant.setDraft(t("diagnostics.ai.explainPrompt", { rule: ruleName }));
    assistant.open();
  };

  return (
    <div
      data-testid="diagnostics-finding"
      className={cn(
        "rounded-md border border-l-2 transition-colors",
        selected ? "border-primary bg-primary/10" : "border-border"
      )}
      style={{ borderLeftColor: SEVERITY_COLOR[finding.severity] }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={t("diagnostics.finding.jumpAria", {
          rule: ruleName,
          time: `${start}s`,
        })}
        className="flex w-full flex-col gap-1 rounded-md p-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[finding.severity]}>
            {t(`diagnostics.severity.${finding.severity}`)}
          </Badge>
          <span className="text-sm font-medium text-foreground">{ruleName}</span>
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            aria-label={t("diagnostics.finding.evidenceAria", { start, end })}
          >
            {t("diagnostics.finding.window", { start, end })}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {t(finding.explanation, finding.detail)}
        </span>
        <span className="text-xs text-foreground/80">
          <span className="font-medium text-foreground">
            {t("diagnostics.finding.whyTitle")}:
          </span>{" "}
          {t(`diagnostics.why.${camel(finding.ruleId)}`)}
        </span>
      </button>

      <div className="px-2.5 pb-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={
              expanded
                ? t("diagnostics.finding.collapse")
                : t("diagnostics.finding.expand")
            }
            className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3.5 motion-safe:transition-transform",
                expanded && "rotate-180"
              )}
            />
            {expanded
              ? t("diagnostics.finding.collapse")
              : t("diagnostics.finding.expand")}
          </button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="diagnostics-explain-finding"
            onClick={handleExplain}
            aria-label={t("diagnostics.finding.explainAria")}
            className="h-7 px-2 text-xs"
          >
            <Sparkles aria-hidden />
            {t("diagnostics.finding.explain")}
          </Button>
        </div>

        {expanded && (
          <dl
            id={detailsId}
            className="mt-2 flex flex-col gap-1 border-t border-border/40 pt-2"
          >
            {detailEntries.map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-2">
                <dt className="text-xs text-muted-foreground">
                  {t(`diagnostics.detail.${key}`, key)}
                </dt>
                <dd className="font-mono text-xs tabular-nums text-foreground">
                  {value}
                </dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">
                {t("diagnostics.finding.confidenceLabel")}
              </dt>
              <dd className="font-mono text-xs tabular-nums text-foreground">
                {t("diagnostics.finding.confidence", { pct: confidencePct })}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}
