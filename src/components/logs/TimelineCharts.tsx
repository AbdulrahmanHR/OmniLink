import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTranslation } from "react-i18next";
import type { ParsedLog } from "@/lib/blackbox";
import type { AnomalySeverity } from "@/lib/anomaly";
import { useSessionStore } from "@/stores/session";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import {
  buildDiagnosticMarkers,
  buildPatternMarkers,
} from "@/components/diagnostics/DiagnosticChartMarkers";

/** Severity → Signal Lab status token used for both lines and dots. */
const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

/**
 * Max plotted points **per channel**. A flight log can hold tens of thousands of
 * samples; handing all of them to Recharts would freeze the UI and bloat the SVG.
 * We downsample every channel to this bound with a uniform, index-preserving
 * stride (mirrors `decimatePath` in `lib/flight-path.ts`) so each plotted point
 * still maps back to a real `log.time` index — which keeps click-to-scrub and the
 * shared cursor exact rather than approximated. The mapping is a pure function of
 * `sampleCount` + this constant, so it is deterministic across renders.
 */
const CHART_MAX_POINTS = 800;

const tickStyle = {
  fill: "var(--color-muted-foreground)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

/** One decimated chart row: original sample index + relative-seconds + channels. */
interface ChartRow {
  /** Original index into `log.time` (so a clicked point resolves to the cursor). */
  i: number;
  /** Seconds since the log start, the shared X value across all channel charts. */
  t: number;
  /** Channel value by channel key (`NaN` gaps become `null` for Recharts). */
  [channelKey: string]: number | null;
}

/**
 * Evenly-spaced ascending source indices across `[0, n-1]`, at most `max`, always
 * including both endpoints. Same stride logic as `decimatePath`, kept here so the
 * chart downsample stays index-preserving (output index → real sample index).
 */
function downsampleIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max || max <= 1) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  let prev = -1;
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (n - 1)) / (max - 1));
    if (idx === prev) continue;
    prev = idx;
    out.push(idx);
  }
  return out;
}

interface TimelineChartsProps {
  log: ParsedLog;
}

/**
 * Synchronized per-channel time-series charts (M14, FR-LOG-03/04).
 *
 * Every channel gets its own auto-scaled chart, but they all share ONE X (time)
 * axis and ONE scrub cursor: the cursor is `useSessionStore().positionIndex`
 * (the single source of truth, also read by the dashboard, map panel +
 * transport). Each chart
 * draws a {@link ReferenceLine} at that cursor's time and a {@link ReferenceArea}
 * over the analysis selection; clicking any chart moves the same shared cursor.
 * `syncId` ties Recharts' hover tooltips across all charts too.
 */
export function TimelineCharts({ log }: TimelineChartsProps) {
  const { t } = useTranslation();
  const cursorIndex = useSessionStore((s) => s.positionIndex);
  const selectionStart = useSessionStore((s) => s.selectionStart);
  const selectionEnd = useSessionStore((s) => s.selectionEnd);
  const setCursor = useSessionStore((s) => s.seek);
  const anomalies = useSessionStore((s) => s.anomalies);
  const selectedAnomalyIndex = useSessionStore((s) => s.selectedAnomalyIndex);
  const selectAnomaly = useSessionStore((s) => s.selectAnomaly);
  // M37 diagnostic findings (added alongside the M15 anomaly markers). Null until
  // the Session Analysis page analyzes the loaded log.
  const diagnosticReport = useDiagnosticsStore((s) => s.sessionReport);
  // M38 session-level patterns, rendered as distinct (dashed) evidence markers.
  const patternReport = useDiagnosticsStore((s) => s.sessionPatternReport);

  // Downsample once; reused by every channel chart. Bounded by CHART_MAX_POINTS.
  const { rows, indices } = useMemo(() => {
    const idx = downsampleIndices(log.sampleCount, CHART_MAX_POINTS);
    const t0 = log.time[0] ?? 0;
    const built: ChartRow[] = idx.map((sourceIndex) => {
      const row: ChartRow = {
        i: sourceIndex,
        t: ((log.time[sourceIndex] ?? 0) - t0) / 1000,
      };
      for (const ch of log.channels) {
        const v = ch.values[sourceIndex];
        row[ch.key] = Number.isFinite(v) ? v : null;
      }
      return row;
    });
    return { rows: built, indices: idx };
  }, [log]);

  const t0 = log.time[0] ?? 0;
  const cursorSeconds = ((log.time[cursorIndex] ?? t0) - t0) / 1000;
  const selStartSeconds =
    selectionStart !== null ? ((log.time[selectionStart] ?? t0) - t0) / 1000 : null;
  const selEndSeconds =
    selectionEnd !== null ? ((log.time[selectionEnd] ?? t0) - t0) / 1000 : null;

  // Anomaly markers: each event's time in the same relative-seconds scale the
  // cursor uses, plus its colour and array index (for select-on-click).
  const anomalyMarkers = useMemo(
    () =>
      anomalies.map((ev, i) => ({
        i,
        type: ev.type,
        seconds: ((log.time[ev.index] ?? t0) - t0) / 1000,
        color: SEVERITY_COLOR[ev.severity],
      })),
    [anomalies, log, t0]
  );

  // Map a click on the decimated data back to the real sample index.
  const handleActiveIndex = (active: number | undefined) => {
    if (active === undefined || !Number.isFinite(active)) return;
    const row = rows[active];
    if (row) setCursor(row.i);
  };

  if (log.channels.length === 0 || rows.length === 0) {
    return (
      <p
        data-testid="logs-timeline-charts"
        className="py-8 text-center text-sm text-muted-foreground"
      >
        {t("logs.charts.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="logs-timeline-charts">
      <p className="text-xs text-muted-foreground">
        {t("logs.charts.decimated", {
          shown: indices.length,
          total: log.sampleCount,
        })}
      </p>
      <div className="flex flex-col gap-3">
        {log.channels.map((channel, i) => {
          const color = `var(--color-chart-${(i % 5) + 1})`;
          const unit = channel.unit ? ` (${channel.unit})` : "";
          // Top of this channel's plotted data — where the clickable anomaly
          // dots sit (the charts share the X axis but each has its own Y scale).
          let channelMax = -Infinity;
          for (const row of rows) {
            const v = row[channel.key];
            if (typeof v === "number" && v > channelMax) channelMax = v;
          }
          const hasDotY = Number.isFinite(channelMax);
          return (
            <div key={channel.key} className="rounded-md border border-border p-2">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-foreground">
                  {channel.label}
                  <span className="text-muted-foreground">{unit}</span>
                </span>
              </div>
              <div className="h-24">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={rows}
                    syncId="logs-timeline"
                    margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                    onClick={(state) =>
                      handleActiveIndex(
                        typeof state.activeTooltipIndex === "number"
                          ? state.activeTooltipIndex
                          : Number(state.activeTooltipIndex)
                      )
                    }
                  >
                    <CartesianGrid
                      stroke="var(--color-signal-grid)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tick={tickStyle}
                      tickLine={false}
                      axisLine={{ stroke: "var(--color-border)" }}
                      tickFormatter={(v: number) => `${Math.round(v)}s`}
                      minTickGap={40}
                    />
                    <YAxis
                      tick={tickStyle}
                      tickLine={false}
                      axisLine={{ stroke: "var(--color-border)" }}
                      width={44}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      isAnimationActive={false}
                      contentStyle={{
                        background: "var(--color-popover)",
                        border: "1px solid var(--color-border)",
                        borderRadius: "var(--radius-md)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      labelStyle={{ color: "var(--color-muted-foreground)" }}
                      labelFormatter={(value) => `${Math.round(Number(value))}s`}
                    />
                    {selStartSeconds !== null && selEndSeconds !== null && (
                      <ReferenceArea
                        x1={selStartSeconds}
                        x2={selEndSeconds}
                        fill="var(--color-primary)"
                        fillOpacity={0.1}
                        stroke="var(--color-primary)"
                        strokeOpacity={0.3}
                      />
                    )}
                    {anomalyMarkers.map((m) => {
                      const selected = m.i === selectedAnomalyIndex;
                      return (
                        <ReferenceLine
                          key={`anom-line-${m.i}`}
                          x={m.seconds}
                          stroke={m.color}
                          strokeWidth={selected ? 2.5 : 1.5}
                          strokeDasharray={selected ? undefined : "4 2"}
                          ifOverflow="extendDomain"
                        />
                      );
                    })}
                    <ReferenceLine
                      x={cursorSeconds}
                      stroke="var(--color-primary)"
                      strokeWidth={1.5}
                    />
                    <Line
                      type="monotone"
                      dataKey={channel.key}
                      name={channel.label}
                      stroke={color}
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                    {hasDotY &&
                      anomalyMarkers.map((m) => {
                        const selected = m.i === selectedAnomalyIndex;
                        return (
                          <ReferenceDot
                            key={`anom-dot-${m.i}`}
                            x={m.seconds}
                            y={channelMax}
                            r={selected ? 5 : 3.5}
                            fill={m.color}
                            stroke="var(--color-background)"
                            strokeWidth={1}
                            ifOverflow="extendDomain"
                            cursor="pointer"
                            data-testid="logs-anomaly-marker"
                            role="button"
                            aria-label={t("anomaly.marker.aria", {
                              type: t(`anomaly.type.${m.type}`),
                              time: `${m.seconds.toFixed(1)}s`,
                            })}
                            onClick={(_dotProps, e) => {
                              // Stop the click from bubbling to the LineChart's
                              // onClick (which would scrub the cursor to the
                              // nearest decimated point), mirroring the map
                              // markers — selecting an anomaly should not also
                              // re-scrub. Recharts passes the underlying DOM
                              // event as the 2nd arg.
                              e.stopPropagation();
                              selectAnomaly(m.i);
                            }}
                          />
                        );
                      })}
                    {/* M37 diagnostic evidence-window markers, layered alongside
                        the anomaly markers. Spread as literal chart children so
                        Recharts renders them; the click scrubs the shared cursor
                        to the finding's window start. */}
                    {hasDotY &&
                      diagnosticReport &&
                      buildDiagnosticMarkers(diagnosticReport.findings, log, {
                        onSelect: setCursor,
                        y: channelMax,
                        t,
                      })}
                    {/* M38 session-pattern evidence markers, layered alongside the
                        M37 finding markers (dashed bands to read as distinct). */}
                    {hasDotY &&
                      patternReport &&
                      buildPatternMarkers(patternReport.patterns, log, {
                        onSelect: setCursor,
                        y: channelMax,
                        t,
                      })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
