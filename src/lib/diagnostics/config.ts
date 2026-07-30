/**
 * Diagnostic-engine configuration + sensitivity presets (M36).
 *
 * {@link DEFAULT_DIAGNOSTIC_CONFIG} is the **intermediate** preset and the
 * acceptance baseline (DL3): on the M36 fixture corpus it raises zero
 * warning-or-higher findings on any healthy fixture (false-positive rate 0) and
 * reproduces every labelled expected finding (recall 1.0). The thresholds are
 * anchored to the M15 `DEFAULT_ANOMALY_CONFIG` where they overlap (LQ
 * absThreshold 50 / slopeDrop 30 / window 5 / criticalTo 20; RSSI floor −100 /
 * minSamples 3) and calibrated against the corpus for the new
 * SNR/packet/TX rules.
 *
 * Three tiers trade recall against caution; **all three keep the healthy
 * false-positive rate at zero**:
 *  - `beginner`  — higher thresholds, fewer/only-clearer warnings.
 *  - `intermediate` — the default.
 *  - `advanced`  — lower thresholds, maximum recall.
 *
 * Pure data + pure helpers; no side effects.
 */

import { DEFAULT_HEALTH_SCORE_CONFIG } from "./health-score";
import type {
  DiagnosticCategory,
  DiagnosticConfig,
  DiagnosticSensitivity,
} from "./types";

/** All categories enabled. */
const ALL_CATEGORIES_ENABLED: Record<DiagnosticCategory, boolean> = {
  signal: true,
  link: true,
  power: true,
  stability: true,
};

/**
 * The **intermediate** preset and engine default. Reproduces the full M36
 * acceptance corpus (FP 0, recall 1.0).
 */
export const DEFAULT_DIAGNOSTIC_CONFIG: DiagnosticConfig = {
  sensitivity: "intermediate",
  enabledCategories: { ...ALL_CATEGORIES_ENABLED },
  rules: {
    lqCollapse: { absThreshold: 50, slopeDrop: 30, window: 5, criticalTo: 20, recoverMargin: 15 },
    rssiFloor: { floorDbm: -100, minSamples: 3 },
    snrNoise: { window: 20, stdThreshold: 3.0, minSpan: 20 },
    packetInstability: { window: 20, jitterThreshold: 5, minSpan: 20 },
    txPowerSaturation: { maxStepMw: 500, minSamples: 20, poorRssiDbm: -88, degradedLq: 80 },
  },
  healthScore: DEFAULT_HEALTH_SCORE_CONFIG,
};

/** The **beginner** preset: more conservative thresholds (fewer warnings). */
const BEGINNER_CONFIG: DiagnosticConfig = {
  sensitivity: "beginner",
  enabledCategories: { ...ALL_CATEGORIES_ENABLED },
  rules: {
    lqCollapse: { absThreshold: 45, slopeDrop: 35, window: 5, criticalTo: 20, recoverMargin: 15 },
    rssiFloor: { floorDbm: -100, minSamples: 4 },
    snrNoise: { window: 20, stdThreshold: 4.5, minSpan: 25 },
    packetInstability: { window: 20, jitterThreshold: 8, minSpan: 25 },
    txPowerSaturation: { maxStepMw: 500, minSamples: 30, poorRssiDbm: -90, degradedLq: 78 },
  },
  healthScore: DEFAULT_HEALTH_SCORE_CONFIG,
};

/** The **advanced** preset: more sensitive thresholds (higher recall). */
const ADVANCED_CONFIG: DiagnosticConfig = {
  sensitivity: "advanced",
  enabledCategories: { ...ALL_CATEGORIES_ENABLED },
  rules: {
    lqCollapse: { absThreshold: 52, slopeDrop: 25, window: 6, criticalTo: 20, recoverMargin: 15 },
    rssiFloor: { floorDbm: -100, minSamples: 2 },
    snrNoise: { window: 20, stdThreshold: 2.2, minSpan: 15 },
    packetInstability: { window: 20, jitterThreshold: 3, minSpan: 15 },
    txPowerSaturation: { maxStepMw: 500, minSamples: 15, poorRssiDbm: -86, degradedLq: 82 },
  },
  healthScore: DEFAULT_HEALTH_SCORE_CONFIG,
};

/** The three sensitivity presets, keyed by tier. */
export const SENSITIVITY_PRESETS: Record<DiagnosticSensitivity, DiagnosticConfig> = {
  beginner: BEGINNER_CONFIG,
  intermediate: DEFAULT_DIAGNOSTIC_CONFIG,
  advanced: ADVANCED_CONFIG,
};

/** Return the config for a sensitivity preset. */
export function getConfigForPreset(preset: DiagnosticSensitivity): DiagnosticConfig {
  return SENSITIVITY_PRESETS[preset];
}

/** A recursive partial of `T` (objects merge; leaf values replace). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Is `v` a mergeable plain object (not an array/null)? */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Immutably deep-merge `override` into `base`, returning a new value. */
function mergeDeep<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return override as unknown as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = (base as Record<string, unknown>)[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? mergeDeep(baseValue, value as DeepPartial<typeof baseValue>)
        : value;
  }
  return out as T;
}

/**
 * Produce a new {@link DiagnosticConfig} by immutably deep-merging `overrides`
 * onto `base` (default: {@link DEFAULT_DIAGNOSTIC_CONFIG}). `base` is never
 * mutated, so the shared presets stay intact.
 */
export function applyConfigOverrides(
  base: DiagnosticConfig,
  overrides: DeepPartial<DiagnosticConfig>
): DiagnosticConfig {
  return mergeDeep(base, overrides);
}
