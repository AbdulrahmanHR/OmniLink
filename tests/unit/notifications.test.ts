import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTIFICATION_CAP,
  selectUnreadCount,
  useNotificationsStore,
  type AppNotification,
} from "@/stores/notifications";

/** Minimal fired-alarm payload (id supplied per-case to exercise dedup/cap). */
function entry(
  id: string,
  over: Partial<Omit<AppNotification, "read">> = {}
): Omit<AppNotification, "read"> {
  return {
    id,
    type: "signalLoss",
    severity: "critical",
    ts: 1000,
    body: "alerts.message.signalLoss",
    params: { rssi: -101 },
    ...over,
  };
}

const store = () => useNotificationsStore.getState();
const enqueue = (id: string, over?: Partial<Omit<AppNotification, "read">>) =>
  store().enqueue(entry(id, over));

beforeEach(() => {
  store().reset();
});

describe("enqueue — dedup", () => {
  it("ignores a second enqueue with an already-seen id", () => {
    enqueue("signalLoss:1000", { params: { rssi: -101 } });
    enqueue("signalLoss:1000", { params: { rssi: -120 } }); // same id, re-fired
    expect(store().items).toHaveLength(1);
    // The first payload wins; the duplicate did not overwrite it.
    expect(store().items[0].params).toEqual({ rssi: -101 });
  });

  it("keeps distinct ids", () => {
    enqueue("signalLoss:1000");
    enqueue("lqDrop:1050", { type: "lqDrop", severity: "warning" });
    expect(store().items).toHaveLength(2);
  });
});

describe("enqueue — ordering + cap", () => {
  it("prepends newest-first", () => {
    enqueue("a");
    enqueue("b");
    enqueue("c");
    expect(store().items.map((n) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("bounds the queue at NOTIFICATION_CAP, evicting the oldest", () => {
    for (let i = 0; i < NOTIFICATION_CAP + 5; i++) enqueue(`n${i}`);
    expect(store().items).toHaveLength(NOTIFICATION_CAP);
    // Newest retained at the head…
    expect(store().items[0].id).toBe(`n${NOTIFICATION_CAP + 4}`);
    // …and the oldest five evicted entirely.
    const ids = new Set(store().items.map((n) => n.id));
    expect(ids.has("n0")).toBe(false);
    expect(ids.has("n4")).toBe(false);
    expect(ids.has("n5")).toBe(true);
  });
});

describe("unread math", () => {
  it("counts every freshly-enqueued (unread) item", () => {
    enqueue("a");
    enqueue("b");
    expect(selectUnreadCount(store())).toBe(2);
  });

  it("markRead clears exactly one; the rest stay unread", () => {
    enqueue("a");
    enqueue("b");
    store().markRead("a");
    expect(selectUnreadCount(store())).toBe(1);
    // The marked item is the one flipped, not an arbitrary one.
    expect(store().items.find((n) => n.id === "a")?.read).toBe(true);
    expect(store().items.find((n) => n.id === "b")?.read).toBe(false);
  });

  it("markRead on an unknown id is a no-op (count unchanged)", () => {
    enqueue("a");
    store().markRead("missing");
    expect(selectUnreadCount(store())).toBe(1);
  });

  it("markAllRead zeroes the count without dropping items", () => {
    enqueue("a");
    enqueue("b");
    store().markAllRead();
    expect(selectUnreadCount(store())).toBe(0);
    expect(store().items).toHaveLength(2);
  });
});

describe("clear", () => {
  it("drops every notification and zeroes the unread count", () => {
    enqueue("a");
    enqueue("b");
    store().clear();
    expect(store().items).toHaveLength(0);
    expect(selectUnreadCount(store())).toBe(0);
  });
});
