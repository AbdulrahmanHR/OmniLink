/**
 * Golden retrieval evaluation harness (M50, D19).
 *
 * Runs a labelled golden set of common ExpressLRS questions against a
 * {@link RetrievalIndex} and scores it against the frozen {@link EVAL_PASS_BAR}:
 *  - in-corpus questions must return the EXPECTED top-source citation at/above
 *    the threshold (top-source accuracy ≥ 0.90); and
 *  - out-of-corpus questions must return `noSourceFound` (no-source rate = 1.0).
 *
 * The golden set lives in `data/knowledge/eval/golden.json`. This substrate is
 * an early deliverable — M55 re-audits the same set against the same bar. Pure
 * and deterministic.
 */

import type { RetrievalIndex } from "./bm25";
import { retrieve } from "./retrieve";
import { EVAL_PASS_BAR, RELEVANCE_THRESHOLD } from "./retrievalConsts";

/** One labelled golden question. */
export interface GoldenItem {
  /** Stable id for the case. */
  id: string;
  /** The user question. */
  query: string;
  /** `in-corpus` ⇒ a source is expected; `out-of-corpus` ⇒ none should match. */
  kind: "in-corpus" | "out-of-corpus";
  /** Expected top-source id (required for `in-corpus`, omitted otherwise). */
  expectedSourceId?: string;
}

/** Per-item eval outcome. */
export interface EvalCaseResult {
  id: string;
  kind: GoldenItem["kind"];
  /** True when the item met its expectation. */
  pass: boolean;
  /** The top-source id the pipeline returned (or null when no source). */
  actualSourceId: string | null;
  expectedSourceId: string | null;
  topScore: number;
  noSourceFound: boolean;
}

/** Aggregate eval report. */
export interface EvalReport {
  inCorpusTotal: number;
  /** In-corpus items whose top source matched AND cleared the threshold. */
  inCorpusTopSourceHits: number;
  /** `hits / total` in `[0, 1]` (1 when there are no in-corpus items). */
  inCorpusTopSourceAccuracy: number;
  outOfCorpusTotal: number;
  /** Out-of-corpus items that correctly returned `noSourceFound`. */
  outOfCorpusNoSourceHits: number;
  /** `hits / total` in `[0, 1]` (1 when there are no out-of-corpus items). */
  outOfCorpusNoSourceRate: number;
  /** True when BOTH rates meet {@link EVAL_PASS_BAR}. */
  passes: boolean;
  /** The threshold used (frozen D19 value unless overridden). */
  threshold: number;
  cases: EvalCaseResult[];
}

/** Options for {@link runEval}. */
export interface RunEvalOptions {
  threshold?: number;
}

/**
 * Evaluate an index over a golden set. Deterministic; no clock, no I/O.
 * `passes` is the binary M50/M55 gate: in-corpus top-source accuracy ≥
 * {@link EVAL_PASS_BAR.inCorpusTopSource} AND out-of-corpus no-source rate ≥
 * {@link EVAL_PASS_BAR.outOfCorpusNoSource}.
 */
export function runEval(
  index: RetrievalIndex,
  golden: readonly GoldenItem[],
  opts: RunEvalOptions = {},
): EvalReport {
  const threshold = opts.threshold ?? RELEVANCE_THRESHOLD;
  const cases: EvalCaseResult[] = [];

  let inCorpusTotal = 0;
  let inCorpusHits = 0;
  let outTotal = 0;
  let outHits = 0;

  for (const item of golden) {
    const result = retrieve(item.query, index, { threshold });
    const actualSourceId =
      result.chunks.length > 0 ? result.chunks[0].sourceId : null;

    if (item.kind === "in-corpus") {
      inCorpusTotal += 1;
      const pass =
        !result.noSourceFound &&
        actualSourceId !== null &&
        actualSourceId === item.expectedSourceId;
      if (pass) inCorpusHits += 1;
      cases.push({
        id: item.id,
        kind: item.kind,
        pass,
        actualSourceId,
        expectedSourceId: item.expectedSourceId ?? null,
        topScore: result.topScore,
        noSourceFound: result.noSourceFound,
      });
    } else {
      outTotal += 1;
      const pass = result.noSourceFound;
      if (pass) outHits += 1;
      cases.push({
        id: item.id,
        kind: item.kind,
        pass,
        actualSourceId,
        expectedSourceId: null,
        topScore: result.topScore,
        noSourceFound: result.noSourceFound,
      });
    }
  }

  const inAccuracy = inCorpusTotal > 0 ? inCorpusHits / inCorpusTotal : 1;
  const outRate = outTotal > 0 ? outHits / outTotal : 1;
  const passes =
    inAccuracy >= EVAL_PASS_BAR.inCorpusTopSource &&
    outRate >= EVAL_PASS_BAR.outOfCorpusNoSource;

  return {
    inCorpusTotal,
    inCorpusTopSourceHits: inCorpusHits,
    inCorpusTopSourceAccuracy: inAccuracy,
    outOfCorpusTotal: outTotal,
    outOfCorpusNoSourceHits: outHits,
    outOfCorpusNoSourceRate: outRate,
    passes,
    threshold,
    cases,
  };
}
