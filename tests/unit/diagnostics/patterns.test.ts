/**
 * M38 session-level pattern detection — mechanics + corpus.
 *
 * "mechanics": synthetic inline logs prove each detector fires on a positive case
 * and stays silent on a negative case, plus the short-session guard, determinism,
 * the no-identifier safety contract, and the sort/`mostLikely` invariants.
 *
 * "corpus": over the real DL2 fixtures, the antenna fixtures raise
 * `heading-degradation`, the recurring/multi-drop fixtures raise
 * `repeated-lq-drops`, and — critically — **every healthy fixture stays entirely
 * pattern-free** (the pattern-detector false-positive guard). A synthetic GPS
 * fixture (the corpus itself carries no coordinates) exercises the area detector.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedLog, LogGpsFix } from "@/lib/blackbox";
import { parseOmniLogCsv } from "@/lib/omnilog";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  detectSessionPatterns,
  evaluateSession,
  MIN_SAMPLES_FOR_PATTERNS,
  type SessionPatternId,
} from "@/lib/diagnostics";
import { buildLog, FIXTURES_DIR, loadAllFixtures } from "./fixtures";

const IDENTIFIER_TOKEN = /lat|lon|lng|gps|coord|geo|uid|mac|email|serial/i;

/** Assert a detail bag has no identifier-shaped KEY or string VALUE, finite numbers. */
function assertSafeDetail(detail: Record<string, number | string>): void {
  for (const [key, value] of Object.entries(detail)) {
    expect(key, `identifier-shaped key "${key}"`).not.toMatch(IDENTIFIER_TOKEN);
    if (typeof value === "number") {
      expect(Number.isFinite(value), `non-finite detail value at "${key}"`).toBe(true);
    } else {
      expect(value, `identifier-shaped value at "${key}"`).not.toMatch(IDENTIFIER_TOKEN);
    }
  }
}

/** Run the full engine + pattern detector over a log. */
function patternsOf(log: ParsedLog) {
  const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
  return detectSessionPatterns(log, report);
}

/** Present pattern ids in a report. */
function idsOf(log: ParsedLog): SessionPatternId[] {
  return patternsOf(log).patterns.map((p) => p.patternId);
}

/**
 * Build a {@link ParsedLog} with a GPS track (buildLog has no gps). Channels are a
 * `{ key: values[] }` map; `gps` is an aligned array of fixes/null.
 */
function buildGpsLog(
  channels: Record<string, number[]>,
  gps: Array<LogGpsFix | null>
): ParsedLog {
  return { ...buildLog(channels), gps };
}

/** Repeat a segment `times` back-to-back. */
function repeat<T>(seg: T[], times: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < times; i++) out.push(...seg);
  return out;
}

// ---------------------------------------------------------------------------
// Mechanics — per-detector positive/negative, guards, determinism, safety
// ---------------------------------------------------------------------------

describe("M38 patterns — short-session guard", () => {
  it("returns hasEnoughEvidence:false below the minimum sample count", () => {
    const short = buildLog({ link_quality: new Array(MIN_SAMPLES_FOR_PATTERNS - 1).fill(95) });
    const rep = patternsOf(short);
    expect(rep.hasEnoughEvidence).toBe(false);
    expect(rep.patterns).toEqual([]);
    expect(rep.mostLikely).toBeNull();
    expect(rep.sampleCount).toBe(MIN_SAMPLES_FOR_PATTERNS - 1);
  });

  it("has enough evidence at the minimum sample count (even if no patterns)", () => {
    const ok = buildLog({ link_quality: new Array(MIN_SAMPLES_FOR_PATTERNS).fill(95) });
    const rep = patternsOf(ok);
    expect(rep.hasEnoughEvidence).toBe(true);
    expect(rep.patterns).toEqual([]);
    expect(rep.mostLikely).toBeNull();
  });
});

describe("M38 patterns — detector A: repeated-lq-drops", () => {
  it("fires on ≥3 lq-collapse drops and stays silent on a steady link", () => {
    // Each dip: high plateau → sharp fall to ~10% → recover. 4 dips.
    const dip = [...new Array(15).fill(95), ...new Array(6).fill(10), ...new Array(9).fill(95)];
    const badLog = buildLog({ link_quality: repeat(dip, 4) });
    const rep = patternsOf(badLog);
    const drops = rep.patterns.find((p) => p.patternId === "repeated-lq-drops");
    expect(drops).toBeDefined();
    expect(Number(drops!.detail.drops)).toBeGreaterThanOrEqual(3);
    expect(drops!.evidenceWindows.length).toBeGreaterThanOrEqual(3);

    const steady = buildLog({ link_quality: new Array(120).fill(95) });
    expect(idsOf(steady)).not.toContain("repeated-lq-drops");
  });
});

describe("M38 patterns — detector B: heading-degradation", () => {
  it("fires on a direction-correlated null and not on a uniform link", () => {
    // Sweep heading 0→360 across 240 samples so each 45° sector holds 30 samples
    // (≥ the absolute floor of 20 AND ≥ 5% of the flight). LQ is ~95 everywhere
    // EXCEPT the 135–180° sector (sector 3), where it collapses to ~45.
    const n = 240;
    const heading: number[] = [];
    const lq: number[] = [];
    for (let i = 0; i < n; i++) {
      const h = (i * 360) / n;
      heading.push(h);
      const s = Math.floor((((h % 360) + 360) % 360) / 45);
      lq.push(s === 3 ? 45 : 95);
    }
    const rep = patternsOf(buildLog({ link_quality: lq, heading }));
    const hd = rep.patterns.find((p) => p.patternId === "heading-degradation");
    expect(hd).toBeDefined();
    expect(hd!.evidenceWindows.length).toBeGreaterThanOrEqual(1);
    expect(Number(hd!.detail.sectorLq)).toBeLessThan(Number(hd!.detail.baselineLq));

    // Uniform LQ across all headings ⇒ spread below threshold ⇒ no fire (M36's job).
    const uniformLq = heading.map(() => 94);
    expect(idsOf(buildLog({ link_quality: uniformLq, heading }))).not.toContain(
      "heading-degradation"
    );
  });

  it("does NOT fire on a brief transient excursion (not direction-correlated)", () => {
    // Case 1 — below the absolute per-sector floor: 120 samples facing ~0°
    // (sector 0, LQ 95) with a short 10-sample excursion to ~200° (sector 4, LQ
    // 40). Sector 4 holds only 10 < 20 samples, so it never even qualifies.
    const heading1 = [...new Array(120).fill(0), ...new Array(10).fill(200)];
    const lq1 = [...new Array(120).fill(95), ...new Array(10).fill(40)];
    expect(idsOf(buildLog({ link_quality: lq1, heading: heading1 }))).not.toContain(
      "heading-degradation"
    );

    // Case 2 — clears the absolute floor (25 ≥ 20) but is a tiny slice of a long
    // flight (25 / 625 = 4% < 5%), so the fraction guard excludes it. Without that
    // guard this long-flight transient would fire.
    const heading2 = [...new Array(600).fill(0), ...new Array(25).fill(200)];
    const lq2 = [...new Array(600).fill(95), ...new Array(25).fill(40)];
    expect(idsOf(buildLog({ link_quality: lq2, heading: heading2 }))).not.toContain(
      "heading-degradation"
    );
  });

  it("resolves alternate heading channel keys (e.g. Betaflight GPS_ground_course)", () => {
    const n = 240;
    const course: number[] = [];
    const lq: number[] = [];
    for (let i = 0; i < n; i++) {
      const h = (i * 360) / n;
      course.push(h);
      lq.push(Math.floor((((h % 360) + 360) % 360) / 45) === 3 ? 45 : 95);
    }
    // The channel is keyed "GPS_ground_course", not "heading".
    expect(idsOf(buildLog({ link_quality: lq, GPS_ground_course: course }))).toContain(
      "heading-degradation"
    );
  });

  it("does not fire when the heading channel is absent", () => {
    const lq = new Array(120).fill(95);
    lq.fill(40, 40, 60); // a dip, but no heading data at all
    expect(idsOf(buildLog({ link_quality: lq }))).not.toContain("heading-degradation");
  });
});

describe("M38 patterns — detector C: gps-area-degradation", () => {
  it("fires on a weak spot revisited ≥2 times and not on a uniform overflight", () => {
    // Two loops over the same 4 cells. In one cell LQ is ~55; elsewhere ~95.
    const cellCoords: Array<[number, number]> = [
      [47.0, 8.0],
      [47.001, 8.0],
      [47.002, 8.0], // the weak cell
      [47.003, 8.0],
    ];
    const gps: Array<LogGpsFix | null> = [];
    const lq: number[] = [];
    for (let loop = 0; loop < 2; loop++) {
      for (let c = 0; c < cellCoords.length; c++) {
        for (let k = 0; k < 20; k++) {
          gps.push({ lat: cellCoords[c][0], lon: cellCoords[c][1] });
          lq.push(c === 2 ? 55 : 95);
        }
      }
    }
    const rep = patternsOf(buildGpsLog({ link_quality: lq }, gps));
    const area = rep.patterns.find((p) => p.patternId === "gps-area-degradation");
    expect(area).toBeDefined();
    expect(Number(area!.detail.passes)).toBeGreaterThanOrEqual(2);
    expect(Number(area!.detail.areaLq)).toBeLessThan(Number(area!.detail.baselineLq));

    // Uniform LQ over the same track ⇒ no bad cell.
    const uniform = lq.map(() => 95);
    expect(idsOf(buildGpsLog({ link_quality: uniform }, gps))).not.toContain(
      "gps-area-degradation"
    );

    // No GPS at all ⇒ silently no area pattern (does not flip hasEnoughEvidence).
    const noGps = patternsOf(buildLog({ link_quality: lq }));
    expect(noGps.hasEnoughEvidence).toBe(true);
    expect(noGps.patterns.map((p) => p.patternId)).not.toContain("gps-area-degradation");
  });

  it("treats a single hover with GPS dropout as ONE pass (not recurring)", () => {
    // Healthy transit through two cells (establishes the ~95% baseline)…
    const gps: Array<LogGpsFix | null> = [];
    const lq: number[] = [];
    for (const c of [
      [46.0, 7.0],
      [46.001, 7.0],
    ] as Array<[number, number]>) {
      for (let k = 0; k < 15; k++) {
        gps.push({ lat: c[0], lon: c[1] });
        lq.push(95);
      }
    }
    // …then a SINGLE continuous hover in a weak cell (~55%), with two interior GPS
    // dropouts. A dropout must NOT split the hover into multiple "passes": the cell
    // is visited once, so it is not recurring and must raise NO pattern. (Before
    // the fix the two nulls made it read as 3 passes ≥ 2 → a false recurrence.)
    for (let k = 0; k < 30; k++) {
      const dropout = k === 10 || k === 20;
      gps.push(dropout ? null : { lat: 47.0, lon: 8.0 });
      lq.push(55);
    }
    expect(idsOf(buildGpsLog({ link_quality: lq }, gps))).not.toContain(
      "gps-area-degradation"
    );
  });
});

describe("M38 patterns — detector D: power-packet-link-events", () => {
  it("fires when TX power ramps around ≥2 link events", () => {
    // Two LQ collapses; TX power sits at 100 mW then ramps to 250 mW into each drop.
    const seg = (): { lq: number[]; tx: number[] } => ({
      lq: [...new Array(20).fill(95), ...new Array(6).fill(8), ...new Array(14).fill(95)],
      tx: [...new Array(20).fill(100), ...new Array(6).fill(250), ...new Array(14).fill(100)],
    });
    const a = seg();
    const b = seg();
    const lq = [...a.lq, ...b.lq];
    const tx = [...a.tx, ...b.tx];
    const rep = patternsOf(buildLog({ link_quality: lq, tx_power: tx }));
    const pp = rep.patterns.find((p) => p.patternId === "power-packet-link-events");
    expect(pp).toBeDefined();
    expect(Number(pp!.detail.events)).toBeGreaterThanOrEqual(2);
    expect(Number(pp!.detail.maxTxRampMw)).toBeGreaterThanOrEqual(100);

    // Same drops but TX power steady ⇒ no correlated power/packet change.
    const steadyTx = tx.map(() => 100);
    expect(idsOf(buildLog({ link_quality: lq, tx_power: steadyTx }))).not.toContain(
      "power-packet-link-events"
    );
  });
});

describe("M38 patterns — determinism, safety, ordering", () => {
  // A rich synthetic log that trips several detectors at once.
  function richLog(): ParsedLog {
    const cell: Array<[number, number]> = [
      [10.0, 20.0],
      [10.001, 20.0],
    ];
    const gps: Array<LogGpsFix | null> = [];
    const lq: number[] = [];
    const tx: number[] = [];
    const heading: number[] = [];
    for (let loop = 0; loop < 2; loop++) {
      for (let c = 0; c < cell.length; c++) {
        for (let k = 0; k < 30; k++) {
          gps.push({ lat: cell[c][0], lon: cell[c][1] });
          const weak = c === 1;
          lq.push(weak ? 40 : 95);
          tx.push(weak ? 250 : 100);
          heading.push(c === 1 ? 150 : 10);
        }
      }
    }
    return buildGpsLog({ link_quality: lq, tx_power: tx, heading }, gps);
  }

  it("is deterministic: two runs are deeply equal", () => {
    const log = richLog();
    expect(patternsOf(log)).toEqual(patternsOf(log));
  });

  it("emits no identifier keys/values and only finite numeric detail values", () => {
    const rep = patternsOf(richLog());
    expect(rep.patterns.length).toBeGreaterThan(0);
    for (const p of rep.patterns) {
      // No identifier-shaped KEY or string VALUE; all numbers finite (this rich
      // log includes the gps-area detector, so the coordinate path is exercised).
      assertSafeDetail(p.detail);
      // Evidence windows are ascending by startIndex.
      for (let i = 1; i < p.evidenceWindows.length; i++) {
        expect(p.evidenceWindows[i].startIndex).toBeGreaterThanOrEqual(
          p.evidenceWindows[i - 1].startIndex
        );
      }
    }
    // The gps-area detector must have run here (the coordinate path is exercised).
    expect(rep.patterns.map((p) => p.patternId)).toContain("gps-area-degradation");
  });

  it("sorts patterns (severity → confidence desc → id) and mostLikely===patterns[0]", () => {
    const rep = patternsOf(richLog());
    const rank = (s: string): number => (s === "critical" ? 0 : s === "warning" ? 1 : 2);
    for (let i = 1; i < rep.patterns.length; i++) {
      const prev = rep.patterns[i - 1];
      const cur = rep.patterns[i];
      const ok =
        rank(prev.severity) < rank(cur.severity) ||
        (rank(prev.severity) === rank(cur.severity) &&
          (prev.confidence > cur.confidence ||
            (prev.confidence === cur.confidence && prev.patternId <= cur.patternId)));
      expect(ok, `unsorted at ${i}`).toBe(true);
    }
    expect(rep.mostLikely).toBe(rep.patterns[0] ?? null);
  });
});

// ---------------------------------------------------------------------------
// Corpus — real DL2 fixtures (false-positive guard is the important one)
// ---------------------------------------------------------------------------

const FIXTURES = loadAllFixtures();

describe("M38 patterns — DL2 corpus", () => {
  it("antenna fixtures raise heading-degradation", () => {
    const antenna = FIXTURES.filter((f) => f.label === "antenna");
    expect(antenna.length).toBeGreaterThan(0);
    for (const fx of antenna) {
      expect(idsOf(fx.log), `${fx.file} should show heading-degradation`).toContain(
        "heading-degradation"
      );
    }
  });

  it("recurring/multi-drop fixtures raise repeated-lq-drops", () => {
    const recurring = FIXTURES.find((f) => f.file.includes("warning-recurring-dips-07"));
    const multiDrop = FIXTURES.find((f) => f.file.includes("wiring-multi-drop-04"));
    expect(recurring).toBeDefined();
    expect(multiDrop).toBeDefined();
    expect(idsOf(recurring!.log)).toContain("repeated-lq-drops");
    expect(idsOf(multiDrop!.log)).toContain("repeated-lq-drops");
  });

  it("EVERY healthy fixture is entirely pattern-free (false-positive guard)", () => {
    const healthy = FIXTURES.filter((f) => f.label === "healthy");
    expect(healthy.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const fx of healthy) {
      const rep = patternsOf(fx.log);
      expect(rep.hasEnoughEvidence, `${fx.file} too short?`).toBe(true);
      expect(rep.mostLikely, `${fx.file} raised a pattern`).toBeNull();
      if (rep.patterns.length > 0) {
        offenders.push(`${fx.file}: ${rep.patterns.map((p) => p.patternId).join(",")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the synthetic GPS fixture raises gps-area-degradation", () => {
    const csv = readFileSync(
      path.join(FIXTURES_DIR, "patterns", "gps-area-recurring-01.csv"),
      "utf8"
    );
    const log = parseOmniLogCsv(csv);
    expect(idsOf(log)).toContain("gps-area-degradation");
  });

  it("the clean GPS fixture raises no gps-area-degradation", () => {
    const csv = readFileSync(
      path.join(FIXTURES_DIR, "patterns", "gps-clean-01.csv"),
      "utf8"
    );
    const log = parseOmniLogCsv(csv);
    expect(idsOf(log)).not.toContain("gps-area-degradation");
  });
});
