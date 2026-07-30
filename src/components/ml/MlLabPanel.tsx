import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bot, Database, FlaskConical, ShieldCheck, TriangleAlert, XCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  listStoredSessions,
  formatSessionDuration,
  type StoredSessionMeta,
} from "@/lib/sessions-db";
import {
  latestLabelBySession,
  listSessionLabels,
  setSessionLabel,
  type SessionLabelRow,
} from "@/lib/session-labels";
import { ML_LABELS, type MlLabel } from "@/lib/ml/dataset";
import {
  buildReadinessReport,
  countLabels,
  type ReadinessReport,
} from "@/lib/ml/readiness";
import { explainSession, type AnomalyModel, type AnomalyModelOutput } from "@/lib/ml/anomalyModel";
import type { ModelEvalArtifact } from "@/lib/ml/modelEval";
import { PredictiveWarningPanel } from "@/components/ml/PredictiveWarningPanel";
import { evaluateSession, type DiagnosticReport } from "@/lib/diagnostics";
import { useSessionStore } from "@/stores/session";

/** Shared classes for the native `<select>` (mirrors `BaudOverride` / `FindingsList`). */
const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/** The sentinel `<option>` value for a session nobody has labeled yet. */
const UNLABELED = "";

/**
 * The **ML lab** (v2.5 / M56c): label a stored telemetry session, and see exactly
 * how far the labeled corpus is from the D21 bar.
 *
 * Gated behind the OFF-by-default `mlLab` feature flag at the *render boundary* in
 * `SettingsPage` — with the flag off this component is never mounted, so the surface
 * does not exist rather than existing-but-disabled. The free local core never
 * consults the flag and is completely unaffected by this release.
 *
 * ## What it does
 *  - Lists the user's **stored** sessions through the EXISTING `listStoredSessions`
 *    read seam (no second session list is built), and lets each be labeled with one
 *    of the six canonical {@link MlLabel}s. A label is appended as a new revision via
 *    `setSessionLabel` — relabeling never destroys the prior assertion.
 *  - Renders the **data-readiness verdict** (`buildReadinessReport`) right beside the
 *    labeling controls, because seeing the distance to the bar IS the point of the
 *    tool. The verdict today is `not-enough-data`: 36 of the 1 500 labeled sessions
 *    D21 requires, and the 36 are OmniLink's bundled fixtures — not the user's
 *    recordings. The two are counted, and displayed, separately.
 *
 * ## What it deliberately does NOT do
 *  - **No progress bar.** A 2.4 %-full progress meter reads as "getting there!"; the
 *    honest rendering of this number is the number.
 *  - **No free-text note field.** A note box is how a pilot's name or a flying site
 *    gets into a dataset. The label column has a SQL `CHECK` pinning it to the six
 *    canonical values, so it *cannot* store a sentence.
 *  - **No upload.** There is no network call in this surface or in anything it calls.
 */
export function MlLabPanel() {
  const { t, i18n } = useTranslation();

  const [status, setStatus] = React.useState<"loading" | "ready">("loading");
  const [sessions, setSessions] = React.useState<StoredSessionMeta[]>([]);
  const [labels, setLabels] = React.useState<SessionLabelRow[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Localized integer formatting ("1,500" / "1.500") — numbers go through Intl,
  // never through a hand-written thousands separator.
  const nf = React.useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  // Both reads are best-effort + `isTauri()`-guarded internally, so this resolves
  // to empty lists (never throws) on a browser/dev host.
  const load = React.useCallback(async () => {
    const [storedSessions, storedLabels] = await Promise.all([
      listStoredSessions(),
      listSessionLabels(),
    ]);
    setSessions(storedSessions);
    setLabels(storedLabels);
    setStatus("ready");
  }, []);

  // Initial load, with a cancel guard for unmount / StrictMode double-invoke.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedSessions, storedLabels] = await Promise.all([
        listStoredSessions(),
        listSessionLabels(),
      ]);
      if (cancelled) return;
      setSessions(storedSessions);
      setLabels(storedLabels);
      setStatus("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The CURRENT label of each session = its highest revision (the table is
  // append-only). Scoped to sessions that still exist, so a stale label can never
  // inflate the readiness denominator.
  const currentLabels = React.useMemo(() => {
    const latest = latestLabelBySession(labels);
    const live = new Map<string, MlLabel>();
    for (const session of sessions) {
      const row = latest.get(session.sessionId);
      if (row) live.set(session.sessionId, row.label);
    }
    return live;
  }, [labels, sessions]);

  const report: ReadinessReport = React.useMemo(
    () => buildReadinessReport(countLabels([...currentLabels.values()])),
    [currentLabels]
  );

  const handleLabel = React.useCallback(
    async (sessionId: string, value: string) => {
      if (value === UNLABELED) return;
      setBusyId(sessionId);
      try {
        // `now` is injected (never read inside the seam) and is used only to order
        // the revision history — it never reaches a feature vector or an eval path.
        await setSessionLabel(sessionId, value as MlLabel, Date.now());
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  return (
    <Card data-testid="ml-lab-panel">
      <CardHeader>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" aria-hidden />
          <CardTitle>{t("mlLab.title")}</CardTitle>
        </div>
        <CardDescription>{t("mlLab.description")}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <ReadinessVerdict report={report} nf={nf} />

        <section aria-labelledby="ml-lab-sessions-heading" className="space-y-2">
          <h3
            id="ml-lab-sessions-heading"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t("mlLab.sessions.title")}
          </h3>

          {status === "loading" ? (
            <p className="text-xs text-muted-foreground" data-testid="ml-lab-loading">
              {t("mlLab.sessions.loading")}
            </p>
          ) : sessions.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card/40 px-6 py-8 text-center"
              data-testid="ml-lab-sessions-empty"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Database className="h-6 w-6 text-muted-foreground" aria-hidden />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {t("mlLab.sessions.empty")}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {t("mlLab.sessions.emptyHint")}
                </p>
              </div>
            </div>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="ml-lab-session-list">
              {sessions.map((session) => {
                const recordedAt = new Date(session.startedAt).toLocaleString(
                  i18n.language
                );
                const duration = formatSessionDuration(
                  session.startedAt,
                  session.endedAt
                );
                const current = currentLabels.get(session.sessionId);
                const selectId = `ml-label-${session.sessionId}`;
                return (
                  <li
                    key={session.sessionId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{recordedAt}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("mlLab.sessions.meta", {
                          frames: nf.format(session.frameCount),
                          duration: duration ?? t("mlLab.sessions.unknownDuration"),
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={selectId}
                        className="whitespace-nowrap text-xs text-muted-foreground"
                      >
                        {t("mlLab.label.legend")}
                      </label>
                      <select
                        id={selectId}
                        data-testid={`ml-label-select-${session.sessionId}`}
                        className={SELECT_CLASS}
                        value={current ?? UNLABELED}
                        disabled={busyId === session.sessionId}
                        aria-label={t("mlLab.label.aria", { session: recordedAt })}
                        onChange={(e) =>
                          void handleLabel(session.sessionId, e.target.value)
                        }
                      >
                        <option value={UNLABELED}>{t("mlLab.label.unlabeled")}</option>
                        {ML_LABELS.map((label) => (
                          <option key={label} value={label}>
                            {t(`mlLab.label.${label}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <ModelPrototype nf={nf} />

        {/* v2.5 / M59 — the predictive failsafe warning EXPERIMENT. Rides the SAME `mlLab`
            flag (no second flag was added), so it inherits the render-boundary gate above:
            with the flag off, `MlLabPanel` is never mounted and this surface does not exist.
            It is deliberately placed AFTER the M58 model prototype, because M59's headline is
            a null result and a null result belongs at the end of the story, not the top of the
            panel. */}
        <PredictiveWarningPanel nf={nf} />

        <p
          className="flex items-start gap-2 text-xs text-muted-foreground"
          data-testid="ml-lab-privacy"
        >
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("mlLab.privacyNote")}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// M58 — the model prototype
// ---------------------------------------------------------------------------

/** The two checked-in M58 artifacts, loaded lazily. */
interface ModelArtifacts {
  model: AnomalyModel;
  report: ModelEvalArtifact;
}

/**
 * The M58 anomaly-model prototype, surfaced honestly.
 *
 * ## Three rules this section is built to obey
 *  1. **It states the gate verdict, and the verdict is a failure.** `clearsM56Gate()`
 *     returned `false`, and the headline says so — with the structural reason (the v2.0
 *     baseline's false-positive rate on the same held-out set is 0.000, and D25's ceiling
 *     is a *strict* `<`; nothing is strictly below zero). A lab user must not be able to
 *     leave this panel thinking the prototype is a validated feature, and the copy does not
 *     give them the room to.
 *  2. **It shows the model beside the rules, never instead of them.** The loaded session is
 *     scanned by the deterministic v2.0 engine — the production path, unchanged — and the
 *     model's opinion is rendered *next to* that scan, badged **model-assisted / advisory**.
 *     Nothing here reorders, suppresses, or replaces a v2.0 finding.
 *  3. **Every number carries its n.** The held-out split has three healthy sessions, so its
 *     false-positive rate quantises in 33.3-point steps. That is said next to the number, in
 *     the UI, not in a footnote.
 *
 * ## Why the artifacts are `import()`ed, not imported
 * The trained forest (~37 KB) and its report card (~74 KB) are checked-in JSON. A static
 * import would fold ~110 KB into the Settings chunk for **every** user — including the
 * overwhelming majority for whom `mlLab` is off and this component never mounts. Release
 * invariant #2 says a normal user sees zero change from this release, and 110 KB of model
 * weights in their bundle is not zero. So they are dynamic-imported here, which puts them in
 * a chunk that is fetched only when the lab actually renders.
 */
function ModelPrototype({ nf }: { nf: Intl.NumberFormat }) {
  const { t, i18n } = useTranslation();
  const log = useSessionStore((s) => s.log);

  const [artifacts, setArtifacts] = React.useState<ModelArtifacts | null>(null);

  // Three decimals: precision/recall/FP live in [0,1] and the differences that matter here
  // are in the second decimal. Through `Intl`, never a hand-rolled `toFixed`.
  const rf = React.useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
    [i18n.language]
  );
  const pf = React.useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [i18n.language]
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [model, report] = await Promise.all([
        import("../../../data/ml/model-m58.json"),
        import("../../../data/ml/model-eval-m58.json"),
      ]);
      if (cancelled) return;
      setArtifacts({
        model: model.default as unknown as AnomalyModel,
        report: report.default as unknown as ModelEvalArtifact,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The loaded session, scanned BOTH ways. The deterministic v2.0 report is computed first
   * and then handed to the model — which is both the honest ordering (the rules are the
   * production path; the model rides along) and the one the perf budget is scoped to.
   */
  const analysis: { report: DiagnosticReport; output: AnomalyModelOutput } | null =
    React.useMemo(() => {
      if (!artifacts || !log || log.sampleCount === 0) return null;
      const report = evaluateSession(log);
      return { report, output: explainSession(artifacts.model, log, report) };
    }, [artifacts, log]);

  if (!artifacts) {
    return (
      <section
        aria-labelledby="ml-lab-model-heading"
        className="space-y-2 rounded-lg border border-border bg-surface-inset p-3"
      >
        <h3
          id="ml-lab-model-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("mlLab.model.title")}
        </h3>
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-loading">
          {t("mlLab.model.loading")}
        </p>
      </section>
    );
  }

  const { report } = artifacts;
  const held = report.heldOutTestSplit;
  const whole = report.wholeCorpus;
  const rows = [
    {
      key: "test-rules",
      set: t("mlLab.model.scores.setTest"),
      detector: t("mlLab.model.scores.detectorRules"),
      precision: 1,
      recall: held.gateBaseline.baselineRecall,
      fp: held.gateBaseline.baselineFpRate,
      sessions: held.sessionCount,
      negatives: held.negativeSessions,
      isModel: false,
    },
    {
      key: "test-model",
      set: t("mlLab.model.scores.setTest"),
      detector: t("mlLab.model.scores.detectorModel"),
      precision: held.model.perSession.precision.value,
      recall: held.model.perSession.recall.value,
      fp: held.model.perSession.falsePositiveRate.value,
      sessions: held.sessionCount,
      negatives: held.negativeSessions,
      isModel: true,
    },
    {
      key: "corpus-rules",
      set: t("mlLab.model.scores.setCorpus"),
      detector: t("mlLab.model.scores.detectorRules"),
      precision: 1,
      recall: whole.gateBaseline.baselineRecall,
      fp: whole.gateBaseline.baselineFpRate,
      sessions: whole.sessionCount,
      negatives: whole.negativeSessions,
      isModel: false,
    },
    {
      key: "corpus-model",
      set: t("mlLab.model.scores.setCorpus"),
      detector: t("mlLab.model.scores.detectorModel"),
      precision: whole.model.perSession.precision.value,
      recall: whole.model.perSession.recall.value,
      fp: whole.model.perSession.falsePositiveRate.value,
      sessions: whole.sessionCount,
      negatives: whole.negativeSessions,
      isModel: true,
    },
  ];

  return (
    <section
      aria-labelledby="ml-lab-model-heading"
      className="space-y-3 rounded-lg border border-border bg-surface-inset p-3"
      data-testid="ml-lab-model"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-lab-model-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("mlLab.model.title")}
        </h3>
        <span
          className="rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-warning"
          data-testid="ml-lab-model-badge"
        >
          {t("mlLab.model.badge")}
        </span>
      </div>

      {/* The gate verdict. It is a failure, and it leads. */}
      <p
        className="flex items-start gap-2 text-sm font-medium text-foreground"
        data-testid="ml-lab-model-verdict"
      >
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-critical" aria-hidden />
        {held.passes ? t("mlLab.model.verdictCleared") : t("mlLab.model.verdictFailed")}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-reason">
        {t("mlLab.model.verdictReason", {
          baselineFp: rf.format(held.gateBaseline.baselineFpRate),
        })}
      </p>

      {/* Model vs rules, with the n behind every number. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs" data-testid="ml-lab-model-scores">
          <caption className="sr-only">{t("mlLab.model.scores.caption")}</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("mlLab.model.scores.colSet")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("mlLab.model.scores.colDetector")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.model.scores.colPrecision")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.model.scores.colRecall")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.model.scores.colFp")}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t("mlLab.model.scores.colN")}
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border/60">
                <th scope="row" className="py-1 pr-3 font-sans font-normal text-muted-foreground">
                  {row.set}
                </th>
                <td
                  className={`py-1 pr-3 font-sans ${row.isModel ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {row.detector}
                </td>
                <td className="py-1 pr-3 text-right">{rf.format(row.precision)}</td>
                <td className="py-1 pr-3 text-right">{rf.format(row.recall)}</td>
                <td
                  className={`py-1 pr-3 text-right ${row.isModel && row.fp > 0 ? "text-status-critical" : ""}`}
                >
                  {rf.format(row.fp)}
                </td>
                <td className="py-1 text-right text-muted-foreground">
                  {t("mlLab.model.scores.nCell", {
                    sessions: nf.format(row.sessions),
                    negatives: nf.format(row.negatives),
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-quantum">
        {t("mlLab.model.scores.quantum", {
          negatives: nf.format(held.negativeSessions),
          quantum: pf.format(held.fpRateQuantumPp),
        })}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-databar">
        {t("mlLab.model.dataBar", {
          rows: nf.format(report.honesty.trainingRows),
          required: nf.format(report.honesty.d21RequiredSessionsPerClass),
        })}
      </p>

      {/* The model beside the rules, on the session the user actually has open. */}
      <div className="space-y-2 border-t border-border/60 pt-3">
        <h4 className="text-xs font-medium text-foreground">
          {t("mlLab.model.session.title")}
        </h4>

        {!analysis ? (
          <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-session-empty">
            {t("mlLab.model.session.empty")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {/* The deterministic v2.0 scan — the production path, unchanged. */}
            <div
              className="space-y-1 rounded-md border border-border bg-card/40 p-2"
              data-testid="ml-lab-session-deterministic"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-status-good" aria-hidden />
                {t("mlLab.model.session.deterministic")}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {t("mlLab.model.session.deterministicSummary", {
                  health: nf.format(Math.round(analysis.report.healthScore)),
                  findings: nf.format(analysis.report.findings.length),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("mlLab.model.session.deterministicNote")}
              </p>
            </div>

            {/* The model's opinion — advisory, and badged as such. */}
            <div
              className="space-y-1 rounded-md border border-status-warning/40 bg-card/40 p-2"
              data-testid="ml-lab-session-model"
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-status-warning" aria-hidden />
                {t("mlLab.model.session.model")}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {t("mlLab.model.session.modelSummary", {
                  score: rf.format(analysis.output.score),
                  threshold: rf.format(analysis.output.threshold),
                  verdict: analysis.output.flagged
                    ? t("mlLab.model.session.flagged")
                    : t("mlLab.model.session.notFlagged"),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("mlLab.model.session.topFeatures", {
                  features: analysis.output.topFeatures.map((f) => f.feature).join(", "),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("mlLab.model.session.evidence", {
                  start: nf.format(analysis.output.evidenceWindow.startIndex),
                  end: nf.format(analysis.output.evidenceWindow.endIndex),
                })}
              </p>
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground" data-testid="ml-lab-model-advisory">
          {t("mlLab.model.advisoryNote")}
        </p>
      </div>
    </section>
  );
}

/**
 * The data-readiness verdict, stated plainly.
 *
 * The copy does not hedge and is not allowed to: the bar is unmet by a factor of
 * ~40, so the headline is the shortfall, the sub-line is what that means for every
 * metric this release can produce (indicative, never a gate pass), and the table
 * keeps OmniLink's 36 bundled fixtures visually and numerically distinct from the
 * user's own labels.
 */
function ReadinessVerdict({
  report,
  nf,
}: {
  report: ReadinessReport;
  nf: Intl.NumberFormat;
}) {
  const { t } = useTranslation();

  return (
    <section
      aria-labelledby="ml-lab-readiness-heading"
      className="space-y-3 rounded-lg border border-border bg-surface-inset p-3"
      data-testid="ml-lab-readiness"
    >
      <h3
        id="ml-lab-readiness-heading"
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t("mlLab.readiness.title")}
      </h3>

      <p
        className="flex items-start gap-2 text-sm font-medium text-foreground"
        data-testid="ml-lab-verdict"
      >
        <TriangleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-status-warning"
          aria-hidden
        />
        {report.barMet
          ? t("mlLab.readiness.verdictBarMet", {
              required: nf.format(report.requiredTotal),
            })
          : t("mlLab.readiness.verdictNotEnoughData", {
              have: nf.format(report.labeledSessionTotal),
              required: nf.format(report.requiredTotal),
            })}
      </p>

      {report.indicativeOnly && (
        <p className="text-xs text-muted-foreground" data-testid="ml-lab-meaning">
          {t("mlLab.readiness.meaning", {
            perClass: nf.format(report.requiredPerClass),
            classes: nf.format(report.perClass.length),
          })}
        </p>
      )}

      <p className="text-xs text-muted-foreground" data-testid="ml-lab-provenance">
        {t("mlLab.readiness.provenance", {
          fixtures: nf.format(report.fixtureSessionTotal),
          user: nf.format(report.userLabeledTrainableTotal),
        })}
        {report.userLabeledUnknown > 0
          ? ` ${t("mlLab.readiness.unknownNote", {
              unknown: nf.format(report.userLabeledUnknown),
            })}`
          : ""}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t("mlLab.readiness.tableCaption")}</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("mlLab.readiness.colClass")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.readiness.colFixtures")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.readiness.colYours")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t("mlLab.readiness.colRequired")}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t("mlLab.readiness.colShortfall")}
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {report.perClass.map((row) => (
              <tr key={row.label} className="border-t border-border/60">
                <th
                  scope="row"
                  className="py-1 pr-3 font-sans font-normal text-foreground"
                >
                  {t(`mlLab.label.${row.label}`)}
                </th>
                <td className="py-1 pr-3 text-right text-muted-foreground">
                  {nf.format(row.fixtureSessions)}
                </td>
                <td className="py-1 pr-3 text-right text-foreground">
                  {nf.format(row.userLabeledSessions)}
                </td>
                <td className="py-1 pr-3 text-right text-muted-foreground">
                  {nf.format(row.required)}
                </td>
                <td className="py-1 text-right text-status-warning">
                  {nf.format(row.shortfall)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
