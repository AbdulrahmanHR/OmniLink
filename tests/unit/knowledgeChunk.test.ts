import { describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  chunkSources,
  loadAllowedSources,
} from "@/lib/knowledge";

/**
 * Chunking correctness (M50): the markdown-aware chunker must produce stable,
 * unique, non-empty, heading-aware chunks over the bundled trusted packs. These
 * properties are what the BM25 index + citation excerpts are built on.
 */

const SAMPLE = `# Title One

Intro paragraph under the H1 heading with a few words to index.

## Section A

First paragraph of section A.

Second paragraph of section A.

## Section B

Only paragraph of section B.
`;

describe("chunkMarkdown", () => {
  const chunks = chunkMarkdown("sample", "Sample Source", SAMPLE);

  it("produces at least one chunk per non-trivial section", () => {
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it("assigns stable, unique, sequential chunk ids", () => {
    const ids = chunks.map((c) => c.chunkId);
    expect(ids).toEqual([...new Set(ids)]); // unique
    expect(ids[0]).toBe("sample#0");
    ids.forEach((id, i) => expect(id).toBe(`sample#${i}`));
  });

  it("is deterministic (same content ⇒ identical chunks)", () => {
    expect(chunkMarkdown("sample", "Sample Source", SAMPLE)).toEqual(chunks);
  });

  it("never emits an empty chunk", () => {
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
  });

  it("labels chunks with the nearest heading (never crosses one)", () => {
    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("Title One");
    expect(titles).toContain("Section A");
    expect(titles).toContain("Section B");
    // A chunk's text never contains a Markdown heading line.
    for (const c of chunks) {
      for (const line of c.text.split("\n")) {
        expect(/^#{1,6}\s/.test(line.trim())).toBe(false);
      }
    }
  });

  it("carries the source id + title onto every chunk", () => {
    for (const c of chunks) {
      expect(c.sourceId).toBe("sample");
      expect(c.sourceTitle).toBe("Sample Source");
    }
  });
});

describe("chunkSources over the bundled corpus", () => {
  const sources = loadAllowedSources();
  const chunks = chunkSources(sources);

  it("chunks every allowlisted source", () => {
    const sourceIds = new Set(chunks.map((c) => c.sourceId));
    for (const s of sources) {
      expect(sourceIds.has(s.metadata.id)).toBe(true);
    }
  });

  it("produces a non-empty, all-non-empty chunk set with unique ids", () => {
    expect(chunks.length).toBeGreaterThan(0);
    const ids = chunks.map((c) => c.chunkId);
    expect(ids).toEqual([...new Set(ids)]);
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
  });
});
