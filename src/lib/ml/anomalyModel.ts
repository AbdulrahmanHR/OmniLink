/**
 * The M58 local anomaly-model prototype: a hand-rolled, one-class **isolation
 * forest** over the frozen 43-feature vector, trained offline on the train split
 * alone and run entirely on-device.
 *
 * Pure TypeScript. Zero dependencies. Seeded. No clock, no `Math.random`, no I/O,
 * no network. Same rows + same seed ⇒ byte-identical model; same model + same log
 * ⇒ byte-identical output.
 *
 * ## Read this before you read the code: this model does not clear the M56 gate
 * It cannot, and neither could a flawless oracle. D25's FP ceiling
 * ({@link import("./mlConsts").FP_CEILING_RULE}) is a **strict `<`** against the
 * measured v2.0 baseline, and that baseline's false-positive rate on the held-out
 * test split is **0.000** (`data/ml/baseline-v20.json` → `gateBaseline.baselineFpRate`).
 * Nothing is strictly below zero, so `clearsM56Gate` returns `false` for every
 * candidate — the artifact records exactly that in `gateBaseline.fpCeilingClearable:
 * false`, and `tests/unit/ml/baseline.test.ts` already asserts a perfect model fails.
 *
 * This module therefore exists to be a *well-built* model that is *honestly scored*,
 * not to win. `tests/unit/ml/m58Gate.test.ts` pins the failure and the reason for it,
 * so a later commit that "fixes" the gate into a pass goes red.
 *
 * ## Why an isolation forest, and not a tiny autoencoder — at n = 36
 * The corpus is 36 labeled sessions; the seeded 60/20/20 session-level split gives a
 * **train split of 21**, of which **7 are healthy**. The model is one-class (see
 * below), so the fit is against **7 points in 43 dimensions**. At that n:
 *
 *  - **Anything that estimates a covariance is undefined.** A 43×43 covariance from 7
 *    points has rank ≤ 6. Mahalanobis distance, PCA reconstruction error, a Gaussian
 *    one-class model — all of them require inverting a matrix that is singular by
 *    construction. Not "poorly conditioned": singular.
 *  - **An autoencoder has more parameters than it has training scalars.** 7 sessions ×
 *    43 features = **301 training numbers**. Even a brutally narrow 43→3→43 tied-weight
 *    autoencoder carries 43 × 3 = 129 encoder weights + 129 decoder weights + biases —
 *    ~260 free parameters fit to 301 numbers. It would reconstruct the training set by
 *    memorising it, its reconstruction error on a new session would be a function of the
 *    initialisation seed as much as of the physics, and its "explanation" (per-feature
 *    reconstruction error) would be explaining the seed. Building it would be building a
 *    random number generator with a loss curve.
 *  - **An isolation forest estimates nothing.** It fits no weights, inverts no matrix,
 *    and assumes no distribution. A tree is a sequence of uniform random axis-aligned
 *    cuts; the score is a path length. Its only "parameters" are the cut points, which
 *    are drawn from the data's own range. It is the one family in the anomaly-detection
 *    toolbox that is *defined* at n = 7 rather than merely *runnable* at n = 7. It is
 *    also scale-invariant per feature, so no scaler has to be estimated from 7 points
 *    either.
 *
 * That is the whole justification, and it is a justification about **what is estimable
 * at this n**, not about what scores best. The honest summary of both options is that
 * 7 points cannot support a model; the isolation forest is the option that *says* so
 * (with an enormous score variance) instead of hiding it inside a converged loss.
 *
 * ## One-class: trained on HEALTHY sessions only
 * Anomaly detection here means "does this session look like the healthy ones?", so the
 * forest is fit to the **healthy rows of the train split** and every other session is
 * scored against them. The alternative — fitting the forest to all 21 train rows
 * unsupervised, in the classic contaminated-data iForest setup — puts **14 faulty
 * sessions (67 %) into the reference distribution**, which is not contamination, it is a
 * majority. iForest's premise ("anomalies are few and different") is simply false there.
 *
 * ## The threshold is chosen A PRIORI, and fitted on TRAIN ONLY
 * {@link AnomalyModel.threshold} is the **maximum score over the training rows**: flag a
 * session that is more anomalous than any healthy session the model was ever shown. That
 * is the zero-knob novelty-detection convention — no quantile to pick, no contamination
 * rate to guess, and nothing to tune against val or test.
 *
 * Liu et al.'s textbook `s > 0.5` convention is deliberately NOT used, and the reason is
 * worth stating: that convention assumes a subsample of ψ ≈ 256, where a normal point's
 * expected path length sits at `c(ψ)` and the score therefore centres on 0.5. At ψ = 7,
 * `c(7) ≈ 3.19` while the tree's height limit is `ceil(log2 7) = 3`, so *every* point —
 * healthy included — has a path shorter than `c(ψ)` and scores above 0.5. Applying the
 * textbook threshold at this ψ would flag all 36 sessions and report a 100 % false-
 * positive rate. The convention is not wrong; it is simply not defined at a corpus this
 * small, which is one more way of measuring how small the corpus is.
 *
 * ## What the forest structurally CANNOT see, and it matters
 * A split is only ever drawn on a feature whose range is non-zero **within the training
 * data**. Across the 7 healthy training sessions the v2.0 report features are constant:
 * `findingCountCritical`, every `rule*Count`, every `pattern*` flag are **0 for every
 * healthy session**. A feature that is constant in training is never split on — so a test
 * session with three critical findings is, to this forest, *invisible along that axis*.
 * The model detects faults through the continuous channel statistics (link quality, RSSI,
 * RSSI imbalance, SNR, heading spread) that actually vary among healthy flights, and
 * through nothing else. That is a real property of the algorithm at this corpus, it is
 * reported in the artifact (`training.constantFeatures`), and it is not worked around:
 * a workaround would be a feature-selection decision made to improve a number.
 *
 * ## Safety — advisory only, numeric only, zero identifiers
 * {@link AnomalyModelOutput} carries a score, a threshold, a boolean, feature **names**
 * drawn from the frozen {@link FEATURE_NAMES} tuple, an {@link EvidenceWindow}, and a
 * `detail` bag typed `Record<string, number>` — numbers only, exactly like
 * `DiagnosticFinding.detail` but stricter (no `string` branch at all). There is nowhere
 * in the shape to put a device setting, a config key, a firmware field, a coordinate, a
 * UID, a MAC, an IP, or a sentence. The model cannot write hardware config because its
 * output has no field a hardware writer could read, and this module imports nothing from
 * the flash, config, profile, or Tauri layers. `advisory: true` is a literal type, not a
 * runtime flag someone can flip.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticReport, EvidenceWindow } from "@/lib/diagnostics";
import { CHANNEL_CANDIDATES, resolveChannelValues } from "@/lib/diagnostics/util";
import {
  extractFeatures,
  FEATURE_NAMES,
  toFeatureArray,
  type FeatureName,
  type FeatureVector,
  type MlLabel,
  type TrainingRow,
  ML_DATASET_SCHEMA_VERSION,
} from "./dataset";
import { createRng, DEFAULT_SEED, shuffled } from "./rng";
import { isFiniteNumber, round6 } from "./stats";

// ---------------------------------------------------------------------------
// Identity + schema
// ---------------------------------------------------------------------------

/** Stable model id. Appears in every output and in the checked-in artifact. */
export const ANOMALY_MODEL_ID = "m58-isolation-forest";

/**
 * Semantic version of the {@link AnomalyModel} + {@link AnomalyModelOutput} shapes.
 * Bump on any breaking change; a consumer that does not recognise the version must
 * reject the artifact rather than coerce it — the discipline
 * `ML_DATASET_SCHEMA_VERSION` and `DIAGNOSTIC_EXPORT_SCHEMA_VERSION` already follow.
 */
export const ANOMALY_MODEL_SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Frozen hyperparameters (chosen before any score was looked at)
// ---------------------------------------------------------------------------

/**
 * Trees in the forest. **100** is Liu et al.'s published default, and it is kept
 * *because* it is the published default: at ψ = 7 the per-tree path-length variance is
 * enormous, so the ensemble size is the one knob that would visibly move a score, and a
 * knob that moves the score is a knob that must not be chosen by looking at the score.
 */
export const FOREST_TREE_COUNT = 100;

/**
 * Subsample size per tree, capped at Liu et al.'s default of 256. On this corpus the
 * training set is smaller than the cap, so **every tree sees all 7 healthy training
 * rows** and trees differ only through their random cuts. That is the algorithm at this
 * n, stated rather than disguised.
 */
export const FOREST_SUBSAMPLE_CAP = 256;

/**
 * Evidence-window length in samples: **25**, i.e. **1 second** at the canonical 40 ms
 * telemetry cadence — the same order as the v2.0 rules' minimum evidence spans, so a
 * model window and a rule window are comparable spans of flight rather than two
 * different notions of "a while".
 */
export const EVIDENCE_WINDOW_SAMPLES = 25;

/** How many contributing features {@link explainSession} names. */
export const TOP_FEATURE_COUNT = 5;

/** Euler–Mascheroni constant, for the harmonic-number approximation in {@link cNorm}. */
const EULER_GAMMA = 0.5772156649015329;

/**
 * Average path length of an unsuccessful search in a binary search tree over `n` points
 * — iForest's normalising constant, and the correction applied at a leaf that still
 * holds several points (Liu et al., eq. 1).
 *
 * `c(n) = 2·H(n−1) − 2(n−1)/n` for `n > 2`, `c(2) = 1`, `c(n ≤ 1) = 0`.
 */
export function cNorm(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  const h = Math.log(n - 1) + EULER_GAMMA;
  return 2 * h - (2 * (n - 1)) / n;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * One node of an isolation tree, in a flat array (index 0 is the root).
 *
 * Short keys because this is a machine artifact that gets checked in: a 100-tree forest
 * is ~1 300 nodes, and `featureIndex`/`splitValue`/`leftChild`/`rightChild`/`sampleCount`
 * would quadruple the file for no reader's benefit. The meaning is here, in the type.
 */
export interface IsolationTreeNode {
  /** Split feature as an index into {@link FEATURE_NAMES}, or **−1** for a leaf. */
  f: number;
  /** Split value: a sample goes left when `x[f] < v`. `0` at a leaf. */
  v: number;
  /** Left child index into the node array, or **−1** at a leaf. */
  l: number;
  /** Right child index into the node array, or **−1** at a leaf. */
  r: number;
  /** Training rows that reached this node. Drives {@link cNorm} at a leaf. */
  n: number;
}

/** One isolation tree: a flat node array whose element 0 is the root. */
export interface IsolationTree {
  nodes: IsolationTreeNode[];
}

/** The frozen hyperparameters a trained model was produced under. */
export interface AnomalyModelHyperparams {
  /** {@link FOREST_TREE_COUNT}. */
  trees: number;
  /** `min(FOREST_SUBSAMPLE_CAP, trainingRows)` — ψ. */
  subsampleSize: number;
  /** `ceil(log2(ψ))`, Liu et al.'s height limit. */
  heightLimit: number;
  /** The seed the forest was grown under. Quote it with any number derived from it. */
  seed: number;
  /** The single class the one-class model was fit to (`"healthy"`). */
  trainedOnClass: MlLabel;
}

/** What the model was fit to — counts only, never a session key. */
export interface AnomalyModelTrainingInfo {
  /** Rows the model was fit to (the healthy rows of the **train** split). */
  rowCount: number;
  /** Rows offered to {@link trainAnomalyModel}, before the one-class filter. */
  offeredRowCount: number;
  /**
   * Features whose value is **constant across every training row** and which the forest
   * therefore never splits on — it is blind along these axes. See the module header.
   */
  constantFeatures: FeatureName[];
  /** Features with a non-zero training range: the axes the forest can actually cut. */
  splittableFeatureCount: number;
}

/**
 * A trained isolation forest. **Numeric + structural only**: no session key, no label
 * per row, no free text, nothing that could identify a device or a person. Safe to check
 * in, safe to ship in a flag-gated bundle, safe to persist locally.
 */
export interface AnomalyModel {
  modelId: typeof ANOMALY_MODEL_ID;
  schemaVersion: typeof ANOMALY_MODEL_SCHEMA_VERSION;
  /** The dataset schema whose {@link FEATURE_NAMES} the split indices refer to. */
  datasetSchemaVersion: typeof ML_DATASET_SCHEMA_VERSION;
  hyperparams: AnomalyModelHyperparams;
  training: AnomalyModelTrainingInfo;
  /** `c(ψ)` — the score's normaliser, cached so inference never recomputes it. */
  pathNorm: number;
  /**
   * Flag threshold: the **maximum score over the training rows** (see the module header).
   * A session scores `> threshold` ⇒ flagged. Fitted on train only.
   */
  threshold: number;
  trees: IsolationTree[];
}

/** Options for {@link trainAnomalyModel}. */
export interface TrainOptions {
  /** Defaults to {@link DEFAULT_SEED}. */
  seed?: number;
  /** Defaults to {@link FOREST_TREE_COUNT}. */
  trees?: number;
  /** The one class the forest is fit to. Defaults to `"healthy"`. */
  trainClass?: MlLabel;
  /**
   * Tree height limit. Defaults to Liu et al.'s `ceil(log2 ψ)`.
   *
   * Exposed **only** so `modelEval.ts` can run its checked-in sensitivity probe — the
   * one that proves the shipped model is not a strawman by showing that a *deeper* forest
   * and a *bigger* forest both separate the classes WORSE, not better. It selects nothing:
   * the shipped model is the reference configuration, and the probe never touches test.
   */
  heightLimit?: number;
}

/** Thrown when a caller hands {@link trainAnomalyModel} rows it cannot honestly fit. */
export class UntrainableModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrainableModelError";
  }
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * Grow one isolation tree over `indices` of `data`, appending nodes to `nodes` and
 * returning the new node's index.
 *
 * Standard iForest growth with the usual "attribute with non-zero range" refinement: a
 * cut can only be drawn on a feature that actually varies among the node's points (a
 * constant feature offers no cut), and a node with no such feature is a leaf regardless
 * of its size. The cut value is drawn uniformly in `(min, max)`, so both children are
 * non-empty.
 */
function growTree(
  data: readonly number[][],
  indices: readonly number[],
  depth: number,
  heightLimit: number,
  rng: () => number,
  nodes: IsolationTreeNode[]
): number {
  const self = nodes.length;
  nodes.push({ f: -1, v: 0, l: -1, r: -1, n: indices.length });

  if (depth >= heightLimit || indices.length <= 1) return self;

  // Features that can actually be cut here: min < max among this node's points.
  const splittable: number[] = [];
  for (let f = 0; f < FEATURE_NAMES.length; f++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const i of indices) {
      const x = data[i][f];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (hi > lo) splittable.push(f);
  }
  if (splittable.length === 0) return self;

  const f = splittable[Math.floor(rng() * splittable.length)];
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of indices) {
    const x = data[i][f];
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  // Uniform in (lo, hi). Rounded for artifact stability; re-clamped strictly inside the
  // open interval so a rounded value can never collapse a child to zero points.
  let v = round6(lo + rng() * (hi - lo));
  if (v <= lo || v >= hi) v = (lo + hi) / 2;

  const left: number[] = [];
  const right: number[] = [];
  for (const i of indices) {
    if (data[i][f] < v) left.push(i);
    else right.push(i);
  }

  nodes[self].f = f;
  nodes[self].v = v;
  nodes[self].l = growTree(data, left, depth + 1, heightLimit, rng, nodes);
  nodes[self].r = growTree(data, right, depth + 1, heightLimit, rng, nodes);
  return self;
}

/**
 * Fit the one-class isolation forest to the **healthy rows of the split the caller hands
 * in**. Pure and seeded: same rows + same seed ⇒ a byte-identical {@link AnomalyModel}.
 *
 * The input is {@link TrainingRow}[] — the `sessionId`-stripped shape — so the model
 * *cannot* see a session key even by accident. Callers must pass the **train** partition
 * of {@link import("./dataset").splitDataset} and nothing else; val and test rows in this
 * array would be leakage, and the leakage guard in `tests/unit/ml/anomalyModel.test.ts`
 * asserts the fitted model is invariant to every test-split row.
 *
 * @throws {UntrainableModelError} when no row of the training class is present — a model
 *   fit to nothing would score everything identically and is not a model.
 */
export function trainAnomalyModel(
  rows: readonly TrainingRow[],
  options: TrainOptions = {}
): AnomalyModel {
  const seed = options.seed ?? DEFAULT_SEED;
  const treeCount = options.trees ?? FOREST_TREE_COUNT;
  const trainClass: MlLabel = options.trainClass ?? "healthy";

  const normal = rows.filter((r) => r.label === trainClass);
  if (normal.length === 0) {
    throw new UntrainableModelError(
      `no rows of the training class "${trainClass}" (offered ${rows.length})`
    );
  }

  const data = normal.map((r) => toFeatureArray(r.features));
  const subsampleSize = Math.min(FOREST_SUBSAMPLE_CAP, data.length);
  const heightLimit =
    options.heightLimit ?? Math.max(1, Math.ceil(Math.log2(Math.max(2, subsampleSize))));

  // Which axes can the forest ever cut? (See the module header — this is a real blind
  // spot, not a diagnostic curiosity.)
  const constantFeatures: FeatureName[] = [];
  for (let f = 0; f < FEATURE_NAMES.length; f++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of data) {
      if (row[f] < lo) lo = row[f];
      if (row[f] > hi) hi = row[f];
    }
    if (!(hi > lo)) constantFeatures.push(FEATURE_NAMES[f]);
  }

  // ONE rng stream, consumed in a fixed tree order ⇒ reproducible as a whole forest and
  // not merely per tree (the same discipline `splitDataset` follows).
  const rng = createRng(seed);
  const allIndices = data.map((_, i) => i);
  const trees: IsolationTree[] = [];
  for (let t = 0; t < treeCount; t++) {
    const sample = shuffled(allIndices, rng).slice(0, subsampleSize);
    const nodes: IsolationTreeNode[] = [];
    growTree(data, sample, 0, heightLimit, rng, nodes);
    trees.push({ nodes });
  }

  const pathNorm = round6(cNorm(subsampleSize));
  const model: AnomalyModel = {
    modelId: ANOMALY_MODEL_ID,
    schemaVersion: ANOMALY_MODEL_SCHEMA_VERSION,
    datasetSchemaVersion: ML_DATASET_SCHEMA_VERSION,
    hyperparams: {
      trees: treeCount,
      subsampleSize,
      heightLimit,
      seed,
      trainedOnClass: trainClass,
    },
    training: {
      rowCount: normal.length,
      offeredRowCount: rows.length,
      constantFeatures,
      splittableFeatureCount: FEATURE_NAMES.length - constantFeatures.length,
    },
    pathNorm,
    // Provisional: the score function needs a model, so the threshold is filled in from
    // the training rows' own scores immediately below.
    threshold: 0,
    trees,
  };

  // The a-priori threshold: the most anomalous healthy session the model was ever shown.
  let worst = 0;
  for (const row of normal) {
    const s = scoreFeatures(model, row.features).score;
    if (s > worst) worst = s;
  }
  model.threshold = round6(worst);
  return model;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Walk one tree, returning the point's adjusted path length and crediting each split
 * feature with the path it saved.
 *
 * ## The attribution is exact, not a heuristic
 * At a node holding `n` training points whose chosen child holds `m`, the split is
 * credited with `c(n) − 1 − c(m)`: the expected remaining path had we stopped here,
 * minus the step we took, minus the expected remaining path from where we landed. Summed
 * along the path this **telescopes exactly** to `c(ψ) − h(x)` — the point's whole
 * anomaly excess, decomposed over the features that produced it, with no residual. A
 * feature that routed the point into a small, quickly-isolated region gets a large
 * positive credit; one that routed it into the bulk gets a negative one.
 */
function pathAndAttribution(
  tree: IsolationTree,
  x: readonly number[],
  attribution: number[]
): number {
  let node = tree.nodes[0];
  let depth = 0;
  while (node.f >= 0) {
    const childIdx = x[node.f] < node.v ? node.l : node.r;
    const child = tree.nodes[childIdx];
    attribution[node.f] += cNorm(node.n) - 1 - cNorm(child.n);
    node = child;
    depth += 1;
  }
  return depth + cNorm(node.n);
}

/** One feature's additive contribution to a session's anomaly score. */
export interface FeatureContribution {
  /** A real {@link FEATURE_NAMES} member — never an index, never free text. */
  feature: FeatureName;
  /**
   * Mean path saved by this feature across the forest, in path-length units. Positive ⇒
   * pushed the session toward *anomalous*; negative ⇒ toward *normal*. Summing over all
   * 43 features gives exactly `c(ψ) − meanPathLength`.
   */
  contribution: number;
}

/** A scored session: the score, the verdict, and the decomposition behind them. */
export interface AnomalyScore {
  /** iForest score in `[0, 1]`: `2^(−meanPathLength / c(ψ))`. Higher ⇒ more anomalous. */
  score: number;
  /** Mean adjusted path length across the forest. */
  meanPathLength: number;
  /** `score > model.threshold`. */
  flagged: boolean;
  /** Per-feature additive contributions, in canonical {@link FEATURE_NAMES} order. */
  contributions: FeatureContribution[];
}

/**
 * Score one {@link FeatureVector}. **Pure**: same model + same vector ⇒ byte-identical
 * result, on every machine and in every run order.
 */
export function scoreFeatures(model: AnomalyModel, features: FeatureVector): AnomalyScore {
  const x = toFeatureArray(features);
  const attribution = new Array<number>(FEATURE_NAMES.length).fill(0);

  let pathSum = 0;
  for (const tree of model.trees) {
    pathSum += pathAndAttribution(tree, x, attribution);
  }
  const treeCount = model.trees.length;
  const meanPathLength = treeCount > 0 ? pathSum / treeCount : 0;
  const score = model.pathNorm > 0 ? Math.pow(2, -meanPathLength / model.pathNorm) : 0;

  return {
    score: round6(score),
    meanPathLength: round6(meanPathLength),
    flagged: round6(score) > model.threshold,
    contributions: FEATURE_NAMES.map((feature, f) => ({
      feature,
      contribution: round6(attribution[f] / (treeCount > 0 ? treeCount : 1)),
    })),
  };
}

// ---------------------------------------------------------------------------
// The evidence window — an explainability PROXY, and labelled as one
// ---------------------------------------------------------------------------

/**
 * How a feature localises to a span of flight.
 *
 * `"session"` means the feature is a **session aggregate that does not localise** — a
 * sample count, a duration, a health score, a finding count, a pattern flag. Claiming a
 * narrow evidence window for one of those would be a fabrication, so the window for such
 * a feature is the whole session and the artifact says which case it fell into.
 */
type EvidenceLocator =
  | { kind: "session" }
  | { kind: "channel"; channel: keyof typeof CHANNEL_CANDIDATES; extreme: "min" | "max" }
  | { kind: "imbalance" };

/**
 * Per-feature localisation table. Every one of the 43 frozen {@link FEATURE_NAMES} has an
 * entry — a missing entry is a compile error, so a new feature cannot silently inherit a
 * window it has no claim to.
 */
const EVIDENCE_LOCATORS: Readonly<Record<FeatureName, EvidenceLocator>> = {
  lqMean: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqMin: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqStd: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqP05: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqFracBelowLow: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqFracZero: { kind: "channel", channel: "linkQuality", extreme: "min" },
  lqMaxStepDrop: { kind: "channel", channel: "linkQuality", extreme: "min" },
  rssi1Mean: { kind: "channel", channel: "rssi1", extreme: "min" },
  rssi1Min: { kind: "channel", channel: "rssi1", extreme: "min" },
  rssi1Std: { kind: "channel", channel: "rssi1", extreme: "min" },
  rssi2Mean: { kind: "channel", channel: "rssi2", extreme: "min" },
  rssi2Min: { kind: "channel", channel: "rssi2", extreme: "min" },
  rssiBestMean: { kind: "channel", channel: "rssi1", extreme: "min" },
  rssiImbalanceMean: { kind: "imbalance" },
  rssiImbalanceMax: { kind: "imbalance" },
  rssiFracBelowFloor: { kind: "channel", channel: "rssi1", extreme: "min" },
  snrMean: { kind: "channel", channel: "snr", extreme: "min" },
  snrMin: { kind: "channel", channel: "snr", extreme: "min" },
  snrStd: { kind: "channel", channel: "snr", extreme: "min" },
  txPowerMean: { kind: "channel", channel: "txPower", extreme: "max" },
  txPowerMax: { kind: "channel", channel: "txPower", extreme: "max" },
  txPowerRangeMw: { kind: "channel", channel: "txPower", extreme: "max" },
  txPowerFracAtTopStep: { kind: "channel", channel: "txPower", extreme: "max" },
  packetRateMean: { kind: "channel", channel: "packetRate", extreme: "min" },
  packetRateChangeRate: { kind: "channel", channel: "packetRate", extreme: "min" },
  // The antenna-null signature is a directional RSSI *deficit*; it localises to where the
  // best-antenna RSSI is worst, which is the null the aircraft flew through.
  headingSectorRssiSpreadDb: { kind: "channel", channel: "rssi1", extreme: "min" },
  sampleCount: { kind: "session" },
  durationMs: { kind: "session" },
  healthScore: { kind: "session" },
  findingCountInfo: { kind: "session" },
  findingCountWarning: { kind: "session" },
  findingCountCritical: { kind: "session" },
  maxFindingConfidence: { kind: "session" },
  findingCoverageFrac: { kind: "session" },
  ruleLqCollapseCount: { kind: "session" },
  ruleRssiFloorCount: { kind: "session" },
  ruleSnrNoiseCount: { kind: "session" },
  rulePacketInstabilityCount: { kind: "session" },
  ruleTxPowerSaturationCount: { kind: "session" },
  patternRepeatedLqDrops: { kind: "session" },
  patternHeadingDegradation: { kind: "session" },
  patternPowerPacketLinkEvents: { kind: "session" },
  patternMaxConfidence: { kind: "session" },
};

/** The whole session as an inclusive window (the honest window for a session aggregate). */
function wholeSessionWindow(log: ParsedLog): EvidenceWindow {
  return { startIndex: 0, endIndex: Math.max(0, log.sampleCount - 1) };
}

/**
 * The `EVIDENCE_WINDOW_SAMPLES`-long window whose **rolling mean** of `values` is
 * extremal in `direction`. O(n), one pass — so it stays inside the marginal ML perf
 * budget even at 50 000 samples.
 *
 * Gaps (`NaN`) are skipped rather than read as zero, the same rule every other module in
 * this project follows. A window with no finite sample cannot win.
 */
function extremalWindow(
  values: readonly number[],
  sampleCount: number,
  direction: "min" | "max"
): EvidenceWindow | null {
  const width = Math.min(EVIDENCE_WINDOW_SAMPLES, sampleCount);
  if (width <= 0 || values.length === 0) return null;

  let sum = 0;
  let count = 0;
  let bestStart = -1;
  let bestMean = direction === "min" ? Infinity : -Infinity;

  for (let i = 0; i < sampleCount; i++) {
    const v = values[i];
    if (isFiniteNumber(v)) {
      sum += v;
      count += 1;
    }
    const out = i - width;
    if (out >= 0) {
      const o = values[out];
      if (isFiniteNumber(o)) {
        sum -= o;
        count -= 1;
      }
    }
    if (i >= width - 1 && count > 0) {
      const mean = sum / count;
      const better = direction === "min" ? mean < bestMean : mean > bestMean;
      if (better) {
        bestMean = mean;
        bestStart = i - width + 1;
      }
    }
  }

  if (bestStart < 0) return null;
  return { startIndex: bestStart, endIndex: bestStart + width - 1 };
}

/** Per-sample `|rssi1 − rssi2|`, `NaN` where either antenna has a gap. */
function imbalanceSeries(log: ParsedLog): number[] {
  const r1 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1) ?? [];
  const r2 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi2) ?? [];
  const n = log.sampleCount;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = isFiniteNumber(r1[i]) && isFiniteNumber(r2[i]) ? Math.abs(r1[i] - r2[i]) : NaN;
  }
  return out;
}

/**
 * Localise the model's verdict to a span of the session, driven by its **top contributing
 * feature**.
 *
 * This is an explainability **proxy** and the name is not modesty: the model's features
 * are session aggregates, so the model does not, and cannot, have an opinion about *when*
 * within the session the anomaly happened. What this function does is find the window of
 * the session over which the *channel behind the top contributor* is at its worst — the
 * span a human would be pointed at to see what the model reacted to. A top contributor
 * that is itself a session aggregate (a finding count, a health score) localises to the
 * whole session, because that is the truth.
 */
export function evidenceWindowFor(log: ParsedLog, top: FeatureName): EvidenceWindow {
  if (log.sampleCount <= 0) return { startIndex: 0, endIndex: 0 };
  const locator = EVIDENCE_LOCATORS[top];

  if (locator.kind === "session") return wholeSessionWindow(log);

  const values =
    locator.kind === "imbalance"
      ? imbalanceSeries(log)
      : resolveChannelValues(log, CHANNEL_CANDIDATES[locator.channel]);
  if (!values || values.length === 0) return wholeSessionWindow(log);

  const direction = locator.kind === "imbalance" ? "max" : locator.extreme;
  return extremalWindow(values, log.sampleCount, direction) ?? wholeSessionWindow(log);
}

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

/**
 * One session's model output. **Advisory only, numeric only, zero identifiers.**
 *
 * There is deliberately nothing in this shape that a hardware-writing path could consume:
 * no setting key, no value to write, no target, no firmware field, no free text. A device
 * writer takes a `ProfileSettings`/options patch; this is a score, a boolean, five feature
 * names from a frozen tuple, a sample window, and a bag of numbers. `advisory: true` is a
 * **literal type** — there is no representable output with `advisory: false`.
 */
export interface AnomalyModelOutput {
  modelId: typeof ANOMALY_MODEL_ID;
  schemaVersion: typeof ANOMALY_MODEL_SCHEMA_VERSION;
  /** Advisory, always. The type has no other inhabitant. */
  advisory: true;
  /** iForest score in `[0, 1]`. Higher ⇒ less like the healthy sessions it was fit to. */
  score: number;
  /** The model's flag threshold (fitted on the train split; see the module header). */
  threshold: number;
  /** `score > threshold`. **A suggestion to look, never an action.** */
  flagged: boolean;
  /** The {@link TOP_FEATURE_COUNT} strongest contributors, descending. Real feature names. */
  topFeatures: FeatureContribution[];
  /** The span the top contributor's channel is worst over — the same inclusive shape a
   * `DiagnosticFinding` uses, so a model window and a rule window render identically. */
  evidenceWindow: EvidenceWindow;
  /**
   * Non-identifying **numbers only** — stricter than `DiagnosticFinding.detail`, which
   * also allows strings. Nothing here can be a coordinate, a UID, a MAC, an IP, a serial,
   * a binding phrase, or a sentence, because nothing here can be anything but a number.
   */
  detail: Record<string, number>;
}

/**
 * Run the model over one session and explain the result.
 *
 * **Pure.** Same model + same log ⇒ byte-identical output.
 *
 * ## Pass the report you already have
 * `report` is forwarded straight to `extractFeatures(log, report)`. The frozen
 * {@link import("./mlConsts").ML_INFERENCE_P95_BUDGET_MS} (150 ms @ 50 k samples) budgets
 * the **marginal** ML pass — features-with-report plus the forward pass — because that is
 * the only cost a user perceives as *new* when ML is layered onto an "analyze this
 * session" action that was going to run the deterministic scan anyway. Calling this
 * without a report makes `extractFeatures` re-run the whole v2.0 scan internally, and the
 * caller is then paying for a scan and an ML pass, not for an ML pass.
 */
export function explainSession(
  model: AnomalyModel,
  log: ParsedLog,
  report?: DiagnosticReport
): AnomalyModelOutput {
  const features = extractFeatures(log, report);
  const scored = scoreFeatures(model, features);

  const ranked = [...scored.contributions].sort(
    (a, b) =>
      b.contribution - a.contribution ||
      FEATURE_NAMES.indexOf(a.feature) - FEATURE_NAMES.indexOf(b.feature)
  );
  const topFeatures = ranked.slice(0, TOP_FEATURE_COUNT);
  const top = topFeatures[0]?.feature ?? FEATURE_NAMES[0];

  return {
    modelId: ANOMALY_MODEL_ID,
    schemaVersion: ANOMALY_MODEL_SCHEMA_VERSION,
    advisory: true,
    score: scored.score,
    threshold: model.threshold,
    flagged: scored.flagged,
    topFeatures,
    evidenceWindow: evidenceWindowFor(log, top),
    detail: {
      score: scored.score,
      threshold: model.threshold,
      meanPathLength: scored.meanPathLength,
      pathNorm: model.pathNorm,
      trees: model.trees.length,
      trainingRows: model.training.rowCount,
      topContribution: round6(topFeatures[0]?.contribution ?? 0),
    },
  };
}

/**
 * Serialize a trained model to the exact bytes checked in at `data/ml/model-m58.json`.
 *
 * **Compact** (no indentation), unlike the 2-space-indented `baseline-v20.json`, and the
 * asymmetry is deliberate: a baseline artifact is a *report a human reads and diffs*,
 * whereas a forest is ~1 300 machine-generated nodes whose pretty-printed form is ~5×
 * larger and no more readable for it. It is still fully deterministic (no clock, no
 * machine state), so a re-run rewrites byte-identical bytes and
 * `tests/unit/ml/anomalyModel.test.ts` deep-equals the checked-in file against a freshly
 * trained model. The *human-readable* half of this artifact pair — the honesty header, the
 * scores, the gate verdict — is `data/ml/model-eval-m58.json`, which IS indented.
 */
export function serializeAnomalyModel(model: AnomalyModel): string {
  return `${JSON.stringify(model)}\n`;
}
