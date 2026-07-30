/**
 * Public type contract for the local diagnostic engine (M36, v2.0.0).
 *
 * This is the single home for every diagnostic-engine type so the rule files,
 * the health-score module, the config presets, and the live evaluator all share
 * one stable vocabulary (and so the config interfaces can reference the rule
 * types and vice-versa without a runtime cycle — all imports here are type-only
 * and erased at build time).
 *
 * The severity vocabulary is **reused** from the M15 anomaly module rather than
 * redefined, so a diagnostic finding and an anomaly event grade identically.
 *
 * ## Safety
 * A {@link DiagnosticFinding.detail} bag carries **only** non-identifying
 * numbers/strings (an RSSI in dBm, a link-quality %, a TX-power in mW, a sample
 * count) — never a GPS coordinate, UID, MAC, IP, or any other identifier, exactly
 * as `anomaly.ts` / `liveAlerts.ts` guarantee.
 */

import type { AnomalySeverity } from "@/lib/anomaly";
import type { ParsedLog } from "@/lib/blackbox";

/** Finding severity. Reuses the M15 `'info' | 'warning' | 'critical'` scale. */
export type DiagnosticSeverity = AnomalySeverity;

/** The four diagnostic problem domains a rule can belong to. */
export type DiagnosticCategory = "signal" | "link" | "power" | "stability";

/** Sensitivity preset names (threshold tiers from cautious to aggressive). */
export type DiagnosticSensitivity = "beginner" | "intermediate" | "advanced";

/** An inclusive `[startIndex, endIndex]` window into `log.time`. */
export interface EvidenceWindow {
  /** First sample index the finding covers (inclusive). */
  startIndex: number;
  /** Last sample index the finding covers (inclusive). */
  endIndex: number;
}

/**
 * One diagnosed link-health problem over a window of a session.
 *
 * `detail` is a bag of non-identifying numbers/strings safe to interpolate into
 * a UI string or forward to the assistant (no coordinates/identifiers, ever).
 */
export interface DiagnosticFinding {
  /** Rule id — one of the five engine rule ids (e.g. `"lq-collapse"`). */
  ruleId: string;
  /** The problem domain this finding belongs to. */
  category: DiagnosticCategory;
  /** Severity of the finding. */
  severity: DiagnosticSeverity;
  /** Detector confidence in `[0, 1]` (deeper/longer/clearer ⇒ higher). */
  confidence: number;
  /** Inclusive sample window the finding spans. */
  evidenceWindow: EvidenceWindow;
  /** i18n key, e.g. `"diagnostics.finding.lqCollapse"`. Never a raw sentence. */
  explanation: string;
  /** Non-identifying interpolation values only (numbers/strings; no GPS/ids). */
  detail: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Per-rule threshold shapes (values live in config.ts)
// ---------------------------------------------------------------------------

/** Thresholds for the `lq-collapse` rule. */
export interface LqCollapseThresholds {
  /** LQ% below which a crossing counts as a drop edge. */
  absThreshold: number;
  /** Minimum LQ fall (within `window`) that counts as a sharp drop. */
  slopeDrop: number;
  /** Look-back window (samples) for the pre-drop high. */
  window: number;
  /** Bottom at-or-below this LQ% grades the finding `critical`. */
  criticalTo: number;
  /** Recovery hysteresis: the drop stays open until LQ climbs above `absThreshold + recoverMargin`. */
  recoverMargin: number;
}

/** Thresholds for the `rssi-floor` rule. */
export interface RssiFloorThresholds {
  /** RSSI floor in dBm; a run at-or-below this is signal loss. */
  floorDbm: number;
  /** Minimum run length (samples) to raise a finding. */
  minSamples: number;
}

/** Thresholds for the `snr-noise` rule. */
export interface SnrNoiseThresholds {
  /** Rolling-window size (samples) for the SNR standard deviation. */
  window: number;
  /** Rolling stddev above this (dB) marks a noisy sample. */
  stdThreshold: number;
  /** Minimum noisy-span length (samples) to raise a finding. */
  minSpan: number;
}

/** Thresholds for the `packet-instability` rule. */
export interface PacketInstabilityThresholds {
  /** Rolling-window size (samples) for the packet-rate change count. */
  window: number;
  /** Change count (within `window`) at-or-above this marks a jittery sample. */
  jitterThreshold: number;
  /** Minimum jittery-span length (samples) to raise a finding. */
  minSpan: number;
}

/** Thresholds for the `tx-power-saturation` rule. */
export interface TxSaturationThresholds {
  /** TX power (mW) at-or-above this is treated as pinned at the top step. */
  maxStepMw: number;
  /** Minimum saturated-run length (samples) to consider. */
  minSamples: number;
  /** Mean rssi1 at-or-below this (dBm) over the run counts as poor signal. */
  poorRssiDbm: number;
  /** Mean link quality at-or-below this (%) over the run counts as degraded. */
  degradedLq: number;
}

/** All five rules' thresholds, keyed by rule. */
export interface RuleThresholds {
  lqCollapse: LqCollapseThresholds;
  rssiFloor: RssiFloorThresholds;
  snrNoise: SnrNoiseThresholds;
  packetInstability: PacketInstabilityThresholds;
  txPowerSaturation: TxSaturationThresholds;
}

/** Tunable weights + domain constants for the signal-health score. */
export interface HealthScoreConfig {
  /** Composite weights (positive entries sum to 1.0). */
  weights: {
    /** Link-quality weight (dominant). */
    lq: number;
    /** Best-antenna RSSI-margin weight. */
    rssiMargin: number;
    /** SNR weight. */
    snr: number;
    /** Packet-stability weight (session-level; neutral per-frame). */
    packetStability: number;
    /** TX-power-headroom weight (lower power ⇒ more headroom). */
    txHeadroom: number;
    /** RF-mode robustness weight (lower packet rate ⇒ more robust). */
    rfMode: number;
  };
  /** Points subtracted from a dropout/failsafe frame's score. */
  dropoutPenalty: number;
  /** RSSI floor (dBm); at-or-below this the margin normalizer reads 0 (dropout). */
  rssiFloorDbm: number;
  /** RSSI (dBm) at-or-above which the margin normalizer plateaus at 1.0. */
  rssiGoodDbm: number;
  /** Added to SNR before normalizing (shifts the 0-point). */
  snrOffsetDb: number;
  /** SNR span (dB) the normalizer spreads `[0,1]` across. */
  snrSpanDb: number;
  /** Lowest RF-mode robustness factor (the fastest packet rate maps to this). */
  rfMinFactor: number;
  /** Fixed window size (samples) for the per-window session scores. */
  windowSize: number;
}

/**
 * Full diagnostic configuration: sensitivity tier, per-category enable flags,
 * per-rule thresholds, and the health-score config. Passed to every
 * {@link DiagnosticRule.evaluate} and to {@link DiagnosticReport} computation.
 */
export interface DiagnosticConfig {
  /** Which preset tier this config represents. */
  sensitivity: DiagnosticSensitivity;
  /** Per-category master switches; a disabled category's rules are skipped. */
  enabledCategories: Record<DiagnosticCategory, boolean>;
  /** Per-rule thresholds. */
  rules: RuleThresholds;
  /** Signal-health-score weights + domain constants. */
  healthScore: HealthScoreConfig;
}

/**
 * One diagnostic rule: a pure function from a parsed session + config to zero or
 * more findings. Rules never read `log.gps` and never emit identifiers.
 */
export interface DiagnosticRule {
  /** Stable rule id (e.g. `"lq-collapse"`). */
  id: string;
  /** Human-readable rule name (data, not UI chrome). */
  name: string;
  /** The category this rule belongs to. */
  category: DiagnosticCategory;
  /** Evaluate the rule over a session, returning its findings. */
  evaluate(log: ParsedLog, config: DiagnosticConfig): DiagnosticFinding[];
}

// ---------------------------------------------------------------------------
// Session-level pattern detection (M38, v2.0.1 backfill)
// ---------------------------------------------------------------------------

/**
 * Session-level pattern kinds detected post-flight (M38).
 *
 * These are cross-window / correlated problems that are hard to see from raw
 * charts — they consume the per-window {@link DiagnosticFinding}s plus the raw
 * channels/GPS track and summarise a recurring story ("most likely issue").
 */
export type SessionPatternId =
  | "repeated-lq-drops"
  | "heading-degradation"
  | "gps-area-degradation"
  | "power-packet-link-events";

/**
 * One session-level pattern (M38): a recurring/correlated signal problem spanning
 * one or more evidence windows, with plain-language "most likely issue / evidence /
 * what to check first" i18n keys. Distinct from a per-window {@link DiagnosticFinding}.
 *
 * ## Safety
 * `detail` is a bag of **non-identifying** numbers/strings only (a drop count, an
 * LQ %, a TX ramp in mW, a heading sector centre in degrees) — never a coordinate,
 * a cell key, a UID, MAC, IP, or any other identifier, exactly like a
 * {@link DiagnosticFinding.detail}.
 */
export interface SessionPattern {
  /** The pattern kind. */
  patternId: SessionPatternId;
  /** The problem domain this pattern belongs to. */
  category: DiagnosticCategory;
  /** Severity of the pattern. */
  severity: DiagnosticSeverity;
  /** Detector confidence in `[0, 1]`. */
  confidence: number;
  /** Inclusive evidence windows (≥1, ascending by `startIndex`). */
  evidenceWindows: EvidenceWindow[];
  /** i18n key for the "most likely issue" headline (rendered with `detail`). */
  summaryKey: string;
  /** i18n key for the "evidence" line (rendered with `detail`). */
  evidenceKey: string;
  /** i18n key for "what to check first" (no interpolation). */
  checkFirstKey: string;
  /** Non-identifying interpolation values only (numbers/strings; no GPS/ids). */
  detail: Record<string, number | string>;
}

/**
 * Result of session-level pattern detection (M38).
 *
 * `patterns` are sorted (severity critical→warning→info, then confidence
 * descending, then `patternId` ascending for determinism). `mostLikely` is the
 * top pattern (drives the summary cards). `hasEnoughEvidence` is `false` only when
 * the session is too short for any pattern to be meaningful.
 */
export interface SessionPatternReport {
  /** Detected patterns, sorted for display (see interface docs). */
  patterns: SessionPattern[];
  /** The top pattern (`patterns[0] ?? null`). */
  mostLikely: SessionPattern | null;
  /** `false` when the session is shorter than the pattern-detection minimum. */
  hasEnoughEvidence: boolean;
  /** Number of time samples analysed. */
  sampleCount: number;
  /** Session duration in ms. */
  durationMs: number;
}

/** The full result of evaluating a session. */
export interface DiagnosticReport {
  /** All findings, sorted by severity (critical→warning→info) then startIndex. */
  findings: DiagnosticFinding[];
  /** Overall session health, 0–100. */
  healthScore: number;
  /** Session-level rollups for the UI. */
  sessionSummary: {
    /** Number of time samples in the session. */
    sampleCount: number;
    /** Session duration in ms. */
    durationMs: number;
    /** Finding counts per severity. */
    countsBySeverity: Record<DiagnosticSeverity, number>;
    /** Per-window health scores (drives the session gauge). */
    perWindowHealth: number[];
  };
}
