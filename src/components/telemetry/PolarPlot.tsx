import { useId, useMemo } from "react";
import { curveCardinalClosed, lineRadial, scaleLinear } from "d3";
import { cn } from "@/lib/utils";
import { useTelemetryStore, type TelemetryFrame } from "@/stores/telemetry";

interface PolarPlotProps {
  labels: {
    antenna1: string;
    antenna2: string;
    noSignal: string;
    /** Accessible name describing the whole instrument for screen readers. */
    ariaLabel: string;
  };
}

const VIEW = 220;
const CENTER = VIEW / 2;
const R = 92;
const RSSI_MIN = -110;
const RSSI_MAX = -30;
/** dBm levels drawn as concentric grid rings. */
const RING_LEVELS = [-30, -50, -70, -90, -110];
/** Angle samples per antenna lobe. */
const LOBE_STEPS = 72;
/** Recent samples used for the faint rotating scope trace. */
const TRACE_SAMPLES = 64;

const radiusScale = scaleLinear()
  .domain([RSSI_MIN, RSSI_MAX])
  .range([0, R])
  .clamp(true);

/**
 * Build a directional antenna-lobe path (teardrop) centered on heading `axis`
 * (radians, 0 = up) whose extent scales with the antenna's normalized RSSI.
 */
function lobePath(rssi: number, axis: number): string {
  const mag = radiusScale(rssi) / R; // 0..1
  const gen = lineRadial<number>()
    .angle((a) => a)
    .radius((a) => {
      const lobe = Math.pow(Math.max(0, 0.5 + 0.5 * Math.cos(a - axis)), 1.3);
      return mag * R * (0.18 + 0.82 * lobe);
    })
    .curve(curveCardinalClosed);
  const angles = Array.from(
    { length: LOBE_STEPS },
    (_, i) => (i / LOBE_STEPS) * Math.PI * 2
  );
  return gen(angles) ?? "";
}

/**
 * Custom D3-driven radar / signal-pattern instrument. Renders concentric dBm
 * rings, angular spokes, two directional per-antenna RSSI lobes (the active
 * diversity path glows), and a faint rotating scope trace of recent RSSI for
 * live 25Hz motion. Implemented with d3-scale + d3-shape, not Recharts.
 */
export function PolarPlot({ labels }: PolarPlotProps) {
  // Select each field separately: a combined `{ latest, history }` selector
  // returns a fresh object every render, which useSyncExternalStore treats as a
  // changed snapshot and spins into an infinite update loop.
  const latest = useTelemetryStore((s) => s.latest);
  const history = useTelemetryStore((s) => s.history);

  // Unique gradient id so multiple plot instances never collide on <defs>.
  const sweepGradId = `polar-sweep-${useId().replace(/:/g, "")}`;

  const ant1 = latest?.antennas.find((a) => a.id === 1);
  const ant2 = latest?.antennas.find((a) => a.id === 2);

  const lobe1 = useMemo(
    () => (ant1 ? lobePath(ant1.rssi, 0) : ""),
    [ant1?.rssi] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lobe2 = useMemo(
    () => (ant2 ? lobePath(ant2.rssi, Math.PI) : ""),
    [ant2?.rssi] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const tracePath = useMemo(() => {
    if (history.length < 4) return "";
    const slice = history.slice(-TRACE_SAMPLES);
    const gen = lineRadial<TelemetryFrame>()
      .angle((_, i) => (i / slice.length) * Math.PI * 2)
      .radius((f) => radiusScale(f.rssi1))
      .curve(curveCardinalClosed);
    return gen(slice) ?? "";
  }, [history]);

  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return {
      x: CENTER + Math.sin(a) * R,
      y: CENTER - Math.cos(a) * R,
    };
  });

  return (
    <div className="flex h-full w-full items-center justify-center">
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full max-h-[260px] w-auto max-w-full"
        role="img"
        aria-label={labels.ariaLabel}
      >
        {/* Accessible name for the decorative SVG instrument (role="img"). The
            <title> also surfaces as a native tooltip on hover. */}
        <title>{labels.ariaLabel}</title>

        {/* Grid rings */}
        {RING_LEVELS.map((level) => (
          <circle
            key={level}
            cx={CENTER}
            cy={CENTER}
            r={radiusScale(level)}
            fill="none"
            stroke="var(--color-signal-grid)"
            strokeWidth={1}
          />
        ))}

        {/* Ring labels (dBm) */}
        {RING_LEVELS.filter((l) => l !== RSSI_MIN).map((level) => (
          <text
            key={`lbl-${level}`}
            x={CENTER + 3}
            y={CENTER - radiusScale(level) - 2}
            className="fill-muted-foreground font-mono"
            fontSize={7}
          >
            {level}
          </text>
        ))}

        {/* Spokes */}
        {spokes.map((s, i) => (
          <line
            key={i}
            x1={CENTER}
            y1={CENTER}
            x2={s.x}
            y2={s.y}
            stroke="var(--color-signal-grid)"
            strokeWidth={0.75}
          />
        ))}

        {/* Rotating scope sweep wedge */}
        <g
          className="origin-center motion-safe:animate-[spin_4s_linear_infinite]"
          style={{ transformOrigin: "center" }}
        >
          <defs>
            <linearGradient id={sweepGradId} x1="0.5" y1="0.5" x2="1" y2="0.5">
              <stop offset="0%" stopColor="var(--color-signal-primary)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--color-signal-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path
            d={`M ${CENTER} ${CENTER} L ${CENTER} ${CENTER - R} A ${R} ${R} 0 0 1 ${
              CENTER + R * Math.sin(0.5)
            } ${CENTER - R * Math.cos(0.5)} Z`}
            fill={`url(#${sweepGradId})`}
          />
        </g>

        {/* Faint live scope trace of recent RSSI1 */}
        {tracePath && (
          <path
            transform={`translate(${CENTER} ${CENTER})`}
            d={tracePath}
            fill="none"
            stroke="var(--color-signal-primary)"
            strokeOpacity={0.35}
            strokeWidth={0.75}
          />
        )}

        {/* Antenna lobes */}
        {lobe2 && (
          <path
            transform={`translate(${CENTER} ${CENTER})`}
            d={lobe2}
            fill="var(--color-chart-2)"
            fillOpacity={ant2?.active ? 0.35 : 0.18}
            stroke="var(--color-chart-2)"
            strokeWidth={ant2?.active ? 1.5 : 1}
            className={cn(
              "transition-all duration-100",
              ant2?.active &&
                "drop-shadow-[0_0_6px_var(--color-signal-glow)]"
            )}
          />
        )}
        {lobe1 && (
          <path
            transform={`translate(${CENTER} ${CENTER})`}
            d={lobe1}
            fill="var(--color-chart-1)"
            fillOpacity={ant1?.active ? 0.4 : 0.2}
            stroke="var(--color-chart-1)"
            strokeWidth={ant1?.active ? 1.5 : 1}
            className={cn(
              "transition-all duration-100",
              ant1?.active &&
                "drop-shadow-[0_0_6px_var(--color-signal-glow)]"
            )}
          />
        )}

        {/* Center hub */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={2.5}
          fill="var(--color-signal-primary)"
        />

        {/* Antenna readouts */}
        {latest ? (
          <>
            <text
              x={CENTER}
              y={14}
              textAnchor="middle"
              className="fill-chart-1 font-mono"
              fontSize={9}
            >
              {labels.antenna1} {ant1?.rssi}
            </text>
            <text
              x={CENTER}
              y={VIEW - 6}
              textAnchor="middle"
              className="fill-chart-2 font-mono"
              fontSize={9}
            >
              {labels.antenna2} {ant2?.rssi}
            </text>
          </>
        ) : (
          <text
            x={CENTER}
            y={CENTER + 3}
            textAnchor="middle"
            className="fill-muted-foreground font-mono"
            fontSize={9}
          >
            {labels.noSignal}
          </text>
        )}
      </svg>
    </div>
  );
}
