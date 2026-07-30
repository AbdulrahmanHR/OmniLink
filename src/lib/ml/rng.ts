/**
 * Seeded, deterministic pseudo-random number generation for the v2.5 ML line
 * (M56).
 *
 * ## Why this file exists at all
 * **Determinism is invariant #7 of this release: every training and evaluation
 * path must be byte-reproducible across runs.** That is not a stylistic
 * preference — it is what makes the M56 gate mean anything. `clearsM56Gate` is a
 * strict `<` against a measured baseline; if the dataset split reshuffled on each
 * run, a model could pass the gate on Tuesday and fail it on Wednesday with no
 * code change, and no reviewer could ever tell whether a reported delta came from
 * the model or from the shuffle. A gate you cannot re-run to the same answer is
 * not a gate. It also means a reported result is auditable: anyone can re-derive
 * the exact split, the exact features, and the exact score from the seed alone.
 *
 * The repo had **no seeded RNG before this file** — every `Math.random()` in the
 * tree is id-generation, and `src/lib/diagnostics/perf.ts` achieves its
 * determinism by *avoiding* randomness entirely (sines + modular arithmetic). The
 * ML line cannot avoid it: a stratified split needs to shuffle. So it takes the
 * only other honest option — randomness that is a pure function of a seed.
 *
 * ## Contract
 * Pure. No `Math.random()`, no `Date.now()`, no I/O, no global state. The same
 * seed always yields the same sequence, on every machine, in every run order.
 * Asserted by `tests/unit/ml/dataset.test.ts`.
 */

/**
 * The frozen default seed for every ML split/eval path in v2.5.
 *
 * The value itself is arbitrary (it is the release number, 2.5.1 → `2551`) — what
 * matters is that it is *fixed and checked in*, so "the split" is a single
 * well-defined object rather than a family of them. Callers may override the seed
 * to probe split sensitivity, but every reported metric must name the seed it was
 * produced under.
 */
export const DEFAULT_SEED = 2551;

/**
 * Create a seeded PRNG returning floats in `[0, 1)`.
 *
 * Implementation is **mulberry32**: a 32-bit counter-based generator — one add,
 * two multiplies, a few shifts and xors. Chosen because it is ~10 lines with no
 * dependency (invariant #1: zero new dependencies), has a full 2³² period, and
 * passes gjrand/practrand at the scale we need. We are shuffling ≤ a few hundred
 * sessions, not doing cryptography or Monte-Carlo integration; statistical
 * pedigree beyond "uniform and reproducible" buys nothing here, and any weakness
 * mulberry32 has is irrelevant at this scale.
 *
 * `seed` is coerced to a uint32 (`>>> 0`), so `createRng(-1)` and
 * `createRng(0xffffffff)` are the same stream — deliberate, and harmless.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Return a shuffled **copy** of `items` using an unbiased Fisher–Yates pass driven
 * by `rng`. Does not mutate the input (so a caller's canonical ordering survives)
 * and consumes exactly `items.length - 1` draws, which keeps the RNG's position
 * predictable when several groups are shuffled from one generator in sequence —
 * that is what makes the per-class stratified shuffle in `dataset.ts` reproducible
 * as a whole and not just per group.
 */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
