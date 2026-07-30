/**
 * Public API barrel for the v2.5 ML line (M56).
 *
 * The frozen gate (`mlConsts.ts`), the seeded RNG that makes every training/eval
 * path byte-reproducible (`rng.ts`), the gap-tolerant summary statistics
 * (`stats.ts`), the dataset schema + seeded, stratified, session-level split
 * (`dataset.ts`), the evaluation harness every score is computed by
 * (`evalHarness.ts`), and the v2.0 baseline characterization that produces the frozen
 * `data/ml/baseline-v20.json` artifact (`baseline.ts`).
 *
 * Pure TypeScript — no Rust, no UI, no I/O, no network, nothing leaves the device.
 * Everything here is numeric-only and carries zero identifiers.
 */

// Frozen gate constants + predicates (D21/D25, M59 lead time, perf budget).
export {
  MIN_LABELED_SESSIONS_PER_CLASS,
  MIN_TEST_SESSIONS_PER_CLASS,
  DEFAULT_SPLIT_RATIOS,
  BASELINE_METRICS_ARTIFACT,
  FP_CEILING_RULE,
  MIN_RECALL_RULE,
  clearsFpCeiling,
  clearsRecallFloor,
  clearsM56Gate,
  HEALTHY_FIXTURE_COUNT,
  FP_RATE_QUANTUM_PP,
  fpRateQuantumPp,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  MEASURED_MAX_FIXTURE_LEAD_MS,
  DIAGNOSTICS_SCAN_MEASURED_P95_MS,
  ML_INFERENCE_BUDGET_SAMPLE_COUNT,
  ML_INFERENCE_P95_BUDGET_MS,
  type GateCandidate,
  type GateBaseline,
} from "./mlConsts";

// Seeded determinism substrate.
export { DEFAULT_SEED, createRng, shuffled } from "./rng";

// Gap-tolerant summary statistics.
export {
  finite,
  fractionWhere,
  isFiniteNumber,
  maxFinite,
  meanFinite,
  minFinite,
  quantileFinite,
  round6,
  stdDev,
} from "./stats";

// Dataset schema, features, and the seeded stratified session-level split.
export {
  ML_DATASET_SCHEMA_VERSION,
  ML_LABELS,
  MANIFEST_LABEL_TO_ML_LABEL,
  toMlLabel,
  FEATURE_LQ_LOW_PCT,
  FEATURE_RSSI_FLOOR_DBM,
  FEATURE_TX_TOP_STEP_MW,
  FEATURE_HEADING_SECTORS,
  FEATURE_HEADING_MIN_SECTOR_SAMPLES,
  FEATURE_HEADING_CANDIDATES,
  GPS_FREE_PATTERN_IDS,
  FEATURE_NAMES,
  FEATURE_COUNT,
  toFeatureArray,
  extractFeatures,
  buildDatasetRow,
  toTrainingRow,
  splitDataset,
  InvalidDatasetError,
  type MlLabel,
  type FeatureName,
  type FeatureVector,
  type DatasetRow,
  type TrainingRow,
  type SplitRatios,
  type ClassCounts,
  type SplitWarning,
  type DatasetSplit,
  type SplitOptions,
} from "./dataset";

// The evaluation harness: precision/recall/FP at two named granularities, the
// rate-vs-raw-count discipline, lead time, and D25's gate.
export {
  ML_EVAL_SCHEMA_VERSION,
  DEFAULT_WINDOW_TOLERANCE_SAMPLES,
  MIN_INSTANCES_FOR_FINDING_RATE,
  CORPUS_LIMITATION_SUBJECT,
  rateMetric,
  findingMetric,
  windowsOverlap,
  runMlEval,
  type RateMetric,
  type CountMetric,
  type EvalMetric,
  type EvalLimitationCode,
  type EvalLimitation,
  type SessionPrediction,
  type FindingPrediction,
  type TimedPrediction,
  type EventOnset,
  type MlPredictions,
  type SessionTruth,
  type ExpectedFindingTruth,
  type MlGroundTruth,
  type RunMlEvalOptions,
  type ConfusionCounts,
  type PerSessionMetrics,
  type PerRuleFindingMetrics,
  type PerFindingMetrics,
  type LeadTimeOutcome,
  type LeadTimeCase,
  type LeadTimeMetrics,
  type SessionCaseResult,
  type MlEvalReport,
} from "./evalHarness";

// The data-readiness verdict: labeled sessions vs the D21 bar (M56c). Pure; the
// bundled fixture corpus and the user's own local labels are counted SEPARATELY.
export {
  READINESS_SCHEMA_VERSION,
  TRAINABLE_ML_LABELS,
  isTrainableLabel,
  FIXTURE_SESSIONS_BY_CLASS,
  FIXTURE_SESSION_TOTAL,
  REQUIRED_SESSION_TOTAL,
  countLabels,
  buildReadinessReport,
  type TrainableMlLabel,
  type LabelCounts,
  type ClassReadiness,
  type ReadinessVerdict,
  type ReadinessReport,
} from "./readiness";

// The M58 anomaly-model prototype: a one-class isolation forest over the frozen
// 43-feature vector. Advisory-only output; numeric-only detail bag; zero identifiers.
// It does NOT clear the M56 gate — see the module header for why no model can.
export {
  ANOMALY_MODEL_ID,
  ANOMALY_MODEL_SCHEMA_VERSION,
  FOREST_TREE_COUNT,
  FOREST_SUBSAMPLE_CAP,
  EVIDENCE_WINDOW_SAMPLES,
  TOP_FEATURE_COUNT,
  cNorm,
  trainAnomalyModel,
  scoreFeatures,
  explainSession,
  evidenceWindowFor,
  serializeAnomalyModel,
  UntrainableModelError,
  type IsolationTreeNode,
  type IsolationTree,
  type AnomalyModelHyperparams,
  type AnomalyModelTrainingInfo,
  type AnomalyModel,
  type TrainOptions,
  type FeatureContribution,
  type AnomalyScore,
  type AnomalyModelOutput,
} from "./anomalyModel";

// The M58 evaluation: the model scored through `runMlEval` against the frozen v2.0
// baselines, on the held-out test split AND the whole corpus, plus the early-warning
// measurement and the anti-strawman sensitivity probe.
export {
  MODEL_EVAL_SCHEMA_VERSION,
  PREFIX_STRIDE_SAMPLES,
  modelPredictions,
  measureEarlyWarning,
  evaluateAnomalyModel,
  serializeModelEvalArtifact,
  type ModelSessionResult,
  type FeatureImportance,
  type EarlyWarningDetector,
  type EarlyWarningReport,
  type SensitivityCell,
  type SensitivityReport,
  type ModelEvalPartition,
  type ModelEvalHonesty,
  type ModelEvalArtifact,
} from "./modelEval";

// M59 — the predictive failsafe warner. A trend-based projected-time-to-link-loss predictor
// over the M26 `AlertFrame` pipeline. Advisory-only; numeric-only detail bag; zero identifiers;
// GPS actively excluded.
//
// ⚠ Its entry point is `evaluateRiskFrame`, NOT `evaluateFrame` — that name already exists in
// BOTH `lib/liveAlerts.ts` and `lib/diagnostics/live.ts`, and both are barrel-exported.
//
// ON THE REAL CORPUS IT FINDS NOTHING, AND THAT IS M59's FINDING: the oracle bound
// (`measureCorpusLeadCeiling`) shows the corpus offers a median of 0 ms and a maximum of 80 ms
// of lead to ANY predictor, against a 2000 ms target. See the module header.
export {
  PREDICTOR_ID,
  PREDICTIVE_SCHEMA_VERSION,
  PREDICTIVE_WINDOW_SAMPLES,
  PREDICTIVE_MIN_WINDOW_SAMPLES,
  PREDICTIVE_RISK_HORIZON_MS,
  PREDICTIVE_RISK_THRESHOLD,
  PREDICTIVE_CLEAR_THRESHOLD,
  PREDICTIVE_TRIP_FRAMES,
  PREDICTIVE_CREDIT_HORIZON_MS,
  PREDICTIVE_FEATURE_NAMES,
  PREDICTIVE_FEATURE_COUNT,
  PREDICTIVE_WARNING_CODE,
  riskFromTtl,
  extractWindowFeatures,
  initialPredictiveState,
  evaluateRiskFrame,
  runPredictor,
  runPredictorIntervals,
  coversOnset,
  alertFramesFromLog,
  predictOverLog,
  measureCorpusLeadCeiling,
  type PredictiveFeatureName,
  type PredictiveFeatures,
  type PredictiveWarning,
  type PredictiveWarningInterval,
  type PredictiveState,
  type PredictiveResult,
  type LeadCeilingCase,
  type LeadCeilingBound,
  type LeadCeilingReport,
} from "./predictive";

// M59 — the SYNTHETIC degradation corpus (track b). NOT field evidence; NOT an acceptance pass.
// It measures "can the detector find a ramp we drew?", and its own manifest says so.
export {
  SYNTHETIC_CORPUS_SCHEMA_VERSION,
  SYNTHETIC_CORPUS_DIR,
  SYNTHETIC_MANIFEST_FILE,
  SYNTHETIC_CADENCE_MS,
  SYNTHETIC_RAMP_COUNT,
  SYNTHETIC_NEAR_MISS_COUNT,
  SYNTHETIC_STEADY_COUNT,
  NEAR_MISS_BANDS,
  RAMP_MIN_MS,
  RAMP_MAX_MS,
  generateSyntheticCorpus,
  syntheticLog,
  syntheticSessionToCsv,
  fingerprintSyntheticCorpus,
  assertGroundTruth,
  buildSyntheticManifest,
  serializeSyntheticManifest,
  SyntheticCorpusError,
  type SyntheticClass,
  type NearMissBand,
  type SyntheticSession,
  type SyntheticParams,
  type SyntheticManifestEntry,
  type SyntheticManifest,
} from "./syntheticCorpus";

// M59 — the evaluation: the predictor scored through `runMlEval` on the real corpus (the
// NULL RESULT, which is the deliverable) and, separately and never pooled, on the synthetic
// corpus (indicative only).
export {
  PREDICTIVE_EVAL_SCHEMA_VERSION,
  buildPredictiveGroundTruth,
  buildPredictiveOnsets,
  runPredictorOverCorpus,
  scorePredictiveCorpus,
  evaluatePredictor,
  serializePredictiveEvalArtifact,
  type PredictiveCorpusSession,
  type PredictiveSessionResult,
  type HorizonCell,
  type BucketFalseAlarms,
  type PredictivePartition,
  type PredictiveAcceptance,
  type PredictiveEvalHonesty,
  type PredictorDescriptor,
  type PredictiveEvalInputs,
  type PredictiveEvalArtifact,
} from "./predictiveEval";

// The v2.0 baseline characterization + the frozen artifact it produces.
export {
  BASELINE_ARTIFACT_SCHEMA_VERSION,
  BASELINE_RULE_ENGINE,
  BASELINE_ANOMALY_HEURISTIC,
  FAILSAFE_ONSET_RULE,
  findFailsafeOnsetIndices,
  fingerprintCorpus,
  buildGroundTruth,
  buildEventOnsets,
  ruleEnginePredictions,
  anomalyHeuristicPredictions,
  characterizeBaselines,
  serializeBaselineArtifact,
  type BaselineId,
  type BaselineFixture,
  type BaselineCorpusInfo,
  type BaselineHonesty,
  type BaselineScoringDecisions,
  type BaselinePartition,
  type BaselineArtifact,
} from "./baseline";
