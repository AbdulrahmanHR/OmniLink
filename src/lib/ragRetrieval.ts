/**
 * Chat-facing RAG retrieval (M51). Thin, pure wrapper over the M50 local
 * retrieval pipeline that a chat turn (and the pre-send preview) call to get the
 * trusted excerpts for a question — kept offline and client-side (no network).
 *
 * Adds two things on top of `retrieve()`:
 *  - **Enabled-source gating (respect `useKnowledgeStore`).** Retrieval is
 *    scoped to the currently-enabled knowledge sources; a disabled source's
 *    chunks are excluded before the threshold decision, so turning a source off
 *    genuinely removes it from grounding. An empty enabled set ⇒ "no source
 *    found" with no docs (never fabricate a citation).
 *  - **Both outbound shapes at once:** the UI `RetrievedChunk[]` (with scores,
 *    for citation cards) AND the outbound `RetrievedDoc[]` (for the model
 *    context), from a single retrieval so citations and grounding never diverge.
 */

import {
  DEFAULT_TOP_K,
  getRetrievalIndex,
  retrieve,
  toRetrievedDocs,
  type RetrievalIndex,
  type RetrievedChunk,
  type RetrievedDoc,
} from "@/lib/knowledge";

/** The result of a chat retrieval — citation chunks + outbound docs + D19 flag. */
export interface ChatRetrieval {
  /** Cited chunks (with scores) for the citation cards. */
  chunks: RetrievedChunk[];
  /** Outbound-to-model docs (no scores) for `AiContextInput.retrievedDocs`. */
  docs: RetrievedDoc[];
  /** Best chunk score seen (before enabled-source filtering); 0 when none. */
  topScore: number;
  /** True when nothing clears the D19 threshold from an enabled source. */
  noSourceFound: boolean;
}

/** Options for {@link retrieveForChat}. */
export interface RetrieveForChatOptions {
  /**
   * Ids of the knowledge sources currently enabled. When provided, only chunks
   * from these sources are eligible. `undefined` ⇒ every source is eligible.
   */
  enabledSourceIds?: ReadonlySet<string>;
  /** Retrieval index to score against (defaults to the app's bundled index). */
  index?: RetrievalIndex;
  /** Max cited chunks to keep after gating (defaults to {@link DEFAULT_TOP_K}). */
  topK?: number;
}

/** The empty (no-source-found) retrieval, shared by the early-outs. */
function emptyRetrieval(topScore = 0): ChatRetrieval {
  return { chunks: [], docs: [], topScore, noSourceFound: true };
}

/**
 * Retrieve the trusted excerpts for a chat query, scoped to the enabled sources.
 * Pure + deterministic + offline. An empty/whitespace query or an empty enabled
 * set short-circuits to "no source found".
 */
export function retrieveForChat(
  query: string,
  opts: RetrieveForChatOptions = {},
): ChatRetrieval {
  const trimmed = query.trim();
  if (trimmed.length === 0) return emptyRetrieval();

  const enabled = opts.enabledSourceIds;
  // An explicit, empty enabled set means the user turned every source off.
  if (enabled && enabled.size === 0) return emptyRetrieval();

  const index = opts.index ?? getRetrievalIndex();
  const topK = opts.topK ?? DEFAULT_TOP_K;

  // Retrieve the FULL above-threshold ranking, then filter to enabled sources
  // BEFORE trimming to topK, so a disabled source that fills the top hits can
  // never starve an enabled source whose qualifying match ranks lower. The
  // scorer already scores the whole corpus, so an unbounded pre-filter window is
  // free — capping it (e.g. to MAX_RETRIEVED_DOCS) would reintroduce the
  // starvation this ordering is meant to prevent.
  const raw = retrieve(trimmed, index, { topK: index.chunks.length });

  const eligible = enabled
    ? raw.chunks.filter((c) => enabled.has(c.sourceId))
    : raw.chunks;
  const chunks = eligible.slice(0, topK);

  if (chunks.length === 0) return emptyRetrieval(raw.topScore);

  return {
    chunks,
    docs: toRetrievedDocs(chunks),
    topScore: raw.topScore,
    noSourceFound: false,
  };
}
