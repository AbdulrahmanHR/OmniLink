import { useId, useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

interface SparklineProps {
  /** Raw value series, oldest first. */
  data: number[];
  /** Stroke/fill color (any CSS color, e.g. a var(--color-*) token). */
  color: string;
  /** Optional fixed domain; defaults to auto-scaling with padding. */
  domain?: [number, number];
  className?: string;
}

interface SparkPoint {
  i: number;
  v: number;
}

/**
 * Tiny axis-less area chart fed from a rolling history buffer. Animation is
 * disabled so the line streams smoothly at the 25Hz push rate instead of
 * re-tweening every frame.
 */
export function Sparkline({ data, color, domain, className }: SparklineProps) {
  const points = useMemo<SparkPoint[]>(
    () => data.map((v, i) => ({ i, v })),
    [data]
  );

  const rawId = useId();
  const gradientId = `spark${rawId.replace(/:/g, "")}`;

  return (
    <div className={className}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={points}
          margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={domain ?? ["dataMin", "dataMax"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
