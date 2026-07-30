/**
 * Public API barrel for the local diagnostic engine (M36, v2.0.0).
 *
 * The deterministic, on-device link-health diagnostics: five rules over the
 * shared {@link import("@/lib/blackbox").ParsedLog} model, a transparent
 * signal-health score, sensitivity presets, and a frame-by-frame live evaluator.
 * Pure TypeScript — no Rust, no UI, no AI, no cloud, no I/O.
 */

// Types
export type {
  DiagnosticSeverity,
  DiagnosticCategory,
  DiagnosticSensitivity,
  EvidenceWindow,
  DiagnosticFinding,
  DiagnosticRule,
  DiagnosticReport,
  DiagnosticConfig,
  RuleThresholds,
  LqCollapseThresholds,
  RssiFloorThresholds,
  SnrNoiseThresholds,
  PacketInstabilityThresholds,
  TxSaturationThresholds,
  HealthScoreConfig,
  SessionPatternId,
  SessionPattern,
  SessionPatternReport,
} from "./types";

// Engine + rule registry
export { evaluateSession, ALL_RULES } from "./engine";
export * from "./rules";

// Session-level pattern detection (M38)
export {
  detectSessionPatterns,
  MIN_SAMPLES_FOR_PATTERNS,
  DEFAULT_PATTERN_CONFIG,
  type PatternConfig,
} from "./patterns";

// Per-session history summary + cross-session trends + setup suggestions (M40)
export {
  computeSessionSignature,
  summarizeSessionForHistory,
  type SessionHistorySummary,
  type DiagnosticHistoryRecord,
} from "./history";
export {
  summarizeTrends,
  MIN_SESSIONS_FOR_TRENDS,
  MIN_TREND_RECURRENCE,
  WEAK_RF_HEALTH_THRESHOLD,
  DEFAULT_TRENDS_CONFIG,
  type RepeatedEvent,
  type WeakRfMode,
  type DeviceTrend,
  type TrendReport,
  type TrendsConfig,
} from "./trends";
export {
  deriveSuggestions,
  MIN_SUGGESTION_SESSIONS,
  DEFAULT_SUGGESTIONS_CONFIG,
  type SuggestionConfidence,
  type SuggestionId,
  type SetupSuggestion,
  type SuggestionsConfig,
} from "./suggestions";

// Deterministic findings export schema (M38; consumed by M39a + the v2.5 ML line)
export {
  buildDiagnosticExport,
  DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
  type DiagnosticExport,
  type DiagnosticExportWindow,
  type DiagnosticExportFinding,
  type DiagnosticExportPattern,
} from "./export";

// Health score
export {
  computeHealthScore,
  computeSessionHealthScore,
  DEFAULT_HEALTH_SCORE_CONFIG,
} from "./health-score";

// Config + presets
export {
  DEFAULT_DIAGNOSTIC_CONFIG,
  SENSITIVITY_PRESETS,
  getConfigForPreset,
  applyConfigOverrides,
  type DeepPartial,
} from "./config";

// Frozen scan-budget constants + shared large-log builder (M41)
export {
  DIAGNOSTICS_SCAN_P95_BUDGET_MS,
  DIAGNOSTICS_SCAN_COMPLEXITY_K,
  buildLargeSessionLog,
} from "./perf";

// Live evaluator
export {
  evaluateFrame,
  evaluateFrames,
  initialLiveDiagnosticState,
  LIVE_MIN_FRAMES,
  type LiveDiagnosticState,
  type LiveEvaluateResult,
} from "./live";
