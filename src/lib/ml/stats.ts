/**
 * Gap-tolerant summary statistics for ML feature extraction (M56).
 *
 * Every helper here ignores non-finite samples (a `NaN` in a {@link
 * import("@/lib/blackbox").LogChannel} marks a **gap**, not a zero) and returns a
 * caller-supplied finite fallback when a series has nothing to summarise. That
 * matters: `data/fixtures/diagnostics/antenna/*.csv` genuinely carry blank
 * `alt`/`sats`/`ground_speed` columns, so gap handling is a real code path on the
 * real corpus, not a defensive flourish.
 *
 * ## Why not `d3-array`
 * `d3` is a direct dependency and `d3-array` would give us `mean`/`deviation`/
 * `quantile` for free. It is deliberately not used, for two reasons:
 *  1. `d3-array` is only present as a **transitive** dep of `d3` — importing it
 *     directly is a phantom dependency that a different hoist/dedupe could break,
 *     and importing the `d3` root barrel to get three arithmetic functions drags
 *     the whole selection/scale/shape graph into a pure library module; and
 *  2. the repo already has this exact vocabulary in `src/lib/diagnostics/util.ts`
 *     (`isFiniteNumber`, `meanFinite`, `stdDev`), which the diagnostic rules use.
 *     Reusing it means the ML features and the v2.0 rules agree on what a "gap"
 *     is — a real correctness property, since M58's model is compared against
 *     those very rules.
 *
 * So: reuse `diagnostics/util` where it already has the helper, and hand-roll the
 * three it lacks (min/max/quantile). Zero new dependencies (invariant #1), and no
 * second definition of "mean".
 *
 * Pure: no clock, no RNG, no I/O.
 */

import { isFiniteNumber, meanFinite, stdDev } from "@/lib/diagnostics/util";

export { isFiniteNumber, meanFinite, stdDev };

/** The finite entries of `values`, in order. */
export function finite(values: readonly number[]): number[] {
  return values.filter(isFiniteNumber);
}

/** Minimum of the finite entries of `values` (`fallback` when there are none). */
export function minFinite(values: readonly number[], fallback: number): number {
  let out = Infinity;
  for (const v of values) if (isFiniteNumber(v) && v < out) out = v;
  return out === Infinity ? fallback : out;
}

/** Maximum of the finite entries of `values` (`fallback` when there are none). */
export function maxFinite(values: readonly number[], fallback: number): number {
  let out = -Infinity;
  for (const v of values) if (isFiniteNumber(v) && v > out) out = v;
  return out === -Infinity ? fallback : out;
}

/**
 * Linearly-interpolated `p`-quantile (`p` in `[0, 1]`) of the finite entries of
 * `values`, computed on a sorted copy. Matches the standard "type 7" definition
 * used by NumPy/d3, so a number reported from here is comparable to one computed
 * anywhere else. Returns `fallback` when there is nothing finite to rank.
 *
 * Deterministic: sorts a copy with a numeric comparator (never the default
 * lexicographic one), so ties and negative numbers behave.
 */
export function quantileFinite(
  values: readonly number[],
  p: number,
  fallback: number
): number {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return fallback;
  if (xs.length === 1) return xs[0];
  const idx = (xs.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/**
 * Fraction of the finite entries of `values` satisfying `pred`, in `[0, 1]`.
 * Returns `0` when there are no finite entries — a session with no data has no
 * *evidence* of the condition, which is the correct null for every downstream
 * `…Frac…` feature.
 */
export function fractionWhere(
  values: readonly number[],
  pred: (v: number) => boolean
): number {
  let seen = 0;
  let hits = 0;
  for (const v of values) {
    if (!isFiniteNumber(v)) continue;
    seen += 1;
    if (pred(v)) hits += 1;
  }
  return seen === 0 ? 0 : hits / seen;
}

/**
 * Round to 6 decimal places.
 *
 * IEEE-754 arithmetic is already bit-reproducible for a fixed code path, so this
 * is not what makes the features deterministic — {@link import("./rng").createRng}
 * and the absence of a clock are. What it buys is *artifact stability*: a feature
 * vector serialised to JSON round-trips to the same short text on every machine,
 * so a checked-in dataset artifact diffs cleanly instead of churning in the 15th
 * decimal place.
 */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
