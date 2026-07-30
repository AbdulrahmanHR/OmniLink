/**
 * Shared pure helpers for the local diagnostic engine (M36).
 *
 * Every export here is a tiny, deterministic arithmetic/array helper reused by
 * the rule files, the health-score module, and the live evaluator. Nothing here
 * touches `Date.now`, `Math.random`, the DOM, the network, or `log.gps` — the
 * same purity contract the M15 anomaly detectors and M26 live alerts hold to.
 *
 * Channel resolution mirrors `anomaly.ts`: a channel is looked up by trying a
 * priority-ordered list of candidate keys, matched case-insensitively against
 * `channel.key`, so the canonical OmniLog keys (`rssi1`, `link_quality`, …) and
 * their aliases all resolve to the same series.
 */

import type { ParsedLog } from "@/lib/blackbox";

/** Candidate key lists (priority order) for the channels the rules read. */
export const CHANNEL_CANDIDATES = {
  /** Primary antenna RSSI (rssi1 wins over a bare rssi). */
  rssi1: ["rssi1", "rssi", "RSSI"],
  /** Second antenna RSSI (diversity path). */
  rssi2: ["rssi2"],
  /** Uplink link quality, 0–100 %. */
  linkQuality: ["link_quality", "lq", "linkQuality"],
  /** Signal-to-noise ratio, dB. */
  snr: ["snr", "SNR"],
  /** TX power, mW. */
  txPower: ["tx_power", "txPower"],
  /** Packet/RF rate, Hz. */
  packetRate: ["packet_rate", "packetRate"],
} as const;

/** Round to at most two decimals (keeps `detail` numbers tidy for the UI/AI). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Clamp `n` into the inclusive `[lo, hi]` range. */
export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Clamp `n` into `[0, 1]` (the normalizer range for the health score). */
export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/** Type guard: a real, finite number (NaN/Infinity are treated as gaps). */
export function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Resolve a channel's sample array by trying `candidates` in priority order,
 * matching each case-insensitively against `channel.key`. Returns the first
 * hit's `values` (never a copy — callers must not mutate), or `undefined` when
 * no candidate matches.
 */
export function resolveChannelValues(
  log: ParsedLog,
  candidates: readonly string[]
): number[] | undefined {
  for (const cand of candidates) {
    const want = cand.toLowerCase();
    const found = log.channels.find((c) => c.key.toLowerCase() === want);
    if (found) return found.values;
  }
  return undefined;
}

/**
 * Index of the discrete `steps` entry nearest to `value` (ties resolve to the
 * lower index). Used to map a continuous TX-power / packet-rate reading onto the
 * canonical {@link import("@/stores/telemetry").TX_POWER_STEPS} ladder.
 */
export function nearestStepIndex(value: number, steps: readonly number[]): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const d = Math.abs(steps[i] - value);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Population standard deviation of the finite entries of `values` (0 for <2). */
export function stdDev(values: readonly number[]): number {
  const finite = values.filter(isFiniteNumber);
  if (finite.length < 2) return 0;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance =
    finite.reduce((a, b) => a + (b - mean) * (b - mean), 0) / finite.length;
  return Math.sqrt(variance);
}

/** Arithmetic mean of the finite entries of `values` (`fallback` when none). */
export function meanFinite(values: readonly number[], fallback: number): number {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) return fallback;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Per-index trailing rolling standard deviation: `out[i]` is the population
 * stddev of the finite samples in `[i - window + 1, i]`. Deterministic and
 * gap-tolerant (non-finite samples are skipped inside each window).
 */
export function rollingStdDev(values: readonly number[], window: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - window + 1);
    out[i] = stdDev(values.slice(start, i + 1));
  }
  return out;
}

/**
 * Per-index trailing count of adjacent value changes: `out[i]` is the number of
 * `a !== b` transitions between consecutive finite samples in
 * `[i - window + 1, i]`. Used to quantify packet-rate jitter density.
 */
export function rollingChangeCount(values: readonly number[], window: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - window + 1);
    const w = values.slice(start, i + 1).filter(isFiniteNumber);
    let changes = 0;
    for (let j = 1; j < w.length; j++) {
      if (w[j] !== w[j - 1]) changes++;
    }
    out[i] = changes;
  }
  return out;
}
