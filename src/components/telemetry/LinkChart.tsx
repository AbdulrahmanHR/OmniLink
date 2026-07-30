import { useId, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTelemetryStore, type TelemetryFrame } from "@/stores/telemetry";

interface LinkChartProps {
  labels: {
    rssi1: string;
    rssi2: string;
    linkQuality: string;
    seconds: string;
  };
}

interface LinkPoint {
  /** Relative seconds before "now" (negative, oldest most negative). */
  t: number;
  rssi1: number;
  rssi2: number;
  linkQuality: number;
}

const tickStyle = {
  fill: "var(--color-muted-foreground)",
  fontSize: 10,
  fontFamily: "var(--font-mono)",
} as const;

function selectHistory(state: { history: TelemetryFrame[] }) {
  return state.history;
}

/**
 * Rolling RSSI + Link Quality chart over the recent telemetry window. RSSI is
 * plotted as area lobes on the left (dBm) axis; link quality as a line on the
 * right (%) axis. Streaming animation disabled for smooth 25Hz updates.
 */
export function LinkChart({ labels }: LinkChartProps) {
  const history = useTelemetryStore(selectHistory);

  // Unique gradient ids so multiple chart instances never collide on <defs>.
  const uid = useId().replace(/:/g, "");
  const rssi1GradId = `link-rssi1-${uid}`;
  const rssi2GradId = `link-rssi2-${uid}`;

  const data = useMemo<LinkPoint[]>(() => {
    if (history.length === 0) return [];
    const now = history[history.length - 1].t;
    return history.map((f) => ({
      t: (f.t - now) / 1000,
      rssi1: f.rssi1,
      rssi2: f.rssi2,
      linkQuality: f.linkQuality,
    }));
  }, [history]);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 8, bottom: 4, left: -8 }}
      >
        <defs>
          <linearGradient id={rssi1GradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={rssi2GradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-2)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--color-chart-2)" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid stroke="var(--color-signal-grid)" strokeDasharray="3 3" />

        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", 0]}
          tick={tickStyle}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          tickFormatter={(v: number) => `${v.toFixed(1)}${labels.seconds}`}
          minTickGap={40}
        />
        <YAxis
          yAxisId="rssi"
          domain={[-110, -30]}
          tick={tickStyle}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          width={44}
        />
        <YAxis
          yAxisId="lq"
          orientation="right"
          domain={[0, 100]}
          tick={tickStyle}
          tickLine={false}
          axisLine={{ stroke: "var(--color-border)" }}
          width={34}
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
          labelFormatter={(v) => `${Number(v).toFixed(2)}${labels.seconds}`}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
        />

        <Area
          yAxisId="rssi"
          type="monotone"
          dataKey="rssi1"
          name={labels.rssi1}
          stroke="var(--color-chart-1)"
          strokeWidth={1.5}
          fill={`url(#${rssi1GradId})`}
          isAnimationActive={false}
          dot={false}
        />
        <Area
          yAxisId="rssi"
          type="monotone"
          dataKey="rssi2"
          name={labels.rssi2}
          stroke="var(--color-chart-2)"
          strokeWidth={1.5}
          fill={`url(#${rssi2GradId})`}
          isAnimationActive={false}
          dot={false}
        />
        <Line
          yAxisId="lq"
          type="monotone"
          dataKey="linkQuality"
          name={labels.linkQuality}
          stroke="var(--color-status-good)"
          strokeWidth={1.5}
          isAnimationActive={false}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
