/**
 * M39a — the pure diagnostics-aggregate builders that feed the BYOK AI
 * "explain this finding" / "ask about this session" evidence.
 *
 * `diagnosticsContextFromExport` / `diagnosticsContextFromFinding` must be
 * deterministic (two runs deep-equal), identifier-free (no lat/lon/gps/coord/geo/
 * uid/mac/email/serial in any key or free-form string value, all numbers finite) —
 * INCLUDING a session that fires `gps-area-degradation`, proving no coordinate can
 * escape — and carry the right `scope` + shape per builder. The authoritative
 * redaction still runs Rust-side in `sanitize_context()`; these builders only gather
 * the already-safe aggregate.
 */

import { describe, expect, it } from "vitest";
import type { LogGpsFix, ParsedLog } from "@/lib/blackbox";
import {
  buildDiagnosticExport,
  detectSessionPatterns,
  evaluateSession,
  DEFAULT_DIAGNOSTIC_CONFIG,
} from "@/lib/diagnostics";
import {
  diagnosticsContextFromExport,
  diagnosticsContextFromFinding,
} from "@/lib/aiContext";
import { buildLog } from "./diagnostics/fixtures";

const IDENTIFIER_TOKEN = /lat|lon|lng|gps|coord|geo|uid|mac|email|serial/i;

/**
 * The complete aggregate `detail` vocabulary across every M36 rule + M38 detector.
 * A key outside this set in a produced diagnostics context would be a coordinate /
 * cell-key / index leak — the numeric scan alone can't catch those, so the builder
 * tests pin the keyset against this exact whitelist.
 */
const ALLOWED_DETAIL_KEYS = new Set([
  // M36 rule details
  "from", "to", "rssi", "stdDev", "window", "changes", "txPower", "avgRssi",
  // M38 pattern details
  "drops", "lowestLq", "sectorDeg", "sectorLq", "baselineLq", "sectors",
  "areas", "passes", "areaLq", "events", "maxTxRampMw", "packetRateChanges",
]);

/**
 * Enum-label fields whose VALUE is a fixed vocabulary constant (e.g. `patternId`
 * "gps-area-degradation" legitimately contains "gps"). Their KEYS are still
 * checked; only their controlled VALUE is exempt from the identifier-substring
 * scan — every free-form `detail` value is still scanned.
 */
const ENUM_LABEL_KEYS = new Set(["scope", "ruleId", "patternId", "category", "severity"]);

/** Recursively assert no identifier-shaped key or free-form value, finite numbers only. */
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

/** A synthetic session with a couple of LQ collapses (so it has findings). */
function collapseLog(): ParsedLog {
  const dip = [...new Array(15).fill(95), ...new Array(6).fill(8), ...new Array(9).fill(95)];
  const lq: number[] = [];
  for (let i = 0; i < 4; i++) lq.push(...dip);
  return buildLog({ link_quality: lq, tx_power: lq.map((q) => (q < 50 ? 250 : 100)) });
}

/**
 * A GPS session that fires `gps-area-degradation`: a loop over four cells flown
 * twice, with the third cell recurrently weak (~55%). Exercises the coordinate
 * path of the identifier-safety scan (mirrors the M38 export test's fixture).
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
  return {
    report,
    patternReport,
    exp: buildDiagnosticExport(report, patternReport, log),
  };
}

describe("diagnosticsContextFromExport (M39a, session scope)", () => {
  it("is deterministic across two builds", () => {
    const { exp } = exportOf(collapseLog());
    expect(diagnosticsContextFromExport(exp)).toEqual(
      diagnosticsContextFromExport(exp)
    );
  });

  it("carries scope 'session' and mirrors the export's aggregate", () => {
    const { report, patternReport, exp } = exportOf(collapseLog());
    const ctx = diagnosticsContextFromExport(exp);
    expect(ctx.scope).toBe("session");
    expect(ctx.healthScore).toBe(report.healthScore);
    expect(ctx.countsBySeverity).toEqual(report.sessionSummary.countsBySeverity);
    expect(ctx.hasEnoughEvidence).toBe(patternReport.hasEnoughEvidence);
    expect(ctx.findings).toHaveLength(exp.findings.length);
    expect(ctx.patterns).toHaveLength(exp.patterns.length);
    // Relative seconds carried through from the export windows (not raw indices).
    for (let i = 0; i < ctx.findings.length; i++) {
      expect(ctx.findings[i].startSec).toBe(exp.findings[i].window.startSec);
      expect(ctx.findings[i].endSec).toBe(exp.findings[i].window.endSec);
    }
  });

  it("emits no identifiers and only finite numbers (collapse session)", () => {
    const { exp } = exportOf(collapseLog());
    const ctx = diagnosticsContextFromExport(exp);
    assertSafe(ctx);
    assertSafe(JSON.parse(JSON.stringify(ctx)));
  });

  it("emits no identifiers even for a GPS session firing gps-area-degradation", () => {
    const { patternReport, exp } = exportOf(gpsAreaLog());
    // The coordinate path is genuinely exercised: the pattern is present…
    expect(patternReport.patterns.some((p) => p.patternId === "gps-area-degradation")).toBe(
      true
    );
    const ctx = diagnosticsContextFromExport(exp);
    // …yet no lat/lon/cell coordinate leaks into the aggregate or its serialized form.
    assertSafe(ctx);
    assertSafe(JSON.parse(JSON.stringify(ctx)));

    // Pin builder discipline: the gps-area pattern carries EXACTLY its four aggregate
    // detail keys — a coordinate/cell-key/index key (which `assertSafe`'s numeric +
    // word-substring scan could miss) can never appear.
    const gpsArea = ctx.patterns.find((p) => p.patternId === "gps-area-degradation");
    expect(gpsArea).toBeDefined();
    expect(Object.keys(gpsArea!.detail).sort()).toEqual([
      "areaLq",
      "areas",
      "baselineLq",
      "passes",
    ]);
    // Every detail key anywhere in the produced context stays inside the known
    // aggregate vocabulary (no coordinate/cell/index key sneaks through any row).
    for (const f of ctx.findings) {
      for (const k of Object.keys(f.detail)) {
        expect(ALLOWED_DETAIL_KEYS.has(k), `finding detail key '${k}'`).toBe(true);
      }
    }
    for (const p of ctx.patterns) {
      for (const k of Object.keys(p.detail)) {
        expect(ALLOWED_DETAIL_KEYS.has(k), `pattern detail key '${k}'`).toBe(true);
      }
    }
  });

  it("caps findings and patterns at MAX_DIAGNOSTICS_ROWS", () => {
    const { exp } = exportOf(collapseLog());
    // Fabricate an over-long export by cloning the first finding many times.
    const many = { ...exp, findings: new Array(50).fill(exp.findings[0] ?? {
      ruleId: "lq-collapse",
      category: "link",
      severity: "critical",
      confidence: 1,
      window: { startIndex: 0, endIndex: 1, startSec: 0, endSec: 0 },
      detail: {},
    }) };
    const ctx = diagnosticsContextFromExport(many);
    expect(ctx.findings.length).toBeLessThanOrEqual(32);
  });
});

describe("diagnosticsContextFromFinding (M39a, finding scope)", () => {
  it("is deterministic and carries exactly one finding and no patterns", () => {
    const log = collapseLog();
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const finding = report.findings[0];
    expect(finding).toBeDefined();
    const a = diagnosticsContextFromFinding(finding, log);
    const b = diagnosticsContextFromFinding(finding, log);
    expect(a).toEqual(b);
    expect(a.scope).toBe("finding");
    expect(a.findings).toHaveLength(1);
    expect(a.patterns).toHaveLength(0);
    expect(a.findings[0].ruleId).toBe(finding.ruleId);
  });

  it("derives startSec/endSec from log.time like the M38 export (relative, 1 dp)", () => {
    const log = collapseLog(); // buildLog: 40 ms interval ⇒ index i is i*0.04 s
    const round1 = (n: number): number => Math.round(n * 10) / 10;
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const finding = report.findings[0];
    const ctx = diagnosticsContextFromFinding(finding, log);
    expect(ctx.findings[0].startSec).toBe(round1(finding.evidenceWindow.startIndex * 0.04));
    expect(ctx.findings[0].endSec).toBe(round1(finding.evidenceWindow.endIndex * 0.04));
  });

  it("emits no identifiers and only finite numbers", () => {
    const log = collapseLog();
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    for (const finding of report.findings) {
      const ctx = diagnosticsContextFromFinding(finding, log);
      assertSafe(ctx);
      assertSafe(JSON.parse(JSON.stringify(ctx)));
    }
  });
});
