import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceLiveAlerts,
  reconcileToasts,
  type LiveAlertCursor,
} from "@/components/alerts/LiveAlertHost";
import {
  DEFAULT_LIVE_ALERT_CONFIG,
  evaluateFrame,
  initialAlertState,
  type LiveAlert,
} from "@/lib/liveAlerts";
import { recordFiredAlerts } from "@/lib/notificationFeed";
import { parsedLogFromTelemetryRows } from "@/lib/omnilog";
import type { TelemetrySessionCsvRow } from "@/lib/telemetry-session-csv";
import { selectLiveAlertConfig, useAlertsStore } from "@/stores/alerts";
import { useNotificationsStore } from "@/stores/notifications";
import { useSessionStore } from "@/stores/session";
import {
  TELEMETRY_HISTORY_CAP,
  useTelemetryStore,
  type TelemetryFrame,
} from "@/stores/telemetry";

/**
 * Batch evaluation in the live-alert runner (v3.0.1 defect fix).
 *
 * `LiveAlertHost` used to react to `useTelemetryStore.latest` and evaluate that
 * ONE frame per store change. But the shared history does not only grow one
 * frame at a time: `useSessionStore.seek` appends every newly-passed sample in a
 * single `setHistory()`, and `latest` is only the last of them. A scrubber jump
 * therefore evaluated 1 frame where N had elapsed, and any alarm with hysteresis
 * never accumulated its debounce counter — `signalLoss` needs 3 consecutive
 * recovered frames to clear, so its toast stood forever after a jump over the
 * recovery (`tests/e2e/notifications.spec.ts:58`).
 *
 * These specs drive the host's OWN exported runner functions — the component is
 * a thin subscribe-and-render shell around them — because the unit suite runs in
 * Node with no DOM (AGENTS.md § Testing). {@link mountRunner} performs exactly
 * the subscription body the component performs, in the same order.
 */

// ---------------------------------------------------------------------------
// Fixtures — the e2e `alert-dropout.csv` ladder, frame for frame
// ---------------------------------------------------------------------------

/**
 * (rssi1, rssi2) per sample, copied from `tests/e2e/fixtures/alert-dropout.csv`:
 * healthy → four frames at/below the −100 dBm trip → recovery well above the
 * −95 dBm clear threshold. `signalLoss` trips on sample 5 (3 consecutive bad)
 * and can only clear on sample 9 (3 consecutive recovered).
 */
const DROPOUT: ReadonlyArray<readonly [number, number]> = [
  [-55, -58],
  [-57, -60],
  [-60, -62],
  [-105, -106],
  [-110, -112],
  [-107, -108],
  [-104, -103],
  [-61, -63],
  [-58, -60],
  [-56, -57],
  [-55, -56],
];

const T0 = 1_700_000_000_000;

/** One synthetic live frame. */
function frame(i: number, rssi1: number, rssi2: number, linkQuality = 98): TelemetryFrame {
  return {
    t: T0 + i * 100,
    rssi1,
    rssi2,
    linkQuality,
    snr: 8,
    txPower: 25,
    packetRate: 150,
    antennas: [
      { id: 1, rssi: rssi1, active: rssi1 >= rssi2 },
      { id: 2, rssi: rssi2, active: rssi2 > rssi1 },
    ],
    gps: null,
  };
}

/** The dropout ladder as live frames. */
function dropoutFrames(): TelemetryFrame[] {
  return DROPOUT.map(([a, b], i) => frame(i, a, b));
}

/** The same ladder as an importable session (what the e2e loads from CSV). */
function dropoutLog() {
  const rows: TelemetrySessionCsvRow[] = DROPOUT.map(([rssi1, rssi2], i) => ({
    ts: T0 + i * 100,
    rssi1,
    rssi2,
    linkQuality: 98,
    snr: 8,
    txPower: 25,
    packetRate: 150,
    lat: null,
    lon: null,
    alt: null,
    sats: null,
    groundSpeed: null,
    heading: null,
  }));
  return parsedLogFromTelemetryRows(rows);
}

const notifications = () => useNotificationsStore.getState();
const session = () => useSessionStore.getState();
const telemetry = () => useTelemetryStore.getState();

// ---------------------------------------------------------------------------
// DOM-free stand-in for the host's telemetry subscription
// ---------------------------------------------------------------------------

interface Runner {
  unsubscribe: () => void;
  /** The frames evaluated per store change, in order — the batching evidence. */
  batches: TelemetryFrame[][];
  toasts: () => LiveAlert[];
  cursor: () => LiveAlertCursor;
  resets: () => number;
}

/** Mirror of `LiveAlertHost`'s subscription body, using its exported runner. */
function mountRunner(): Runner {
  let cursor: LiveAlertCursor = { state: initialAlertState(), anchor: null };
  let active: LiveAlert[] = [];
  let resets = 0;
  const batches: TelemetryFrame[][] = [];

  const unsubscribe = useTelemetryStore.subscribe((store, prev) => {
    if (store.history === prev.history) return;
    const alerts = useAlertsStore.getState();
    const advance = advanceLiveAlerts(store.history, cursor, selectLiveAlertConfig(alerts));
    cursor = { state: advance.state, anchor: advance.anchor };
    batches.push([...advance.evaluated]);
    if (advance.didReset) resets += 1;
    recordFiredAlerts(advance.firedAlerts, alerts.muted);
    active = reconcileToasts(active, advance, alerts.muted);
  });

  return {
    unsubscribe,
    batches,
    toasts: () => active,
    cursor: () => cursor,
    resets: () => resets,
  };
}

beforeEach(() => {
  session().reset();
  telemetry().clear();
  notifications().reset();
  useAlertsStore.setState({
    ...DEFAULT_LIVE_ALERT_CONFIG,
    muted: false,
    soundEnabled: false,
  });
});

// ---------------------------------------------------------------------------
// The defect: a scrubber jump must evaluate every frame that elapsed
// ---------------------------------------------------------------------------

describe("live-alert runner — batched appends", () => {
  it("evaluates ONE frame per single-frame push, exactly like the pre-fix runner", () => {
    const runner = mountRunner();
    const frames = dropoutFrames();

    // The live path: one `push` per decoded frame.
    for (const f of frames) telemetry().push(f);
    runner.unsubscribe();

    // Every store change carried exactly one frame, in order, none repeated.
    expect(runner.batches.map((b) => b.length)).toEqual(frames.map(() => 1));
    expect(runner.batches.flat()).toEqual(frames);

    // …and the threaded state matches a plain frame-by-frame `evaluateFrame`
    // fold — the reference implementation of the behaviour being preserved.
    let state = initialAlertState();
    const fired: LiveAlert[] = [];
    const cleared: string[] = [];
    for (const f of frames) {
      const res = evaluateFrame(f, DEFAULT_LIVE_ALERT_CONFIG, state);
      state = res.newState;
      fired.push(...res.firedAlerts);
      cleared.push(...res.clearedKinds);
    }
    expect(runner.cursor().state).toEqual(state);
    expect(fired.map((a) => a.kind)).toEqual(["signalLoss"]);
    expect(cleared).toEqual(["signalLoss"]);
    // The alarm tripped and recovered, so nothing is left on screen, and the
    // feed holds the one alarm that fired.
    expect(runner.toasts()).toEqual([]);
    expect(notifications().items).toHaveLength(1);
  });

  it("clears a hysteresis alarm on a multi-frame scrubber jump (the e2e defect)", () => {
    const runner = mountRunner();
    session().loadLog(dropoutLog());

    // Step into the dropout one sample at a time (the e2e's ArrowRight idiom).
    for (let i = 1; i <= 6; i++) session().seek(i);
    expect(runner.toasts().map((a) => a.kind)).toEqual(["signalLoss"]);
    expect(notifications().items).toHaveLength(1);

    // One jump to the end: FOUR samples elapse inside a SINGLE store change.
    session().seek(10);
    runner.unsubscribe();

    const jump = runner.batches[runner.batches.length - 1];
    expect(jump).toHaveLength(4);
    expect(jump.map((f) => f.rssi1)).toEqual([-61, -58, -56, -55]);

    // Three consecutive recovered frames land inside that one batch, so the
    // alarm clears — where evaluating `latest` alone never could.
    expect(runner.cursor().state.signalLoss.phase).toBe("ok");
    expect(runner.toasts()).toEqual([]);
    // Recovery fires nothing new: the feed still holds exactly the one alarm.
    expect(notifications().items).toHaveLength(1);
  });

  it("pins the pre-fix behaviour it replaces: evaluating only `latest` never clears", () => {
    const frames = dropoutFrames();

    // Reach the alarming phase the way the live path does.
    let state = initialAlertState();
    for (let i = 0; i <= 6; i++) {
      state = evaluateFrame(frames[i], DEFAULT_LIVE_ALERT_CONFIG, state).newState;
    }
    expect(state.signalLoss.phase).toBe("alarming");

    // OLD: the jump 6 → 10 evaluated the final frame only. One recovered frame
    // is not three, so the alarm stays up and the toast is unclearable.
    const single = evaluateFrame(frames[10], DEFAULT_LIVE_ALERT_CONFIG, state);
    expect(single.clearedKinds).toEqual([]);
    expect(single.newState.signalLoss.phase).toBe("alarming");

    // NEW: the same jump, diffed against the last evaluated frame, evaluates the
    // four frames that actually elapsed and clears.
    const batched = advanceLiveAlerts(
      frames,
      { state, anchor: frames[6] },
      DEFAULT_LIVE_ALERT_CONFIG
    );
    expect(batched.evaluated).toEqual(frames.slice(7));
    expect(batched.clearedKinds).toEqual(["signalLoss"]);
    expect(batched.state.signalLoss.phase).toBe("ok");
    expect(batched.didReset).toBe(false);
  });

  it("records one notification per fired alarm on a batch — no duplicates", () => {
    const runner = mountRunner();
    const frames = dropoutFrames();

    // Healthy baseline, then ONE append carrying the whole dropout: four frames
    // are below the trip, but hysteresis fires the alarm exactly once.
    telemetry().push(frames[0]);
    telemetry().setHistory([...telemetry().history, ...frames.slice(1, 7)]);
    runner.unsubscribe();

    const batch = runner.batches[runner.batches.length - 1];
    expect(batch).toHaveLength(6);

    const items = notifications().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "signalLoss", severity: "critical" });
    expect(new Set(items.map((n) => n.id)).size).toBe(items.length);
    // The one entry is stamped with the frame that tripped it (sample 5), not
    // the newest frame in the batch.
    expect(items[0].id).toBe(`signalLoss:${frames[5].t}`);
    expect(runner.toasts().map((a) => a.kind)).toEqual(["signalLoss"]);
  });

  it("an alarm that trips AND clears inside one batch leaves no toast but is still recorded", () => {
    const runner = mountRunner();
    const frames = dropoutFrames();

    telemetry().push(frames[0]);
    // Everything from the dropout through the full recovery in ONE append.
    telemetry().setHistory([...telemetry().history, ...frames.slice(1)]);
    runner.unsubscribe();

    // Fired and cleared in the same batch → the batch's FINAL phase decides.
    expect(runner.cursor().state.signalLoss.phase).toBe("ok");
    expect(runner.toasts()).toEqual([]);
    // The alarm really happened, so the feed keeps its single entry.
    expect(notifications().items).toHaveLength(1);
  });

  it("still honours the master mute across a batch", () => {
    useAlertsStore.setState({ muted: true });
    const runner = mountRunner();
    const frames = dropoutFrames();

    telemetry().push(frames[0]);
    telemetry().setHistory([...telemetry().history, ...frames.slice(1, 7)]);
    runner.unsubscribe();

    // No toast, no feed entry — but the machine still advanced, so unmuting
    // does not replay the alarm.
    expect(runner.toasts()).toEqual([]);
    expect(notifications().items).toHaveLength(0);
    expect(runner.cursor().state.signalLoss.phase).toBe("alarming");
  });
});

// ---------------------------------------------------------------------------
// Replace vs append, and the ring-buffer cap
// ---------------------------------------------------------------------------

describe("live-alert runner — window replacement", () => {
  it("resets instead of replaying when the window is rebuilt (backward seek)", () => {
    const runner = mountRunner();
    session().loadLog(dropoutLog());
    for (let i = 1; i <= 6; i++) session().seek(i);
    expect(runner.toasts().map((a) => a.kind)).toEqual(["signalLoss"]);

    const before = runner.batches.length;
    session().seek(0); // backward → the store rebuilds the window wholesale
    runner.unsubscribe();

    const rebuild = runner.batches[runner.batches.length - 1];
    expect(runner.batches.length).toBe(before + 1);
    // Only the newest frame is re-baselined — the rebuilt window is NOT replayed.
    expect(rebuild).toHaveLength(1);
    expect(rebuild[0].t).toBe(T0);
    // The machine is fresh, and the standing toast goes with it: a reset machine
    // could never clear a toast it no longer remembers raising.
    expect(runner.cursor().state).toEqual(initialAlertState());
    expect(runner.toasts()).toEqual([]);
    // Re-baselining fires nothing, so the feed is untouched.
    expect(notifications().items).toHaveLength(1);
  });

  it("resets on clear() and on a freshly loaded session", () => {
    const runner = mountRunner();
    session().loadLog(dropoutLog());
    for (let i = 1; i <= 6; i++) session().seek(i);
    expect(runner.toasts()).toHaveLength(1);

    telemetry().clear();
    expect(runner.cursor().state).toEqual(initialAlertState());
    expect(runner.cursor().anchor).toBeNull();
    expect(runner.toasts()).toEqual([]);
    expect(runner.batches[runner.batches.length - 1]).toEqual([]);

    // A new session starts from that clean baseline (loadLog clears, then feeds
    // sample 0) — one frame evaluated, nothing replayed.
    const before = runner.batches.length;
    session().loadLog(dropoutLog());
    runner.unsubscribe();
    expect(runner.batches.slice(before).map((b) => b.length)).toEqual([0, 1]);
    expect(runner.toasts()).toEqual([]);
  });

  it("evaluates each frame exactly once across TELEMETRY_HISTORY_CAP eviction", () => {
    const runner = mountRunner();
    // A long healthy run, longer than the ring buffer.
    const frames = Array.from({ length: TELEMETRY_HISTORY_CAP + 40 }, (_, i) =>
      frame(i, -60, -65)
    );

    // Seed a nearly-full window (a replace), then append past the cap twice.
    const seeded = frames.slice(0, TELEMETRY_HISTORY_CAP - 2);
    telemetry().setHistory(seeded);
    const seedBatches = runner.batches.length;

    const first = frames.slice(TELEMETRY_HISTORY_CAP - 2, TELEMETRY_HISTORY_CAP + 8);
    telemetry().setHistory([...telemetry().history, ...first]);
    const second = frames.slice(TELEMETRY_HISTORY_CAP + 8);
    telemetry().setHistory([...telemetry().history, ...second]);
    runner.unsubscribe();

    // The buffer really did evict (it is pinned at the cap, and the oldest
    // seeded frames are gone).
    expect(telemetry().history).toHaveLength(TELEMETRY_HISTORY_CAP);
    expect(telemetry().history.includes(frames[0])).toBe(false);

    // Every appended frame was evaluated exactly once, in order: eviction shifts
    // the anchor's index but can neither re-play nor skip a frame.
    const evaluated = runner.batches.slice(seedBatches).flat();
    expect(evaluated).toEqual([...first, ...second]);
    expect(new Set(evaluated).size).toBe(evaluated.length);
    expect(runner.resets()).toBe(1); // the seeding setHistory only
  });

  it("re-baselines rather than replays when an append outruns the whole buffer", () => {
    const runner = mountRunner();
    const frames = Array.from({ length: TELEMETRY_HISTORY_CAP * 2 }, (_, i) =>
      frame(i, -60, -65)
    );
    telemetry().push(frames[0]);
    // More than a full buffer in one set: the anchor itself is evicted, so the
    // window is a different window — evaluate the newest frame from scratch
    // instead of replaying frames that no longer have a continuous history.
    telemetry().setHistory(frames);
    runner.unsubscribe();

    const last = runner.batches[runner.batches.length - 1];
    expect(last).toEqual([frames[frames.length - 1]]);
    expect(runner.resets()).toBe(2); // the first push (no anchor yet) + this one
  });
});

// ---------------------------------------------------------------------------
// Toast reconciliation
// ---------------------------------------------------------------------------

describe("reconcileToasts", () => {
  const alarming = () => {
    const s = initialAlertState();
    return { ...s, signalLoss: { phase: "alarming" as const, badStreak: 0, goodStreak: 0 } };
  };
  const toast: LiveAlert = {
    kind: "signalLoss",
    severity: "critical",
    t: T0,
    messageKey: "alerts.message.signalLoss",
    detail: { rssi: -105 },
  };

  it("returns the same array reference when nothing changed", () => {
    const active = [toast];
    const next = reconcileToasts(
      active,
      { state: alarming(), firedAlerts: [], clearedKinds: [], didReset: false },
      false
    );
    expect(next).toBe(active);
  });

  it("drops a cleared alarm and keeps an unrelated one", () => {
    const other: LiveAlert = { ...toast, kind: "lqDrop", severity: "warning" };
    const next = reconcileToasts(
      [toast, other],
      {
        state: initialAlertState(),
        firedAlerts: [],
        clearedKinds: ["signalLoss"],
        didReset: false,
      },
      false
    );
    expect(next.map((a) => a.kind)).toEqual(["lqDrop"]);
  });

  it("shows a re-trip that outlives its clear inside one batch", () => {
    const later: LiveAlert = { ...toast, t: T0 + 900, detail: { rssi: -110 } };
    const next = reconcileToasts(
      [],
      {
        state: alarming(),
        firedAlerts: [toast, later], // fired, cleared, fired again
        clearedKinds: ["signalLoss"],
        didReset: false,
      },
      false
    );
    // One toast per kind, and it is the LAST fire — never a duplicate React key.
    expect(next).toEqual([later]);
  });

  it("suppresses new toasts while muted but still clears a standing one", () => {
    const next = reconcileToasts(
      [toast],
      {
        state: alarming(),
        firedAlerts: [{ ...toast, kind: "lqDrop", severity: "warning" }],
        clearedKinds: ["signalLoss"],
        didReset: false,
      },
      true
    );
    expect(next).toEqual([]);
  });
});
