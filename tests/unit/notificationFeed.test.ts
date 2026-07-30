import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_ALERT_CONFIG,
  evaluateFrames,
  initialAlertState,
  type AlertFrame,
} from "@/lib/liveAlerts";
import {
  notificationFromAlert,
  recordFiredAlerts,
} from "@/lib/notificationFeed";
import { selectUnreadCount, useNotificationsStore } from "@/stores/notifications";

const store = () => useNotificationsStore.getState();

/** A sustained low-RSSI dropout: ≥3 frames below the −100 dBm signalLoss trip. */
function dropoutFrames(): AlertFrame[] {
  const frames: AlertFrame[] = [];
  // Two healthy frames, then four well below the floor → trips signalLoss once.
  const samples = [-60, -62, -105, -110, -107, -103];
  samples.forEach((rssi, i) => {
    frames.push({ t: 1000 + i * 50, rssi1: rssi, rssi2: rssi, linkQuality: 90, gps: null });
  });
  return frames;
}

/** Run the REAL M26 evaluator over a frame sequence and return its fired alerts. */
function fire(frames: AlertFrame[]) {
  return evaluateFrames(frames, DEFAULT_LIVE_ALERT_CONFIG, initialAlertState())
    .firedAlerts;
}

beforeEach(() => {
  store().reset();
});

describe("notificationFromAlert", () => {
  it("maps a fired alarm onto the stored notification shape", () => {
    const [alert] = fire(dropoutFrames());
    expect(alert).toBeDefined();
    const n = notificationFromAlert(alert);
    expect(n).toEqual({
      id: `signalLoss:${alert.t}`,
      type: "signalLoss",
      severity: "critical",
      ts: alert.t,
      body: "alerts.message.signalLoss",
      params: alert.detail, // numbers-only interpolation bag, kept for re-render
    });
    // The body is a key, not resolved copy — so a language switch re-translates.
    expect(n.body).toMatch(/^alerts\.message\./);
  });
});

describe("recordFiredAlerts — wiring", () => {
  it("enqueues exactly one notification for a single tripped alarm", () => {
    const fired = fire(dropoutFrames());
    expect(fired).toHaveLength(1); // M26 debounce → one fire per crossing

    recordFiredAlerts(fired, false);

    expect(store().items).toHaveLength(1);
    expect(selectUnreadCount(store())).toBe(1);
    expect(store().items[0]).toMatchObject({
      type: "signalLoss",
      severity: "critical",
      read: false,
    });
  });

  it("suppresses new entries while muted (no second channel leaks past mute)", () => {
    const fired = fire(dropoutFrames());
    recordFiredAlerts(fired, true);
    expect(store().items).toHaveLength(0);
    expect(selectUnreadCount(store())).toBe(0);
  });

  it("re-recording the same fired alarm does not double-count (dedup by id)", () => {
    const fired = fire(dropoutFrames());
    recordFiredAlerts(fired, false);
    recordFiredAlerts(fired, false); // same kind:t id → no-op
    expect(store().items).toHaveLength(1);
  });

  it("no fired alarms → nothing enqueued", () => {
    const healthy: AlertFrame[] = [0, 1, 2, 3].map((i) => ({
      t: 1000 + i * 50,
      rssi1: -60,
      rssi2: -60,
      linkQuality: 95,
      gps: null,
    }));
    recordFiredAlerts(fire(healthy), false);
    expect(store().items).toHaveLength(0);
  });
});
