import { create } from "zustand";
import type { ParsedLog } from "@/lib/blackbox";
import { detectAnomalies, type AnomalyEvent } from "@/lib/anomaly";
import {
  indexAtSessionElapsed,
  logRelativeTimes,
  telemetryFrameFromLog,
} from "@/lib/replay";
import { TELEMETRY_HISTORY_CAP, useTelemetryStore } from "@/stores/telemetry";

/**
 * Unified Session Analysis store (v1.7.0).
 *
 * This is the single source of truth for the merged Session Analysis surface,
 * folding the former `useLogsStore` (forensic scrub over a {@link ParsedLog})
 * and `useSimulatorStore` (wall-clock replay into the live dashboard) into ONE
 * store with ONE session model and ONE position index.
 *
 * - **One session** — a single loaded {@link ParsedLog} (`log`), parsed once by
 *   the unified import surface regardless of source (CSV/`.bbl` or a prior
 *   SQLite session). The dashboard's live frames are *derived* from this one
 *   model via {@link telemetryFrameFromLog}; there is no parallel
 *   `TelemetrySessionCsvRow[]` buffer.
 * - **One position index** — `positionIndex` (an index into `log.time`). Every
 *   consumer reads it: the dashboard gauges (indirectly, via the shared
 *   {@link useTelemetryStore} this store feeds), the timeline charts, the
 *   flight-path map, and the anomaly list.
 * - **Two interaction modes over that one index** — `mode` is `"scrub"`
 *   (forensic: the user drags the index) or `"play"` (replay: the wall-clock
 *   driver animates the index forward at `speed`). Replay is literally
 *   "animate `positionIndex` forward".
 *
 * The driver (timer id), the relative-time table, and the wall-clock anchor live
 * in module-level refs — imperative engine internals, never render inputs — so
 * play/pause/seek/stop stay idempotent and re-renders never touch them.
 */

/** Interaction mode over the single position index. */
export type SessionMode = "scrub" | "play";

/** Allowed playback-speed multipliers. */
export type SessionSpeed = 0.5 | 1 | 2 | 4;

interface SessionState {
  /** The loaded session, or `null` when nothing has been imported yet. */
  log: ParsedLog | null;
  /** THE single shared position — an index into `log.time`. */
  positionIndex: number;
  /** `"scrub"` (user drags the index) or `"play"` (driver animates it). */
  mode: SessionMode;
  /** Playback-speed multiplier for replay. */
  speed: SessionSpeed;
  /**
   * True while a session is loaded and feeding the shared telemetry store —
   * drives the persistent SIMULATED badge and suppresses the live stream
   * (FR-SIM-02: a SIMULATED badge must never sit over live data).
   */
  isSimulating: boolean;
  /** Inclusive start of the analysis selection, or `null` for none. */
  selectionStart: number | null;
  /** Inclusive end of the analysis selection, or `null` for none. */
  selectionEnd: number | null;
  /** Anomalies detected over the loaded log (recomputed by {@link loadLog}). */
  anomalies: AnomalyEvent[];
  /** Selected anomaly as an index into {@link anomalies}, or `null`. */
  selectedAnomalyIndex: number | null;

  /** Load a parsed session, resetting the position to 0 and feeding frame 0. */
  loadLog: (log: ParsedLog) => void;
  /**
   * Tear the session down to the empty import state: stop the driver, clear the
   * shared telemetry store, drop `isSimulating`. Used by the Stop / "Load
   * another" controls.
   */
  reset: () => void;
  /**
   * Page-unmount cleanup: stop the replay timer (so simulated frames cannot keep
   * flowing once the page is gone) and settle in `"scrub"`. The loaded session
   * (log, position, anomalies, selection) AND its fed telemetry window are
   * deliberately KEPT — and `isSimulating` stays true — so the simulated replay
   * survives SPA navigation to the live `/telemetry` dashboard (proven
   * end-to-end by `map.spec`/`offline.spec`), where that dashboard still labels
   * the frames SIMULATED and the live stream stays suppressed (FR-SIM-02: the
   * badge never sits over live data). This adopts the former Simulator's model
   * where a loaded session owns the shared dashboard; Stop / "Load another" are
   * the off-ramp that fully clear it ({@link reset}) and hand the dashboard back
   * to a live link.
   */
  suspend: () => void;
  /** Move the single shared position (clamped), syncing the dashboard window. */
  seek: (index: number) => void;
  /** Enter replay: animate `positionIndex` forward at `speed`. */
  play: () => void;
  /** Leave replay: stop the driver, settle in `"scrub"`. */
  pause: () => void;
  /** Set the replay speed (re-anchors live if currently playing). */
  setSpeed: (speed: SessionSpeed) => void;
  /** Replace the anomaly list and reset the anomaly selection. */
  setAnomalies: (events: AnomalyEvent[]) => void;
  /** Select an anomaly (or `null`); also scrubs the one index to its sample. */
  selectAnomaly: (i: number | null) => void;
  /** Mark the current position as the selection start. */
  markSelectionStart: () => void;
  /** Mark the current position as the selection end. */
  markSelectionEnd: () => void;
  /** Clear the analysis selection. */
  clearSelection: () => void;
}

/**
 * Wall-clock anchor: at `wallStart` (Date.now ms) the session was at
 * `sessionAtAnchor` session-relative ms. Session elapsed is derived from these
 * plus the current speed, so pause/seek/speed-change just re-anchor without
 * losing position.
 */
interface ClockAnchor {
  wallStart: number;
  sessionAtAnchor: number;
}

/** Driver tick interval (~30fps). */
const TICK_MS = 33;

/**
 * Module-level driver refs — imperative engine internals, deliberately outside
 * Zustand state (not render inputs).
 */
let timerId: ReturnType<typeof setInterval> | null = null;
let relTimes: number[] = [];
let anchor: ClockAnchor | null = null;

/** Stop the wall-clock driver if it's running. Idempotent. */
function stopTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

/** Clamp `i` into `[0, last]` (integer); returns 0 when there are no samples. */
function clampIndex(i: number, sampleCount: number): number {
  const last = sampleCount - 1;
  if (last < 0) return 0;
  const t = Math.trunc(i);
  if (t < 0) return 0;
  if (t > last) return last;
  return t;
}

export const useSessionStore = create<SessionState>()((set, get) => {
  /**
   * Push every newly-passed sample from `fromExclusive+1`..`target` into the
   * shared telemetry store so the dashboard's history grows like live capture.
   */
  const pushRange = (fromExclusive: number, target: number): void => {
    const { log } = get();
    if (!log) return;
    const added = Array.from({ length: target - fromExclusive }, (_, i) =>
      telemetryFrameFromLog(log, fromExclusive + 1 + i)
    );
    if (added.length === 0) return;
    // Append the newly-passed frames in ONE set() (the store trims to the cap)
    // rather than N per-frame push() notifications.
    const telemetry = useTelemetryStore.getState();
    telemetry.setHistory([...telemetry.history, ...added]);
  };

  /**
   * Rebuild the shared telemetry window so it ends at `index`, bounded by the
   * rolling cap (so the work stays O(cap) regardless of session length). Used by
   * a backward or large-jump `seek` to re-anchor the dashboard history to the
   * single position.
   */
  const rebuildWindowTo = (index: number): void => {
    const { log } = get();
    if (!log) return;
    const start = Math.max(0, index - TELEMETRY_HISTORY_CAP + 1);
    // Build the whole capped window as one array and apply it in a single set()
    // instead of clear()+N push() (which is O(cap^2) copies + ~cap notifications).
    const frames = Array.from({ length: index - start + 1 }, (_, i) =>
      telemetryFrameFromLog(log, start + i)
    );
    useTelemetryStore.getState().setHistory(frames);
  };

  /** Re-anchor the wall clock to the current position without moving it. */
  const reanchor = (): void => {
    anchor = {
      wallStart: Date.now(),
      sessionAtAnchor: relTimes[get().positionIndex] ?? 0,
    };
  };

  /** Park at the final sample: stop the driver and settle in `"scrub"`. */
  const parkAtEnd = (lastIndex: number): void => {
    stopTimer();
    anchor = null;
    set({ positionIndex: lastIndex, mode: "scrub" });
  };

  const tick = (): void => {
    if (anchor === null) return;
    const { positionIndex, speed, log } = get();
    if (!log) return;
    const lastIndex = log.sampleCount - 1;
    // Already at (or past) the end — a degenerate single-sample session or a
    // seek-to-last while playing — park instead of spinning the timer forever.
    if (positionIndex >= lastIndex) {
      parkAtEnd(lastIndex);
      return;
    }
    const sessionElapsed =
      (Date.now() - anchor.wallStart) * speed + anchor.sessionAtAnchor;
    const target = indexAtSessionElapsed(relTimes, sessionElapsed);
    if (target <= positionIndex) return;

    if (target >= lastIndex) {
      // Reached the end: push the remaining samples, park at the last one.
      pushRange(positionIndex, lastIndex);
      parkAtEnd(lastIndex);
      return;
    }

    pushRange(positionIndex, target);
    set({ positionIndex: target });
  };

  const startTimer = (): void => {
    stopTimer();
    reanchor();
    timerId = setInterval(tick, TICK_MS);
  };

  return {
    log: null,
    positionIndex: 0,
    mode: "scrub",
    speed: 1,
    isSimulating: false,
    selectionStart: null,
    selectionEnd: null,
    anomalies: [],
    selectedAnomalyIndex: null,

    loadLog: (log) => {
      stopTimer();
      anchor = null;
      const telemetry = useTelemetryStore.getState();
      telemetry.clear();
      if (log.sampleCount === 0) {
        relTimes = [];
        set({
          log,
          positionIndex: 0,
          mode: "scrub",
          isSimulating: false,
          selectionStart: null,
          selectionEnd: null,
          anomalies: [],
          selectedAnomalyIndex: null,
        });
        return;
      }
      relTimes = logRelativeTimes(log);
      telemetry.push(telemetryFrameFromLog(log, 0));
      set({
        log,
        positionIndex: 0,
        mode: "scrub",
        isSimulating: true,
        selectionStart: null,
        selectionEnd: null,
        // Detection runs here so every consumer (panel, charts, map) shares one
        // computed list keyed off the loaded log.
        anomalies: detectAnomalies(log),
        selectedAnomalyIndex: null,
      });
    },

    reset: () => {
      stopTimer();
      anchor = null;
      relTimes = [];
      useTelemetryStore.getState().clear();
      set({
        log: null,
        positionIndex: 0,
        mode: "scrub",
        speed: 1,
        isSimulating: false,
        selectionStart: null,
        selectionEnd: null,
        anomalies: [],
        selectedAnomalyIndex: null,
      });
    },

    suspend: () => {
      stopTimer();
      anchor = null;
      if (get().mode === "play") set({ mode: "scrub" });
    },

    seek: (target) => {
      const { log, mode, positionIndex } = get();
      if (!log || log.sampleCount === 0) return;
      const clamped = clampIndex(target, log.sampleCount);
      // No-op seek (e.g. slider dragged to the current sample): the position and
      // its history window are already correct, so skip the rebuild entirely. In
      // "play" mode the existing wall-clock anchor stays valid (position is
      // unchanged), so returning here does not pause playback or drop the mode.
      if (clamped === positionIndex) return;
      // Keep the single history in sync with the scrubbed-to point — one cursor,
      // one history. Seeking *forward* within the rolling cap grows that history
      // like live capture (push only the newly-passed samples); a backward seek
      // (or a forward jump larger than the cap, which would discard the whole
      // window anyway) rebuilds, but starts at the first sample that can survive
      // TELEMETRY_HISTORY_CAP so the work is bounded regardless of session
      // length. Either path yields the same final history and `latest`.
      if (clamped > positionIndex && clamped - positionIndex < TELEMETRY_HISTORY_CAP) {
        pushRange(positionIndex, clamped);
      } else {
        rebuildWindowTo(clamped);
      }
      set({ positionIndex: clamped });
      if (mode === "play") {
        // Re-anchor so playback continues from the scrubbed-to point with no jump.
        startTimer();
      }
    },

    play: () => {
      const { log, positionIndex } = get();
      if (!log || log.sampleCount === 0) return;
      const lastIndex = log.sampleCount - 1;
      if (positionIndex >= lastIndex) {
        // Parked at the final sample. A single-sample session has nothing to
        // play — stay in scrub. Otherwise restart from the top: rebuild
        // start-of-session state via seek(0), then play from the beginning.
        if (lastIndex === 0) return;
        get().seek(0);
      }
      set({ mode: "play" });
      startTimer();
    },

    pause: () => {
      if (get().mode !== "play") return;
      stopTimer();
      anchor = null;
      set({ mode: "scrub" });
    },

    setSpeed: (speed) => {
      set({ speed });
      if (get().mode === "play") {
        // Re-anchor so the new multiplier continues from here with no jump.
        startTimer();
      }
    },

    setAnomalies: (events) =>
      set({ anomalies: events, selectedAnomalyIndex: null }),

    selectAnomaly: (i) => {
      if (i === null) {
        set({ selectedAnomalyIndex: null });
        return;
      }
      const { anomalies, log } = get();
      const ev = anomalies[i];
      if (!ev || !log) {
        set({ selectedAnomalyIndex: null });
        return;
      }
      // Drive the ONE shared index to the anomaly's sample (and the dashboard
      // window with it) — there is no second cursor.
      set({ selectedAnomalyIndex: i });
      get().seek(ev.index);
    },

    markSelectionStart: () => {
      const { positionIndex, selectionEnd } = get();
      // Keep the window ordered: if the new start passes the end, drop the end.
      set({
        selectionStart: positionIndex,
        selectionEnd:
          selectionEnd !== null && selectionEnd < positionIndex
            ? null
            : selectionEnd,
      });
    },

    markSelectionEnd: () => {
      const { positionIndex, selectionStart } = get();
      set({
        selectionEnd: positionIndex,
        selectionStart:
          selectionStart !== null && selectionStart > positionIndex
            ? null
            : selectionStart,
      });
    },

    clearSelection: () => set({ selectionStart: null, selectionEnd: null }),
  };
});
