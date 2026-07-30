import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiagnosticHistoryRecord } from "@/lib/diagnostics";
// Re-export the record type from the store so consumers can import it from either
// layer; the canonical definition lives in the pure engine (`@/lib/diagnostics`).
export type { DiagnosticHistoryRecord };

/**
 * Persisted diagnostic-history store (M40, v2.0.2) — the impure home for the
 * user's OWN accumulated per-session diagnostic summaries.
 *
 * This is the raw material the /trends surface aggregates: one
 * {@link DiagnosticHistoryRecord} is appended each time a session is analyzed (by
 * the analysis page), and the pure trend engine (`summarizeTrends` /
 * `deriveSuggestions`) reads them back out. The store adds **no** analysis logic —
 * it only dedupes, caps, and persists.
 *
 * ## Honest-mock contract
 * Records are ONLY ever added by {@link DiagnosticsHistoryState.recordSession} from
 * a real analyzed session. There is no seed and no fabrication: a fresh install
 * starts empty, and {@link DiagnosticsHistoryState.clear} / `reset` genuinely
 * empties the history so the trend state disappears with it.
 *
 * ## Persistence
 * Persisted to localStorage (key {@link DIAGNOSTICS_HISTORY_STORAGE_KEY}) following
 * the same zustand `persist` convention as the diagnostics / notifications stores —
 * the default JSON storage no-ops cleanly when `localStorage` is absent (Node
 * tests). Only {@link DiagnosticsHistoryState.records} is persisted, and the merge
 * defensively coerces a missing/old shape so a legacy blob can never crash rehydrate.
 */

/** Persist key for the diagnostic-history store. */
export const DIAGNOSTICS_HISTORY_STORAGE_KEY = "omnilink-diagnostics-history";

/** Maximum retained history records; the oldest are evicted past this. */
export const DIAGNOSTICS_HISTORY_CAP = 200;

/** State + actions exposed by {@link useDiagnosticsHistoryStore}. */
export interface DiagnosticsHistoryState {
  /** Recorded per-session summaries, newest-first, capped at {@link DIAGNOSTICS_HISTORY_CAP}. */
  records: DiagnosticHistoryRecord[];
  /**
   * Record one analyzed session. Dedupes by `signature` — re-analyzing (a config
   * tweak) or re-importing the same content updates the record in place rather
   * than duplicating it: any existing record with the same signature is dropped,
   * the new one is prepended, and the list is capped (oldest evicted).
   */
  recordSession: (rec: DiagnosticHistoryRecord) => void;
  /** Drop every history record (the reset-history control + a hard clear). */
  clear: () => void;
  /** Alias of {@link clear} (test seam / store-convention parity). */
  reset: () => void;
}

/** Is `v` a mergeable plain object (not an array/null)? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Rehydrate merge: tolerate a missing/old persisted shape by coercing `records`
 * to `[]` when absent or malformed. Runtime actions keep the current values.
 */
function mergePersisted(
  persisted: unknown,
  current: DiagnosticsHistoryState
): DiagnosticsHistoryState {
  const slice = isPlainObject(persisted) ? persisted : {};
  const records = Array.isArray(slice.records)
    ? (slice.records as DiagnosticHistoryRecord[])
    : [];
  return { ...current, records };
}

export const useDiagnosticsHistoryStore = create<DiagnosticsHistoryState>()(
  persist(
    (set) => ({
      records: [],

      recordSession: (rec) =>
        set((state) => {
          // Dedupe by content signature: drop a prior copy, prepend the fresh
          // record, then cap (oldest evicted).
          const withoutDup = state.records.filter(
            (r) => r.signature !== rec.signature
          );
          return { records: [rec, ...withoutDup].slice(0, DIAGNOSTICS_HISTORY_CAP) };
        }),

      clear: () => set({ records: [] }),
      reset: () => set({ records: [] }),
    }),
    {
      name: DIAGNOSTICS_HISTORY_STORAGE_KEY,
      // Persist only the record list; defensively normalize a legacy/absent shape.
      partialize: (state) => ({ records: state.records }),
      merge: mergePersisted,
    }
  )
);
