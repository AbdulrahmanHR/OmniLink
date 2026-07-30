import { describe, expect, it, vi } from "vitest";

/**
 * v2.0 DIAGNOSTICS OFFLINE REGRESSION (M41) — the whole Smart Diagnostics line runs
 * PURELY in-process, with **no account and no network**.
 *
 * The v2.0 doc's core promise is that the diagnostic engine and every finding stay
 * "free and local, with no account and no upload" (`v2.0_MILESTONES.md` §"Relationship
 * to the v2.1 Platform line"). This regression locks that guarantee by driving the
 * full M36 → M38 → M40 pipeline over the on-disk DL2 corpus with the Tauri IPC seam
 * mocked OFF (`isTauri()` false, every `invoke` rejects — exactly as in a bare browser
 * / disconnected machine). The pipeline must return REAL results without ever touching
 * the seam:
 *
 *  - M36 `evaluateSession` → findings on a failing fixture;
 *  - M38 `detectSessionPatterns` → a pattern on a recurring fixture;
 *  - M40 `summarizeSessionForHistory` + `summarizeTrends` + `deriveSuggestions` →
 *    a trend + a conservative suggestion from ≥3 synthesized records.
 *
 * The one hard proof it is free + local: the mocked-off `invoke` is asserted NEVER
 * called across the whole pipeline. If any step secretly needed Tauri/network/account
 * the spy would register a call (or the reject would surface). It doesn't — the engine
 * is pure TypeScript. This is the unit half of the M41 offline gate; the e2e half (the
 * panels rendering with the network aborted) lives in `tests/e2e/offline.spec.ts`.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.reject(new Error("offline"))),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: tauri.invoke,
}));

import { isTauri } from "@tauri-apps/api/core";
import type { ParsedLog } from "@/lib/blackbox";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  detectSessionPatterns,
  deriveSuggestions,
  evaluateSession,
  summarizeSessionForHistory,
  summarizeTrends,
  type DiagnosticHistoryRecord,
} from "@/lib/diagnostics";
import { loadAllFixtures } from "./diagnostics/fixtures";

const FIXTURES = loadAllFixtures();
const wiringFixtures = FIXTURES.filter((f) => f.label === "wiring");
const failing = (file: string): ParsedLog =>
  FIXTURES.find((f) => f.file.includes(file))!.log;

/** Build ≥3 device-scoped history records from real analyzed wiring sessions. */
function synthesizeRecords(): DiagnosticHistoryRecord[] {
  return wiringFixtures.slice(0, 3).map((fx, i) => {
    const report = evaluateSession(fx.log, DEFAULT_DIAGNOSTIC_CONFIG);
    const patternReport = detectSessionPatterns(fx.log, report);
    const summary = summarizeSessionForHistory(report, patternReport, fx.log);
    // The impure `recordedAt`/`deviceKey` axes (normally the store's job) are filled
    // here so the PURE trends/suggestions engine has something to aggregate.
    return { ...summary, recordedAt: i + 1, deviceKey: "test-device|1", deviceLabel: "TestTX" };
  });
}

describe("v2.0 diagnostics run offline + account-free (Tauri mocked OFF)", () => {
  it("the Tauri seam is genuinely mocked off in this suite (isTauri === false)", () => {
    expect(isTauri()).toBe(false);
  });

  it("M36 evaluateSession finds findings on a failing fixture — no IPC/network", () => {
    const report = evaluateSession(failing("wiring-multi-drop-04"), DEFAULT_DIAGNOSTIC_CONFIG);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.healthScore).toBeGreaterThanOrEqual(0);
    expect(report.healthScore).toBeLessThanOrEqual(100);
  });

  it("M38 detectSessionPatterns raises a pattern on a recurring fixture", () => {
    const log = failing("wiring-multi-drop-04");
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const patternReport = detectSessionPatterns(log, report);
    expect(patternReport.hasEnoughEvidence).toBe(true);
    expect(patternReport.patterns.map((p) => p.patternId)).toContain("repeated-lq-drops");
  });

  it("M40 trends + suggestions derive from ≥3 synthesized records, fully local", () => {
    expect(wiringFixtures.length).toBeGreaterThanOrEqual(3);
    const trends = summarizeTrends(synthesizeRecords());
    expect(trends.hasEnoughHistory).toBe(true);
    expect(trends.sessionCount).toBe(3);
    expect(trends.devices).toHaveLength(1);
    // The wiring class recurs lq-collapse + rssi-floor across all 3 sessions.
    expect(trends.devices[0].repeatedEvents.length).toBeGreaterThan(0);

    const suggestions = deriveSuggestions(trends);
    expect(suggestions.length).toBeGreaterThan(0);
    // The intermittent-connection signature (rssi-floor AND lq-collapse recurring)
    // yields the wiring/power suspicion suggestion — a real, local recommendation.
    expect(suggestions.map((s) => s.id)).toContain("wiring-power-suspicion");
  });

  it("the whole pipeline touched NO Tauri/account/network seam", () => {
    // Run the full M36 → M38 → M40 pipeline once more and prove it resolved entirely
    // in-process: the mocked-off `invoke` was never called anywhere in this file.
    const log = failing("wiring-multi-drop-04");
    const report = evaluateSession(log, DEFAULT_DIAGNOSTIC_CONFIG);
    const patternReport = detectSessionPatterns(log, report);
    const summary = summarizeSessionForHistory(report, patternReport, log);
    deriveSuggestions(summarizeTrends(synthesizeRecords()));

    expect(summary.signature).toBeTruthy();
    // The one hard proof this is free + local: the Tauri IPC seam was never invoked.
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
