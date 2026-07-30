import { describe, expect, it } from "vitest";
import {
  buildIndex,
  loadCorpusChunks,
  retrieve,
  RETRIEVAL_P95_BUDGET_MS,
} from "@/lib/knowledge";

/**
 * Retrieval performance budget (M50). A single retrieval over the bundled corpus
 * must stay within the frozen interactive p95 budget. The budget is deliberately
 * generous vs. the sub-millisecond reality on this corpus, so the assertion pins
 * "stays interactive" without flaking under CI/WSL jitter.
 */

const index = buildIndex(loadCorpusChunks());

const QUERIES = [
  "How do I bind my receiver to my transmitter?",
  "What packet rate should I use for freestyle?",
  "How should I set transmit power and dynamic power?",
  "Which regulatory domain do I flash for Europe?",
  "What does the telemetry ratio control?",
  "Why does my link keep dropping out at range?",
];

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return sorted[idx];
}

describe("retrieval perf budget", () => {
  it(`stays under the frozen p95 of ${RETRIEVAL_P95_BUDGET_MS}ms`, () => {
    // Warm up (JIT + first-call effects) so the measured window is steady-state.
    for (let i = 0; i < 50; i += 1) retrieve(QUERIES[i % QUERIES.length], index);

    const samples: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const q = QUERIES[i % QUERIES.length];
      const start = performance.now();
      retrieve(q, index);
      samples.push(performance.now() - start);
    }

    expect(p95(samples)).toBeLessThan(RETRIEVAL_P95_BUDGET_MS);
  });
});
