/**
 * M59 — the predictive failsafe warning experiment.
 *
 * ## What this suite is FOR
 * **The real-corpus null result is M59's deliverable, and this file is what makes it
 * load-bearing.** A finding recorded only in a changelog is a claim; a finding pinned by a
 * red test is a fact that a later commit has to consciously overturn. So the central
 * assertions here are, deliberately, that the predictor **finds nothing** on the real corpus,
 * and that **nothing could** — and any future change that starts claiming a predictive signal
 * exists will turn this suite red and force someone to justify it.
 *
 * Sections, mirroring `baseline.test.ts`'s separation of concerns:
 *  1. **the risk model's arithmetic** — on hand-built inputs with answers worked out by hand.
 *     Scoring the real corpus proves nothing about the maths;
 *  2. **privacy + safety invariants** — GPS is excluded, the detail bag is numeric, the output
 *     is advisory;
 *  3. **the standing-fault guard** — the predictor is structurally incapable of M58's artifact;
 *  4. **the ORACLE BOUND, and the real-corpus NULL** — the headline;
 *  5. **the synthetic corpus** — determinism, ground-truth integrity, and separation from the
 *     real corpus;
 *  6. **the frozen artifact** — `data/ml/model-eval-m59.json` still reproduces EXACTLY.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEASURED_MAX_FIXTURE_LEAD_MS,
  PREDICTIVE_CLEAR_THRESHOLD,
  PREDICTIVE_FEATURE_NAMES,
  PREDICTIVE_LEAD_TIME_TARGET_MS,
  PREDICTIVE_MIN_WINDOW_SAMPLES,
  PREDICTIVE_RISK_HORIZON_MS,
  PREDICTIVE_RISK_THRESHOLD,
  PREDICTIVE_TRIP_FRAMES,
  PREDICTIVE_WINDOW_SAMPLES,
  PREDICTOR_ID,
  alertFramesFromLog,
  assertGroundTruth,
  buildSyntheticManifest,
  evaluatePredictor,
  extractWindowFeatures,
  fingerprintCorpus,
  fingerprintSyntheticCorpus,
  findFailsafeOnsetIndices,
  generateSyntheticCorpus,
  measureCorpusLeadCeiling,
  predictOverLog,
  riskFromTtl,
  runPredictor,
  scorePredictiveCorpus,
  serializePredictiveEvalArtifact,
  syntheticLog,
  toMlLabel,
  NEAR_MISS_BANDS,
  SYNTHETIC_CADENCE_MS,
  type BaselineArtifact,
  type BaselineFixture,
  type PredictiveCorpusSession,
  type PredictiveEvalArtifact,
  type SyntheticSession,
} from "@/lib/ml";
import type { AlertFrame } from "@/lib/liveAlerts";
import { loadAllFixtures, loadManifest } from "../diagnostics/fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");

const MANIFEST = loadManifest();
const FIXTURES: BaselineFixture[] = loadAllFixtures();

const BASELINE: BaselineArtifact = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "data/ml/baseline-v20.json"), "utf8")
) as BaselineArtifact;

/** The real corpus, projected onto the predictive scorer's neutral session shape. */
const REAL_SESSIONS: PredictiveCorpusSession[] = FIXTURES.map((fx) => ({
  sessionId: fx.file,
  label: toMlLabel(fx.label),
  bucket: fx.label,
  log: fx.log,
}));

/** The synthetic corpus, regenerated from the seed (never read from disk here). */
const SYNTHETIC: SyntheticSession[] = generateSyntheticCorpus();

const SYNTHETIC_SESSIONS: PredictiveCorpusSession[] = SYNTHETIC.map((s) => ({
  sessionId: s.sessionId,
  label: s.cls === "ramp" ? "failsafe" : s.cls === "nearMiss" ? "warning" : "healthy",
  bucket: s.band ?? s.cls,
  log: syntheticLog(s),
}));

/** A steady stream of `n` healthy frames at the canonical cadence. */
function healthyFrames(n: number, lq = 95, rssi = -60): AlertFrame[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i * SYNTHETIC_CADENCE_MS,
    rssi1: rssi,
    rssi2: rssi - 2,
    linkQuality: lq,
    gps: null,
  }));
}

// ---------------------------------------------------------------------------
// 1. The risk model's arithmetic — hand-built inputs, hand-worked answers
// ---------------------------------------------------------------------------

describe("M59 risk model — the trip threshold IS the product requirement", () => {
  it("risk(ttl = the 2000 ms target) is EXACTLY the trip threshold", () => {
    // This identity is the whole model. `risk >= 0.5` and `projected to be gone within the
    // pilot's reaction window` are the same statement, and that is what makes the threshold a
    // derivation rather than a knob someone could quietly retune.
    expect(riskFromTtl(PREDICTIVE_LEAD_TIME_TARGET_MS)).toBe(PREDICTIVE_RISK_THRESHOLD);
    expect(PREDICTIVE_RISK_HORIZON_MS).toBe(2 * PREDICTIVE_LEAD_TIME_TARGET_MS);
  });

  it("risk is 1 at ttl 0, 0 at the horizon, and 0 for a link that is not falling", () => {
    expect(riskFromTtl(0)).toBe(1);
    expect(riskFromTtl(PREDICTIVE_RISK_HORIZON_MS)).toBe(0);
    expect(riskFromTtl(PREDICTIVE_RISK_HORIZON_MS * 10)).toBe(0);
    expect(riskFromTtl(Infinity)).toBe(0);
  });

  it("projects time-to-loss from a hand-computed decay: LQ 50 falling 25 %/s ⇒ ttl 2000 ms", () => {
    // A perfectly linear ramp: LQ 100 → 50 over 2000 ms is −25 %/s. From the fitted endpoint
    // of 50, at 25 %/s, the link reaches 0 in exactly 2000 ms — the target — so risk == 0.5.
    const frames: AlertFrame[] = Array.from({ length: PREDICTIVE_WINDOW_SAMPLES }, (_, i) => {
      const t = i * SYNTHETIC_CADENCE_MS;
      return { t, rssi1: -60, rssi2: -62, linkQuality: 100 - (t * 25) / 1000, gps: null };
    });
    const f = extractWindowFeatures(frames);

    expect(f.lqSlopePctPerSec).toBeCloseTo(-25, 6);
    expect(f.lqFit).toBeCloseTo(100 - (frames[frames.length - 1].t * 25) / 1000, 6);
    // ttl = lqFit / 25 %/s. At the last sample (t = 960 ms) lqFit = 76 ⇒ ttl = 3040 ms.
    expect(f.ttlMs).toBeCloseTo((f.lqFit / 25) * 1000, 3);
    expect(f.risk).toBe(riskFromTtl(f.ttlMs));
  });

  it("fails CLOSED on too few samples: no slope is fitted, and risk is 0 — never a guess", () => {
    const f = extractWindowFeatures(healthyFrames(PREDICTIVE_MIN_WINDOW_SAMPLES - 1, 10, -99));
    expect(f.risk).toBe(0);
    expect(f.lqSlopePctPerSec).toBe(0);
  });

  it("treats a NaN sample as a GAP, never as LQ 0 (a dropped packet is not a dead link)", () => {
    const withGap = healthyFrames(PREDICTIVE_WINDOW_SAMPLES).map((f, i) =>
      i === 10 ? { ...f, linkQuality: NaN } : f
    );
    // Reading the gap as 0 would manufacture a catastrophic decay rate out of a missing packet.
    expect(extractWindowFeatures(withGap).risk).toBe(0);
  });

  it("raises exactly ONE warning per trip, after the debounce, and clears with hysteresis", () => {
    const warnings = runPredictor([
      ...healthyFrames(PREDICTIVE_WINDOW_SAMPLES),
      // A hard collapse: many consecutive frames deep inside the trip band.
      ...Array.from({ length: 20 }, (_, i) => ({
        t: (PREDICTIVE_WINDOW_SAMPLES + i) * SYNTHETIC_CADENCE_MS,
        rssi1: -60 - i * 3,
        rssi2: -62 - i * 3,
        linkQuality: Math.max(0, 95 - i * 12),
        gps: null,
      })),
    ]);
    // One trip ⇒ one warning. Not one per frame.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].confidence).toBeGreaterThanOrEqual(PREDICTIVE_RISK_THRESHOLD);
    expect(PREDICTIVE_CLEAR_THRESHOLD).toBeLessThan(PREDICTIVE_RISK_THRESHOLD);
    expect(PREDICTIVE_TRIP_FRAMES).toBe(3);
  });

  it("is deterministic: the same frames yield byte-identical warnings", () => {
    const frames = alertFramesFromLog(syntheticLog(SYNTHETIC[0]));
    expect(JSON.stringify(runPredictor(frames))).toBe(JSON.stringify(runPredictor(frames)));
  });
});

// ---------------------------------------------------------------------------
// 2. Privacy + safety — invariants #1 and #4
// ---------------------------------------------------------------------------

describe("M59 safety — advisory only, numeric only, zero identifiers", () => {
  it("EXCLUDES GPS: a window with a real coordinate track yields identical features", () => {
    // `AlertFrame` HAS a `gps` field — M26's distance-from-home alarm reads it. The guarantee
    // is worthless if it is only tested where there was nothing to leak, so this tests against
    // frames that actually carry coordinates.
    const plain = healthyFrames(PREDICTIVE_WINDOW_SAMPLES);
    const withGps: AlertFrame[] = plain.map((f, i) => ({
      ...f,
      gps: {
        latitude: 51.5074 + i * 1e-4,
        longitude: -0.1278 + i * 1e-4,
        altitude: 120,
        satellites: 11,
        speed: 14,
        heading: 270,
      },
    }));

    expect(extractWindowFeatures(withGps)).toEqual(extractWindowFeatures(plain));
    expect(JSON.stringify(runPredictor(withGps))).toBe(JSON.stringify(runPredictor(plain)));
  });

  it("emits a NUMERIC-ONLY detail bag and an advisory-only output", () => {
    const warnings = predictOverLog(syntheticLog(SYNTHETIC.find((s) => s.cls === "ramp")!));
    expect(warnings.length).toBeGreaterThan(0);

    for (const w of warnings) {
      expect(w.advisory).toBe(true);
      expect(w.predictorId).toBe(PREDICTOR_ID);
      // Every `detail` value is a finite number. There is nowhere to put a coordinate, a UID,
      // a MAC, an IP, a serial, a binding phrase, or a sentence.
      for (const v of Object.values(w.detail)) {
        expect(typeof v).toBe("number");
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const v of Object.values(w.features)) {
        expect(typeof v).toBe("number");
        expect(Number.isFinite(v)).toBe(true);
      }
      // A stable machine-readable CODE, never a sentence and never an i18n key: `src/lib/ml`
      // holds zero user-facing strings and names no UI namespace. The lab UI composes the key.
      expect(w.code).toBe("predictedLinkLoss");
    }
  });

  it("carries no field a hardware writer could consume", () => {
    const w = predictOverLog(syntheticLog(SYNTHETIC.find((s) => s.cls === "ramp")!))[0];
    const keys = Object.keys(w);
    for (const forbidden of ["settings", "config", "target", "firmware", "value", "write"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("freezes the 10-feature vocabulary", () => {
    expect(PREDICTIVE_FEATURE_NAMES).toHaveLength(10);
    expect([...PREDICTIVE_FEATURE_NAMES]).toEqual([
      "lqFit",
      "lqSlopePctPerSec",
      "rssiFit",
      "rssiSlopeDbPerSec",
      "ttlMs",
      "risk",
      "lqMin",
      "lqStd",
      "rssiMin",
      "sampleCount",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The standing-fault guard — M58's artifact must be UNREACHABLE
// ---------------------------------------------------------------------------

describe("M59 — structurally incapable of M58's standing-fault artifact", () => {
  it("does NOT warn about a link that is BAD but STABLE, however bad it is", () => {
    // M58's early-warning probe produced an unbounded "median lead 4920 ms" by flagging a
    // standing wiring fault at sample 0 and crediting it with predicting a failsafe seconds
    // later. It correctly disbelieved its own number. THIS predictor cannot produce that
    // number at all: a channel that is not FALLING has an infinite time-to-loss and therefore
    // zero risk, however awful its level. Detecting an already-present fault is DETECTION,
    // which the v2.0 rules and M26 already do. This module only ever claims PREDICTION.
    const awfulButFlat = Array.from({ length: 200 }, (_, i) => ({
      t: i * SYNTHETIC_CADENCE_MS,
      rssi1: -99, // one dB off the noise floor
      rssi2: -60, // a huge, CONSTANT diversity imbalance — the wiring signature
      linkQuality: 30, // terrible, and going nowhere
      gps: null,
    }));

    expect(runPredictor(awfulButFlat)).toHaveLength(0);
  });

  it("does NOT warn on a healthy link, however long it runs", () => {
    expect(runPredictor(healthyFrames(500))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. THE HEADLINE — the oracle bound, and the real-corpus NULL RESULT
// ---------------------------------------------------------------------------

describe("M59 REAL CORPUS — the null result (this is the milestone's deliverable)", () => {
  const ceiling = measureCorpusLeadCeiling(
    REAL_SESSIONS.map((s) => ({
      sessionId: s.sessionId,
      log: s.log,
      onsets: findFailsafeOnsetIndices(s.log),
    }))
  );
  const partition = scorePredictiveCorpus(REAL_SESSIONS);

  it("inherits the FROZEN 17-onset event set — M59 does not invent its own", () => {
    expect(ceiling.eventCount).toBe(17);
    expect(partition.eventCount).toBe(17);
  });

  it("ORACLE BOUND: the corpus offers a MEDIAN of 0 ms of lead to ANY predictor", () => {
    // Measured with NO reference to any model: the earliest sample at which link quality has
    // departed from health. A predictor cannot react to a fall it has not observed, so this is
    // an upper bound a perfect oracle attains and nothing exceeds.
    expect(ceiling.threshold.medianMs).toBe(0);
    expect(ceiling.threshold.maxMs).toBe(80);

    // And it INDEPENDENTLY reproduces the constant frozen in `mlConsts.ts` before this code
    // existed. Two derivations, one number.
    expect(ceiling.threshold.maxMs).toBe(MEASURED_MAX_FIXTURE_LEAD_MS);
  });

  it("9 of the 17 onsets give LITERALLY ZERO warning (LQ: healthy → 0 in ONE sample)", () => {
    expect(ceiling.threshold.zeroLeadEvents).toBe(9);
  });

  it("the null does NOT depend on how 'departure from health' is defined", () => {
    // The maximally generous definition credits even a 1-point noise wiggle as a precursor —
    // something no real detector could act on without firing constantly on healthy links. Even
    // so the ceiling only reaches 120 ms, ~17x short of the target. The null is robust to the
    // definition, so it cannot be dismissed as an artifact of a stingy one.
    expect(ceiling.anyMovement.medianMs).toBe(40);
    expect(ceiling.anyMovement.maxMs).toBe(120);
    expect(ceiling.anyMovement.maxMs).toBeLessThan(PREDICTIVE_LEAD_TIME_TARGET_MS);
  });

  it("THE TARGET IS UNREACHABLE ON THIS CORPUS — by any predictor, under either definition", () => {
    expect(ceiling.targetReachable).toBe(false);
    expect(ceiling.threshold.targetReachable).toBe(false);
    expect(ceiling.anyMovement.targetReachable).toBe(false);
    expect(PREDICTIVE_LEAD_TIME_TARGET_MS).toBe(2000);
  });

  it("THE PREDICTOR FINDS NO PREDICTIVE SIGNAL: ZERO creditable predictions out of 17", () => {
    // ***** THE NULL RESULT. This is M59's headline finding, pinned. *****
    // A future change that starts claiming a predictive signal exists in this corpus turns
    // this red, and someone has to justify it against the oracle bound above.
    const lead = partition.report.leadTime;
    expect(lead).not.toBeNull();
    expect(lead!.predictedCount).toBe(0);
    expect(lead!.meetsTargetMedian).toBe(false);

    // `null`, NOT 0 — and the difference matters. There is no median because there are no
    // creditable predictions to take a median of. `0 ms` would mean "it warned, with no lead";
    // `null` means "it never warned in time at all". The stronger of the two nulls.
    expect(lead!.medianLeadMs).toBeNull();

    // Every onset is either LATE (detected after the link was already gone — which is what the
    // shipped M26 alerts already do) or MISSED. None is PREDICTED.
    expect(lead!.lateCount + lead!.missedCount).toBe(17);
  });

  it("the null does NOT depend on the creditability horizon (2 s / 10 s / unbounded)", () => {
    for (const cell of partition.horizonSensitivity) {
      expect(cell.predictedCount).toBe(0);
      expect(cell.medianLeadMs).toBeNull();
      expect(cell.meetsTargetMedian).toBe(false);
    }
    // Including the UNBOUNDED cell — the one that let M58's probe inflate its number.
    expect(partition.horizonSensitivity.some((c) => c.horizonMs === null)).toBe(true);
  });

  it("the NAIVE lead time is an ARTIFACT, and the oracle bound is what proves it", () => {
    // Crediting warnings the predictor ITSELF WITHDREW reports a multi-second median lead on a
    // corpus whose oracle ceiling is 80 ms. Both cannot be true. The oracle bound has no knobs
    // in it, so the naive attribution is what is wrong.
    //
    // The mechanism: `failsafe-after-warning-05.csv` dips to LQ 40, RECOVERS TO LQ 91, and only
    // then dies. The predictor warns on the dip and withdraws when the link recovers. The same
    // dip shape appears in the 7 `warning` fixtures, WHICH NEVER FAILSAFE — where the identical
    // warning is scored as a false alarm. The same signal, counted as a triumph or a failure
    // depending on what happened afterwards, is not a predictor.
    expect(partition.withdrawnWarnings).toBeGreaterThan(0);
    expect(partition.leadTimeNaive!.medianLeadMs).not.toBeNull();
    expect(partition.leadTimeNaive!.medianLeadMs!).toBeGreaterThan(ceiling.threshold.maxMs);
    // ...and the headline number does NOT credit them: it has no predictions at all.
    expect(partition.report.leadTime!.predictedCount).toBe(0);
    expect(partition.report.leadTime!.medianLeadMs).toBeNull();
  });

  it("false alarms: it fires on the confusable negatives, and never on a healthy session", () => {
    // The honest denominator: every session that did NOT failsafe (24), including the 7
    // `warning` fixtures whose dip shape is genuinely confusable.
    expect(partition.predictiveFpRate.denominator).toBe(24);
    expect(partition.predictiveFpRate.numerator).toBeGreaterThan(0);

    // The D25-comparable denominator: healthy sessions only (12). It fires on none of them —
    // which is a real property worth having, and which STILL does not clear D25's gate,
    // because the ceiling is a strict `<` against a baseline FP rate of 0.000.
    expect(partition.healthyOnlyFpRate.denominator).toBe(12);
    expect(partition.healthyOnlyFpRate.value).toBe(0);
    expect(BASELINE.gateBaseline.fpCeilingClearable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The synthetic corpus — deterministic, honest, and SEPARATE
// ---------------------------------------------------------------------------

describe("M59 SYNTHETIC corpus — indicative only, and structurally separate from the real one", () => {
  it("is byte-reproducible from the seed", () => {
    expect(JSON.stringify(generateSyntheticCorpus())).toBe(JSON.stringify(SYNTHETIC));
    expect(fingerprintSyntheticCorpus(generateSyntheticCorpus())).toBe(
      fingerprintSyntheticCorpus(SYNTHETIC)
    );
  });

  it("a different seed yields a different corpus (the seed is real, not decorative)", () => {
    expect(fingerprintSyntheticCorpus(generateSyntheticCorpus(1234))).not.toBe(
      fingerprintSyntheticCorpus(SYNTHETIC)
    );
  });

  it("HONOURS ITS GROUND TRUTH under the FROZEN onset rule — every negative truly never failsafes", () => {
    // If a near-miss accidentally failsafed it would be a positive mislabelled as a negative,
    // and EVERY false-alarm number from this corpus would be wrong in the flattering direction.
    // The generator itself caught exactly this bug during development (full-amplitude noise at
    // the bottom of the collapse shattered one failsafe into four) and refused to emit.
    expect(() => assertGroundTruth(SYNTHETIC, findFailsafeOnsetIndices)).not.toThrow();

    for (const s of SYNTHETIC) {
      const onsets = findFailsafeOnsetIndices(syntheticLog(s));
      expect(onsets.length).toBe(s.failsafe ? 1 : 0);
    }
  });

  it("contains genuinely CONFUSABLE near-miss negatives across three depth bands", () => {
    // A false-alarm rate measured only against easy negatives is decoration.
    for (const { band, count } of NEAR_MISS_BANDS) {
      expect(SYNTHETIC.filter((s) => s.band === band)).toHaveLength(count);
    }
    // The `deep` band nearly died and came back: two seconds before the bottom it is the SAME
    // SIGNAL as a true failsafe.
    for (const s of SYNTHETIC.filter((s) => s.band === "deep")) {
      expect(s.params.floorLq).toBeLessThanOrEqual(15);
      expect(s.failsafe).toBe(false);
    }
  });

  it("is NOT the real corpus: different fingerprint, and the real one has NOT moved", () => {
    const realFingerprint = fingerprintCorpus(FIXTURES);
    expect(fingerprintSyntheticCorpus(SYNTHETIC)).not.toBe(realFingerprint);
    // The frozen real-corpus fingerprint is untouched — nothing synthetic was folded into it.
    expect(realFingerprint).toBe(BASELINE.corpus.fingerprint);
    expect(FIXTURES).toHaveLength(36);
    expect(MANIFEST.fixtures).toHaveLength(36);
  });

  it("declares itself synthetic in its own manifest, in the data", () => {
    const manifest = buildSyntheticManifest(SYNTHETIC);
    expect(manifest.synthetic).toBe(true);
    expect(manifest.notFieldEvidence).toBe(true);
    expect(manifest.isAcceptanceEvidence).toBe(false);
    expect(manifest.warning.join(" ")).toContain("NOT FIELD EVIDENCE");
    expect(manifest.generator.assumptions.length).toBeGreaterThan(4);
    // The FP quantum is representable — 30 near-miss negatives ⇒ 3.3 pp steps.
    expect(manifest.counts.nearMissFpRateQuantumPp).toBeCloseTo(100 / 30, 4);
  });

  it("carries NO coordinate anywhere: it is GPS-free at the FILE level", () => {
    for (const s of SYNTHETIC) {
      for (const row of s.rows) {
        expect(row.lat).toBeNull();
        expect(row.lon).toBeNull();
      }
    }
  });

  it("the pipeline RUNS on it — but the false alarms are the price of the lead time", () => {
    const partition = scorePredictiveCorpus(SYNTHETIC_SESSIONS);
    const lead = partition.report.leadTime!;

    // The pipeline works end-to-end on data that contains the phenomenon it was built for.
    // THIS IS NOT AN ACCEPTANCE PASS — the ramps were DRAWN long enough that a 2 s lead is
    // available, so this measures "can the detector find a ramp we drew?" and nothing else.
    expect(lead.predictedCount).toBe(30);
    expect(lead.medianLeadMs).toBeGreaterThanOrEqual(PREDICTIVE_LEAD_TIME_TARGET_MS);

    // ...and it buys that lead by firing on EVERY deep near-miss. That is not a defect; it is
    // the physics. Before the bottom of the ramp, a deep near-miss and a true failsafe are the
    // same signal, and no causal predictor can separate them. So even on the corpus drawn to be
    // findable, the false-alarm rate is FAR above the M56 ceiling of 0.000, and the experiment
    // stays research-only on its own most favourable data.
    const deep = partition.falseAlarmsByBucket.find((b) => b.bucket === "deep")!;
    expect(deep.falseAlarms).toBe(deep.negatives);
    expect(partition.predictiveFpRate.value).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The frozen artifact — anti-drift
// ---------------------------------------------------------------------------

describe("M59 artifact — data/ml/model-eval-m59.json reproduces EXACTLY", () => {
  const checkedIn = readFileSync(path.join(REPO_ROOT, "data/ml/model-eval-m59.json"), "utf8");
  const artifact = JSON.parse(checkedIn) as PredictiveEvalArtifact;

  const rebuilt = evaluatePredictor({
    realSessions: REAL_SESSIONS,
    realManifestVersion: MANIFEST.version,
    realFingerprint: BASELINE.corpus.fingerprint,
    syntheticSessions: SYNTHETIC_SESSIONS,
    syntheticFingerprint: fingerprintSyntheticCorpus(SYNTHETIC),
    gateBaseline: {
      baselineFpRate: BASELINE.gateBaseline.baselineFpRate,
      baselineRecall: BASELINE.gateBaseline.baselineRecall,
      fpCeilingClearable: BASELINE.gateBaseline.fpCeilingClearable,
    },
  });

  it("is byte-identical to a fresh evaluation (change anything ⇒ re-freeze consciously)", () => {
    expect(serializePredictiveEvalArtifact(rebuilt)).toBe(checkedIn);
  });

  it("records the VERDICT: M59's acceptance is NOT MET on the real corpus", () => {
    // ***** THE VERDICT, pinned. *****
    expect(artifact.acceptance.acceptanceMetOnRealCorpus).toBe(false);
    expect(artifact.acceptance.meetsLeadTimeTarget).toBe(false);
    // `null`, not 0: ZERO creditable predictions, so there is no median to take.
    expect(artifact.acceptance.measuredMedianLeadMs).toBeNull();
    expect(artifact.acceptance.creditablePredictions).toBe(0);
    expect(artifact.acceptance.lateDetections + artifact.acceptance.missedEvents).toBe(17);
    expect(artifact.acceptance.targetLeadMs).toBe(2000);
    expect(artifact.acceptance.oracleMedianLeadMs).toBe(0);
    expect(artifact.acceptance.oracleMaxLeadMs).toBe(MEASURED_MAX_FIXTURE_LEAD_MS);
    expect(artifact.acceptance.targetReachableOnRealCorpus).toBe(false);

    // BOTH halves fail, INDEPENDENTLY. The lead-time failure is the substantive one and does
    // not lean on the FP ceiling being unclearable — even with a reachable ceiling, M59 would
    // still fail on 0 ms of lead.
    expect(artifact.acceptance.clearsFpCeiling).toBe(false);
    expect(artifact.acceptance.fpCeilingClearable).toBe(false);
  });

  it("carries the honesty header, including the synthetic-corpus disclaimer", () => {
    expect(artifact.honesty.indicativeNotAGatePass).toBe(true);
    expect(artifact.honesty.syntheticCorpusNotFieldEvidence).toBe(true);
    expect(artifact.honesty.syntheticCorpusIsAcceptanceEvidence).toBe(false);
    expect(artifact.honesty.d21Met).toBe(false);
    expect(artifact.honesty.notes.join(" ")).toContain("NOT MET");
  });

  it("keeps the two corpora separate, with separate fingerprints", () => {
    expect(artifact.corpora.real.fingerprint).toBe(BASELINE.corpus.fingerprint);
    expect(artifact.corpora.synthetic.fingerprint).not.toBe(artifact.corpora.real.fingerprint);
    expect(artifact.realCorpus.sessionCount).toBe(36);
    expect(artifact.syntheticCorpus.sessionCount).toBe(72);
  });

  it("does not touch the frozen M56/M58 artifacts", () => {
    // M59 inherits the frozen gate and the frozen event set. It does not get to move them.
    expect(BASELINE.gateBaseline.baselineFpRate).toBe(0);
    expect(BASELINE.gateBaseline.baselineRecall).toBe(1);
    expect(BASELINE.corpus.failsafeEventCount).toBe(17);
  });
});
