/**
 * Frozen retrieval constants for the local RAG pipeline (M50, D15/D19).
 *
 * These numbers are the load-bearing D19 decisions. They live in ONE module so
 * M55's launch-gate audit has a single source of truth. Changing any of them is
 * a deliberate, reviewed edit — the golden eval (`eval.ts` + `data/knowledge/
 * eval/golden.json`) and the perf test pin the behaviour these values produce.
 *
 * The threshold applies to a NORMALIZED BM25 score in `[0, 1]` (see
 * `bm25.ts::buildIndex`). The normalization — not these constants — is tuned so
 * real in-corpus ExpressLRS questions clear the threshold and clearly
 * out-of-corpus questions fall below it (validated by the golden set).
 */

/**
 * Minimum normalized relevance a chunk must reach to be cited (D19). A retrieval
 * with no chunk at/above this yields `noSourceFound` — Omnia says "no source
 * found" rather than answering unsupported. Applied in `retrieve.ts`.
 */
export const RELEVANCE_THRESHOLD = 0.18;

/**
 * Golden-eval pass-bar (D19), frozen here and re-audited in M55:
 *  - `inCorpusTopSource` — fraction of in-corpus questions whose top citation is
 *    the expected source AND clears the threshold (≥ 0.90);
 *  - `outOfCorpusNoSource` — fraction of out-of-corpus questions that correctly
 *    return `noSourceFound` (= 1.0, no false-positive citations).
 */
export const EVAL_PASS_BAR = {
  inCorpusTopSource: 0.9,
  outOfCorpusNoSource: 1.0,
} as const;

/**
 * Default number of chunks `retrieve()` keeps (after the threshold filter). A
 * small K keeps the cited-sources UI and any outbound context compact.
 */
export const DEFAULT_TOP_K = 4;

/**
 * Hard cap on a citation excerpt's length (characters). The excerpt is a bounded
 * SNIPPET of a single chunk — NEVER a full document — so no full source text can
 * reach the model or the UI. Enforced in `retrieve.ts::boundExcerpt`.
 */
export const MAX_EXCERPT_CHARS = 320;

/**
 * Max retrieved docs forwarded outbound (mirrors the Rust `MAX_RETRIEVED_DOCS`).
 * Bounds token cost and the prompt-injection surface of the retrieved-docs
 * channel, the same discipline `MAX_DEFINES` applies to user defines.
 */
export const MAX_RETRIEVED_DOCS = 8;

/**
 * Interactive perf budget: the p95 wall-clock (ms) a single `retrieve()` over
 * the bundled corpus must stay under on a mid-range machine. Deliberately
 * generous vs. the sub-millisecond reality on this corpus so the assertion pins
 * "stays interactive" without flaking. Frozen here; asserted by the perf test.
 */
export const RETRIEVAL_P95_BUDGET_MS = 25;
