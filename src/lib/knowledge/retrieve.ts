/**
 * Retrieval + citation payload for the local RAG pipeline (M50, D19).
 *
 * `retrieve()` scores a query against a {@link RetrievalIndex}, applies the
 * frozen {@link RELEVANCE_THRESHOLD}, and returns bounded citation payloads. If
 * no chunk clears the threshold it returns `noSourceFound` — the D19 "say when
 * no source was found" contract, enforced here so callers never fabricate a
 * citation.
 *
 * Two shapes leave this module:
 *  - {@link RetrievedChunk} — the CITATION payload for the UI (carries `score`);
 *  - {@link RetrievedDoc} — the OUTBOUND-to-model payload (no score), which
 *    populates `AiContextInput.retrievedDocs` and is sanitized Rust-side.
 *
 * Both carry only a bounded `excerpt` (a SNIPPET of one chunk) — never a full
 * document. Pure and deterministic.
 */

import type { RetrievalIndex } from "./bm25";
import {
  DEFAULT_TOP_K,
  MAX_EXCERPT_CHARS,
  MAX_RETRIEVED_DOCS,
  RELEVANCE_THRESHOLD,
} from "./retrievalConsts";

/** A cited chunk shown in the UI (frozen M50 schema). */
export interface RetrievedChunk {
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  /** Bounded snippet of the chunk — never the full document. */
  excerpt: string;
  /** Normalized relevance in `[0, 1]`. */
  score: number;
}

/**
 * The outbound-to-model shape (frozen M50 schema): a {@link RetrievedChunk}
 * WITHOUT the score. Populates `AiContextInput.retrievedDocs`; the authoritative
 * redaction runs Rust-side in `sanitize_context()`.
 */
export interface RetrievedDoc {
  sourceId: string;
  sourceTitle: string;
  chunkId: string;
  excerpt: string;
}

/** The result of a retrieval. */
export interface RetrievalResult {
  /** Chunks at/above the threshold, highest score first (may be empty). */
  chunks: RetrievedChunk[];
  /** The best chunk's normalized score (0 when the corpus is empty). */
  topScore: number;
  /** True when nothing cleared the threshold — the "no source found" state. */
  noSourceFound: boolean;
}

/** Options for {@link retrieve}. */
export interface RetrieveOptions {
  /** Max chunks to return after the threshold filter (default {@link DEFAULT_TOP_K}). */
  topK?: number;
  /** Override the relevance threshold (defaults to the frozen D19 value). */
  threshold?: number;
}

/**
 * Bound a chunk's prose into a compact citation excerpt: collapse whitespace,
 * then truncate at a word boundary to {@link MAX_EXCERPT_CHARS} with an ellipsis.
 * Guarantees the excerpt is a SNIPPET, never a full multi-paragraph document.
 */
export function boundExcerpt(text: string, max = MAX_EXCERPT_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const slice = collapsed.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Retrieve the chunks relevant to `query`. Scores every chunk via the index's
 * scorer, keeps those at/above the threshold (highest first, up to `topK`), and
 * reports `noSourceFound` when none qualify. `topScore` is reported even when it
 * is below the threshold, so callers can surface how close a near-miss was.
 */
export function retrieve(
  query: string,
  index: RetrievalIndex,
  opts: RetrieveOptions = {},
): RetrievalResult {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const threshold = opts.threshold ?? RELEVANCE_THRESHOLD;

  const scores = index.scorer.scoreChunks(query);
  const ranked = index.chunks
    .map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);

  const topScore = ranked.length > 0 ? ranked[0].score : 0;

  const chunks: RetrievedChunk[] = ranked
    .filter((r) => r.score >= threshold)
    .slice(0, topK)
    .map((r) => ({
      sourceId: r.chunk.sourceId,
      sourceTitle: r.chunk.sourceTitle,
      chunkId: r.chunk.chunkId,
      excerpt: boundExcerpt(r.chunk.text),
      score: r.score,
    }));

  return { chunks, topScore, noSourceFound: chunks.length === 0 };
}

/**
 * Project cited chunks to the outbound-to-model shape (drops `score`), bounded
 * to {@link MAX_RETRIEVED_DOCS}. This is what M51 will attach to
 * `AiContextInput.retrievedDocs`; the Rust sanitizer scrubs it again before it
 * can leave the machine.
 */
export function toRetrievedDocs(
  chunks: readonly RetrievedChunk[],
  max = MAX_RETRIEVED_DOCS,
): RetrievedDoc[] {
  return chunks.slice(0, max).map((c) => ({
    sourceId: c.sourceId,
    sourceTitle: c.sourceTitle,
    chunkId: c.chunkId,
    excerpt: c.excerpt,
  }));
}
