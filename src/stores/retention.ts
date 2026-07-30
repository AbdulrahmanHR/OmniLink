import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Persisted session-retention policy (M24, FR-LOG-02).
 *
 * Bounds the growth of `omnilink.db` by pruning old recorded telemetry sessions
 * when the session list loads. The policy maps onto
 * {@link import("@/lib/sessions-db").RetentionPolicy}: `maxCount` keeps the
 * newest N recordings, `maxAgeDays` drops anything older than N days, and the
 * two combine as a union. Disabled by default so OmniLink never deletes a
 * recording until the operator opts in; the choice is persisted to localStorage
 * (key `omnilink-retention`) following the same zustand `persist` convention as
 * the theme / dashboard-panels stores.
 */
interface RetentionState {
  /** Whether automatic pruning runs at all. Off by default (no surprise data loss). */
  enabled: boolean;
  /** Keep only the newest this-many sessions when pruning. */
  maxCount: number;
  /** Prune sessions older than this many days when pruning. */
  maxAgeDays: number;
  /** Enable/disable automatic pruning. */
  setEnabled: (value: boolean) => void;
  /** Set the kept-session count bound. */
  setMaxCount: (value: number) => void;
  /** Set the maximum-age (days) bound. */
  setMaxAgeDays: (value: number) => void;
}

export const useRetentionStore = create<RetentionState>()(
  persist(
    (set) => ({
      enabled: false,
      maxCount: 50,
      maxAgeDays: 90,
      setEnabled: (value: boolean) => set({ enabled: value }),
      setMaxCount: (value: number) => set({ maxCount: value }),
      setMaxAgeDays: (value: number) => set({ maxAgeDays: value }),
    }),
    {
      name: "omnilink-retention",
    }
  )
);
