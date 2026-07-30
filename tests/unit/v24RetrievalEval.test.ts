import { describe, expect, it } from "vitest";
import {
  getRetrievalIndex,
  loadAllowedSources,
  runEval,
  retrieve,
  EVAL_PASS_BAR,
  RELEVANCE_THRESHOLD,
  type EvalReport,
  type GoldenItem,
} from "@/lib/knowledge";
import goldenRaw from "../../data/knowledge/eval/golden.json";

/**
 * v2.4 RETRIEVAL EVALUATION AUDIT (M55, D19) — the launch-gate re-audit of the
 * M50 golden eval.
 *
 * This is the D19 audit clause of the acceptance: "cited answers pass the
 * retrieval evaluation threshold." It runs the FROZEN golden set
 * (`data/knowledge/eval/golden.json`) — which M55 widened with edge cases
 * (in-corpus paraphrases + clearly-out-of-corpus questions) — against the
 * BUNDLED app index (`getRetrievalIndex()`) at the FROZEN `RELEVANCE_THRESHOLD`
 * (0.18), and makes the D19 threshold + pass-bar the explicit assertions:
 *
 *  - in-corpus top-source accuracy ≥ `EVAL_PASS_BAR.inCorpusTopSource` (0.90),
 *    i.e. common AND edge-case ELRS questions cite the correct trusted source
 *    at/above the threshold; and
 *  - out-of-corpus no-source rate ≥ `EVAL_PASS_BAR.outOfCorpusNoSource` (1.0),
 *    i.e. every off-topic question returns "no source found" — ZERO false-positive
 *    citations, the D19 "say when no source was found" contract.
 *
 * Unlike `knowledgeEval.test.ts` (which scores over a locally-built index), this
 * gate scores over the SAME memoized index the running app uses, so the launch
 * verdict reflects production retrieval. Pure + deterministic; no clock, no I/O.
 */

const golden = (goldenRaw as { items: GoldenItem[] }).items;

/** Score the frozen golden set over the app's bundled index at the frozen threshold. */
const report: EvalReport = runEval(getRetrievalIndex(), golden);

describe("v2.4 retrieval eval — audited against the frozen D19 threshold + pass-bar", () => {
  it("uses the frozen D19 relevance threshold (0.18), not a relaxed one", () => {
    // The audit must not quietly loosen the bar: assert the exact frozen value.
    expect(RELEVANCE_THRESHOLD).toBe(0.18);
    expect(report.threshold).toBe(RELEVANCE_THRESHOLD);
  });

  it("exercises BOTH common and edge-case questions across every trusted source", () => {
    const inCorpus = golden.filter((g) => g.kind === "in-corpus");
    const outCorpus = golden.filter((g) => g.kind === "out-of-corpus");
    // The set is not thin — a healthy mix of common + edge cases.
    expect(inCorpus.length).toBeGreaterThanOrEqual(16);
    expect(outCorpus.length).toBeGreaterThanOrEqual(8);
    // The M55 edge cases (in-corpus paraphrases + clearly-off-topic) are present.
    const ids = new Set(golden.map((g) => g.id));
    for (const edge of [
      "edge-bind-led-blinking",
      "edge-telemetry-dense-ratio",
      "edge-domain-americas",
      "edge-pinched-antenna",
      "edge-ooc-golf",
      "edge-ooc-coffee",
    ]) {
      expect(ids.has(edge), `missing edge case ${edge}`).toBe(true);
    }
    // Every allowlisted trusted source is represented by ≥1 in-corpus case, so
    // the accuracy number is not an artifact of over-sampling one pack.
    const covered = new Set(
      inCorpus.map((g) => g.expectedSourceId).filter(Boolean),
    );
    for (const source of loadAllowedSources()) {
      expect(
        covered.has(source.metadata.id),
        `no in-corpus case cites ${source.metadata.id}`,
      ).toBe(true);
    }
  });

  it("meets the in-corpus top-source accuracy pass-bar (≥ 0.90)", () => {
    expect(report.inCorpusTopSourceAccuracy).toBeGreaterThanOrEqual(
      EVAL_PASS_BAR.inCorpusTopSource,
    );
  });

  it("meets the out-of-corpus no-source pass-bar (= 1.0, zero false-positive citations)", () => {
    expect(report.outOfCorpusNoSourceRate).toBeGreaterThanOrEqual(
      EVAL_PASS_BAR.outOfCorpusNoSource,
    );
    // Exactly 1.0: not a single off-topic question fabricated a citation.
    expect(report.outOfCorpusNoSourceRate).toBe(1);
  });

  it("passes the binary M55 launch gate overall", () => {
    expect(report.passes).toBe(true);
  });

  it("reports a per-case breakdown with ZERO failures (names any regression)", () => {
    expect(report.cases).toHaveLength(golden.length);
    const failures = report.cases.filter((c) => !c.pass);
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
  });

  it("every in-corpus HIT genuinely cleared the threshold (not a below-bar match)", () => {
    // A pass must mean the cited chunk really scored at/above the frozen
    // threshold — proving the accuracy number is honest, not threshold-relaxed.
    for (const c of report.cases) {
      if (c.kind === "in-corpus" && c.pass) {
        expect(c.noSourceFound).toBe(false);
        expect(c.topScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
        expect(c.actualSourceId).toBe(c.expectedSourceId);
      }
    }
  });
});

describe("v2.4 retrieval eval — the D19 'no source found' contract is genuine", () => {
  it("a clearly out-of-corpus question returns noSourceFound over the app index", () => {
    // Directly (not via the golden loop) prove the contract on a fresh off-topic
    // query: nothing clears the threshold, so no citation is fabricated.
    const res = retrieve(
      "What is the airspeed velocity of an unladen swallow?",
      getRetrievalIndex(),
    );
    expect(res.noSourceFound).toBe(true);
    expect(res.chunks).toHaveLength(0);
    expect(res.topScore).toBeLessThan(RELEVANCE_THRESHOLD);
  });

  it("a raised threshold can only REDUCE hits — proving the bar is load-bearing", () => {
    // Sanity check that the threshold actually gates: at an impossibly high
    // threshold, even in-corpus questions fall to no-source. If the number were
    // threshold-independent, this would not change — so it proves genuineness.
    const strict = runEval(getRetrievalIndex(), golden, { threshold: 0.99 });
    expect(strict.inCorpusTopSourceHits).toBeLessThan(
      report.inCorpusTopSourceHits,
    );
    // Off-topic questions still (correctly) find no source at any threshold.
    expect(strict.outOfCorpusNoSourceRate).toBe(1);
  });
});
