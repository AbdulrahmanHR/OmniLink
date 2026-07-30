import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEndUpdate,
  buildSessionStartInsert,
  openTelemetryPersistence,
} from "@/lib/telemetry-db";
import type { TelemetryFrame } from "@/stores/telemetry";

// File-scoped mock of the tauri-plugin-sql Database. vitest runs each test file
// in its own module registry, so mocking the plugin here cannot leak into other
// suites. The hoisted handles let the (hoisted) vi.mock factory share spies with
// the test body.
const { loadMock, execMock, closeMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  execMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: loadMock },
}));

function frame(t: number): TelemetryFrame {
  return {
    t,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 8,
    txPower: 100,
    packetRate: 250,
    antennas: [
      { id: 1, rssi: -70, active: true },
      { id: 2, rssi: -80, active: false },
    ],
  };
}

describe("buildSessionStartInsert", () => {
  it("builds an idempotent INSERT OR REPLACE seeding frame_count to 0", () => {
    const stmt = buildSessionStartInsert({
      sessionId: "sess-1",
      startedAt: 1700000000000,
      targetName: "Jumper AION Nano",
      firmware: "3.5.3",
    });
    expect(stmt.sql).toBe(
      "INSERT OR REPLACE INTO telemetry_sessions " +
        "(session_id, started_at, target_name, firmware, frame_count) " +
        "VALUES ($1, $2, $3, $4, 0)"
    );
    expect(stmt.params).toEqual([
      "sess-1",
      1700000000000,
      "Jumper AION Nano",
      "3.5.3",
    ]);
  });

  it("passes empty target/firmware strings through unchanged", () => {
    const stmt = buildSessionStartInsert({
      sessionId: "sess-2",
      startedAt: 42,
      targetName: "",
      firmware: "",
    });
    expect(stmt.params).toEqual(["sess-2", 42, "", ""]);
  });
});

describe("buildSessionEndUpdate", () => {
  it("builds an UPDATE ... WHERE session_id with params in $1,$2,$3 order", () => {
    const stmt = buildSessionEndUpdate({
      sessionId: "sess-1",
      endedAt: 1700000005000,
      frameCount: 1234,
    });
    expect(stmt.sql).toBe(
      "UPDATE telemetry_sessions SET ended_at = $1, frame_count = $2 " +
        "WHERE session_id = $3"
    );
    // ended_at = $1, frame_count = $2, session_id = $3
    expect(stmt.params).toEqual([1700000005000, 1234, "sess-1"]);
  });
});

describe("openTelemetryPersistence session row writes", () => {
  beforeEach(() => {
    loadMock.mockReset();
    execMock.mockReset();
    closeMock.mockReset();
    execMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
    loadMock.mockResolvedValue({ execute: execMock, close: closeMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts the session row on open and updates it with the frame count on close", async () => {
    const persistence = await openTelemetryPersistence({
      id: "sess-9",
      targetName: "RadioMaster RP3",
      firmware: "3.4.0",
    });

    // Start INSERT runs on open, before any frames.
    expect(execMock).toHaveBeenCalledTimes(1);
    const [startSql, startParams] = execMock.mock.calls[0];
    expect(startSql).toContain("INSERT OR REPLACE INTO telemetry_sessions");
    expect(startParams.slice(0, 1)).toEqual(["sess-9"]);
    expect(startParams).toContain("RadioMaster RP3");
    expect(startParams).toContain("3.4.0");

    // Every frame handed to record() is counted (one per persisted frame).
    persistence.record(frame(1));
    persistence.record(frame(2));
    persistence.record(frame(3));

    await persistence.close();

    // The final execute is the session end UPDATE carrying the frame count.
    const endCall = execMock.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE telemetry_sessions")
    );
    expect(endCall).toBeDefined();
    const endParams = endCall![1] as (number | string)[];
    // params: [endedAt, frameCount, sessionId]
    expect(endParams[1]).toBe(3);
    expect(endParams[2]).toBe("sess-9");
    // The process-global SQLite pool ("sqlite:omnilink.db") is shared with
    // chat/session persistence, so teardown must NOT close it — a no-arg
    // close() would tear down every pool and silently break the others.
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("degrades to a no-op handle when the DB cannot be opened (no throw)", async () => {
    loadMock.mockRejectedValueOnce(new Error("not in tauri"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const persistence = await openTelemetryPersistence({
      id: "sess-x",
      targetName: "",
      firmware: "",
    });
    // No DB -> no start insert attempted.
    expect(execMock).not.toHaveBeenCalled();
    // record()/close() are safe with no DB.
    persistence.record(frame(1));
    await expect(persistence.close()).resolves.toBeUndefined();
    expect(execMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
