import { describe, expect, it } from "vitest";
import {
  type AlertFrame,
  type LiveAlertConfig,
  type LiveAlert,
  type RangeAlarmConfig,
  DEFAULT_LIVE_ALERT_CONFIG,
  evaluateFrame,
  evaluateFrames,
  haversineMeters,
  initialAlertState,
} from "@/lib/liveAlerts";

// ---------------------------------------------------------------------------
// Fixture helpers — build deterministic live-frame sequences. Defaults are a
// HEALTHY link (strong RSSI, full LQ, no GPS) so a test only has to override the
// metric under test; everything else stays quiet.
// ---------------------------------------------------------------------------

/** One healthy frame, with overrides. */
function frame(over: Partial<AlertFrame> = {}): AlertFrame {
  return { t: 0, rssi1: -60, rssi2: -65, linkQuality: 95, gps: null, ...over };
}

/** A frame sequence from RSSI values (rssi1 is always the better antenna). */
function rssiFrames(values: number[]): AlertFrame[] {
  return values.map((r, i) => frame({ t: i * 40, rssi1: r, rssi2: r - 50 }));
}

/** A frame sequence from link-quality values. */
function lqFrames(values: number[]): AlertFrame[] {
  return values.map((lq, i) => frame({ t: i * 40, linkQuality: lq }));
}

/** Isolate ONE alarm so `firedAlerts.length` is unambiguous. */
function only(kind: keyof LiveAlertConfig, cfg: Partial<RangeAlarmConfig> = {}): LiveAlertConfig {
  const base: LiveAlertConfig = {
    signalLoss: { ...DEFAULT_LIVE_ALERT_CONFIG.signalLoss, enabled: false },
    lqDrop: { ...DEFAULT_LIVE_ALERT_CONFIG.lqDrop, enabled: false },
    failsafe: { ...DEFAULT_LIVE_ALERT_CONFIG.failsafe, enabled: false },
    gpsDistance: { ...DEFAULT_LIVE_ALERT_CONFIG.gpsDistance, enabled: false },
  };
  if (kind === "failsafe") {
    return { ...base, failsafe: { enabled: true, minFrames: cfg.minFrames ?? 2 } };
  }
  return {
    ...base,
    [kind]: { ...DEFAULT_LIVE_ALERT_CONFIG[kind], enabled: true, ...cfg },
  } as LiveAlertConfig;
}

/** Fold frames, keeping the per-frame result so a test can assert WHICH frame fired. */
function run(frames: AlertFrame[], config: LiveAlertConfig) {
  let state = initialAlertState();
  const perFrame = frames.map((f) => {
    const res = evaluateFrame(f, config, state);
    state = res.newState;
    return res;
  });
  const fired = perFrame.flatMap((r) => r.firedAlerts);
  const cleared = perFrame.flatMap((r) => r.clearedKinds);
  return { perFrame, fired, cleared, finalState: state };
}

// ---------------------------------------------------------------------------
// Healthy link — the foundational NEGATIVE case
// ---------------------------------------------------------------------------

describe("evaluateFrames — healthy link never alarms", () => {
  it("a long, strong, full-quality stream fires NOTHING (default config)", () => {
    const frames = rssiFrames(Array.from({ length: 50 }, () => -60));
    const { firedAlerts, clearedKinds } = evaluateFrames(frames, DEFAULT_LIVE_ALERT_CONFIG);
    expect(firedAlerts).toEqual([]);
    expect(clearedKinds).toEqual([]);
  });

  it("a disabled alarm stays silent even on sustained bad data", () => {
    // RSSI pinned at -120 (far below the -100 floor) but the alarm is OFF.
    const cfg: LiveAlertConfig = {
      ...DEFAULT_LIVE_ALERT_CONFIG,
      signalLoss: { ...DEFAULT_LIVE_ALERT_CONFIG.signalLoss, enabled: false },
    };
    const { fired } = run(rssiFrames(Array.from({ length: 20 }, () => -120)), cfg);
    expect(fired.filter((a) => a.kind === "signalLoss")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RSSI — the acceptance alarm (debounce + hysteresis + one-per-crossing)
// ---------------------------------------------------------------------------

describe("evaluateFrames — RSSI floor (acceptance)", () => {
  it("ACCEPTANCE: a stream crossing the floor raises EXACTLY ONE alarm (default config)", () => {
    // 5 healthy, then 10 bad (-105 < -100 floor), then recovery.
    const frames = rssiFrames([
      -60, -60, -60, -60, -60,
      -105, -105, -105, -105, -105, -105, -105, -105, -105, -105,
      -60, -60, -60, -60, -60,
    ]);
    const { fired, cleared } = run(frames, DEFAULT_LIVE_ALERT_CONFIG);
    const rssi = fired.filter((a) => a.kind === "signalLoss");
    expect(rssi).toHaveLength(1);
    expect(rssi[0].severity).toBe("critical");
    expect(rssi[0].messageKey).toBe("alerts.message.signalLoss");
    expect(rssi[0].detail).toEqual({ rssi: -105 });
    // Sustained recovery clears it exactly once.
    expect(cleared.filter((k) => k === "signalLoss")).toHaveLength(1);
  });

  it("DEBOUNCE: fires only on the Nth consecutive bad frame, never earlier", () => {
    const cfg = only("signalLoss", { trip: -100, clear: -90, minFrames: 3 });
    const { perFrame, fired } = run(rssiFrames([-101, -101, -101, -101]), cfg);
    expect(perFrame[0].firedAlerts).toEqual([]); // 1 bad
    expect(perFrame[1].firedAlerts).toEqual([]); // 2 bad
    expect(perFrame[2].firedAlerts).toHaveLength(1); // 3rd bad → trip
    expect(perFrame[3].firedAlerts).toEqual([]); // already alarming → no re-fire
    expect(fired).toHaveLength(1);
  });

  it("DEBOUNCE: intermittent single-frame dips (reset by good frames) NEVER fire", () => {
    // Without debounce (minFrames 1) the very first -101 would fire; with the
    // 3-frame window and a healthy frame between each dip, the bad streak never
    // reaches the threshold.
    const cfg = only("signalLoss", { trip: -100, clear: -90, minFrames: 3 });
    const { fired } = run(rssiFrames([-101, -60, -101, -60, -101, -60, -101]), cfg);
    expect(fired).toHaveLength(0);
  });

  it("HYSTERESIS: a value bouncing between the trip and inside the band fires ONCE and never clears", () => {
    // minFrames 1 removes debounce as a factor, isolating hysteresis. trip -100,
    // clear -90: -95 sits INSIDE the band (not bad, not recovered).
    const cfg = only("signalLoss", { trip: -100, clear: -90, minFrames: 1 });
    const { fired, cleared } = run(rssiFrames([-101, -95, -101, -95, -101, -95]), cfg);
    expect(fired).toHaveLength(1); // would be 3+ if clear === trip (no band)
    expect(cleared).toHaveLength(0); // band never lets it clear
  });

  it("CLEAR + RE-ARM: drop → sustained recovery clears → drop again fires AGAIN", () => {
    const cfg = only("signalLoss", { trip: -100, clear: -90, minFrames: 2 });
    //              fire@1            clear@4           fire@6
    const frames = rssiFrames([-101, -101, -101, -85, -85, -101, -101]);
    const { perFrame, fired, cleared } = run(frames, cfg);
    expect(fired).toHaveLength(2);
    expect(cleared).toEqual(["signalLoss"]);
    expect(perFrame[1].firedAlerts).toHaveLength(1);
    expect(perFrame[4].clearedKinds).toEqual(["signalLoss"]);
    expect(perFrame[6].firedAlerts).toHaveLength(1);
  });

  it("HYSTERESIS proof: clearing requires crossing the distinct clear threshold, not just leaving 'bad'", () => {
    const cfg = only("signalLoss", { trip: -100, clear: -90, minFrames: 1 });
    // Trip, then hold at -95 forever (left 'bad' but still below the clear line).
    const { fired, cleared } = run(rssiFrames([-101, -95, -95, -95, -95, -95]), cfg);
    expect(fired).toHaveLength(1);
    expect(cleared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Link quality floor
// ---------------------------------------------------------------------------

describe("evaluateFrames — link-quality floor", () => {
  it("warning then (after recovery) a critical re-trip, with one alarm each", () => {
    const cfg = only("lqDrop", { trip: 50, clear: 60, minFrames: 2 });
    //            healthy   drop→40 (warn)     recover    drop→10 (crit)
    const frames = lqFrames([95, 40, 40, 40, 70, 70, 70, 10, 10]);
    const { fired, cleared } = run(frames, cfg);
    expect(fired).toHaveLength(2);
    expect(fired[0]).toMatchObject({ kind: "lqDrop", severity: "warning", detail: { lq: 40 } });
    expect(fired[1]).toMatchObject({ kind: "lqDrop", severity: "critical", detail: { lq: 10 } });
    expect(cleared).toEqual(["lqDrop"]);
  });

  it("jitter that never reaches the floor fires nothing", () => {
    const cfg = only("lqDrop", { trip: 50, clear: 60, minFrames: 2 });
    const { fired } = run(lqFrames([95, 62, 70, 65, 80, 61, 95]), cfg);
    expect(fired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Link loss (failsafe — LQ pinned at 0)
// ---------------------------------------------------------------------------

describe("evaluateFrames — link loss", () => {
  it("fires once after N consecutive zero-LQ frames and clears on recovery", () => {
    const cfg = only("failsafe", { minFrames: 2 });
    const { perFrame, fired, cleared } = run(lqFrames([95, 0, 0, 95, 95]), cfg);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      kind: "failsafe",
      severity: "critical",
      messageKey: "alerts.message.failsafe",
      detail: { lq: 0 },
    });
    expect(perFrame[2].firedAlerts).toHaveLength(1); // 2nd zero trips it
    expect(cleared).toEqual(["failsafe"]);
  });

  it("a single zero-LQ blip (< debounce) never fires", () => {
    const cfg = only("failsafe", { minFrames: 2 });
    const { fired } = run(lqFrames([95, 0, 95, 0, 95]), cfg);
    expect(fired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GPS distance from home (optional)
// ---------------------------------------------------------------------------

describe("evaluateFrames — GPS distance", () => {
  const HOME = { latitude: 0, longitude: 0, altitude: 0, satellites: 9, groundSpeed: 0, heading: 0 };
  const FAR = { ...HOME, latitude: 0.01 }; // ~1.1 km north of home

  it("is OFF by default — never fires even when far from home", () => {
    const frames = [frame({ gps: HOME }), frame({ gps: FAR }), frame({ gps: FAR })];
    const { fired } = run(frames, DEFAULT_LIVE_ALERT_CONFIG);
    expect(fired.filter((a) => a.kind === "gpsDistance")).toHaveLength(0);
  });

  it("latches home at the first fix, then fires when the aircraft passes the limit", () => {
    const cfg = only("gpsDistance", { trip: 500, clear: 450, minFrames: 1 });
    const near = { ...HOME, latitude: 0.001 }; // ~111 m — inside the limit
    const frames = [frame({ gps: HOME }), frame({ gps: near }), frame({ gps: FAR })];
    const { perFrame, fired, finalState } = run(frames, cfg);
    expect(finalState.home).toEqual({ latitude: 0, longitude: 0 });
    expect(perFrame[0].firedAlerts).toEqual([]); // home, distance 0
    expect(perFrame[1].firedAlerts).toEqual([]); // 111 m < 500 m
    expect(fired).toHaveLength(1);
    expect(fired[0].kind).toBe("gpsDistance");
    expect(fired[0].severity).toBe("warning");
    expect(typeof fired[0].detail.distance).toBe("number");
    expect(fired[0].detail.distance).toBeGreaterThan(1000); // ~1.1 km
  });

  it("a frame with no fix is a gap — the partial debounce streak resets", () => {
    const cfg = only("gpsDistance", { trip: 100, clear: 90, minFrames: 3 });
    const far = { ...HOME, latitude: 0.01 };
    // far, far, then a no-GPS gap, then far again → streak never reaches 3.
    const frames = [
      frame({ gps: HOME }),
      frame({ gps: far }),
      frame({ gps: far }),
      frame({ gps: null }),
      frame({ gps: far }),
    ];
    const { fired } = run(frames, cfg);
    expect(fired).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: determinism + safety (no GPS coordinate / identifier leak)
// ---------------------------------------------------------------------------

describe("evaluateFrames — cross-cutting", () => {
  it("haversineMeters is a sane great-circle distance", () => {
    // 0.001° of latitude ≈ 111 m anywhere on Earth.
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0.001, longitude: 0 });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(115);
  });

  it("is deterministic: the same sequence yields deeply-equal results twice", () => {
    const frames = rssiFrames([-60, -105, -105, -105, -105, -60]);
    expect(evaluateFrames(frames, DEFAULT_LIVE_ALERT_CONFIG)).toEqual(
      evaluateFrames(frames, DEFAULT_LIVE_ALERT_CONFIG)
    );
  });

  it("initialAlertState is all-healthy with no latched home", () => {
    const s = initialAlertState();
    expect(s.signalLoss.phase).toBe("ok");
    expect(s.lqDrop.phase).toBe("ok");
    expect(s.failsafe.phase).toBe("ok");
    expect(s.gpsDistance.phase).toBe("ok");
    expect(s.home).toBeNull();
  });

  it("SAFETY: no alert detail ever carries a coordinate/identifier key or value", () => {
    // A run that trips every alarm, with a real far-from-(0,0) GPS fix planted.
    const cfg: LiveAlertConfig = {
      signalLoss: { enabled: true, trip: -100, clear: -90, minFrames: 1 },
      lqDrop: { enabled: true, trip: 50, clear: 60, minFrames: 1 },
      failsafe: { enabled: false, minFrames: 2 },
      gpsDistance: { enabled: true, trip: 100, clear: 90, minFrames: 1 },
    };
    const COORD_LAT = 12.3456789;
    const COORD_LON = 98.7654321;
    const frames: AlertFrame[] = [
      frame({ rssi1: -60, rssi2: -110, linkQuality: 95, gps: { latitude: COORD_LAT, longitude: COORD_LON, altitude: 0, satellites: 9, groundSpeed: 0, heading: 0 } }),
      frame({ rssi1: -105, rssi2: -160, linkQuality: 40, gps: { latitude: COORD_LAT + 0.02, longitude: COORD_LON + 0.02, altitude: 0, satellites: 9, groundSpeed: 0, heading: 0 } }),
    ];
    const { fired } = run(frames, cfg);
    expect(fired.length).toBeGreaterThan(0);

    const allowedKeys = new Set(["rssi", "lq", "distance"]);
    for (const alert of fired as LiveAlert[]) {
      for (const [key, value] of Object.entries(alert.detail)) {
        expect(allowedKeys.has(key)).toBe(true);
        expect(key).not.toMatch(/lat|lon|lng|gps|coord|geo|uid|mac|email/i);
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
        expect(value).not.toBe(COORD_LAT);
        expect(value).not.toBe(COORD_LON);
        expect(value).not.toBe(COORD_LAT + 0.02);
        expect(value).not.toBe(COORD_LON + 0.02);
      }
    }
  });
});
