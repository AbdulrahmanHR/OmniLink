/**
 * App-facing retrieval corpus glue (M50, D15).
 *
 * Bridges the bundled trusted packs (M49's `loadAllowedSources`, vite-glob) to
 * the pure retrieval pipeline. This is the ONLY retrieval module that touches
 * the glob-loaded registry, so the pure `chunk`/`bm25`/`retrieve` modules stay
 * runnable in the offline build script and in isolation.
 *
 * The index is generated offline into `data/knowledge/index.json` by
 * `scripts/build-knowledge-index.ts` and would be loaded at app start; here we
 * BUILD it from the same bundled chunks at first use (memoized) so the app can
 * never drift from a stale artifact. `knowledgeRetrieveIndex.test.ts` proves the
 * committed artifact is byte-identical to this runtime build.
 */

import { loadAllowedSources, type TrustLevel } from "@/lib/knowledge";
import { chunkSources, type Chunk } from "./chunk";
import { buildIndex, type RetrievalIndex } from "./bm25";

/** Chunk the bundled, allowlist-admitted trusted sources (offline, deterministic). */
export function loadCorpusChunks(): Chunk[] {
  return chunkSources(loadAllowedSources());
}

let cached: RetrievalIndex | null = null;

/** The app's retrieval index, built once from the bundled corpus and memoized. */
export function getRetrievalIndex(): RetrievalIndex {
  if (cached === null) cached = buildIndex(loadCorpusChunks());
  return cached;
}

/** Per-source trust + title metadata for the citation UI (reuses M49 data). */
export interface SourceTrustInfo {
  trustLevel: TrustLevel;
  title: string;
}

/** Map `sourceId -> { trustLevel, title }` from the allowlisted registry. */
export function sourceTrustMap(): Record<string, SourceTrustInfo> {
  const out: Record<string, SourceTrustInfo> = {};
  for (const source of loadAllowedSources()) {
    out[source.metadata.id] = {
      trustLevel: source.metadata.trustLevel,
      title: source.metadata.title,
    };
  }
  return out;
}
