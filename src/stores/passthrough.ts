import { create } from "zustand";
import { runPassthroughCheck } from "@/lib/tauri";
import type { PassthroughCheckReportDto } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// M64: Passthrough diagnostics store (v2.2 "Controller Bridge Mode").
//
// A NON-PERSISTED runtime store (a sibling of `stores/bridge.ts`): it reflects
// LIVE passthrough check attempts against real hardware, so it must never
// persist a stale report across sessions. It holds the latest guided-check
// report plus a BOUNDED diagnostic event log of every attempt (newest-first,
// capped like the notifications queue) — M66 exports this log.
//
// READ-ONLY: `runCheck()` calls `run_passthrough_check`, which sends only the
// read-only MSP GET + the in-scope `MSP_SET_PASSTHROUGH` transport command. The
// FC is a passthrough bridge endpoint, never a managed device.
// ---------------------------------------------------------------------------

/** Lifecycle of the most recent passthrough check. */
export type PassthroughStatus = "idle" | "running" | "done" | "error";

/** Maximum retained log attempts; older entries are evicted past this. */
export const PASSTHROUGH_LOG_CAP = 50;

/**
 * One recorded passthrough attempt in the diagnostic event log. The timestamp
 * is stamped frontend-side (the backend returns only the report — `Date::now`
 * is not available in some Rust contexts), and the entry carries everything M66
 * needs to export: the inputs, the categorised report, or an open-failure error.
 */
export interface PassthroughAttempt {
  /** Stable per-attempt id. */
  id: string;
  /** Wall-clock time the attempt ran (ms, `Date.now()`). */
  timestamp: number;
  /** The serial port the attempt targeted. */
  port: string;
  /** The user-selected baud override tried first, or null for auto-fallback. */
  baudOverride: number | null;
  /** The FC UART the RX was declared wired to, or null. */
  uart: number | null;
  /** The categorised check report, or null if the attempt failed to run. */
  report: PassthroughCheckReportDto | null;
  /** An open/invoke failure message (busy/missing port, off-Tauri), or null. */
  error: string | null;
}

interface PassthroughState {
  /** Lifecycle of the most recent check. */
  status: PassthroughStatus;
  /** The latest completed check report, if any. */
  report: PassthroughCheckReportDto | null;
  /** A check failure message (open/busy/permission, off-Tauri), or null. */
  error: string | null;
  /** The serial port the most recent check targeted. */
  port: string | null;
  /** Bounded, newest-first diagnostic event log of every attempt. */
  log: PassthroughAttempt[];

  /**
   * Run the guided passthrough check on `port` (READ-ONLY MSP GET +
   * `MSP_SET_PASSTHROUGH`). Moves to "running", then lands on "done" with the
   * report, or "error" with the message. Either way the attempt is appended to
   * the bounded {@link log}. Catches an invoke rejection gracefully (off-Tauri
   * or a busy/missing port) so the caller never sees an unhandled rejection.
   */
  runCheck: (
    port: string,
    baudOverride?: number,
    uart?: number
  ) => Promise<void>;
  /** Clear the diagnostic event log (keeps the current status/report). */
  clearLog: () => void;
  /** Reset the whole store back to idle (clears the report, error and log). */
  reset: () => void;
}

/** Monotonic suffix so two attempts in the same millisecond still get unique ids. */
let attemptSeq = 0;

/** Prepend `entry` to `log`, capping at {@link PASSTHROUGH_LOG_CAP} (newest-first). */
function appendCapped(
  log: PassthroughAttempt[],
  entry: PassthroughAttempt
): PassthroughAttempt[] {
  const next = [entry, ...log];
  return next.length > PASSTHROUGH_LOG_CAP
    ? next.slice(0, PASSTHROUGH_LOG_CAP)
    : next;
}

export const usePassthroughStore = create<PassthroughState>()((set) => ({
  status: "idle",
  report: null,
  error: null,
  port: null,
  log: [],

  runCheck: async (port, baudOverride, uart) => {
    set({ status: "running", port, error: null, report: null });
    const timestamp = Date.now();
    const base = {
      id: `${timestamp}-${(attemptSeq += 1)}`,
      timestamp,
      port,
      baudOverride: baudOverride ?? null,
      uart: uart ?? null,
    };
    try {
      const report = await runPassthroughCheck(port, baudOverride, uart);
      set((s) => ({
        status: "done",
        report,
        error: null,
        log: appendCapped(s.log, { ...base, report, error: null }),
      }));
    } catch (e) {
      // Open/busy/permission failure, or running outside Tauri — land on a
      // clean error state and still log the attempt for the diagnostic record.
      const message = String(e);
      set((s) => ({
        status: "error",
        report: null,
        error: message,
        log: appendCapped(s.log, { ...base, report: null, error: message }),
      }));
    }
  },

  clearLog: () => set({ log: [] }),

  reset: () =>
    set({ status: "idle", report: null, error: null, port: null, log: [] }),
}));
