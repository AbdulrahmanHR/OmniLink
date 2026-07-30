import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session";
import { useTelemetryStore } from "@/stores/telemetry";
import { liveStreamActive } from "@/hooks/useTelemetryStream";
import { csvRowToTelemetryFrame, telemetryFrameFromLog } from "@/lib/replay";
import { parsedLogFromTelemetryRows } from "@/lib/omnilog";
import { detectAnomalies, type AnomalyEvent } from "@/lib/anomaly";
import type { ParsedLog } from "@/lib/blackbox";
import type { TelemetrySessionCsvRow } from "@/lib/telemetry-session-csv";

/**
 * State-machine + driver coverage for the v1.7.0 unified Session Analysis store
 * (`@/stores/session`), the merge of the former `useLogsStore` (forensic scrub)
 * and `useSimulatorStore` (wall-clock replay). Migrated from `simulator.test.ts`
 * and extended with the scrub↔play transition + selection/anomaly tests that the
 * Logs half contributed.
 *
 * The pure clock/conversion engine (`@/lib/replay`) is exercised in
 * `replay.test.ts`; this spec drives the *wall-clock* side — the `setInterval`
 * driver and the lifecycle (`loadLog`/`play`/`pause`/`seek`/`setSpeed`/`reset`)
 * over the single `positionIndex` — with fake timers.
 */

/** Build one row; `gps=false` yields a null-GPS row (lat/lon null). */
function row(ts: number, gps: boolean): TelemetrySessionCsvRow {
  return {
    ts,
    rssi1: -70,
    rssi2: -82,
    linkQuality: 96,
    snr: 7,
    txPower: 100,
    packetRate: 250,
    lat: gps ? 37.7749 : null,
    lon: gps ? -122.4194 : null,
    alt: gps ? 120 : null,
    sats: gps ? 11 : null,
    groundSpeed: gps ? 14.5 : null,
    heading: gps ? 271 : null,
  };
}

/** `n` rows at `spacing` ms apart; every third row has no GPS fix. */
function makeRows(n: number, spacing = 100): TelemetrySessionCsvRow[] {
  return Array.from({ length: n }, (_, i) => row(1000 + i * spacing, i % 3 !== 0));
}

/** Build a ParsedLog (the single session model) from `n` synthetic rows. */
function makeLog(n: number, spacing = 100): ParsedLog {
  return parsedLogFromTelemetryRows(makeRows(n, spacing));
}

/** The telemetry frame the store should have fed for `log` sample `i`. */
function frameAt(log: ParsedLog, i: number) {
  return telemetryFrameFromLog(log, i);
}

const session = () => useSessionStore.getState();
const tele = () => useTelemetryStore.getState();

beforeEach(() => {
  useSessionStore.getState().reset();
  useTelemetryStore.getState().clear();
});

describe("frame derivation parity", () => {
  it("telemetryFrameFromLog matches csvRowToTelemetryFrame for an OmniLink log", () => {
    const rows = makeRows(6);
    const log = parsedLogFromTelemetryRows(rows);
    for (let i = 0; i < rows.length; i++) {
      expect(telemetryFrameFromLog(log, i)).toEqual(csvRowToTelemetryFrame(rows[i]));
    }
  });
});

describe("loadLog", () => {
  it("readies the session at index 0 in scrub mode and feeds the first frame", () => {
    const log = makeLog(8);
    session().loadLog(log);
    expect(session().mode).toBe("scrub");
    expect(session().isSimulating).toBe(true);
    expect(session().positionIndex).toBe(0);
    expect(tele().latest).toEqual(frameAt(log, 0));
    expect(tele().history).toHaveLength(1);
  });

  it("computes the anomaly list off the loaded log", () => {
    const log = makeLog(8);
    session().loadLog(log);
    expect(session().anomalies).toEqual(detectAnomalies(log));
    expect(session().selectedAnomalyIndex).toBeNull();
  });

  it("treats an empty session as not simulating", () => {
    session().loadLog(makeLog(0));
    expect(session().isSimulating).toBe(false);
    expect(tele().latest).toBeNull();
  });
});

describe("play / pause — scrub↔play transitions", () => {
  it("play enters play mode; pause returns to scrub", () => {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(8));
      expect(session().mode).toBe("scrub");
      session().play();
      expect(session().mode).toBe("play");
      vi.advanceTimersByTime(150);
      session().pause();
      expect(session().mode).toBe("scrub");
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances the index and grows history like live capture", () => {
    vi.useFakeTimers();
    try {
      const log = makeLog(8);
      session().loadLog(log);
      session().play();

      vi.advanceTimersByTime(350);

      const { positionIndex } = session();
      expect(positionIndex).toBeGreaterThan(0);
      expect(tele().history).toHaveLength(positionIndex + 1);
      expect(tele().latest).toEqual(frameAt(log, positionIndex));
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks at the final sample (scrub) and never spins past the end", () => {
    vi.useFakeTimers();
    try {
      const log = makeLog(8);
      session().loadLog(log);
      session().play();

      vi.advanceTimersByTime(5000); // well past the 700 ms session
      expect(session().positionIndex).toBe(log.sampleCount - 1);
      expect(session().mode).toBe("scrub");
      const settled = tele().history.length;
      expect(settled).toBe(log.sampleCount);

      vi.advanceTimersByTime(2000);
      expect(session().positionIndex).toBe(log.sampleCount - 1);
      expect(tele().history).toHaveLength(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single-sample session cannot play (stays scrub)", () => {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(1));
      session().play();
      expect(session().mode).toBe("scrub");
      expect(session().positionIndex).toBe(0);
      vi.advanceTimersByTime(2000);
      expect(session().positionIndex).toBe(0);
      expect(tele().history).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent — a second play() doesn't double-feed frames", () => {
    vi.useFakeTimers();
    try {
      const log = makeLog(8);
      session().loadLog(log);
      session().play();
      session().play();

      vi.advanceTimersByTime(350);
      const { positionIndex } = session();
      expect(positionIndex).toBeGreaterThan(0);
      expect(tele().history).toHaveLength(positionIndex + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts from the top when play() is pressed at the end", () => {
    vi.useFakeTimers();
    try {
      const log = makeLog(8);
      session().loadLog(log);
      session().play();
      vi.advanceTimersByTime(5000);
      expect(session().positionIndex).toBe(log.sampleCount - 1);

      session().play(); // pressed while parked at the end → restart from 0
      expect(session().mode).toBe("play");
      expect(session().positionIndex).toBe(0);
      expect(tele().latest).toEqual(frameAt(log, 0));
      expect(tele().history).toHaveLength(1);

      vi.advanceTimersByTime(350);
      expect(session().positionIndex).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("speed multipliers", () => {
  function reachedIndex(speed: 0.5 | 1 | 2 | 4, wallMs: number): number {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(8));
      session().setSpeed(speed);
      session().play();
      vi.advanceTimersByTime(wallMs);
      return session().positionIndex;
    } finally {
      vi.useRealTimers();
    }
  }

  it("reaches the end faster as speed increases (0.5/1/2/4×)", () => {
    const last = 7;
    const i05 = reachedIndex(0.5, 400);
    const i1 = reachedIndex(1, 400);
    const i2 = reachedIndex(2, 400);
    const i4 = reachedIndex(4, 400);

    expect(i05).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThanOrEqual(i4);
    expect(i4).toBe(last);
    expect(i1).toBeLessThan(last);
  });
});

describe("seek (the single position setter)", () => {
  it("moves the index and rebuilds history 0..i", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(5);
    expect(session().positionIndex).toBe(5);
    expect(tele().latest).toEqual(frameAt(log, 5));
    expect(tele().history).toHaveLength(6);
  });

  it("clamps out-of-bounds targets to [0, last]", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(999);
    expect(session().positionIndex).toBe(log.sampleCount - 1);
    session().seek(-5);
    expect(session().positionIndex).toBe(0);
  });

  it("seeks forward incrementally — feeds only newly-passed frames", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(3);
    const frame0Before = tele().history[0];

    const setHistorySpy = vi.spyOn(useTelemetryStore.getState(), "setHistory");
    const clearSpy = vi.spyOn(useTelemetryStore.getState(), "clear");

    session().seek(6); // forward 3 → 6: frames 4, 5, 6 are the only new ones

    // Applied as a single batched set (not clear()+rebuild), and the already-fed
    // frames are reused (appended to), not recomputed from scratch.
    expect(setHistorySpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(tele().history[0]).toBe(frame0Before);

    expect(session().positionIndex).toBe(6);
    expect(tele().history).toEqual(
      Array.from({ length: 7 }, (_, i) => frameAt(log, i))
    );

    setHistorySpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("seeks backward by rebuilding the window up to the target", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(6);
    session().seek(2);
    expect(session().positionIndex).toBe(2);
    expect(tele().latest).toEqual(frameAt(log, 2));
    expect(tele().history).toEqual(
      Array.from({ length: 3 }, (_, i) => frameAt(log, i))
    );
  });
});

describe("selection + anomaly", () => {
  it("marks an ordered selection window from the current index", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(2);
    session().markSelectionStart();
    session().seek(5);
    session().markSelectionEnd();
    expect(session().selectionStart).toBe(2);
    expect(session().selectionEnd).toBe(5);
    session().clearSelection();
    expect(session().selectionStart).toBeNull();
    expect(session().selectionEnd).toBeNull();
  });

  it("selectAnomaly drives the one index to the anomaly's sample", () => {
    const log = makeLog(8);
    session().loadLog(log);
    // Inject a deterministic anomaly so the seek-on-select path is ALWAYS
    // exercised — detectAnomalies over the synthetic fixture may legitimately
    // find none, which previously made this assertion silently pass empty.
    const ev: AnomalyEvent = {
      type: "signalLoss",
      severity: "critical",
      index: 5,
      t: log.time[5],
      startIndex: 4,
      endIndex: 6,
      messageKey: "anomaly.message.signalLoss",
    };
    session().setAnomalies([ev]);
    expect(session().selectedAnomalyIndex).toBeNull();

    session().selectAnomaly(0);
    expect(session().selectedAnomalyIndex).toBe(0);
    expect(session().positionIndex).toBe(5);
    // The dashboard window followed the index too (one cursor, one history).
    expect(tele().latest).toEqual(frameAt(log, 5));
    expect(tele().history).toHaveLength(6);

    session().selectAnomaly(null);
    expect(session().selectedAnomalyIndex).toBeNull();
  });
});

describe("reset", () => {
  it("clears the session, telemetry, and lifecycle", () => {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(8));
      session().play();
      vi.advanceTimersByTime(200);
      session().reset();
    } finally {
      vi.useRealTimers();
    }
    expect(session().log).toBeNull();
    expect(session().positionIndex).toBe(0);
    expect(session().isSimulating).toBe(false);
    expect(session().mode).toBe("scrub");
    expect(tele().latest).toBeNull();
    expect(tele().history).toHaveLength(0);
  });
});

describe("live <-> replay arbitration", () => {
  it("feeds no further frames after reset() (timer torn down)", () => {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(8));
      session().play();
      vi.advanceTimersByTime(200);
      session().reset();

      const pushSpy = vi.spyOn(useTelemetryStore.getState(), "push");
      vi.advanceTimersByTime(5000);
      expect(pushSpy).not.toHaveBeenCalled();
      pushSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the live stream while a session is loaded, and only then", () => {
    session().loadLog(makeLog(8));
    expect(session().isSimulating).toBe(true);
    expect(liveStreamActive(true, session().isSimulating)).toBe(false);

    session().reset();
    expect(liveStreamActive(true, session().isSimulating)).toBe(true);

    expect(liveStreamActive(false, false)).toBe(false);
  });
});

describe("suspend (page-unmount cleanup)", () => {
  it("KEEPS the session + simulated feed so replay survives SPA navigation", () => {
    const log = makeLog(8);
    session().loadLog(log);
    session().seek(4);
    expect(session().isSimulating).toBe(true);

    session().suspend();
    // The loaded session + its fed telemetry window survive the round-trip, and
    // isSimulating stays true — this is what lets the simulated replay show on the
    // live /telemetry dashboard after a client-side route change (proven e2e by
    // map.spec/offline.spec) with the SIMULATED badge + live suppressed. Only
    // Stop / "Load another" (reset) hand the dashboard back to a live link.
    expect(session().log).toBe(log);
    expect(session().positionIndex).toBe(4);
    expect(session().mode).toBe("scrub");
    expect(session().isSimulating).toBe(true);
    expect(liveStreamActive(true, session().isSimulating)).toBe(false);
    expect(tele().history).toHaveLength(5);
    expect(tele().latest).toEqual(frameAt(log, 4));
  });

  it("stops the replay timer — no frames feed after unmount", () => {
    vi.useFakeTimers();
    try {
      session().loadLog(makeLog(8));
      session().play();
      vi.advanceTimersByTime(100);
      session().suspend();
      expect(session().mode).toBe("scrub");

      const pushSpy = vi.spyOn(useTelemetryStore.getState(), "push");
      vi.advanceTimersByTime(5000);
      expect(pushSpy).not.toHaveBeenCalled();
      pushSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
