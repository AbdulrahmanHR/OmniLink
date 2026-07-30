import { describe, expect, it } from "vitest";
import {
  buildDeleteSessionStatements,
  buildRenameSessionUpdate,
  dbRowToCsvRow,
  dbRowToSessionMeta,
  formatSessionDuration,
  selectSessionsToPrune,
  summarizeSessions,
  type StoredSessionMeta,
} from "@/lib/sessions-db";

/**
 * Build a {@link StoredSessionMeta} for the pure retention/summary suites with
 * sensible defaults; only `sessionId`/`startedAt`/`frameCount` matter to the
 * policy, so the rest are filled in to keep the DTO complete.
 */
function meta(
  partial: Partial<StoredSessionMeta> &
    Pick<StoredSessionMeta, "sessionId" | "startedAt">
): StoredSessionMeta {
  return {
    endedAt: null,
    targetName: null,
    firmware: null,
    name: null,
    frameCount: 0,
    ...partial,
  };
}

// These suites exercise only the PURE mappers, which is the contract the M11
// read seam exposes for testing without a live DB: db.select returns
// loosely-typed rows (snake_case keys; values are number | string | null), and
// the mappers must produce the camelCase DTOs the rest of the app consumes.

describe("dbRowToSessionMeta", () => {
  it("maps telemetry_sessions columns to the camelCase DTO with numeric coercion", () => {
    // SQLite hands back numerics that may arrive as strings; assert coercion.
    const row = dbRowToSessionMeta({
      session_id: "sess-1",
      started_at: "1700000000000",
      ended_at: "1700000005000",
      target_name: "RadioMaster RP3",
      firmware: "3.4.0",
      name: "Maiden flight",
      frame_count: "1234",
    });
    expect(row).toEqual({
      sessionId: "sess-1",
      startedAt: 1700000000000,
      endedAt: 1700000005000,
      targetName: "RadioMaster RP3",
      firmware: "3.4.0",
      name: "Maiden flight",
      frameCount: 1234,
    });
    // Coerced to real numbers, not strings.
    expect(typeof row.startedAt).toBe("number");
    expect(typeof row.endedAt).toBe("number");
    expect(typeof row.frameCount).toBe("number");
  });

  it("preserves nulls for an unclosed session with unknown device metadata", () => {
    const row = dbRowToSessionMeta({
      session_id: "sess-2",
      started_at: 42,
      ended_at: null,
      target_name: null,
      firmware: null,
      name: null,
      frame_count: 0,
    });
    expect(row).toEqual({
      sessionId: "sess-2",
      startedAt: 42,
      endedAt: null,
      targetName: null,
      firmware: null,
      name: null,
      frameCount: 0,
    });
  });

  it("maps the M24 name column, defaulting an absent column to null", () => {
    // A row written before migration v4 has no `name` key at all; an explicit
    // SQL NULL arrives as `null`. Both must map to a `null` label, never the
    // string "null" or "undefined".
    expect(dbRowToSessionMeta({ session_id: "a", started_at: 1, frame_count: 0 }).name).toBeNull();
    expect(
      dbRowToSessionMeta({ session_id: "b", started_at: 1, frame_count: 0, name: null }).name
    ).toBeNull();
    expect(
      dbRowToSessionMeta({ session_id: "c", started_at: 1, frame_count: 0, name: "Field test" })
        .name
    ).toBe("Field test");
  });
});

describe("dbRowToCsvRow", () => {
  it("maps a telemetry row with a GPS fix to the camelCase CSV row", () => {
    const row = dbRowToCsvRow({
      session_id: "sess-1",
      ts: "1700000000000",
      rssi1: "-70",
      rssi2: "-80",
      link_quality: "100",
      snr: "8",
      tx_power: "100",
      packet_rate: "250",
      lat: "37.7749",
      lon: "-122.4194",
      alt: "120.5",
      sats: "11",
      ground_speed: "42.3",
      heading: "270",
    });
    expect(row).toEqual({
      ts: 1700000000000,
      rssi1: -70,
      rssi2: -80,
      linkQuality: 100,
      snr: 8,
      txPower: 100,
      packetRate: 250,
      lat: 37.7749,
      lon: -122.4194,
      alt: 120.5,
      sats: 11,
      groundSpeed: 42.3,
      heading: 270,
    });
    // Required link-stat fields are coerced to real numbers.
    expect(typeof row.ts).toBe("number");
    expect(typeof row.rssi1).toBe("number");
  });

  it("keeps GPS fields null when their columns are null (non-GPS device / no fix)", () => {
    const row = dbRowToCsvRow({
      session_id: "sess-1",
      ts: 1700000000001,
      rssi1: -71,
      rssi2: -81,
      link_quality: 99,
      snr: 7,
      tx_power: 100,
      packet_rate: 250,
      lat: null,
      lon: null,
      alt: null,
      sats: null,
      ground_speed: null,
      heading: null,
    });
    expect(row).toEqual({
      ts: 1700000000001,
      rssi1: -71,
      rssi2: -81,
      linkQuality: 99,
      snr: 7,
      txPower: 100,
      packetRate: 250,
      lat: null,
      lon: null,
      alt: null,
      sats: null,
      groundSpeed: null,
      heading: null,
    });
    // null GPS must NOT become 0 (Number(null) === 0), which would render as a
    // bogus (0,0) coordinate downstream.
    expect(row.lat).toBeNull();
    expect(row.groundSpeed).toBeNull();
  });

  it("preserves the oldest-first ordering contract when mapping a result set", () => {
    // loadSessionRows selects ORDER BY ts ASC; mapping must be order-preserving
    // so the resulting CSV rows stay chronological.
    const rows = [
      { ts: 1, rssi1: -70, rssi2: -80, link_quality: 100, snr: 8, tx_power: 100, packet_rate: 250, lat: null, lon: null, alt: null, sats: null, ground_speed: null, heading: null },
      { ts: 2, rssi1: -71, rssi2: -81, link_quality: 99, snr: 7, tx_power: 100, packet_rate: 250, lat: 1, lon: 2, alt: 3, sats: 9, ground_speed: 4, heading: 5 },
      { ts: 3, rssi1: -72, rssi2: -82, link_quality: 98, snr: 6, tx_power: 100, packet_rate: 250, lat: null, lon: null, alt: null, sats: null, ground_speed: null, heading: null },
    ].map(dbRowToCsvRow);
    expect(rows.map((r) => r.ts)).toEqual([1, 2, 3]);
    expect(rows[1].lat).toBe(1);
    expect(rows[0].lat).toBeNull();
  });
});

describe("formatSessionDuration", () => {
  it("formats a sub-minute span as seconds only", () => {
    expect(formatSessionDuration(1_000, 1_000 + 42_000)).toBe("42s");
  });

  it("rounds to the nearest second", () => {
    // 1499ms rounds down to 1s, 1500ms rounds up to 2s.
    expect(formatSessionDuration(0, 1_499)).toBe("1s");
    expect(formatSessionDuration(0, 1_500)).toBe("2s");
  });

  it("formats a sub-hour span as minutes and zero-padded seconds", () => {
    expect(formatSessionDuration(0, 83_000)).toBe("1m 23s");
    expect(formatSessionDuration(0, 65_000)).toBe("1m 05s");
  });

  it("formats an hour-plus span with zero-padded minutes and seconds", () => {
    // 1h 02m 03s
    expect(formatSessionDuration(0, (3600 + 123) * 1000)).toBe("1h 02m 03s");
  });

  it("returns null for an unclosed session (endedAt null)", () => {
    expect(formatSessionDuration(1_000, null)).toBeNull();
  });

  it("returns null for a negative or non-finite span", () => {
    // ended before started (clock skew / corrupt row) must not render "-5s".
    expect(formatSessionDuration(10_000, 5_000)).toBeNull();
    expect(formatSessionDuration(Number.NaN, 5_000)).toBeNull();
  });
});

describe("buildDeleteSessionStatements", () => {
  it("deletes frames + labels before the parent row, all bound by session id", () => {
    const stmts = buildDeleteSessionStatements("sess-1");
    expect(stmts).toHaveLength(3);
    // Children first so an interrupted run can't orphan frames or M56c labels
    // behind a missing parent row.
    expect(stmts[0].sql).toBe("DELETE FROM telemetry WHERE session_id = $1");
    expect(stmts[0].params).toEqual(["sess-1"]);
    expect(stmts[1].sql).toBe("DELETE FROM session_labels WHERE session_id = $1");
    expect(stmts[1].params).toEqual(["sess-1"]);
    expect(stmts[2].sql).toBe(
      "DELETE FROM telemetry_sessions WHERE session_id = $1"
    );
    expect(stmts[2].params).toEqual(["sess-1"]);
  });

  it("uses $n positional placeholders (tauri-plugin-sql convention)", () => {
    for (const { sql } of buildDeleteSessionStatements("x")) {
      expect(sql).toContain("$1");
      expect(sql).not.toContain("?");
    }
  });
});

describe("buildRenameSessionUpdate", () => {
  it("sets a trimmed non-empty label", () => {
    const { sql, params } = buildRenameSessionUpdate("sess-1", "  Maiden  ");
    expect(sql).toBe(
      "UPDATE telemetry_sessions SET name = $1 WHERE session_id = $2"
    );
    expect(params).toEqual(["Maiden", "sess-1"]);
  });

  it("clears the label (stores NULL) for an empty or whitespace name", () => {
    expect(buildRenameSessionUpdate("sess-1", "").params).toEqual([
      null,
      "sess-1",
    ]);
    expect(buildRenameSessionUpdate("sess-1", "   ").params).toEqual([
      null,
      "sess-1",
    ]);
  });
});

describe("selectSessionsToPrune", () => {
  // Newest-first, mirroring listStoredSessions' `ORDER BY started_at DESC`.
  const sessions: StoredSessionMeta[] = [
    meta({ sessionId: "s5", startedAt: 5_000 }),
    meta({ sessionId: "s4", startedAt: 4_000 }),
    meta({ sessionId: "s3", startedAt: 3_000 }),
    meta({ sessionId: "s2", startedAt: 2_000 }),
    meta({ sessionId: "s1", startedAt: 1_000 }),
  ];

  it("count-only: keeps the newest maxCount and prunes the older surplus", () => {
    expect(selectSessionsToPrune(sessions, { maxCount: 2 }, 10_000)).toEqual([
      "s3",
      "s2",
      "s1",
    ]);
  });

  it("count-only: keeps everything when maxCount >= the session count", () => {
    expect(selectSessionsToPrune(sessions, { maxCount: 5 }, 10_000)).toEqual([]);
    expect(selectSessionsToPrune(sessions, { maxCount: 99 }, 10_000)).toEqual(
      []
    );
  });

  it("count-only: sorts by startedAt, not input order, to find the newest", () => {
    // Supply the list oldest-first; the newest two (s5, s4) must still survive,
    // and the pruned ids come back in the caller's input order (s1, s2, s3).
    const shuffled = [...sessions].reverse();
    expect(selectSessionsToPrune(shuffled, { maxCount: 2 }, 10_000)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("age-only: prunes sessions older than maxAgeDays before now", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;
    const aged: StoredSessionMeta[] = [
      meta({ sessionId: "fresh", startedAt: now - 1 * DAY }),
      meta({ sessionId: "edge", startedAt: now - 10 * DAY }),
      meta({ sessionId: "stale", startedAt: now - 11 * DAY }),
    ];
    // Strictly older than the 10-day cutoff: only "stale" (edge == cutoff stays).
    expect(selectSessionsToPrune(aged, { maxAgeDays: 10 }, now)).toEqual([
      "stale",
    ]);
  });

  it("combined: prunes the union of the count and age rules", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;
    const list: StoredSessionMeta[] = [
      meta({ sessionId: "a", startedAt: now - 1 * DAY }),
      meta({ sessionId: "b", startedAt: now - 2 * DAY }),
      meta({ sessionId: "c", startedAt: now - 40 * DAY }),
    ];
    // maxCount:1 prunes b + c (keep newest a); maxAgeDays:30 prunes c. Union is
    // {b, c}, returned in input order, deduped.
    expect(
      selectSessionsToPrune(list, { maxCount: 1, maxAgeDays: 30 }, now)
    ).toEqual(["b", "c"]);
  });

  it("all-disabled: prunes nothing for null/undefined/<=0 bounds", () => {
    expect(selectSessionsToPrune(sessions, {}, 10_000)).toEqual([]);
    expect(
      selectSessionsToPrune(sessions, { maxCount: null, maxAgeDays: null }, 10_000)
    ).toEqual([]);
    expect(
      selectSessionsToPrune(sessions, { maxCount: 0, maxAgeDays: 0 }, 10_000)
    ).toEqual([]);
    expect(
      selectSessionsToPrune(sessions, { maxCount: -5, maxAgeDays: -1 }, 10_000)
    ).toEqual([]);
  });
});

describe("summarizeSessions", () => {
  it("counts sessions and sums their frame counts", () => {
    const list: StoredSessionMeta[] = [
      meta({ sessionId: "a", startedAt: 1, frameCount: 100 }),
      meta({ sessionId: "b", startedAt: 2, frameCount: 250 }),
      meta({ sessionId: "c", startedAt: 3, frameCount: 0 }),
    ];
    expect(summarizeSessions(list)).toEqual({
      sessionCount: 3,
      totalFrames: 350,
    });
  });

  it("returns zeroes for an empty list", () => {
    expect(summarizeSessions([])).toEqual({ sessionCount: 0, totalFrames: 0 });
  });
});
