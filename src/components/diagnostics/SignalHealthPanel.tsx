import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticSeverity } from "@/lib/diagnostics";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import {
  linkQualityHealth,
  rssiHealth,
  snrHealth,
  useTelemetryStore,
  type TelemetryHealth,
} from "@/stores/telemetry";
import { useSessionStore } from "@/stores/session";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/telemetry/Sparkline";
import { SignalHealthGauge } from "./SignalHealthGauge";

/** Health level → foreground text token for a color-coded readout. */
const HEALTH_TEXT: Record<TelemetryHealth, string> = {
  // M41: `-strong` is the per-theme contrast-safe good — the base green is only
  // ~2.67:1 as a small factor-readout value on the near-white light card (WCAG AA
  // fail); `-strong` darkens it on light (~5.8:1) and aliases the base on dark/
  // carbon (already ~6.4–6.6:1). Warning already clears AA on every theme.
  good: "text-status-good-strong",
  warning: "text-status-warning",
  // M41: `-strong` is the per-theme contrast-safe critical — the base
  // `text-status-critical` was only ~4.4:1 as a small label on the dark card
  // (below WCAG AA); `-strong` clears it and matches the severity badges.
  critical: "text-status-critical-strong",
};

/** Severity → status badge variant (info→good, warning→warning, critical→critical). */
const SEVERITY_VARIANT: Record<DiagnosticSeverity, "good" | "warning" | "critical"> = {
  info: "good",
  warning: "warning",
  critical: "critical",
};

/** Most recent live findings to surface in the strip (newest-first). */
const LIVE_FINDINGS_SHOWN = 5;

/** Score band → sparkline color token (mirrors the gauge bands). */
function bandColor(score: number): string {
  if (score < 40) return "var(--color-status-critical)";
  if (score < 75) return "var(--color-status-warning)";
  return "var(--color-status-good)";
}

/**
 * TX-power headroom proxy — running pinned at the top step leaves no margin to
 * push, mirroring the health-score's `txHeadroom` term. Not a defect on its own,
 * so it only ever warns.
 */
function txPowerHealth(mw: number): TelemetryHealth {
  return mw >= 500 ? "warning" : "good";
}

/**
 * RF-mode robustness proxy — the fastest packet rate trades range/robustness for
 * latency (lower rate ⇒ more energy/bit), mirroring the score's `rfMode` term.
 */
function packetRateHealth(hz: number): TelemetryHealth {
  return hz >= 500 ? "warning" : "good";
}

/** Candidate channel keys (priority order) for deriving a session frame. */
const CHANNEL_KEYS = {
  rssi1: ["rssi1", "rssi", "RSSI"],
  rssi2: ["rssi2"],
  linkQuality: ["link_quality", "lq", "linkQuality"],
  snr: ["snr", "SNR"],
  txPower: ["tx_power", "txPower"],
  packetRate: ["packet_rate", "packetRate"],
} as const;

/** A real finite number, or `null` for a gap. */
function finite(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Best (least-negative) of two antenna RSSIs, or `null` when neither is finite. */
function bestRssi(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Read a channel value at `index`, resolving the first matching candidate key. */
function valueAt(
  log: ParsedLog,
  candidates: readonly string[],
  index: number
): number | null {
  for (const cand of candidates) {
    const want = cand.toLowerCase();
    const ch = log.channels.find((c) => c.key.toLowerCase() === want);
    if (ch) return finite(ch.values[index]);
  }
  return null;
}

/** The five measured factors behind the score, in display order. */
interface Factor {
  key: "lq" | "rssi" | "snr" | "packetRate" | "txPower";
  value: number | null;
  unit: string;
  health: TelemetryHealth | undefined;
  /** Formatted numeric text (sans unit). */
  text: string;
}

interface FrameValues {
  lq: number | null;
  rssi: number | null;
  snr: number | null;
  packetRate: number | null;
  txPower: number | null;
}

/** Build the factor rows from a frame's values (null ⇒ no-data dash). */
function buildFactors(v: FrameValues | null): Factor[] {
  const lq = v?.lq ?? null;
  const rssi = v?.rssi ?? null;
  const snr = v?.snr ?? null;
  const packetRate = v?.packetRate ?? null;
  const txPower = v?.txPower ?? null;
  return [
    {
      key: "lq",
      value: lq,
      unit: "%",
      health: lq === null ? undefined : linkQualityHealth(lq),
      text: lq === null ? "—" : lq.toFixed(0),
    },
    {
      key: "rssi",
      value: rssi,
      unit: "dBm",
      health: rssi === null ? undefined : rssiHealth(rssi),
      text: rssi === null ? "—" : rssi.toFixed(0),
    },
    {
      key: "snr",
      value: snr,
      unit: "dB",
      health: snr === null ? undefined : snrHealth(snr),
      text: snr === null ? "—" : snr.toFixed(1),
    },
    {
      key: "packetRate",
      value: packetRate,
      unit: "Hz",
      health: packetRate === null ? undefined : packetRateHealth(packetRate),
      text: packetRate === null ? "—" : packetRate.toFixed(0),
    },
    {
      key: "txPower",
      value: txPower,
      unit: "mW",
      health: txPower === null ? undefined : txPowerHealth(txPower),
      text: txPower === null ? "—" : txPower.toFixed(0),
    },
  ];
}

/** The worst (most severe) factor with data, or `null` when all are nominal. */
function worstFactor(factors: Factor[]): Factor | null {
  const crit = factors.find((f) => f.health === "critical");
  if (crit) return crit;
  const warn = factors.find((f) => f.health === "warning");
  if (warn) return warn;
  return null;
}

interface SignalHealthPanelProps {
  /** Presentation: full live widget, full session report, or a mini live tile. */
  mode: "live" | "session" | "compact";
  /** Loaded session (required for `mode="session"`). */
  log?: ParsedLog;
}

/**
 * Signal-health headline widget (M37) with three presentations.
 *
 * - **live / compact** drive the pure live evaluator: a frame-keyed effect feeds
 *   `useTelemetryStore().latest` into `evaluateLiveFrame` and the gauge reads
 *   `liveHealthScore`. The evaluator is reset on unmount. Notifications are
 *   intentionally NOT enqueued here — the M26 live-alert path already owns that.
 *   The full `live` widget also surfaces the rolling `liveFindings` (newest-first,
 *   capped) as a read-only severity-badged strip below the breakdown.
 * - **session** reads the analyzed `sessionReport` (the page owns `analyzeSession`)
 *   and renders a per-window health sparkline; the factor breakdown is read from
 *   the log frame at the shared scrub cursor (`positionIndex`).
 *
 * The factor breakdown is the score's transparent explanation: LQ / RSSI / SNR /
 * packet-rate / TX-power, each colour-coded by the SAME classifiers the live
 * dashboard uses — no thresholds are re-derived here.
 *
 * Store fields are read with SEPARATE selectors; combining them into one object
 * selector would return a fresh snapshot each render and spin `useSyncExternalStore`.
 */
export function SignalHealthPanel({ mode, log }: SignalHealthPanelProps) {
  const { t } = useTranslation();

  // Separate selectors only (see JSDoc).
  const liveHealthScore = useDiagnosticsStore((s) => s.liveHealthScore);
  const liveFindings = useDiagnosticsStore((s) => s.liveFindings);
  const sessionReport = useDiagnosticsStore((s) => s.sessionReport);
  const latest = useTelemetryStore((s) => s.latest);
  const positionIndex = useSessionStore((s) => s.positionIndex);

  const latestT = latest?.t;

  // Live/compact: feed each new telemetry frame into the pure evaluator. Keyed on
  // the frame timestamp so it fires exactly once per frame, not every render.
  useEffect(() => {
    if (mode === "session") return;
    const frame = useTelemetryStore.getState().latest;
    if (!frame) return;
    useDiagnosticsStore.getState().evaluateLiveFrame(frame);
  }, [mode, latestT]);

  // Reset the rolling live evaluator when the live widget unmounts/disconnects.
  useEffect(() => {
    if (mode === "session") return;
    return () => useDiagnosticsStore.getState().resetLive();
  }, [mode]);

  const isSession = mode === "session";
  const score = isSession ? (sessionReport?.healthScore ?? 100) : liveHealthScore;

  // Factor values: from the log frame at the cursor (session) or live telemetry.
  const values = useMemo<FrameValues | null>(() => {
    if (isSession) {
      if (!log || log.sampleCount === 0) return null;
      const i = Math.max(0, Math.min(log.sampleCount - 1, positionIndex));
      return {
        lq: valueAt(log, CHANNEL_KEYS.linkQuality, i),
        rssi: bestRssi(
          valueAt(log, CHANNEL_KEYS.rssi1, i),
          valueAt(log, CHANNEL_KEYS.rssi2, i)
        ),
        snr: valueAt(log, CHANNEL_KEYS.snr, i),
        packetRate: valueAt(log, CHANNEL_KEYS.packetRate, i),
        txPower: valueAt(log, CHANNEL_KEYS.txPower, i),
      };
    }
    if (!latest) return null;
    return {
      lq: finite(latest.linkQuality),
      rssi: bestRssi(finite(latest.rssi1), finite(latest.rssi2)),
      snr: finite(latest.snr),
      packetRate: finite(latest.packetRate),
      txPower: finite(latest.txPower),
    };
  }, [isSession, log, positionIndex, latest]);

  const factors = useMemo(() => buildFactors(values), [values]);
  const perWindow = sessionReport?.sessionSummary.perWindowHealth ?? [];

  // --- Compact: mini live tile ---------------------------------------------
  if (mode === "compact") {
    const worst = worstFactor(factors);
    return (
      <div
        data-testid="diagnostics-health-panel"
        className="flex items-center gap-3"
      >
        <SignalHealthGauge score={score} size={76} compact />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("diagnostics.panel.compact")}
          </span>
          {worst ? (
            <span className="text-xs text-muted-foreground">
              {t("diagnostics.panel.worstFactor")}{" "}
              <span className={cn("font-medium", HEALTH_TEXT[worst.health!])}>
                {t(`diagnostics.factor.${worst.key}`)}
              </span>{" "}
              <span
                className={cn(
                  "font-mono tabular-nums",
                  HEALTH_TEXT[worst.health!]
                )}
              >
                {worst.text} {worst.unit}
              </span>
            </span>
          ) : (
            <span className="text-xs text-status-good-strong">
              {t("diagnostics.panel.allNominal")}
            </span>
          )}
        </div>
      </div>
    );
  }

  // --- Live / Session: full widget -----------------------------------------
  return (
    <div data-testid="diagnostics-health-panel" className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex shrink-0 flex-col items-center gap-2">
          <SignalHealthGauge
            score={score}
            size={150}
            label={t(`diagnostics.panel.${mode}`)}
          />
          {isSession && perWindow.length > 1 && (
            <div
              role="img"
              aria-label={t("diagnostics.panel.windowTrend")}
              className="h-10 w-40"
            >
              <Sparkline
                data={perWindow}
                color={bandColor(score)}
                domain={[0, 100]}
                className="h-full w-full"
              />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("diagnostics.panel.factorsTitle")}
          </p>
          <ul className="flex flex-col">
            {factors.map((f) => (
              <li
                key={f.key}
                className="flex items-center justify-between gap-2 border-b border-border/40 py-1.5 last:border-0"
              >
                <span className="text-xs text-muted-foreground">
                  {t(`diagnostics.factor.${f.key}`)}
                </span>
                <span
                  className={cn(
                    "font-mono text-sm tabular-nums",
                    f.health ? HEALTH_TEXT[f.health] : "text-muted-foreground"
                  )}
                >
                  {f.text}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {f.unit}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Live diagnostic findings strip: the rolling live evaluator's recent
          findings (newest-first, capped) surfaced read-only. Notifications are
          intentionally NOT enqueued here — the M26 live-alert path owns that. */}
      {mode === "live" && (
        <section
          aria-label={t("diagnostics.panel.liveFindings")}
          className="border-t border-border/40 pt-3"
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("diagnostics.panel.liveFindings")}
          </p>
          {liveFindings.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("diagnostics.panel.liveFindingsEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {liveFindings.slice(0, LIVE_FINDINGS_SHOWN).map((f, idx) => (
                <li
                  key={`${f.ruleId}-${f.evidenceWindow.startIndex}-${idx}`}
                  className="flex items-start gap-2"
                >
                  <Badge
                    variant={SEVERITY_VARIANT[f.severity]}
                    aria-label={t(`diagnostics.severity.${f.severity}`)}
                  >
                    {t(`diagnostics.severity.${f.severity}`)}
                  </Badge>
                  <span className="min-w-0 text-xs text-muted-foreground">
                    {t(f.explanation, f.detail)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
