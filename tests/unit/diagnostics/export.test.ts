/**
 * M38 deterministic findings export schema.
 *
 * The export is the cross-line artifact M39a (AI explanations) and the v2.5 ML
 * line consume, so these tests hold it to its contract: a stable schema version,
 * determinism, JSON round-trip, correct relative seconds, finding/pattern length
 * fidelity, and — the safety invariant — zero identifier keys with only finite
 * numbers anywhere in the tree.
 */

import { describe, expect, it } from "vitest";
import type { ParsedLog, LogGpsFix } from "@/lib/blackbox";
import {
  buildDiagnosticExport,
  detectSessionPatterns,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  evaluateSession,
  DEFAULT_DIAGNOSTIC_CONFIG,
} from "@/lib/diagnostics";
import { buildLog } from "./fixtures";

const IDENTIFIER_TOKEN = /lat|lon|lng|gps|coord|geo|uid|mac|email|serial/i;

/** A synthetic session with a couple of LQ collapses (so it has findings). */
function collapseLog(): ParsedLog {
  const dip = [...new Array(15).fill(95), ...new Array(6).fill(8), ...new Array(9).fill(95)];
  const lq: number[] = [];
  for (let i = 0; i < 4; i++) lq.push(...dip);
  return buildLog({ link_quality: lq, tx_power: lq.map((q) => (q < 50 ? 250 : 100)) });
}

/**
 * A GPS session that fires `gps-area-degradation`: a loop over four cells flown
 * twice, with the third cell recurrently weak (~55%) and the rest healthy (~95%).
 * Exercises the coordinate path of the export's identifier-safety scan.
 */
function gpsAreaLog(): ParsedLog {
  const cells: Array<[number, number]> = [
    [47.0, 8.0],
    [47.001, 8.0],
    [47.002, 8.0],
    [47.003, 8.0],
  ];
  const gps: Array<LogGpsFix | null> = [];
  const lq: number[] = [];
  for (let loop = 0; loop < 2; loop++) {
    for (let c = 0; c < cells.length; c++) {
      for (let k = 0; k < 20; k++) {
        gps.push({ lat: cells[c][0], lon: cells[c][1] });
        lq.push(c === 2 ? 55 : 95);
      }
    }
  }
  return { ...buildLog({ link_quality: lq }), gps };
}

function exportOf(log: ParsedLog) {
  const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
  const patternReport = detectSessionPatterns(log, report);
  return { report, patternReport, out: buildDiagnosticExport(report, patternReport, log) };
}

/**
 * Controlled-vocabulary label fields whose VALUE is a fixed enum, not free-form
 * data. Their values are still fixed constants (e.g. `patternId` is
 * `"gps-area-degradation"` — a semantic category label that legitimately contains
 * the substring "gps"), so the identifier-substring check is skipped for THEM
 * only. Their KEYS are still checked, and every other string value — crucially the
 * free-form `detail` bags — is still scanned for leaked coordinates/identifiers.
 */
const ENUM_LABEL_KEYS = new Set([
  "schemaVersion",
  "source",
  "ruleId",
  "patternId",
  "category",
  "severity",
]);

/**
 * Recursively assert no identifier-shaped KEY or free-form string VALUE, and only
 * finite numeric leaves — over the whole export tree (arrays + objects). `key` is
 * the immediate parent key of the value being checked.
 */
function assertSafe(value: unknown, keyPath = "", key = ""): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafe(v, `${keyPath}[${i}]`, key));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      expect(k, `identifier-shaped key at ${keyPath}.${k}`).not.toMatch(IDENTIFIER_TOKEN);
      assertSafe(v, `${keyPath}.${k}`, k);
    }
  } else if (typeof value === "number") {
    expect(Number.isFinite(value), `non-finite number at ${keyPath}`).toBe(true);
  } else if (typeof value === "string" && !ENUM_LABEL_KEYS.has(key)) {
    expect(value, `identifier-shaped string value at ${keyPath}`).not.toMatch(
      IDENTIFIER_TOKEN
    );
  }
}

describe("M38 diagnostic export", () => {
  it("carries the stable schema version", () => {
    const { out } = exportOf(collapseLog());
    expect(out.schemaVersion).toBe("1.0.0");
    expect(out.schemaVersion).toBe(DIAGNOSTIC_EXPORT_SCHEMA_VERSION);
  });

  it("is deterministic across two builds", () => {
    const log = collapseLog();
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const patternReport = detectSessionPatterns(log, report);
    expect(buildDiagnosticExport(report, patternReport, log)).toEqual(
      buildDiagnosticExport(report, patternReport, log)
    );
  });

  it("JSON-round-trips to a deeply-equal object", () => {
    const { out } = exportOf(collapseLog());
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("mirrors the findings and patterns lengths of its inputs", () => {
    const { report, patternReport, out } = exportOf(collapseLog());
    expect(out.findings).toHaveLength(report.findings.length);
    expect(out.patterns).toHaveLength(patternReport.patterns.length);
    expect(out.session.sampleCount).toBe(report.sessionSummary.sampleCount);
    expect(out.healthScore).toBe(report.healthScore);
    expect(out.countsBySeverity).toEqual(report.sessionSummary.countsBySeverity);
    expect(out.hasEnoughEvidence).toBe(patternReport.hasEnoughEvidence);
  });

  it("computes startSec/endSec from log.time (relative, 1 dp)", () => {
    // buildLog uses a 40 ms sample interval, so index i is i*0.04 s, rounded to
    // one decimal place in the export.
    const round1 = (n: number): number => Math.round(n * 10) / 10;
    const { out } = exportOf(collapseLog());
    expect(out.findings.length).toBeGreaterThan(0);
    for (const f of out.findings) {
      expect(f.window.startSec).toBe(round1(f.window.startIndex * 0.04));
      expect(f.window.endSec).toBe(round1(f.window.endIndex * 0.04));
      // Exactly one decimal place of resolution.
      expect(Math.round(f.window.startSec * 10) / 10).toBe(f.window.startSec);
    }
  });

  it("emits no identifier keys and only finite numbers anywhere", () => {
    const { out } = exportOf(collapseLog());
    assertSafe(out);
    // Also scan the serialized form (what a consumer actually receives).
    assertSafe(JSON.parse(JSON.stringify(out)));
  });

  it("emits no identifiers even for a GPS session that fires gps-area-degradation", () => {
    const log = gpsAreaLog();
    const { out } = exportOf(log);
    // The coordinate path is genuinely exercised: the pattern is present…
    expect(out.patterns.some((p) => p.patternId === "gps-area-degradation")).toBe(true);
    // …yet no lat/lon/cell key leaks into the export tree or its serialized form.
    assertSafe(out);
    assertSafe(JSON.parse(JSON.stringify(out)));
  });
});
