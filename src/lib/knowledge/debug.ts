/**
 * Retrieval debug info for the "why was this chunk selected?" surface (M50).
 *
 * Given a query and an index, produces per-chunk scores + which query terms
 * overlapped + whether the chunk was selected (cleared the threshold and fell
 * within top-K). Drives the {@link RetrievalDebugPanel} test-retrieval box.
 * Pure and deterministic.
 */

import type { RetrievalIndex } from "./bm25";
import { queryTerms } from "./bm25";
import { DEFAULT_TOP_K, RELEVANCE_THRESHOLD } from "./retrievalConsts";

/** Per-chunk debug row. */
export interface ChunkDebug {
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  title: string;
  /** Normalized relevance in `[0, 1]`. */
  score: number;
  /** Query terms (stemmed) that occur in this chunk. */
  matchedTerms: string[];
  /** True when the chunk cleared the threshold and is within top-K. */
  selected: boolean;
}

/** Full debug view of a retrieval. */
export interface RetrievalDebug {
  query: string;
  /** Distinct stemmed query terms actually searched for. */
  terms: string[];
  threshold: number;
  topScore: number;
  noSourceFound: boolean;
  /** Every chunk, highest score first. */
  chunks: ChunkDebug[];
}

/** Options for {@link debugRetrieve}. */
export interface DebugOptions {
  topK?: number;
  threshold?: number;
}

/**
 * Compute the full per-chunk debug view for a query. Unlike `retrieve()`, this
 * returns EVERY chunk (not just those above the threshold) so the debug UI can
 * show near-misses; `selected` marks the ones a real retrieval would cite.
 */
export function debugRetrieve(
  query: string,
  index: RetrievalIndex,
  opts: DebugOptions = {},
): RetrievalDebug {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const threshold = opts.threshold ?? RELEVANCE_THRESHOLD;
  const terms = queryTerms(query);

  const scores = index.scorer.scoreChunks(query);
  const ranked = index.chunks
    .map((chunk, i) => ({
      chunk,
      score: scores[i] ?? 0,
      matchedTerms: index.scorer.matchedTerms(query, i),
    }))
    .sort((a, b) => b.score - a.score);

  let kept = 0;
  const chunks: ChunkDebug[] = ranked.map((r) => {
    const selected = r.score >= threshold && kept < topK;
    if (selected) kept += 1;
    return {
      sourceId: r.chunk.sourceId,
      sourceTitle: r.chunk.sourceTitle,
      chunkId: r.chunk.chunkId,
      title: r.chunk.title,
      score: r.score,
      matchedTerms: r.matchedTerms,
      selected,
    };
  });

  return {
    query,
    terms,
    threshold,
    topScore: ranked.length > 0 ? ranked[0].score : 0,
    noSourceFound: kept === 0,
    chunks,
  };
}
