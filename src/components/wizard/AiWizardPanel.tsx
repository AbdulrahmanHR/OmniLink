import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  RotateCcw,
  Sparkles,
  Wand2,
  WifiOff,
  Wrench,
} from "lucide-react";
import {
  availableProviders,
  selectEnabledSourceIds,
  selectRetrievalIndex,
  useAssistantStore,
  useKnowledgeStore,
  useWizardStore,
} from "@/stores";
import {
  FLASH_METHOD_BY_ID,
  REGULATORY_DOMAIN_BY_ID,
} from "@/lib/elrsTargets";
import {
  applyWizardSuggestion,
  buildWizardSuggestion,
  evaluateWizardAiAvailability,
  WIZARD_DEVICE_ROLES,
  WIZARD_REGIONS,
  WIZARD_USE_CASES,
  type WizardIntent,
  type WizardSuggestion,
} from "@/lib/wizardAssist";
import { latestStableRelease } from "@/lib/firmwareReleases";
import { fetchFirmwareReleases } from "@/lib/tauri";
import { retrieveForChat, type ChatRetrieval } from "@/lib/ragRetrieval";
import { SourceCitations } from "@/components/ai/SourceCitations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Reactive `navigator.onLine`, kept in sync via the window online/offline events. */
function useOnline(): boolean {
  const [online, setOnline] = React.useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  React.useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** Qualitative confidence bucket for the summary badge. */
function confidenceLevel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.65) return "medium";
  return "low";
}

/** A single clarifying question rendered as an accessible radio group. */
function RadioQuestion<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  optionLabel,
  testidPrefix,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  value: T | null;
  onChange: (v: T) => void;
  optionLabel: (v: T) => string;
  testidPrefix: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs font-medium text-foreground">{legend}</legend>
      <div role="radiogroup" aria-label={legend} className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt;
          return (
            <label
              key={opt}
              data-testid={`${testidPrefix}-${opt}`}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
                active
                  ? "border-primary/50 bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <input
                type="radio"
                name={name}
                value={opt}
                checked={active}
                onChange={() => onChange(opt)}
                className="sr-only"
              />
              {optionLabel(opt)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * AI-assisted wizard panel (M53, D20). Renders BESIDE the static wizard (never
 * replacing it): a deterministic clarifying-question flow → a catalogue-valid
 * suggested target/settings card (with confidence, RAG citations, and
 * beginner-friendly explanations) → an "Apply & review" action that writes the
 * suggestion through the EXISTING setters and lands the user on the SAME
 * StepReview confirm/flash gate as static mode.
 *
 * When AI is unavailable/disabled/offline/out-of-credits it degrades to a clear
 * fallback notice with a one-click switch to the static wizard — no dead-end.
 */
export function AiWizardPanel() {
  const { t } = useTranslation();
  const setWizardMode = useWizardStore((s) => s.setWizardMode);

  // --- Availability + graceful fallback (D20) -------------------------------
  const keyed = useAssistantStore((s) => s.keyed);
  const refreshKeyedProviders = useAssistantStore((s) => s.refreshKeyedProviders);
  const online = useOnline();

  React.useEffect(() => {
    void refreshKeyedProviders();
  }, [refreshKeyedProviders]);

  const availability = evaluateWizardAiAvailability({
    hasProvider: availableProviders(keyed).length > 0,
    online,
  });

  // --- Clarifying intent ----------------------------------------------------
  const [deviceRole, setDeviceRole] =
    React.useState<WizardIntent["deviceRole"] | null>(null);
  const [useCase, setUseCase] =
    React.useState<WizardIntent["useCase"] | null>(null);
  const [region, setRegion] = React.useState<WizardIntent["region"] | null>(
    null,
  );
  const [suggestion, setSuggestion] = React.useState<WizardSuggestion | null>(
    null,
  );
  const [retrieval, setRetrieval] = React.useState<ChatRetrieval | null>(null);

  const intentComplete = deviceRole !== null && useCase !== null && region !== null;

  // FWCHK-8: this path applies its suggestion straight to review, so
  // StepFrequency — the only place that fetches the live ExpressLRS release list
  // — never runs here. Resolve the latest STABLE release ourselves so the
  // suggested (and then flashed) version is a real upstream one, not the frozen
  // catalogue constant. Fetched once per mount and AWAITED on click, so a fast
  // answer can't silently fall back merely because the fetch hadn't landed; a
  // failed fetch resolves to null → `buildWizardSuggestion` uses the catalogue.
  const latestStable = React.useRef<Promise<string | null> | null>(null);
  React.useEffect(() => {
    latestStable.current ??= fetchFirmwareReleases()
      .then((list) => latestStableRelease(list.releases))
      .catch(() => null);
  }, []);

  const handleRecommend = async () => {
    if (!intentComplete) return;
    const liveVersion = await (latestStable.current ?? Promise.resolve(null));
    const next = buildWizardSuggestion(
      { deviceRole, useCase, region },
      liveVersion,
    );
    // RAG citations for the rationale — local, offline, scoped to enabled sources.
    const knowledge = useKnowledgeStore.getState();
    const cites = retrieveForChat(next.rationaleQuery, {
      enabledSourceIds: selectEnabledSourceIds(knowledge),
      index: selectRetrievalIndex(knowledge),
    });
    setSuggestion(next);
    setRetrieval(cites);
  };

  const handleRestart = () => {
    setSuggestion(null);
    setRetrieval(null);
  };

  const handleApplyReview = () => {
    if (!suggestion) return;
    // Apply through the EXISTING setters (dependency order) + goToStep("review").
    // NEVER calls startFlash — StepReview's button remains the sole flash trigger.
    applyWizardSuggestion(suggestion, useWizardStore.getState());
    // Hand off to the SAME deterministic static review/flash surface.
    setWizardMode("static");
  };

  // --- Fallback (no dead-end) ----------------------------------------------
  if (!availability.available) {
    return (
      <div
        data-testid="ai-wizard-panel"
        className="flex flex-col gap-4 rounded-lg border border-border bg-card/60 p-5"
      >
        <div
          data-testid="ai-wizard-fallback"
          role="status"
          className="flex items-start gap-3 rounded-md border border-status-warning/40 bg-status-warning/10 p-4"
        >
          <WifiOff
            className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("wizard.ai.fallback.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(`wizard.ai.fallback.${availability.reason ?? "disabled"}`)}
            </span>
          </div>
        </div>
        <Button
          data-testid="ai-wizard-use-static"
          className="self-start"
          onClick={() => setWizardMode("static")}
        >
          <Wrench className="h-4 w-4" aria-hidden="true" />
          {t("wizard.ai.fallback.useStatic")}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="ai-wizard-panel"
      className="flex flex-col gap-5 rounded-lg border border-border bg-card/60 p-5"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("wizard.ai.title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("wizard.ai.subtitle")}
          </p>
        </div>
      </div>

      {/* --- Clarifying questions --------------------------------------------- */}
      <div className="flex flex-col gap-4">
        <RadioQuestion
          legend={t("wizard.ai.questions.deviceRole.label")}
          name="ai-device-role"
          options={WIZARD_DEVICE_ROLES}
          value={deviceRole}
          onChange={setDeviceRole}
          optionLabel={(v) => t(`wizard.ai.questions.deviceRole.${v}`)}
          testidPrefix="ai-role"
        />
        <RadioQuestion
          legend={t("wizard.ai.questions.useCase.label")}
          name="ai-use-case"
          options={WIZARD_USE_CASES}
          value={useCase}
          onChange={setUseCase}
          optionLabel={(v) => t(`wizard.ai.questions.useCase.${v}`)}
          testidPrefix="ai-usecase"
        />
        <RadioQuestion
          legend={t("wizard.ai.questions.region.label")}
          name="ai-region"
          options={WIZARD_REGIONS}
          value={region}
          onChange={setRegion}
          optionLabel={(v) => t(`wizard.ai.questions.region.${v}`)}
          testidPrefix="ai-region"
        />

        <Button
          data-testid="ai-wizard-recommend"
          className="self-start"
          disabled={!intentComplete}
          onClick={() => void handleRecommend()}
        >
          <Wand2 className="h-4 w-4" aria-hidden="true" />
          {t("wizard.ai.recommend")}
        </Button>
      </div>

      {/* --- Suggested target/settings summary -------------------------------- */}
      {suggestion && (
        <SuggestionSummary
          suggestion={suggestion}
          retrieval={retrieval}
          onApply={handleApplyReview}
          onRestart={handleRestart}
        />
      )}
    </div>
  );
}

function SummaryRow({ label, value, mono = false }: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate text-sm font-medium text-foreground",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SuggestionSummary({
  suggestion,
  retrieval,
  onApply,
  onRestart,
}: {
  suggestion: WizardSuggestion;
  retrieval: ChatRetrieval | null;
  onApply: () => void;
  onRestart: () => void;
}) {
  const { t } = useTranslation();
  const { target, selections, explanations, confidence } = suggestion;
  const domainMeta = REGULATORY_DOMAIN_BY_ID[selections.domain];
  const methodMeta = FLASH_METHOD_BY_ID[selections.flashMethod];
  const percent = Math.round(confidence * 100);
  const level = confidenceLevel(confidence);

  return (
    <div
      data-testid="ai-wizard-suggestion"
      className="flex flex-col gap-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("wizard.ai.summary.title")}
        </h3>
        <Badge
          variant={level === "low" ? "warning" : "good"}
          aria-label={t("wizard.ai.summary.confidenceAria", {
            percent,
            level: t(`wizard.ai.confidenceLevel.${level}`),
          })}
        >
          {t("wizard.ai.summary.confidence", {
            percent,
            level: t(`wizard.ai.confidenceLevel.${level}`),
          })}
        </Badge>
      </div>

      <div className="divide-y divide-border rounded-md border border-border bg-card/60 px-3">
        <SummaryRow label={t("wizard.ai.summary.brand")} value={target.brandName} />
        <SummaryRow label={t("wizard.ai.summary.model")} value={target.modelName} />
        <SummaryRow
          label={t("wizard.ai.summary.device")}
          value={t(`wizard.deviceType.${target.deviceType}`)}
        />
        <SummaryRow label={t("wizard.ai.summary.target")} value={target.target} mono />
        <SummaryRow
          label={t("wizard.ai.summary.band")}
          value={`${t(domainMeta.labelKey)} (${domainMeta.frequency})`}
        />
        <SummaryRow
          label={t("wizard.ai.summary.firmware")}
          value={selections.firmwareVersion}
          mono
        />
        <SummaryRow
          label={t("wizard.ai.summary.method")}
          value={t(methodMeta.nameKey)}
        />
        <SummaryRow
          label={t("wizard.ai.summary.binding")}
          value={t("wizard.ai.summary.bindingTraditional")}
        />
      </div>

      {/* Beginner-friendly explanations for each suggested setting. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">
          {t("wizard.ai.explain.title")}
        </span>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {explanations.map((ex) => (
            <li key={ex.key} className="flex items-start gap-1.5">
              <ArrowRight
                className="mt-0.5 h-3 w-3 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span>{t(`wizard.ai.explain.${ex.key}`, ex.params)}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Evidence — RAG citations from local retrieval (or "no source found"). */}
      <SourceCitations
        citations={retrieval?.chunks ?? []}
        noSourceFound={retrieval?.noSourceFound ?? true}
      />

      <Separator />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onRestart}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {t("wizard.ai.summary.restart")}
        </Button>
        <Button data-testid="ai-wizard-apply-review" onClick={onApply}>
          {t("wizard.ai.summary.apply")}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
