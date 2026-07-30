import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ParsedLog } from "@/lib/blackbox";
import { RotateCcw, ScrollText, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AnomalyPanel,
  ImportDropzone,
  LogPathPanel,
  SessionPicker,
  TimelineCharts,
} from "@/components/logs";
import { TelemetryDashboard } from "@/components/telemetry";
import { SessionTransport } from "@/components/session/SessionTransport";
import {
  DiagnosticSettings,
  FindingsList,
  SessionPatternCards,
  SignalHealthPanel,
} from "@/components/diagnostics";
import { useSessionStore } from "@/stores/session";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { useDiagnosticsHistoryStore } from "@/stores/diagnosticsHistory";
import { useAlertsStore } from "@/stores/alerts";
import { summarizeLogRangeToPromptString } from "@/lib/log-range-summary";
import { recordDiagnosticFindings } from "@/lib/notificationFeed";
import { summarizeSessionForHistory } from "@/lib/diagnostics";
import { parsedLogFromTelemetryRows } from "@/lib/omnilog";
import type { TelemetrySessionCsvRow } from "@/lib/telemetry-session-csv";
import type { StoredSessionMeta } from "@/lib/sessions-db";
import { useAssistantStore } from "@/stores/assistant";

/**
 * Unified Session Analysis page (v1.7.0) — the merge of the former SimulatorPage
 * (time-driven replay through the live dashboard) and LogsPage (position-driven
 * forensic scrub over charts + map + anomalies).
 *
 * One session is loaded once through a single import on-ramp ({@link ImportDropzone}
 * for CSV/`.bbl` + {@link SessionPicker} for prior SQLite sessions), parsed to one
 * {@link import("@/lib/blackbox").ParsedLog}. A single position index
 * ({@link useSessionStore}.positionIndex) can be **scrubbed** (forensic) or
 * **played** (replay) via {@link SessionTransport}; both modes drive the same
 * index, so the dashboard gauges, timeline charts, flight-path map, and anomaly
 * list all follow it together. The persistent SIMULATED badge + the
 * "analyze selected range" AI action are therefore available in both modes.
 */
export function SessionAnalysisPage() {
  const { t } = useTranslation();
  const log = useSessionStore((s) => s.log);
  const loadLog = useSessionStore((s) => s.loadLog);
  const reset = useSessionStore((s) => s.reset);
  const selectionStart = useSessionStore((s) => s.selectionStart);
  const selectionEnd = useSessionStore((s) => s.selectionEnd);

  // The module-level replay timer outlives this page, so stop it on unmount so
  // simulated frames cannot keep flowing after navigating away. The loaded
  // session + its fed telemetry window are intentionally KEPT (see `suspend`) so
  // the simulated replay survives a client-side route change to the live
  // /telemetry dashboard; the Stop / "Load another" controls are how the user
  // fully clears it and returns the dashboard to a live link.
  useEffect(() => () => useSessionStore.getState().suspend(), []);

  // M37: a SINGLE effect analyzes the loaded session (pure engine) and keeps it
  // in sync with the operator's chosen sensitivity — keyed on `[log,
  // diagnosticConfig]` so a newly-loaded session OR a settings tweak re-runs the
  // pure `analyzeSession` (refreshing the findings list + chart markers). The
  // cleanup drops the report on unmount and on `reset` (which sets `log` to null).
  //
  // Notifications are enqueued ONLY here, and EXACTLY ONCE per loaded session: a
  // `useRef` tracks the log we last notified for, so a config-only re-analysis
  // never re-enqueues the same findings. The live SignalHealthPanel never
  // enqueues (that's the M26 path's job).
  // M40: the device origin of the loaded session (from a picked SQLite session's
  // metadata, or reset to "unknown" for an imported CSV that carries no device),
  // plus the log we last recorded to diagnostic history — a reference-identity
  // guard so a config-only re-analysis never double-records the same session.
  const originRef = useRef<{ deviceKey: string | null; deviceLabel: string | null }>({
    deviceKey: null,
    deviceLabel: null,
  });
  const recordedLogRef = useRef<ParsedLog | null>(null);

  const diagnosticConfig = useDiagnosticsStore((s) => s.config);
  const notifiedLogRef = useRef<ParsedLog | null>(null);
  useEffect(() => {
    if (!log) return;
    useDiagnosticsStore.getState().analyzeSession(log);
    const report = useDiagnosticsStore.getState().sessionReport;
    if (report && notifiedLogRef.current !== log) {
      notifiedLogRef.current = log;
      recordDiagnosticFindings(
        report.findings,
        log,
        useAlertsStore.getState().muted
      );
    }
    // M40: accumulate this session's diagnostic summary into local history ONCE
    // per loaded log (same reference-identity guard as the notification block), so
    // the /trends surface can aggregate the user's OWN real sessions. Deduped
    // downstream by content signature, so re-importing the same content updates in
    // place rather than piling up.
    const patternReport = useDiagnosticsStore.getState().sessionPatternReport;
    if (report && patternReport && recordedLogRef.current !== log) {
      recordedLogRef.current = log;
      const summary = summarizeSessionForHistory(report, patternReport, log);
      useDiagnosticsHistoryStore.getState().recordSession({
        ...summary,
        recordedAt: Date.now(),
        deviceKey: originRef.current.deviceKey,
        deviceLabel: originRef.current.deviceLabel,
      });
    }
    return () => useDiagnosticsStore.getState().clearSessionReport();
  }, [log, diagnosticConfig]);

  // Send-to-AI: reduce the selected (or whole) window to a GPS-free aggregate
  // summary string and hand ONLY that string to the assistant — never raw rows
  // or GPS. Defaults to the full session when no explicit range is marked.
  const handleAnalyze = useCallback(async () => {
    if (!log) return;
    const start = selectionStart ?? 0;
    const end = selectionEnd ?? log.sampleCount - 1;
    const summary = summarizeLogRangeToPromptString(log, start, end);
    await useAssistantStore.getState().sendMessage(summary);
    useAssistantStore.getState().open();
  }, [log, selectionStart, selectionEnd]);

  // A SQLite-stored session loads through the exact same {@link ParsedLog} model
  // the CSV/`.bbl` import path builds, so the analysis surface is source-agnostic
  // — a clicked session is indistinguishable from an import. Its device metadata
  // (targetName/firmware) is captured first (M40) so this session's diagnostic
  // history is attributed to its device for per-device trend grouping.
  const handleSession = useCallback(
    (rows: TelemetrySessionCsvRow[], meta: StoredSessionMeta) => {
      // Fold firmware into the label when present so same-target/different-firmware
      // devices render as distinct cards ("target · firmware"), not indistinguishable.
      const deviceLabel = meta.targetName
        ? meta.firmware
          ? `${meta.targetName} · ${meta.firmware}`
          : meta.targetName
        : null;
      originRef.current = {
        deviceKey:
          meta.targetName && meta.firmware
            ? `${meta.targetName}|${meta.firmware}`
            : meta.targetName ?? null,
        deviceLabel,
      };
      loadLog(parsedLogFromTelemetryRows(rows));
    },
    [loadLog]
  );

  // An imported CSV/`.bbl` carries no device metadata, so it records under the
  // "unknown device" bucket (M40): reset the origin BEFORE loading so a prior
  // picked-session origin never leaks onto a subsequent import.
  const handleImport = useCallback(
    (imported: ParsedLog) => {
      originRef.current = { deviceKey: null, deviceLabel: null };
      loadLog(imported);
    },
    [loadLog]
  );

  return (
    <div className="flex flex-col gap-4" data-testid="session-analysis-page">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-foreground">
            {t("sessionAnalysis.title")}
          </h1>
          {!log && (
            <p className="text-sm text-muted-foreground">
              {t("sessionAnalysis.description")}
            </p>
          )}
        </div>
        {log && (
          <div className="flex items-center gap-2">
            <Button onClick={() => void handleAnalyze()} size="sm">
              <Sparkles aria-hidden />
              {t("logs.analyze")}
            </Button>
            <Button variant="outline" size="sm" onClick={reset}>
              <RotateCcw aria-hidden />
              {t("logs.loadAnother")}
            </Button>
          </div>
        )}
      </div>

      {!log ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("logs.import.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ImportDropzone onLogLoaded={handleImport} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("logs.session.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <SessionPicker onSession={handleSession} />
              </CardContent>
            </Card>
          </div>
          <EmptyState
            icon={ScrollText}
            title={t("sessionAnalysis.empty.title")}
            description={t("sessionAnalysis.empty.description")}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <SessionTransport log={log} />

          {/* M37 signal-health headline: the overall score gauge + per-window
              trend + the transparent factor breakdown at the scrub cursor, with a
              settings trigger opening the diagnostics configuration sheet. */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle>{t("diagnostics.panel.title")}</CardTitle>
              <DiagnosticSettings />
            </CardHeader>
            <CardContent>
              <SignalHealthPanel mode="session" log={log} />
            </CardContent>
          </Card>

          {/* M38 post-flight patterns: the recurring/correlated stories over the
              whole session (most likely issue / evidence / what to check first),
              sitting near the top so the summary reads before the raw surfaces. */}
          <Card>
            <CardHeader>
              <CardTitle>{t("diagnostics.patterns.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <SessionPatternCards log={log} />
            </CardContent>
          </Card>

          {/* Replay surface: the shared live dashboard, fed from the single
              position index. Renders its own persistent SIMULATED badge while a
              session is loaded. Its rolling-window flight map is suppressed here
              (showFlightPath={false}) because the richer full-track map with
              anomaly markers lives in LogPathPanel below. */}
          <div data-testid="simulator-dashboard">
            <TelemetryDashboard showFlightPath={false} />
          </div>

          {/* Forensic surface: synchronized timeline charts (with anomaly
              markers) + the full flight-path map, both reading the same index. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("logs.charts.title")}</CardTitle>
              </CardHeader>
              <CardContent className="max-h-[36rem] overflow-y-auto">
                <TimelineCharts log={log} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("logs.path.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <LogPathPanel log={log} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("anomaly.panel.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <AnomalyPanel log={log} />
            </CardContent>
          </Card>

          {/* M37 diagnostic findings: rule-based link-health problems with
              evidence windows, click-to-scrub, and a copy-summary action. */}
          <Card>
            <CardHeader>
              <CardTitle>{t("diagnostics.findings.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FindingsList log={log} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
