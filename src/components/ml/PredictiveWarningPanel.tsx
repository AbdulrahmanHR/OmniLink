import * as React from "react";
import { useTranslation } from "react-i18next";
import { Activity, Ban, FlaskConical, ShieldAlert, TrendingDown, XCircle } from "lucide-react";
import { predictOverLog, type PredictiveWarning } from "@/lib/ml/predictive";
import type { PredictiveEvalArtifact } from "@/lib/ml/predictiveEval";
import { useSessionStore } from "@/stores/session";

/**
 * The **M59 predictive failsafe warning** experiment, surfaced honestly.
 *
 * Lab-flagged (`mlLab`, OFF by default) and mounted only from {@link MlLabPanel}, which is
 * itself gated at the render boundary in `SettingsPage`. With the flag off this component is
 * never mounted: the surface **does not exist**, rather than existing-but-disabled.
 *
 * ## The four rules this panel is built to obey
 *
 * **1. It leads with the null result, because the null result is the finding.**
 * The headline is not "here is a predictive warning"; it is *"on OmniLink's real reference
 * flights, this predictor found no early-warning signal at all, and here is the number that
 * proves none exists to find"*. A lab user must not be able to leave this panel believing the
 * experiment worked, and the copy does not give them the room to.
 *
 * **2. "Predicted" is kept relentlessly distinct from "measured".**
 * M26's `LiveAlertHost` renders *measurements* of a link that is **already bad**: red/amber
 * `role="alert"` toasts in an `aria-live="assertive"` region, using the severity vocabulary
 * `info | warning | critical`. This panel renders a *forecast* about a link that is **still
 * up** — a fundamentally weaker claim — and so it deliberately shares **none** of that
 * language:
 *   - a different **severity vocabulary**: `projected`, never `critical`. There is no red;
 *   - a different **visual treatment**: a dashed, muted, `TrendingDown`-marked card, not a
 *     solid status-coloured toast;
 *   - a different **semantic role**: `role="region"` + `aria-live="off"`. It is a *report you
 *     read*, not an *alarm that interrupts you*. Announcing a guess as assertively as a
 *     measurement would be an accessibility lie as much as a safety one;
 *   - an explicit **"Predicted · not measured"** badge on every warning; and
 *   - the measured M26 path is shown **beside** it, labelled as the shipped, deterministic
 *     one that this experiment does not change, reorder, or suppress.
 *
 * **3. Every number carries the corpus it came from.**
 * The synthetic numbers are fenced inside their own section, under an explicit statement that
 * they come from sessions a generator *drew* — with ramps deliberately made long enough that a
 * 2-second warning is available at all — and that they are **not** evidence of field
 * performance and **not** an acceptance pass. The false-alarm rate against the deep near-miss
 * negatives is shown *in the same breath* as the lead time, because they are the same
 * purchase: a predictor cannot buy early warning without buying those false alarms.
 *
 * **4. The safety language errs heavily toward understatement.**
 * This is a warning about an aircraft falling out of the sky. The copy says, in the UI, that
 * the warning can be wrong in **both** directions, that it cannot be relied on to keep an
 * aircraft in the air, that it does not replace the pilot's judgement, and that it never
 * writes anything to the hardware. There is no "keeps you safe", no percentage that reads like
 * a probability of a crash, and no green checkmark anywhere in this component.
 */
export function PredictiveWarningPanel({ nf }: { nf: Intl.NumberFormat }) {
  const { t, i18n } = useTranslation();
  const log = useSessionStore((s) => s.log);

  const [report, setReport] = React.useState<PredictiveEvalArtifact | null>(null);

  // One decimal for slopes/ms figures that read better rounded. Through `Intl`, never `toFixed`.
  const df = React.useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [i18n.language]
  );
  const cf = React.useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    [i18n.language]
  );

  // Dynamic-imported for the same reason `ModelPrototype` dynamic-imports its artifacts: the
  // report card is checked-in JSON, and folding it into the Settings chunk would put it in the
  // bundle of every user for whom `mlLab` is off and this panel never mounts. Release invariant
  // #2 says a normal user sees zero change from this release.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const mod = await import("../../../data/ml/model-eval-m59.json");
      if (cancelled) return;
      setReport(mod.default as unknown as PredictiveEvalArtifact);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The predictor, run over the session the user actually has open. Pure; no clock, no RNG. */
  const warnings: PredictiveWarning[] | null = React.useMemo(
    () => (log && log.sampleCount > 0 ? predictOverLog(log) : null),
    [log]
  );

  if (!report) {
    return (
      <section
        aria-labelledby="ml-lab-predictive-heading"
        className="space-y-2 rounded-lg border border-border bg-surface-inset p-3"
      >
        <h3
          id="ml-lab-predictive-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("mlLab.predictive.title")}
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-loading">
          {t("mlLab.predictive.loading")}
        </p>
      </section>
    );
  }

  const { acceptance, realCorpus, syntheticCorpus } = report;
  const deep = syntheticCorpus.falseAlarmsByBucket.find((b) => b.bucket === "deep");
  const nearMiss = syntheticCorpus.falseAlarmsByBucket.filter((b) => b.bucket !== "steady");
  const nearMissNegatives = nearMiss.reduce((a, b) => a + b.negatives, 0);
  const nearMissFalseAlarms = nearMiss.reduce((a, b) => a + b.falseAlarms, 0);
  const syntheticLead = syntheticCorpus.report.leadTime;

  return (
    <section
      aria-labelledby="ml-lab-predictive-heading"
      className="space-y-3 rounded-lg border border-border bg-surface-inset p-3"
      data-testid="ml-lab-predictive"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-lab-predictive-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("mlLab.predictive.title")}
        </h3>
        {/* The badge is deliberately neutral, not a status colour. This is not an alarm. */}
        <span
          className="rounded-full border border-dashed border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="ml-lab-predictive-badge"
        >
          {t("mlLab.predictive.badge")}
        </span>
      </div>

      {/* ---- The verdict. It is a failure, and it leads. -------------------------------- */}
      <p
        className="flex items-start gap-2 text-sm font-medium text-foreground"
        data-testid="ml-lab-predictive-verdict"
      >
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-critical" aria-hidden />
        {acceptance.acceptanceMetOnRealCorpus
          ? t("mlLab.predictive.verdictMet")
          : t("mlLab.predictive.verdictFailed")}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-reason">
        {t("mlLab.predictive.verdictReason", {
          zeroLead: nf.format(realCorpus.leadCeiling.threshold.zeroLeadEvents),
          events: nf.format(realCorpus.leadCeiling.eventCount),
          oracleMax: nf.format(acceptance.oracleMaxLeadMs),
          oracleMedian: nf.format(acceptance.oracleMedianLeadMs),
          target: nf.format(acceptance.targetLeadMs),
        })}
      </p>

      {/* ---- The real corpus: the null, with the oracle bound behind it. ---------------- */}
      <div className="space-y-1 rounded-md border border-border bg-card/40 p-2">
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {t("mlLab.predictive.nullTitle")}
        </h4>
        <p className="font-mono text-xs text-status-warning" data-testid="ml-lab-predictive-ceiling">
          {t("mlLab.predictive.nullCeiling", {
            oracleMax: nf.format(acceptance.oracleMaxLeadMs),
            oracleMedian: nf.format(acceptance.oracleMedianLeadMs),
            target: nf.format(acceptance.targetLeadMs),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t("mlLab.predictive.nullCeilingNote")}</p>
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-coverage">
          {t("mlLab.predictive.nullPredictor", {
            predicted: nf.format(acceptance.creditablePredictions),
            events: nf.format(realCorpus.eventCount),
            late: nf.format(acceptance.lateDetections),
            missed: nf.format(acceptance.missedEvents),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t("mlLab.predictive.nullLate")}</p>
      </div>

      {/* ---- The synthetic corpus: fenced, and labelled as drawn. ----------------------- */}
      <div
        className="space-y-1 rounded-md border border-dashed border-border bg-card/40 p-2"
        data-testid="ml-lab-predictive-synthetic"
      >
        <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {t("mlLab.predictive.syntheticTitle")}
        </h4>
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-synthetic-warning">
          {t("mlLab.predictive.syntheticWarning", {
            sessions: nf.format(syntheticCorpus.sessionCount),
            target: nf.format(acceptance.targetLeadMs),
          })}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {t("mlLab.predictive.syntheticLead", {
            median: nf.format(syntheticLead?.medianLeadMs ?? 0),
          })}
        </p>
        {/* The false alarms are shown in the SAME breath as the lead time. They are the price of it. */}
        <p className="font-mono text-xs text-status-warning" data-testid="ml-lab-predictive-synthetic-fp">
          {t("mlLab.predictive.syntheticFalseAlarms", {
            falseAlarms: nf.format(nearMissFalseAlarms),
            negatives: nf.format(nearMissNegatives),
            deepFalseAlarms: nf.format(deep?.falseAlarms ?? 0),
            deepNegatives: nf.format(deep?.negatives ?? 0),
          })}
        </p>
        <p className="text-xs text-muted-foreground">{t("mlLab.predictive.syntheticTension")}</p>
      </div>

      {/* ---- The predictive state, on the session the user has open. -------------------- */}
      <div className="space-y-2 border-t border-border/60 pt-3">
        <h4 className="text-xs font-medium text-foreground">
          {t("mlLab.predictive.session.title")}
        </h4>

        {warnings === null ? (
          <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-session-empty">
            {t("mlLab.predictive.session.empty")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {/* The MEASURED path — the shipped, deterministic one. Unchanged by this experiment. */}
            <div
              className="space-y-1 rounded-md border border-border bg-card/40 p-2"
              data-testid="ml-lab-predictive-measured"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <ShieldAlert className="h-3.5 w-3.5 text-status-good" aria-hidden />
                {t("mlLab.predictive.session.measured")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("mlLab.predictive.session.measuredNote")}
              </p>
            </div>

            {/*
              The PREDICTED state. Distinct from an M26 alert in every dimension that matters:
              a DASHED border (not a solid status-coloured toast), a `TrendingDown` glyph (not a
              Bell), `aria-live="off"` on a `role="region"` (not an assertive `role="alert"`),
              and no red anywhere. It is a report you read, not an alarm that interrupts you —
              because it is a guess, and a guess must not announce itself like a measurement.
            */}
            <div
              role="region"
              aria-live="off"
              aria-label={t("mlLab.predictive.warning.title")}
              className="space-y-1 rounded-md border border-dashed border-status-warning/50 bg-card/40 p-2"
              data-testid="ml-lab-predictive-state"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <TrendingDown className="h-3.5 w-3.5 text-status-warning" aria-hidden />
                {t("mlLab.predictive.session.predicted")}
              </p>

              {warnings.length === 0 ? (
                <p
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="ml-lab-predictive-none"
                >
                  <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("mlLab.predictive.warning.none")}
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("mlLab.predictive.session.count", { count: warnings.length })}
                  </p>
                  <ul className="flex flex-col gap-2">
                    {warnings.map((w) => (
                      <li
                        key={`${w.index}`}
                        className="space-y-1 rounded border border-dashed border-border bg-surface-inset p-2"
                        data-testid="ml-lab-predictive-warning"
                      >
                        <p className="text-xs font-medium text-foreground">
                          {t("mlLab.predictive.warning.title")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {/* The library emits a stable CODE (`w.code`); the UI composes the
                              i18n key from it. `src/lib/ml` holds zero user-facing strings and
                              names no UI namespace — the discipline `evalHarness.ts` states and
                              `DiagnosticFinding.explanation` already follows. */}
                          {t(`mlLab.predictive.warning.${w.code}`, {
                            ttlMs: nf.format(Math.round(w.ttlMs)),
                          })}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {t("mlLab.predictive.warning.confidence", {
                            confidence: cf.format(w.confidence),
                          })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("mlLab.predictive.warning.confidenceNote")}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {t("mlLab.predictive.warning.evidence", {
                            start: nf.format(w.evidence.startIndex),
                            end: nf.format(w.evidence.endIndex),
                            lqFit: df.format(w.features.lqFit),
                            lqSlope: df.format(w.features.lqSlopePctPerSec),
                            rssiFit: df.format(w.features.rssiFit),
                            rssiSlope: df.format(w.features.rssiSlopeDbPerSec),
                          })}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ---- Safety. Understated, and it does not overclaim. ---------------------------- */}
      <div className="space-y-1 rounded-md border border-status-warning/40 bg-card/40 p-2">
        <h4 className="text-xs font-medium text-foreground">
          {t("mlLab.predictive.safetyTitle")}
        </h4>
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-safety">
          {t("mlLab.predictive.safety")}
        </p>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="ml-lab-predictive-prototype">
        {t("mlLab.predictive.prototype")}
      </p>
    </section>
  );
}
