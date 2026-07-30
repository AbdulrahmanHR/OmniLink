/**
 * Diagnostic-history store tests (M40) — the impure home for per-session summaries.
 *
 * The store adds no analysis logic, so these tests assert wiring: signature dedupe
 * (re-recording the same content updates in place, never duplicates), the
 * newest-first cap eviction, and clear()/reset() emptying the history so the trend
 * state genuinely disappears. Inputs are inline pure data; nothing reads
 * `Date.now`/`Math.random`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticHistoryRecord } from "@/lib/diagnostics";
import {
  DIAGNOSTICS_HISTORY_CAP,
  useDiagnosticsHistoryStore,
} from "@/stores/diagnosticsHistory";

const store = () => useDiagnosticsHistoryStore.getState();

beforeEach(() => {
  useDiagnosticsHistoryStore.setState({ records: [] });
});

function rec(over: Partial<DiagnosticHistoryRecord> = {}): DiagnosticHistoryRecord {
  return {
    signature: "sig-1",
    source: "omnilog",
    sampleCount: 100,
    durationMs: 4000,
    healthScore: 90,
    countsBySeverity: { info: 0, warning: 0, critical: 0 },
    ruleCounts: {},
    patternIds: [],
    packetRate: null,
    recordedAt: 1000,
    deviceKey: "dev-a|fw",
    deviceLabel: "dev-a",
    ...over,
  };
}

describe("recordSession", () => {
  it("prepends new records newest-first", () => {
    store().recordSession(rec({ signature: "a", recordedAt: 1 }));
    store().recordSession(rec({ signature: "b", recordedAt: 2 }));
    expect(store().records.map((r) => r.signature)).toEqual(["b", "a"]);
  });

  it("dedupes by signature — a re-record updates in place, never duplicates", () => {
    store().recordSession(rec({ signature: "a", healthScore: 90, recordedAt: 1 }));
    store().recordSession(rec({ signature: "b", recordedAt: 2 }));
    // Re-record signature "a" with a new health score + timestamp.
    store().recordSession(rec({ signature: "a", healthScore: 42, recordedAt: 3 }));

    expect(store().records).toHaveLength(2);
    // The updated "a" moved to the head with its new value.
    expect(store().records[0].signature).toBe("a");
    expect(store().records[0].healthScore).toBe(42);
    // No duplicate signature remains.
    const sigs = store().records.map((r) => r.signature);
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it("caps at DIAGNOSTICS_HISTORY_CAP, evicting the oldest", () => {
    for (let i = 0; i < DIAGNOSTICS_HISTORY_CAP + 5; i++) {
      store().recordSession(rec({ signature: `s${i}`, recordedAt: i }));
    }
    expect(store().records).toHaveLength(DIAGNOSTICS_HISTORY_CAP);
    // Newest at the head; the oldest evicted entirely.
    expect(store().records[0].signature).toBe(`s${DIAGNOSTICS_HISTORY_CAP + 4}`);
    expect(store().records.some((r) => r.signature === "s0")).toBe(false);
  });
});

describe("clear / reset", () => {
  it("clear empties the history", () => {
    store().recordSession(rec({ signature: "a" }));
    expect(store().records.length).toBeGreaterThan(0);
    store().clear();
    expect(store().records).toEqual([]);
  });

  it("reset empties the history", () => {
    store().recordSession(rec({ signature: "a" }));
    store().reset();
    expect(store().records).toEqual([]);
  });
});
