import { describe, expect, it } from "vitest";
import {
  buildIndex,
  loadAllowedSources,
  loadCorpusChunks,
  runEval,
  EVAL_PASS_BAR,
  type GoldenItem,
} from "@/lib/knowledge";
import goldenRaw from "../../data/knowledge/eval/golden.json";

/**
 * Golden retrieval evaluation (M50, D19). Over the labelled golden set, in-corpus
 * questions must return the correct top source (accuracy ≥ 0.90) and
 * out-of-corpus questions must return "no source found" (rate = 1.0) — the frozen
 * EVAL_PASS_BAR, re-audited in M55.
 */

const golden = (goldenRaw as { items: GoldenItem[] }).items;
const index = buildIndex(loadCorpusChunks());

describe("golden set integrity", () => {
  const validSourceIds = new Set(
    loadAllowedSources().map((s) => s.metadata.id),
  );

  it("has a healthy mix of in- and out-of-corpus cases", () => {
    const inC = golden.filter((g) => g.kind === "in-corpus");
    const outC = golden.filter((g) => g.kind === "out-of-corpus");
    expect(inC.length).toBeGreaterThanOrEqual(10);
    expect(outC.length).toBeGreaterThanOrEqual(5);
  });

  it("labels every in-corpus item with a real allowlisted source id", () => {
    for (const item of golden) {
      if (item.kind === "in-corpus") {
        expect(item.expectedSourceId).toBeDefined();
        expect(validSourceIds.has(item.expectedSourceId as string)).toBe(true);
      } else {
        expect(item.expectedSourceId).toBeUndefined();
      }
    }
  });

  it("uses unique case ids", () => {
    const ids = golden.map((g) => g.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});

describe("runEval", () => {
  const report = runEval(index, golden);

  it("meets the frozen in-corpus top-source pass-bar", () => {
    expect(report.inCorpusTopSourceAccuracy).toBeGreaterThanOrEqual(
      EVAL_PASS_BAR.inCorpusTopSource,
    );
  });

  it("meets the frozen out-of-corpus no-source pass-bar", () => {
    expect(report.outOfCorpusNoSourceRate).toBeGreaterThanOrEqual(
      EVAL_PASS_BAR.outOfCorpusNoSource,
    );
    // = 1.0 means zero false-positive citations on off-topic questions.
    expect(report.outOfCorpusNoSourceRate).toBe(1);
  });

  it("passes overall", () => {
    expect(report.passes).toBe(true);
  });

  it("reports a per-case breakdown covering the whole set", () => {
    expect(report.cases).toHaveLength(golden.length);
    const failures = report.cases.filter((c) => !c.pass);
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0);
  });
});
