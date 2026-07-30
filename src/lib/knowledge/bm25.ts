/**
 * Lexical BM25 retrieval index for the local RAG pipeline (M50, D15).
 *
 * A pure-TypeScript BM25/TF-IDF index over trusted-pack {@link Chunk}s — NO ML
 * model, NO ONNX, NO heavy deps, NO live cloud call. It is generated offline at
 * build time (`scripts/build-knowledge-index.ts` → `data/knowledge/index.json`)
 * and rebuilt identically at app start (`corpus.ts`); tests build it directly
 * from chunks. Deterministic given the same chunks.
 *
 * The scorer sits behind a {@link Scorer} SEAM so a future on-device vector model
 * can replace BM25 without touching `retrieve.ts`, the UI, or the sanitizer.
 *
 * Normalization (the D19-critical part): each chunk's raw BM25 is mapped to a
 * `[0, 1]` score = IDF-weighted query-term coverage with TF saturation. Query
 * terms absent from the corpus carry the HIGHEST idf and contribute 0, so an
 * out-of-corpus query is dragged toward 0 while a well-covered in-corpus query
 * approaches its saturation ceiling. This is what separates in- from
 * out-of-corpus around {@link RELEVANCE_THRESHOLD} — tuned here, not by changing
 * the frozen constant.
 */

import type { Chunk } from "./chunk";

/** BM25 term-frequency saturation. */
const K1 = 1.5;
/** BM25 length normalization strength. */
const B = 0.75;

/** Common English words that carry no retrieval signal for this corpus. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "at", "by", "from", "up", "as", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "i", "you", "your",
  "my", "me", "we", "our", "they", "them", "he", "she", "do", "does", "did",
  "how", "what", "why", "when", "where", "which", "who", "can", "could", "will",
  "would", "should", "if", "then", "so", "than", "too", "very", "just", "not",
  "no", "yes", "get", "got", "into", "out", "about", "over", "some", "any",
  "all", "more", "most", "there", "here", "have", "has", "had", "use", "using",
]);

/**
 * Normalize a token to a stem so plural/gerund variants unify (`binding`/`bind`,
 * `rates`/`rate`, `antennas`/`antenna`). Iterated to a fixed point so
 * `settings` and `setting` collapse to the same stem regardless of the starting
 * form. Applied IDENTICALLY to documents and queries, so consistency — not
 * linguistic correctness — is what matters.
 */
function stem(word: string): string {
  let w = word;
  for (;;) {
    if (w.length > 5 && w.endsWith("ing")) {
      w = w.slice(0, -3);
      // Collapse a doubled final consonant left by the gerund so the base form
      // unifies: `dropping`→`dropp`→`drop`, `setting`→`sett`→`set`.
      if (w.length > 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(w)) {
        w = w.slice(0, -1);
      }
      continue;
    }
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) {
      w = w.slice(0, -1);
      continue;
    }
    break;
  }
  return w;
}

/**
 * Tokenize free text into stemmed, stopword-filtered terms. Lowercased,
 * split on any non-alphanumeric run, length ≥ 2. Pure and deterministic.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const term = stem(raw);
    if (term.length >= 2 && !STOPWORDS.has(term)) out.push(term);
  }
  return out;
}

/** Distinct stemmed query terms, order-preserving. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(query)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** The pluggable relevance seam — BM25 today, a vector model later. */
export interface Scorer {
  /** Discriminator for the active scorer implementation. */
  readonly kind: string;
  /** Normalized `[0, 1]` relevance per chunk, index-aligned to `chunks`. */
  scoreChunks(query: string): number[];
  /** Which query terms actually occur in a given chunk (for the debug surface). */
  matchedTerms(query: string, chunkIndex: number): string[];
}

/** A built index: the chunks plus the scorer bound to them. */
export interface RetrievalIndex {
  readonly chunks: readonly Chunk[];
  readonly scorer: Scorer;
}

/** BM25 IDF (always ≥ 0); `df = 0` (out-of-corpus term) ⇒ the largest idf. */
function idf(df: number, n: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Precomputed per-chunk term frequencies + lengths + document frequencies. */
interface Bm25Data {
  /** Per-chunk `term -> frequency`. */
  termFreqs: Map<string, number>[];
  /** Per-chunk token count. */
  docLengths: number[];
  /** Corpus `term -> document frequency`. */
  docFreqs: Map<string, number>;
  /** Chunk count. */
  n: number;
  /** Mean token count across chunks. */
  avgDocLength: number;
}

function computeBm25Data(chunks: readonly Chunk[]): Bm25Data {
  const termFreqs: Map<string, number>[] = [];
  const docLengths: number[] = [];
  const docFreqs = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    // The heading contributes its terms naturally (a light, honest boost).
    const tokens = tokenize(`${chunk.title} ${chunk.text}`);
    const tf = new Map<string, number>();
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1);
    termFreqs.push(tf);
    docLengths.push(tokens.length);
    totalLength += tokens.length;
    for (const term of tf.keys()) {
      docFreqs.set(term, (docFreqs.get(term) ?? 0) + 1);
    }
  }

  const n = chunks.length;
  return {
    termFreqs,
    docLengths,
    docFreqs,
    n,
    avgDocLength: n > 0 ? totalLength / n : 0,
  };
}

/** BM25 scorer over precomputed data, exposing the {@link Scorer} seam. */
function makeBm25Scorer(data: Bm25Data): Scorer {
  const { termFreqs, docLengths, docFreqs, n, avgDocLength } = data;

  return {
    kind: "bm25",

    scoreChunks(query: string): number[] {
      const terms = queryTerms(query);
      if (terms.length === 0 || n === 0) return new Array(n).fill(0);

      // Denominator = Σ idf over ALL query terms, including out-of-corpus ones
      // (df = 0 ⇒ large idf). Present terms fill the numerator; absent ones only
      // inflate the denominator, so coverage drives the normalized score.
      const idfs = terms.map((t) => idf(docFreqs.get(t) ?? 0, n));
      const denom = idfs.reduce((s, v) => s + v, 0);
      if (denom <= 0) return new Array(n).fill(0);

      const scores = new Array<number>(n);
      for (let c = 0; c < n; c += 1) {
        const tf = termFreqs[c];
        const lengthNorm = 1 - B + (B * docLengths[c]) / (avgDocLength || 1);
        let num = 0;
        for (let i = 0; i < terms.length; i += 1) {
          const f = tf.get(terms[i]) ?? 0;
          if (f === 0) continue;
          const sat = (f * (K1 + 1)) / (f + K1 * lengthNorm);
          // sat ∈ [0, K1+1]; map to a per-term presence strength in [0, 1].
          const s = Math.min(1, sat / (K1 + 1));
          num += idfs[i] * s;
        }
        scores[c] = Math.min(1, Math.max(0, num / denom));
      }
      return scores;
    },

    matchedTerms(query: string, chunkIndex: number): string[] {
      const tf = termFreqs[chunkIndex];
      if (tf === undefined) return [];
      return queryTerms(query).filter((t) => (tf.get(t) ?? 0) > 0);
    },
  };
}

/** Build a BM25 {@link RetrievalIndex} over the given chunks. Deterministic. */
export function buildIndex(chunks: readonly Chunk[]): RetrievalIndex {
  const snapshot = chunks.slice();
  return {
    chunks: snapshot,
    scorer: makeBm25Scorer(computeBm25Data(snapshot)),
  };
}

// ---------------------------------------------------------------------------
// Offline artifact (de)serialization (D15): the index is generated at build
// time into data/knowledge/index.json and loaded at app start. The serialized
// form is deterministic so a committed artifact can be diffed / parity-checked
// against a fresh runtime build.
// ---------------------------------------------------------------------------

/** JSON-safe serialized index artifact. */
export interface SerializedIndex {
  /** Artifact schema version — bump if the shape changes. */
  version: 1;
  /** Active scorer kind (documents which model produced the artifact). */
  scorer: string;
  chunks: Chunk[];
}

/** Serialize an index to its deterministic JSON artifact form. */
export function serializeIndex(index: RetrievalIndex): SerializedIndex {
  return {
    version: 1,
    scorer: index.scorer.kind,
    chunks: index.chunks.map((c) => ({
      sourceId: c.sourceId,
      sourceTitle: c.sourceTitle,
      chunkId: c.chunkId,
      title: c.title,
      text: c.text,
    })),
  };
}

/** Rebuild a live index from a serialized artifact (BM25 stats recomputed). */
export function deserializeIndex(raw: SerializedIndex): RetrievalIndex {
  return buildIndex(raw.chunks);
}
