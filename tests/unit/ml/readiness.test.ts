import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReadinessReport,
  countLabels,
  FIXTURE_SESSIONS_BY_CLASS,
  FIXTURE_SESSION_TOTAL,
  isTrainableLabel,
  READINESS_SCHEMA_VERSION,
  REQUIRED_SESSION_TOTAL,
  TRAINABLE_ML_LABELS,
} from "@/lib/ml/readiness";
import { ML_LABELS, type MlLabel } from "@/lib/ml/dataset";
import { MIN_LABELED_SESSIONS_PER_CLASS } from "@/lib/ml/mlConsts";

/**
 * The data-readiness verdict (M56c).
 *
 * These assertions are the release's honesty gate expressed as code: the D21 bar is
 * unmet on the real corpus, the shortfall is exact, and the report can never let a
 * reader mistake OmniLink's 36 bundled fixtures for sessions they recorded. If a
 * later commit softens any of that, this suite goes red.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** The checked-in v2.0 baseline artifact — the independent source of the corpus counts. */
interface BaselineArtifactShape {
  corpus: {
    sessionCount: number;
    sessionsByClass: Record<string, number>;
  };
  honesty: { d21RequiredSessionsPerClass: number; d21Met: boolean };
}

const artifact = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "data/ml/baseline-v20.json"), "utf8")
) as BaselineArtifactShape;

describe("readiness constants", () => {
  it("pins the schema version", () => {
    expect(READINESS_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("the trainable classes are every canonical label except `unknown`", () => {
    // `unknown` is storable and real ("a human looked and could not tell"), but it
    // is not a class to collect — no D21 quota attaches to it.
    expect([...TRAINABLE_ML_LABELS]).toEqual(
      ML_LABELS.filter((l) => l !== "unknown")
    );
    expect(TRAINABLE_ML_LABELS).toHaveLength(5);
    expect(isTrainableLabel("healthy")).toBe(true);
    expect(isTrainableLabel("unknown")).toBe(false);
  });

  it("the fixture counts match the checked-in baseline artifact (no drift)", () => {
    // Not a tautology: the artifact is produced by `npm run build:ml-baseline` from
    // the fixture manifest, independently of this module's frozen record.
    expect({ ...FIXTURE_SESSIONS_BY_CLASS }).toEqual(artifact.corpus.sessionsByClass);
    expect(FIXTURE_SESSION_TOTAL).toBe(artifact.corpus.sessionCount);
    expect(FIXTURE_SESSION_TOTAL).toBe(36);
  });

  it("the aggregate bar derives from the per-class D21 bar (5 × 300 = 1500)", () => {
    expect(REQUIRED_SESSION_TOTAL).toBe(
      TRAINABLE_ML_LABELS.length * MIN_LABELED_SESSIONS_PER_CLASS
    );
    expect(REQUIRED_SESSION_TOTAL).toBe(1500);
    expect(artifact.honesty.d21RequiredSessionsPerClass).toBe(
      MIN_LABELED_SESSIONS_PER_CLASS
    );
    expect(artifact.honesty.d21Met).toBe(false);
  });
});

describe("countLabels", () => {
  it("initialises every canonical label, `unknown` included", () => {
    expect(countLabels([])).toEqual({
      healthy: 0,
      warning: 0,
      failsafe: 0,
      wiringSuspicion: 0,
      antennaSuspicion: 0,
      unknown: 0,
    });
  });

  it("tallies a flat list of labels", () => {
    const labels: MlLabel[] = [
      "healthy",
      "healthy",
      "failsafe",
      "unknown",
      "antennaSuspicion",
    ];
    expect(countLabels(labels)).toEqual({
      healthy: 2,
      warning: 0,
      failsafe: 1,
      wiringSuspicion: 0,
      antennaSuspicion: 1,
      unknown: 1,
    });
  });
});

describe("buildReadinessReport — the real state of the world (0 user labels)", () => {
  const report = buildReadinessReport();

  it("the bar is NOT met", () => {
    expect(report.barMet).toBe(false);
    expect(report.verdict).toBe("not-enough-data");
    expect(report.indicativeOnly).toBe(true);
    expect(report.perClass.every((c) => c.barMet === false)).toBe(true);
  });

  it("counts 36 of the 1500 labeled sessions the bar requires", () => {
    expect(report.labeledSessionTotal).toBe(36);
    expect(report.requiredTotal).toBe(1500);
    expect(report.requiredPerClass).toBe(300);
    expect(report.shortfallTotal).toBe(1464);
    expect(report.fractionOfBar).toBeCloseTo(0.024, 6);
  });

  it("every one of those 36 is a FIXTURE — the user has labeled nothing", () => {
    expect(report.fixtureSessionTotal).toBe(36);
    expect(report.userLabeledTotal).toBe(0);
    expect(report.userLabeledTrainableTotal).toBe(0);
    expect(report.userLabeledUnknown).toBe(0);
    // The two are never merged into a single "you have 36 sessions" number.
    expect(report.labeledSessionTotal).toBe(
      report.fixtureSessionTotal + report.userLabeledTrainableTotal
    );
  });

  it("per-class shortfalls are exact", () => {
    expect(
      report.perClass.map((c) => [c.label, c.fixtureSessions, c.shortfall])
    ).toEqual([
      ["healthy", 12, 288],
      ["warning", 7, 293],
      ["failsafe", 7, 293],
      ["wiringSuspicion", 5, 295],
      ["antennaSuspicion", 5, 295],
    ]);
    // The per-class shortfalls sum to the aggregate shortfall.
    expect(report.perClass.reduce((s, c) => s + c.shortfall, 0)).toBe(
      report.shortfallTotal
    );
  });

  it("the largest class has 4% of the sessions D21 asks of ONE class", () => {
    const healthy = report.perClass.find((c) => c.label === "healthy")!;
    expect(healthy.fractionOfBar).toBeCloseTo(0.04, 6);
  });

  it("never reports `unknown` as a class the bar applies to", () => {
    expect(report.perClass.map((c) => c.label)).not.toContain("unknown");
  });
});

describe("buildReadinessReport — with user labels", () => {
  it("keeps the user's labels separate from the fixture corpus", () => {
    const report = buildReadinessReport({ healthy: 3, failsafe: 1 });
    const healthy = report.perClass.find((c) => c.label === "healthy")!;

    expect(healthy.fixtureSessions).toBe(12); // OmniLink's, not the user's
    expect(healthy.userLabeledSessions).toBe(3); // the user's own
    expect(healthy.labeledSessions).toBe(15);
    expect(healthy.shortfall).toBe(285);

    expect(report.userLabeledTrainableTotal).toBe(4);
    expect(report.labeledSessionTotal).toBe(40);
    expect(report.shortfallTotal).toBe(1460);
    expect(report.barMet).toBe(false);
  });

  it("`unknown` labels count toward NO class, and are reported separately", () => {
    const report = buildReadinessReport({ unknown: 9 });
    expect(report.userLabeledUnknown).toBe(9);
    expect(report.userLabeledTotal).toBe(9);
    // They move neither the per-class numbers nor the bar.
    expect(report.userLabeledTrainableTotal).toBe(0);
    expect(report.labeledSessionTotal).toBe(36);
    expect(report.shortfallTotal).toBe(1464);
  });

  it("only clears the bar when EVERY class does (~1464 sessions away)", () => {
    // One class at the bar is not the bar.
    const oneClass = buildReadinessReport({ healthy: 288 });
    expect(oneClass.perClass.find((c) => c.label === "healthy")!.barMet).toBe(true);
    expect(oneClass.barMet).toBe(false);
    expect(oneClass.verdict).toBe("not-enough-data");

    const all = buildReadinessReport({
      healthy: 288,
      warning: 293,
      failsafe: 293,
      wiringSuspicion: 295,
      antennaSuspicion: 295,
    });
    expect(all.barMet).toBe(true);
    expect(all.verdict).toBe("bar-met");
    expect(all.indicativeOnly).toBe(false);
    expect(all.shortfallTotal).toBe(0);
    expect(all.labeledSessionTotal).toBe(REQUIRED_SESSION_TOTAL);
  });

  it("clamps hostile counts instead of producing a flattering number", () => {
    const report = buildReadinessReport({
      healthy: -100,
      warning: Number.NaN,
      failsafe: 2.7,
      wiringSuspicion: Number.POSITIVE_INFINITY,
    });
    expect(report.perClass.find((c) => c.label === "healthy")!.userLabeledSessions).toBe(0);
    expect(report.perClass.find((c) => c.label === "warning")!.userLabeledSessions).toBe(0);
    expect(report.perClass.find((c) => c.label === "failsafe")!.userLabeledSessions).toBe(2);
    expect(
      report.perClass.find((c) => c.label === "wiringSuspicion")!.userLabeledSessions
    ).toBe(0);
    expect(report.barMet).toBe(false);
    expect(report.fractionOfBar).toBeLessThanOrEqual(1);
  });

  it("is pure: the same input always yields a deep-equal report", () => {
    expect(buildReadinessReport({ healthy: 2 })).toEqual(
      buildReadinessReport({ healthy: 2 })
    );
  });
});
