import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AlertKind, AnomalySeverity } from "@/lib/liveAlerts";
import type { DiagnosticCategory } from "@/lib/diagnostics";

/**
 * Persisted notification center (v1.7.1).
 *
 * Gives the M26 live-alert layer a browsable, persistent home. The single
 * evaluation path (`LiveAlertHost` → `evaluateFrame`) enqueues one entry per
 * fired alarm — there is no second detector. The queue is **bounded** to
 * {@link NOTIFICATION_CAP} so a long session cannot grow localStorage without
 * limit, and {@link NotificationsState.enqueue} **dedups by id** so a re-render
 * (or a re-fired alarm carrying the same `kind:t` id) never double-counts.
 *
 * Copy stays i18n-reactive: `body` holds the i18n message **key**
 * (`alerts.message.<kind>`) and `params` its interpolation values, so the panel
 * renders `t(body, params)` and follows a language switch — nothing is frozen
 * at enqueue time. Persisted to localStorage (key `omnilink-notifications`)
 * following the same zustand `persist` convention as the alerts / theme stores;
 * only `items` is persisted (the open/close state is runtime-only, cf.
 * `assistant.ts`). The store is pure JS/localStorage, so it populates
 * identically on web and in the Tauri webview — no `isTauri()` guard needed.
 */

/** Maximum retained notifications; older entries are evicted past this. */
export const NOTIFICATION_CAP = 100;

/** One stored notification, fed from a fired {@link AlertKind} alarm. */
export interface AppNotification {
  /** Stable per-fire id (`<kind>:<frame-ts>`); the dedup key. */
  id: string;
  /**
   * Which alarm fired. An M26 live-alert {@link AlertKind} (panel title via
   * `alerts.type.<type>`) or — for an M37 diagnostic finding (`id` prefixed
   * `diag:`) — its {@link DiagnosticCategory} (title via
   * `diagnostics.notification.category.<type>`).
   */
  type: AlertKind | DiagnosticCategory;
  severity: AnomalySeverity;
  /** Frame capture timestamp (ms) the alarm tripped on. */
  ts: number;
  read: boolean;
  /** i18n message key (`alerts.message.<type>`), rendered with {@link params}. */
  body: string;
  /** Interpolation values for {@link body} — non-identifying numbers only. */
  params?: Record<string, number>;
}

interface NotificationsState {
  items: AppNotification[];
  /** Whether the bell dropdown is open (runtime-only, not persisted). */
  isOpen: boolean;
  /** Append a new (unread) notification — dedups by id, caps the queue. */
  enqueue: (notification: Omit<AppNotification, "read">) => void;
  /** Mark a single notification read. */
  markRead: (id: string) => void;
  /** Mark every notification read. */
  markAllRead: () => void;
  /** Drop every notification. */
  clear: () => void;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Reset to the initial state (test seam + a hard clear). */
  reset: () => void;
}

const INITIAL: Pick<NotificationsState, "items" | "isOpen"> = {
  items: [],
  isOpen: false,
};

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set) => ({
      ...INITIAL,
      enqueue: (notification) =>
        set((state) => {
          // Dedup: a re-fired alarm (or a double subscriber tick) carrying an
          // id we already hold is a no-op. Return the SAME items reference so
          // selectors don't churn.
          if (state.items.some((n) => n.id === notification.id)) {
            return { items: state.items };
          }
          // Newest-first; evict the oldest past the retention cap.
          const next = [{ ...notification, read: false }, ...state.items];
          return {
            items:
              next.length > NOTIFICATION_CAP
                ? next.slice(0, NOTIFICATION_CAP)
                : next,
          };
        }),
      markRead: (id) =>
        set((state) => ({
          items: state.items.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        })),
      markAllRead: () =>
        set((state) => ({
          items: state.items.map((n) => (n.read ? n : { ...n, read: true })),
        })),
      clear: () => set({ items: [] }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),
      reset: () => set({ ...INITIAL }),
    }),
    {
      name: "omnilink-notifications",
      // Persist only the queue; open/close is runtime-only (cf. assistant.ts).
      partialize: (state) => ({ items: state.items }),
    }
  )
);

/** Count of unread notifications (derived; the bell badge reads this). */
export function selectUnreadCount(state: NotificationsState): number {
  return state.items.reduce((n, item) => (item.read ? n : n + 1), 0);
}
