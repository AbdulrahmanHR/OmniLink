import { describe, expect, it } from "vitest";
import {
  buildIndex,
  deserializeIndex,
  loadCorpusChunks,
  retrieve,
  serializeIndex,
  type SerializedIndex,
} from "@/lib/knowledge";
import artifact from "../../data/knowledge/index.json";

/**
 * Offline index artifact parity (M50, D15). The committed artifact
 * `data/knowledge/index.json` — generated offline by `build:knowledge-index` —
 * must be byte-identical to a fresh runtime build from the bundled chunks, so
 * the shipped artifact can never silently drift from the corpus. If a pack
 * changes without rerunning the build script, this test goes red.
 */

const runtime = serializeIndex(buildIndex(loadCorpusChunks()));

describe("index.json artifact", () => {
  it("declares the current schema + BM25 scorer", () => {
    const art = artifact as SerializedIndex;
    expect(art.version).toBe(1);
    expect(art.scorer).toBe("bm25");
    expect(art.chunks.length).toBeGreaterThan(0);
  });

  it("is byte-identical to a fresh runtime build (rerun build:knowledge-index if red)", () => {
    expect(artifact).toEqual(runtime);
  });

  it("deserializes into an index that retrieves identically to the runtime build", () => {
    const fromArtifact = deserializeIndex(artifact as SerializedIndex);
    const fromRuntime = buildIndex(loadCorpusChunks());
    for (const q of [
      "How do I bind my receiver?",
      "telemetry ratio",
      "dynamic transmit power",
    ]) {
      const a = retrieve(q, fromArtifact);
      const b = retrieve(q, fromRuntime);
      expect(a.chunks.map((c) => c.chunkId)).toEqual(
        b.chunks.map((c) => c.chunkId),
      );
      expect(a.topScore).toBeCloseTo(b.topScore, 10);
    }
  });
});
