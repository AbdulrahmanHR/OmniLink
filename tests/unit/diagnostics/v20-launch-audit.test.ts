/**
 * Consolidated v2.0 launch audit (M41, v2.0.2) — the single FP/recall gate.
 *
 * M36's `dl3-validation.test.ts` records the intermediate-default DL3 numbers;
 * `manifest-acceptance.test.ts` proves the corpus reproduces; `patterns.test.ts`
 * proves the M38 detectors. THIS suite is the M41 launch gate that scores the WHOLE
 * v2.0 diagnostics line — M36 findings + M38 patterns — across ALL THREE sensitivity
 * presets against the ratified DL3 targets (doc §DL3, `v2.0_MILESTONES.md:267-270`):
 *
 *  • **FP ≤ 5%** of healthy fixtures raising any warning-or-higher finding — here
 *    tightened to the achieved **0/12 on every preset**, for BOTH the M36 engine and
 *    the M38 pattern detector (patterns are preset-independent — they run off
 *    `DEFAULT_PATTERN_CONFIG` — but we assert per preset so a future report-shape
 *    change can't silently leak a pattern FP).
 *  • **Recall ≥ 90%** on the labelled windows — asserted on the ratified
 *    `intermediate` preset, with every preset also held to its own MEASURED floor
 *    (regression guard) and the presets asserted correctly ORDERED
 *    (`beginner ≤ intermediate ≤ advanced` — the sensitivity ladder).
 *  • **Severity ceiling** — a warning-labelled fixture never escalates to critical.
 *  • **M38 positives fire** — the antenna fixtures raise heading-degradation and the
 *    recurring/multi-drop fixtures raise repeated-lq-drops.
 *
 * Every number below is MEASURED against the on-disk DL2 corpus, then pinned.
 */

import { describe, expect, it } from "vitest";
import {
  SENSITIVITY_PRESETS,
  detectSessionPatterns,
  evaluateSession,
  type DiagnosticFinding,
  type DiagnosticSensitivity,
} from "@/lib/diagnostics";
import {
  loadAllFixtures,
  windowsOverlap,
  WINDOW_TOLERANCE,
  type ExpectedFinding,
  type LoadedFixture,
} from "./fixtures";

const FIXTURES = loadAllFixtures();
const PRESETS: readonly DiagnosticSensitivity[] = ["beginner", "intermediate", "advanced"];

type FixtureLabel = LoadedFixture["label"];
const EVENT_LABELS: readonly FixtureLabel[] = ["warning", "failsafe", "wiring", "antenna"];

/**
 * Frozen per-preset recall FLOORS — the numbers MEASURED by this audit on the DL2
 * corpus (67 labelled expected findings), pinned so a regression trips the gate:
 *
 *  - `beginner`  = **59/67 = 0.8806** (floored to 0.88). By design the beginner
 *    preset runs HIGHER thresholds (fewer, only-clearer warnings), so it trades
 *    recall for caution — a *deliberate, documented* trade-off, NOT a bug: it still
 *    holds the healthy false-positive rate at 0, and the 8 windows it misses are the
 *    shallowest/briefest events. We do NOT loosen its thresholds to chase 90%.
 *  - `intermediate` = **67/67 = 1.0** — the ratified DL3 baseline (≥ 0.90).
 *  - `advanced`  = **67/67 = 1.0** — most sensitive, so never below intermediate.
 */
const EXPECTED_RECALL: Record<DiagnosticSensitivity, number> = {
  beginner: 0.88,
  intermediate: 1.0,
  advanced: 1.0,
};

/** The owner-ratified DL3 recall floor (doc §DL3) the DEFAULT preset must clear. */
const RATIFIED_RECALL_FLOOR = 0.9;

const isWarnOrHigher = (f: DiagnosticFinding): boolean =>
  f.severity === "warning" || f.severity === "critical";

/** Does any finding reproduce the expected entry (ruleId + severity + window ±tol)? */
function matches(findings: DiagnosticFinding[], expected: ExpectedFinding): boolean {
  const lo = expected.approxWindow.startIndex - WINDOW_TOLERANCE;
  const hi = expected.approxWindow.endIndex + WINDOW_TOLERANCE;
  return findings.some(
    (f) =>
      f.ruleId === expected.ruleId &&
      f.severity === expected.severity &&
      windowsOverlap(f.evidenceWindow.startIndex, f.evidenceWindow.endIndex, lo, hi)
  );
}

/** Recall of all labelled expected findings under one preset. */
function recallForPreset(preset: DiagnosticSensitivity): { matched: number; total: number } {
  const cfg = SENSITIVITY_PRESETS[preset];
  let total = 0;
  let matched = 0;
  for (const fx of FIXTURES) {
    if (fx.expectedFindings.length === 0) continue;
    const { findings } = evaluateSession(fx.log, cfg);
    for (const expected of fx.expectedFindings) {
      total++;
      if (matches(findings, expected)) matched++;
    }
  }
  return { matched, total };
}

const HEALTHY = FIXTURES.filter((f) => f.label === "healthy");

// ---------------------------------------------------------------------------
// False positives — M36 findings AND M38 patterns, on every preset.
// ---------------------------------------------------------------------------

describe("M41 audit — false positives (all presets, M36 + M38)", () => {
  it("has the expected 12-fixture healthy control", () => {
    expect(HEALTHY.length).toBe(12);
  });

  for (const preset of PRESETS) {
    it(`${preset}: 0 healthy fixtures raise any warning-or-higher M36 finding`, () => {
      const cfg = SENSITIVITY_PRESETS[preset];
      const offenders = HEALTHY.filter((f) =>
        evaluateSession(f.log, cfg).findings.some(isWarnOrHigher)
      ).map((f) => f.file);
      const fpRate = offenders.length / HEALTHY.length;
      // eslint-disable-next-line no-console
      console.log(`M41 FP[M36] ${preset} = ${offenders.length}/${HEALTHY.length} = ${fpRate.toFixed(3)}`);
      expect(offenders).toEqual([]);
      expect(fpRate).toBeLessThanOrEqual(0.05);
    });

    it(`${preset}: 0 healthy fixtures raise any M38 session pattern`, () => {
      const cfg = SENSITIVITY_PRESETS[preset];
      const offenders: string[] = [];
      for (const f of HEALTHY) {
        const report = evaluateSession(f.log, cfg);
        const patternReport = detectSessionPatterns(f.log, report);
        expect(patternReport.hasEnoughEvidence, `${f.file} too short?`).toBe(true);
        if (patternReport.patterns.length > 0) {
          offenders.push(`${f.file}: ${patternReport.patterns.map((p) => p.patternId).join(",")}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`M41 FP[M38] ${preset} = ${offenders.length}/${HEALTHY.length}`);
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Recall — per preset, ratified floor, pinned floors, monotonic ordering.
// ---------------------------------------------------------------------------

describe("M41 audit — recall (all presets, ratified + monotonic)", () => {
  it("logs the per-preset / per-class recall breakdown for the audit record", () => {
    for (const preset of PRESETS) {
      const cfg = SENSITIVITY_PRESETS[preset];
      const perClass = new Map<FixtureLabel, { total: number; matched: number }>();
      for (const label of EVENT_LABELS) perClass.set(label, { total: 0, matched: 0 });
      let total = 0;
      let matched = 0;
      for (const fx of FIXTURES) {
        if (fx.expectedFindings.length === 0) continue;
        const { findings } = evaluateSession(fx.log, cfg);
        const bucket = perClass.get(fx.label)!;
        for (const expected of fx.expectedFindings) {
          total++;
          bucket.total++;
          if (matches(findings, expected)) {
            matched++;
            bucket.matched++;
          }
        }
      }
      const breakdown = EVENT_LABELS.map((label) => {
        const b = perClass.get(label)!;
        return `${label} ${b.matched}/${b.total}`;
      }).join(", ");
      // eslint-disable-next-line no-console
      console.log(
        `M41 recall ${preset} = ${matched}/${total} = ${(matched / total).toFixed(4)} — ${breakdown}`
      );
    }
  });

  it("intermediate (DEFAULT) meets the ratified DL3 floor ≥ 0.90", () => {
    const { matched, total } = recallForPreset("intermediate");
    expect(matched / total).toBeGreaterThanOrEqual(RATIFIED_RECALL_FLOOR);
  });

  for (const preset of PRESETS) {
    it(`${preset}: recall meets its pinned measured floor (${EXPECTED_RECALL[preset]})`, () => {
      const { matched, total } = recallForPreset(preset);
      expect(matched / total).toBeGreaterThanOrEqual(EXPECTED_RECALL[preset]);
    });
  }

  it("recall is monotonic across the sensitivity ladder: beginner ≤ intermediate ≤ advanced", () => {
    const r = (p: DiagnosticSensitivity): number => {
      const { matched, total } = recallForPreset(p);
      return matched / total;
    };
    const beginner = r("beginner");
    const intermediate = r("intermediate");
    const advanced = r("advanced");
    expect(beginner).toBeLessThanOrEqual(intermediate);
    expect(intermediate).toBeLessThanOrEqual(advanced);
  });
});

// ---------------------------------------------------------------------------
// Severity ceiling + M38 positive detections.
// ---------------------------------------------------------------------------

describe("M41 audit — severity ceiling + M38 positives", () => {
  it("no warning-labelled fixture emits a critical finding (any preset)", () => {
    const warningFixtures = FIXTURES.filter((f) => f.label === "warning");
    expect(warningFixtures.length).toBeGreaterThan(0);
    for (const preset of PRESETS) {
      const cfg = SENSITIVITY_PRESETS[preset];
      for (const fx of warningFixtures) {
        const criticals = evaluateSession(fx.log, cfg).findings.filter(
          (f) => f.severity === "critical"
        );
        expect(criticals, `${preset}: ${fx.file} emitted a critical`).toEqual([]);
      }
    }
  });

  /** Present pattern ids for a fixture under the DEFAULT engine + M38 detector. */
  function patternIdsOf(log: LoadedFixture["log"]): string[] {
    const report = evaluateSession(log);
    return detectSessionPatterns(log, report).patterns.map((p) => p.patternId);
  }

  it("antenna fixtures raise heading-degradation", () => {
    const antenna = FIXTURES.filter((f) => f.label === "antenna");
    expect(antenna.length).toBeGreaterThan(0);
    for (const fx of antenna) {
      expect(patternIdsOf(fx.log), `${fx.file}`).toContain("heading-degradation");
    }
  });

  it("recurring/multi-drop fixtures raise repeated-lq-drops", () => {
    const recurring = FIXTURES.find((f) => f.file.includes("warning-recurring-dips-07"));
    const multiDrop = FIXTURES.find((f) => f.file.includes("wiring-multi-drop-04"));
    expect(recurring, "warning-recurring-dips-07 fixture present").toBeDefined();
    expect(multiDrop, "wiring-multi-drop-04 fixture present").toBeDefined();
    expect(patternIdsOf(recurring!.log)).toContain("repeated-lq-drops");
    expect(patternIdsOf(multiDrop!.log)).toContain("repeated-lq-drops");
  });
});
