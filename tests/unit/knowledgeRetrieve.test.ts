import { describe, expect, it } from "vitest";
import {
  buildIndex,
  getRetrievalIndex,
  loadAllowedSources,
  loadCorpusChunks,
  retrieve,
  toRetrievedDocs,
  MAX_EXCERPT_CHARS,
  MAX_RETRIEVED_DOCS,
  RELEVANCE_THRESHOLD,
} from "@/lib/knowledge";

/**
 * Retrieval relevance on known ExpressLRS questions (M50, D19). The local
 * pipeline must return the correct top source at/above the frozen threshold for
 * in-corpus questions and `noSourceFound` for out-of-corpus ones, and citation
 * excerpts must NEVER be a full document.
 */

const index = buildIndex(loadCorpusChunks());

/** Full pack content keyed by source id, for the "never a full doc" guard. */
const fullContentById = new Map(
  loadAllowedSources().map((s) => [s.metadata.id, s.content]),
);

interface Case {
  query: string;
  source: string;
}

const IN_CORPUS: Case[] = [
  { query: "How do I bind my receiver to my transmitter?", source: "elrs-binding" },
  { query: "What is a binding phrase?", source: "elrs-binding" },
  { query: "What packet rate should I use for freestyle?", source: "elrs-packet-rates" },
  { query: "What does the telemetry ratio control?", source: "elrs-packet-rates" },
  { query: "How should I set transmit power and dynamic power?", source: "omnilink-notes" },
  { query: "Which regulatory domain do I flash for Europe?", source: "elrs-getting-started" },
];

describe("retrieve — in-corpus relevance", () => {
  for (const { query, source } of IN_CORPUS) {
    it(`returns ${source} at/above threshold for: "${query}"`, () => {
      const result = retrieve(query, index);
      expect(result.noSourceFound).toBe(false);
      expect(result.chunks.length).toBeGreaterThanOrEqual(1);
      expect(result.chunks[0].sourceId).toBe(source);
      expect(result.topScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
      // Every returned chunk cleared the threshold.
      for (const c of result.chunks) {
        expect(c.score).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
      }
    });
  }
});

describe("retrieve — out-of-corpus returns no source", () => {
  const OFF_TOPIC = [
    "What is the best pizza topping to order?",
    "How do I tune a six string acoustic guitar?",
    "asdfqwer zxcv nonsense gibberish tokens",
  ];
  for (const query of OFF_TOPIC) {
    it(`returns noSourceFound for: "${query}"`, () => {
      const result = retrieve(query, index);
      expect(result.noSourceFound).toBe(true);
      expect(result.chunks).toHaveLength(0);
      expect(result.topScore).toBeLessThan(RELEVANCE_THRESHOLD);
    });
  }
});

describe("retrieve — citations are bounded snippets, never a full document", () => {
  it("keeps every excerpt within the cap and strictly shorter than its source", () => {
    for (const { query } of IN_CORPUS) {
      const result = retrieve(query, index);
      for (const c of result.chunks) {
        expect(c.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
        const full = fullContentById.get(c.sourceId);
        expect(full).toBeDefined();
        // The excerpt is a fraction of the whole source, not the whole thing.
        expect(c.excerpt).not.toBe(full);
        expect(c.excerpt.length).toBeLessThan((full as string).length);
      }
    }
  });
});

describe("toRetrievedDocs", () => {
  it("drops the score and bounds the count", () => {
    const result = retrieve("binding phrase receiver", index);
    const docs = toRetrievedDocs(result.chunks);
    expect(docs.length).toBeLessThanOrEqual(MAX_RETRIEVED_DOCS);
    for (const d of docs) {
      expect(d).not.toHaveProperty("score");
      expect(d.sourceId.length).toBeGreaterThan(0);
      expect(d.excerpt.length).toBeGreaterThan(0);
      expect(d.excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    }
  });
});

describe("getRetrievalIndex (app path)", () => {
  it("is memoized and retrieves the same way as a fresh build", () => {
    const a = getRetrievalIndex();
    const b = getRetrievalIndex();
    expect(a).toBe(b); // memoized instance
    const q = "How do I bind my receiver?";
    expect(retrieve(q, a).chunks[0].sourceId).toBe(
      retrieve(q, index).chunks[0].sourceId,
    );
  });
});
