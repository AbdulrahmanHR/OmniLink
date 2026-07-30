import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ParsedLog } from "@/lib/blackbox";
import type { TelemetryFrame } from "@/stores/telemetry";
import {
  applyConfigOverrides,
  DEFAULT_DIAGNOSTIC_CONFIG,
  detectSessionPatterns,
  evaluateFrame,
  evaluateSession,
  getConfigForPreset,
  initialLiveDiagnosticState,
  type DeepPartial,
  type DiagnosticCategory,
  type DiagnosticConfig,
  type DiagnosticFinding,
  type DiagnosticReport,
  type DiagnosticSensitivity,
  type LiveDiagnosticState,
  type SessionPatternReport,
} from "@/lib/diagnostics";

/**
 * Diagnostics store (M36, v2.0.0) — the single impure bridge between the pure
 * on-device diagnostic engine (`@/lib/diagnostics`) and the UI.
 *
 * This store adds **no** detection logic of its own: every action is a thin call
 * into a pure engine function (`evaluateSession`, `evaluateFrame`,
 * `applyConfigOverrides`, `getConfigForPreset`) plus a `set`. It owns two kinds
 * of state — the operator-tunable {@link DiagnosticConfig}, and the runtime
 * analysis results (the loaded-session {@link DiagnosticReport} and the rolling
 * live-evaluator state/findings/score).
 *
 * ## Persistence
 * Only a **minimal, forward-compatible slice** of the config is persisted —
 * `{ sensitivity, enabledCategories }` (see {@link partializeDiagnostics}) — so a
 * future preset re-tuning (M41) is never pinned to today's stale thresholds. On
 * rehydrate the full `config` is reconstructed from that slice
 * (see {@link mergePersistedDiagnostics}): the preset's thresholds for the saved
 * `sensitivity`, with the saved `enabledCategories` layered back on. All runtime
 * fields (`sessionReport`, `liveState`, `liveFindings`, `liveHealthScore`) are
 * deliberately NOT persisted. Persisted to localStorage (key
 * `omnilink-diagnostics`) following the same zustand `persist` convention as the
 * alerts / notifications stores — the default JSON storage no-ops cleanly when
 * `localStorage` is absent (Node tests), so the initial in-memory config stands.
 */

/** Maximum retained live findings; older entries are evicted past this. */
export const LIVE_FINDINGS_CAP = 50;

/** Persist key for the diagnostics store. */
export const DIAGNOSTICS_STORAGE_KEY = "omnilink-diagnostics";

/**
 * The minimal, forward-compatible config slice written to storage. Holds only
 * the user's preset tier + per-category switches; thresholds are reconstructed
 * from the preset on rehydrate so a future re-tune is not pinned to stale values.
 */
export interface PersistedDiagnosticsSlice {
  /** The chosen sensitivity tier (drives the reconstructed thresholds). */
  sensitivity: DiagnosticSensitivity;
  /** The user's per-category master switches. */
  enabledCategories: Record<DiagnosticCategory, boolean>;
}

/** State + actions exposed by {@link useDiagnosticsStore}. */
export interface DiagnosticsState {
  /** Operator-tunable engine config; starts at the intermediate default. */
  config: DiagnosticConfig;
  /** Report from analyzing a loaded session, or `null` (runtime-only). */
  sessionReport: DiagnosticReport | null;
  /**
   * Session-level pattern detection (M38) over the same loaded session, or `null`
   * (runtime-only, NOT persisted). Set alongside {@link sessionReport}.
   */
  sessionPatternReport: SessionPatternReport | null;
  /** Rolling per-frame live-evaluator state (runtime-only). */
  liveState: LiveDiagnosticState;
  /** Recently-fired live findings, newest-first, capped at {@link LIVE_FINDINGS_CAP} (runtime-only). */
  liveFindings: DiagnosticFinding[];
  /** Current live signal-health score, 0–100 (runtime-only; `100` with no data). */
  liveHealthScore: number;

  /**
   * Analyze a loaded session into {@link sessionReport} (pure `evaluateSession`)
   * and its {@link sessionPatternReport} (pure `detectSessionPatterns`).
   */
  analyzeSession: (log: ParsedLog) => void;
  /** Drop the current session report. */
  clearSessionReport: () => void;
  /**
   * Evaluate one live telemetry frame: thread the live state forward, update the
   * live health score, and prepend any newly-fired findings (capped, newest-first).
   */
  evaluateLiveFrame: (frame: TelemetryFrame) => void;
  /** Reset the live evaluator: fresh state, empty findings, neutral score (100). */
  resetLive: () => void;
  /** Deep-merge a partial config override onto the current config. */
  updateConfig: (partial: DeepPartial<DiagnosticConfig>) => void;
  /**
   * Switch to a sensitivity preset's thresholds while PRESERVING the user's
   * current per-category switches (the preset only re-tunes thresholds).
   */
  setSensitivityPreset: (preset: DiagnosticSensitivity) => void;
}

/** Is `v` a mergeable plain object (not an array/null)? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow an unknown value to a valid sensitivity tier (else `"intermediate"`). */
function asSensitivity(v: unknown): DiagnosticSensitivity {
  return v === "beginner" || v === "intermediate" || v === "advanced"
    ? v
    : "intermediate";
}

/** Persist only the forward-compatible config slice (see store JSDoc). */
function partializeDiagnostics(
  state: DiagnosticsState
): PersistedDiagnosticsSlice {
  return {
    sensitivity: state.config.sensitivity,
    enabledCategories: state.config.enabledCategories,
  };
}

/**
 * Rehydrate merge: reconstruct the full {@link DiagnosticConfig} from the
 * persisted slice. Falls back to the intermediate default for a missing/old
 * persisted shape, and tolerates a partial `enabledCategories` (the preset
 * supplies any missing category). Runtime fields keep the current initial values.
 */
function mergePersistedDiagnostics(
  persisted: unknown,
  current: DiagnosticsState
): DiagnosticsState {
  const slice = isPlainObject(persisted) ? persisted : {};
  const sensitivity = asSensitivity(slice.sensitivity);
  const enabledCategories = isPlainObject(slice.enabledCategories)
    ? (slice.enabledCategories as DeepPartial<Record<DiagnosticCategory, boolean>>)
    : undefined;
  const config = applyConfigOverrides(getConfigForPreset(sensitivity), {
    enabledCategories,
  });
  return { ...current, config };
}

/**
 * The diagnostics Zustand store. The only impure layer of the diagnostic
 * feature: it holds state and calls pure engine functions; it never detects.
 */
export const useDiagnosticsStore = create<DiagnosticsState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_DIAGNOSTIC_CONFIG,
      sessionReport: null,
      sessionPatternReport: null,
      liveState: initialLiveDiagnosticState(),
      liveFindings: [],
      liveHealthScore: 100,

      analyzeSession: (log) => {
        const report = evaluateSession(log, get().config);
        const patternReport = detectSessionPatterns(log, report);
        set({ sessionReport: report, sessionPatternReport: patternReport });
      },

      clearSessionReport: () =>
        set({ sessionReport: null, sessionPatternReport: null }),

      evaluateLiveFrame: (frame) => {
        const { newState, findings, healthScore } = evaluateFrame(
          frame,
          get().liveState,
          get().config
        );
        set((s) => ({
          liveState: newState,
          liveHealthScore: healthScore,
          // Newest frame's findings at the head; evict the oldest past the cap.
          liveFindings: findings.length
            ? [...findings, ...s.liveFindings].slice(0, LIVE_FINDINGS_CAP)
            : s.liveFindings,
        }));
      },

      resetLive: () =>
        set({
          liveState: initialLiveDiagnosticState(),
          liveFindings: [],
          liveHealthScore: 100,
        }),

      updateConfig: (partial) =>
        set({ config: applyConfigOverrides(get().config, partial) }),

      setSensitivityPreset: (preset) => {
        const next = getConfigForPreset(preset);
        // Swap to the preset's thresholds but keep the user's category switches.
        set({ config: { ...next, enabledCategories: get().config.enabledCategories } });
      },
    }),
    {
      name: DIAGNOSTICS_STORAGE_KEY,
      // Persist only a minimal forward-compatible slice; reconstruct the full
      // config from it on rehydrate.
      partialize: partializeDiagnostics,
      merge: mergePersistedDiagnostics,
    }
  )
);
