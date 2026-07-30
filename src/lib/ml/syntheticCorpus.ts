/**
 * M59 track (b) — the **SYNTHETIC** degradation corpus.
 *
 * ## ⚠ READ THIS BEFORE YOU READ A NUMBER PRODUCED FROM IT
 * **This corpus is not evidence of field performance, and no number measured against it is
 * an M59 acceptance pass.**
 *
 * It was authored *alongside* the predictor it is used to exercise. That makes every score
 * it produces an answer to the question **"can the detector find a ramp we drew?"** — not
 * to the question **"can the detector predict a real failsafe?"**. The first question is
 * about this file. The second is about the world, and this file cannot speak to it. M59's
 * real acceptance is measured on the **real** corpus, where it is **UNMET** (median lead
 * 0 ms against a 2000 ms target — see `predictive.ts::measureCorpusLeadCeiling`), and it
 * stays unmet until real field sessions containing genuine degradation exist.
 *
 * This is not boilerplate hedging. It is the single most important fact about this module,
 * it is carried in the generated manifest (`synthetic: true`, `notFieldEvidence: true`), it
 * is carried in the eval artifact, and it is stated in the UI that renders the result.
 *
 * ## Then why does it exist?
 * Because a pipeline that has never seen a positive example is a pipeline nobody has tested.
 * The real corpus contains **zero** sessions with a degradation ramp, so on the real corpus
 * the predictor's *entire* observable behaviour is "it does not fire early" — which is
 * indistinguishable from "it is broken". The synthetic corpus separates those two: it shows
 * the predictor **does** fire, **does** produce lead time, and **does** false-alarm, when
 * given data that contains the phenomenon it was built for. It exercises the code. It does
 * not grade it.
 *
 * The milestone doc sanctions exactly this, and constrains it: the Simulator "can synthesize
 * labeled fixtures to seed the M56 evaluation harness before enough real sessions accrue",
 * and any resulting number is "indicative only".
 *
 * ## WHAT I DREW — the generator's assumptions ARE the result, so here they are
 * Choosing what a "genuine degradation ramp" looks like is choosing the answer. Every
 * assumption below is a decision I made, and a reader is entitled to disagree with each one
 * and discount the synthetic numbers accordingly:
 *
 *  1. **A failsafe is preceded by a monotone collapse of a single latent link margin.** One
 *     hidden variable `p ∈ [0, 1]` (0 = healthy, 1 = link gone) drives link quality, RSSI
 *     **and** SNR together. This is the physics of *flying out of range* or *into an
 *     obstruction*. It is emphatically **not** the physics of a connector that vibrates
 *     loose, of RF interference, of a brownout, or of a firmware fault — all of which can
 *     kill a link **instantly**, with no ramp at all. The real corpus's `wiring` class is
 *     exactly that instantaneous kind, and **the generator does not draw it**. A predictor
 *     scored only on this corpus is being scored on the one failure mode that is
 *     predictable **by assumption**.
 *  2. **The ramp lasts {@link RAMP_MIN_MS}–{@link RAMP_MAX_MS} (1.6–8 s).** Long enough that
 *     a 2-second lead is *available*. I chose that. If real degradation ramps are 300 ms,
 *     every lead-time number here is fiction.
 *  3. **The collapse is smooth** — a power law `p = (elapsed/duration)^gamma`, with `gamma`
 *     drawn in `[0.8, 2.0]` so both accelerating and decelerating collapses appear. Real
 *     links are lumpier.
 *  4. **Noise is small, symmetric, and stationary** (±1–3 % LQ, ±0.5–2 dB RSSI). Real
 *     telemetry has dropouts, bursts, and heteroscedastic noise. This corpus is *cleaner*
 *     than reality, which flatters any detector run on it.
 *  5. **TX power and packet rate are held constant** through the collapse. A real radio may
 *     ramp TX power as the link erodes — a *free* precursor signal. Deliberately withheld:
 *     handing the predictor a signal I invented would be handing it the answer.
 *  6. **One event per positive session.** Lead-time attribution is then unambiguous.
 *
 * ## The near-miss negatives are the point, and they are drawn to be UNFAIR to the predictor
 * A false-alarm rate measured against easy negatives (a clean cruise) is decoration. So the
 * negatives here are **near-misses**: sessions that decay along **the same ramp family as
 * the positives**, from the same distribution of durations, shapes, and noise — and then
 * **recover** instead of dying.
 *
 * The consequence is deliberate and it is worth stating in advance of any measurement,
 * because it is a *prediction of the design* rather than an excuse made after the fact:
 * **before the bottom of the ramp, a near-miss and a positive are the same signal.** A
 * predictor that fires 2 seconds before a positive's failsafe has, at that instant, no
 * information whatsoever that distinguishes it from a deep near-miss — because there is
 * none in the data. **Lead time and false alarms on confusable negatives are therefore in
 * direct, physical tension, and any predictor that buys one buys the other.** The deep band
 * below exists to make that tension *measurable* instead of hideable.
 *
 * Near-misses are drawn across three depth bands (see {@link NEAR_MISS_BANDS}) so the eval
 * can report **where** the false alarms come from, rather than averaging the honest ones
 * away against the easy ones.
 *
 * ## Physically separate from the real corpus, and structurally unable to be confused with it
 *  - It lives in its **own directory** (`data/fixtures/ml-synthetic/`), never in
 *    `data/fixtures/diagnostics/`.
 *  - It has its **own manifest** with its **own schema** — `synthetic-manifest.json` carries
 *    `synthetic: true` and `notFieldEvidence: true`, which the real manifest does not have
 *    and could not acquire by accident.
 *  - It has its **own fingerprint** ({@link fingerprintSyntheticCorpus}), and
 *    `tests/unit/ml/predictive.test.ts` asserts it differs from the real corpus's and that
 *    the real corpus's frozen fingerprint in `data/ml/baseline-v20.json` is **unchanged**.
 *  - Its sessions are a **distinct type** ({@link SyntheticSession}), which is *not*
 *    structurally assignable to `BaselineFixture` — it has no `expectClean` and no
 *    `expectedFindings` — so a synthetic session cannot be handed to `characterizeBaselines`
 *    or folded into the real corpus without a deliberate, visible conversion.
 *  - Every session id is prefixed `synthetic/`, so it is unmistakable in any output.
 *  - And it is **wired in**: `scripts/build-ml-synthetic.ts` writes it, the M59 eval reads it,
 *    and the unit suite regenerates it. It is not another orphan like
 *    `data/fixtures/diagnostics/patterns/`.
 *
 * ## Determinism
 * Seeded by {@link import("./rng").createRng} alone — no clock, no `Math.random`, no I/O.
 * The same seed produces **byte-identical** CSVs and a byte-identical manifest, which the
 * test suite asserts by regenerating the corpus and deep-equalling it against the checked-in
 * files.
 */

import type { ParsedLog } from "@/lib/blackbox";
import { parsedLogFromTelemetryRows } from "@/lib/omnilog";
import {
  telemetrySessionToCsv,
  type TelemetrySessionCsvRow,
} from "@/lib/telemetry-session-csv";
import { createRng, DEFAULT_SEED } from "./rng";
import { round6 } from "./stats";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Semantic version of the synthetic corpus + its manifest. Bump on any breaking change. */
export const SYNTHETIC_CORPUS_SCHEMA_VERSION = "1.0.0";

/** Where the corpus is checked in. **Never** `data/fixtures/diagnostics/`. */
export const SYNTHETIC_CORPUS_DIR = "data/fixtures/ml-synthetic";

/** The corpus's own manifest, distinct in name and schema from the real one. */
export const SYNTHETIC_MANIFEST_FILE = "synthetic-manifest.json";

/** Telemetry cadence: 40 ms (25 Hz), the canonical rate the real fixtures use. */
export const SYNTHETIC_CADENCE_MS = 40;

// ---------------------------------------------------------------------------
// The three session classes
// ---------------------------------------------------------------------------

/**
 * - `ramp` — **positive**: a monotone link-margin collapse into a genuine failsafe
 *   (LQ pinned at 0 for ≥ 2 samples, so the frozen `findFailsafeOnsetIndices` rule fires).
 * - `nearMiss` — **negative**: the same ramp family, decaying to a floor and then recovering.
 *   **Never** failsafes. These are the negatives the false-alarm rate that matters is over.
 * - `steady` — **negative**: a clean cruise. The easy negatives, reported separately so they
 *   cannot dilute the honest number.
 */
export type SyntheticClass = "ramp" | "nearMiss" | "steady";

/** Positive sessions (ramp → failsafe). */
export const SYNTHETIC_RAMP_COUNT = 30;

/** Near-miss negatives (ramp → recover). The FP denominator that matters. */
export const SYNTHETIC_NEAR_MISS_COUNT = 30;

/** Clean-cruise negatives. The easy FP denominator, reported separately. */
export const SYNTHETIC_STEADY_COUNT = 12;

/**
 * Near-miss **depth bands**, by the link quality the decay bottoms out at before recovering.
 *
 * The bands exist so the eval can say **where** the false alarms come from instead of
 * averaging a hard case against an easy one:
 *  - `shallow` (LQ 40–55) — a dip to a warning level and back. This is the shape the **real**
 *    corpus's 7 `warning` fixtures have, so it is the one band with a real-world referent.
 *  - `moderate` (LQ 18–38) — a serious sag.
 *  - `deep` (LQ 2–15) — **the link very nearly died and then came back.** These are the
 *    genuinely confusable negatives. Two seconds before the bottom, a `deep` near-miss and a
 *    `ramp` positive are *the same signal* — there is no information in the telemetry that
 *    separates them, and a predictor with real lead time **must** fire on both. Any predictor
 *    that does not is not predicting; it is peeking at the future.
 *
 * 10 sessions per band. Drawn to be hard on purpose: an FP rate measured only against easy
 * negatives would be a number engineered to look good.
 */
export const NEAR_MISS_BANDS = [
  { band: "shallow", count: 10, floorLqMin: 40, floorLqMax: 55 },
  { band: "moderate", count: 10, floorLqMin: 18, floorLqMax: 38 },
  { band: "deep", count: 10, floorLqMin: 2, floorLqMax: 15 },
] as const;

/** One near-miss depth band. */
export type NearMissBand = (typeof NEAR_MISS_BANDS)[number]["band"];

// ---------------------------------------------------------------------------
// Frozen draw ranges — assumption #2 and #3 of the module header, as numbers
// ---------------------------------------------------------------------------

/** Shortest degradation ramp drawn: **1600 ms** (40 samples). Below M59's 2 s target. */
export const RAMP_MIN_MS = 1_600;

/** Longest degradation ramp drawn: **8000 ms** (200 samples). */
export const RAMP_MAX_MS = 8_000;

/** RSSI (dBm) the latent margin drives the link to at full collapse (`p = 1`). */
const COLLAPSE_RSSI_DBM = -112;

/** SNR (dB) at full collapse. */
const COLLAPSE_SNR_DB = -8;

/** The canonical TX-power ladder steps the generator may draw from (mW). */
const TX_POWER_CHOICES = [50, 100, 250, 500] as const;

/** The canonical packet-rate steps the generator may draw from (Hz). */
const PACKET_RATE_CHOICES = [50, 150, 250, 500] as const;

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

/**
 * One generated session. **Structurally NOT a `BaselineFixture`** — no `expectClean`, no
 * `expectedFindings` — so it cannot be folded into the real corpus without a deliberate,
 * visible conversion that a reviewer would see. That is the point.
 */
export interface SyntheticSession {
  /** Always `true`. A literal type: there is no synthetic session that claims to be real. */
  synthetic: true;
  /** Corpus-local key, always prefixed `synthetic/`. Never a user identifier. */
  sessionId: string;
  /** Path within {@link SYNTHETIC_CORPUS_DIR}. */
  file: string;
  cls: SyntheticClass;
  /** The depth band, for a `nearMiss`; `null` otherwise. */
  band: NearMissBand | null;
  /** Ground truth: does this session contain a failsafe? `true` only for `ramp`. */
  failsafe: boolean;
  /** The draw that produced it — every knob, recorded, so the session is auditable. */
  params: SyntheticParams;
  /** The rows, ready to serialize. */
  rows: TelemetrySessionCsvRow[];
}

/** Every parameter one session was drawn with. Numbers only; zero identifiers. */
export interface SyntheticParams {
  sampleCount: number;
  cruiseLq: number;
  cruiseRssiDbm: number;
  cruiseSnrDb: number;
  txPowerMw: number;
  packetRateHz: number;
  /** Sample index the collapse begins at. */
  rampStartIndex: number;
  /** Ramp duration in samples. */
  rampSamples: number;
  /** Power-law exponent of the collapse (`< 1` decelerating, `> 1` accelerating). */
  gamma: number;
  /** Peak latent collapse `p`. **1.0** for a `ramp`; `< 1` for a `nearMiss`. */
  pMax: number;
  /** The LQ a `nearMiss` bottoms out at; `0` for a `ramp`. */
  floorLq: number;
  /** Samples LQ is held at 0 (a `ramp`), or at the floor (a `nearMiss`). */
  holdSamples: number;
  /** Samples the recovery back to cruise takes (a `nearMiss`); `0` for a `ramp`. */
  recoverySamples: number;
  lqNoise: number;
  rssiNoiseDb: number;
}

// ---------------------------------------------------------------------------
// Seeded draws
// ---------------------------------------------------------------------------

/** Uniform in `[lo, hi)`. */
function uniform(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Uniform integer in `[lo, hi]`. */
function uniformInt(rng: () => number, lo: number, hi: number): number {
  return Math.floor(uniform(rng, lo, hi + 1));
}

/** Pick one element. Consumes exactly one draw. */
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/**
 * Symmetric, zero-mean noise in `[-amp, +amp]`, triangular (the sum of two uniforms) so it
 * is bell-ish rather than flat without needing a Box–Muller transform's unbounded tails —
 * an unbounded tail could push a near-miss's link quality to 0 and turn a *negative* into a
 * failsafe, silently corrupting the ground truth. Bounded noise cannot. Consumes 2 draws.
 */
function noise(rng: () => number, amp: number): number {
  return (rng() + rng() - 1) * amp;
}

// ---------------------------------------------------------------------------
// The latent collapse
// ---------------------------------------------------------------------------

/**
 * The latent link-margin collapse `p(i) ∈ [0, pMax]` at sample `i` — **assumption #1 of the
 * module header, as code**. One hidden variable drives link quality, RSSI and SNR together.
 *
 * Phases: cruise (`p = 0`) → ramp (`p` rises as a power law to `pMax`) → hold (`p = pMax`) →
 * recovery (`p` falls linearly back to 0; a `ramp` positive has no recovery) → cruise.
 */
function latentCollapse(i: number, p: SyntheticParams): number {
  const rampEnd = p.rampStartIndex + p.rampSamples;
  const holdEnd = rampEnd + p.holdSamples;
  const recoveryEnd = holdEnd + p.recoverySamples;

  if (i < p.rampStartIndex) return 0;
  if (i < rampEnd) {
    const progress = (i - p.rampStartIndex) / p.rampSamples;
    return p.pMax * Math.pow(progress, p.gamma);
  }
  if (i < holdEnd) return p.pMax;
  if (p.recoverySamples > 0 && i < recoveryEnd) {
    const progress = (i - holdEnd) / p.recoverySamples;
    return p.pMax * (1 - progress);
  }
  return p.recoverySamples > 0 ? 0 : p.pMax;
}

/**
 * Render one session's rows from its parameters + a noise stream.
 *
 * ## The one hard invariant, enforced here rather than hoped for
 * A `nearMiss` **must not failsafe**, or the ground truth is corrupt and every FP number
 * computed from this corpus is meaningless. Link quality on a non-`ramp` session is
 * therefore **clamped to ≥ 1**, which makes a `lq <= 0` run — and hence a
 * `findFailsafeOnsetIndices` onset — *unreachable by construction*, not merely unlikely.
 * The generator additionally verifies it (see {@link generateSyntheticCorpus}), so a future
 * change to the noise model cannot quietly turn a negative into a positive.
 *
 * GPS is `null` on every row: there is no `lat`/`lon` anywhere in this corpus, so it is
 * coordinate-free at the **file** level and not merely at the feature level.
 */
function renderRows(params: SyntheticParams, isRamp: boolean, rng: () => number): TelemetrySessionCsvRow[] {
  const rows: TelemetrySessionCsvRow[] = [];

  for (let i = 0; i < params.sampleCount; i++) {
    const p = latentCollapse(i, params);

    // Link quality: cruise level scaled down by the collapse. At p = 1 it is exactly 0,
    // which is what makes a `ramp` a real failsafe under the frozen onset rule.
    //
    // ## LQ noise is scaled by the surviving margin `(1 − p)`, and this is load-bearing
    // Link quality is a **packet-success ratio**. A link that is gone delivers no packets, so
    // its LQ is *exactly* 0 — not "0 ± 2". Full-amplitude noise at the bottom of the collapse
    // would make LQ chatter 0 → 2 → 0, which under the frozen `lq <= 0 for >= 2 samples` onset
    // rule shatters ONE failsafe into several, and the ground truth the whole corpus rests on
    // becomes a fiction. The generator's own `assertGroundTruth` check caught exactly that and
    // refused to emit the corpus; this is the fix, and it is the physically correct model
    // rather than a patch to satisfy the check.
    //
    // RSSI noise is deliberately NOT scaled: RSSI is a *receiver measurement*, and a receiver
    // hearing nothing still reports a jittering noise floor. The two channels are noisy in
    // different ways because they are different kinds of quantity.
    const lqRaw = params.cruiseLq * (1 - p) + noise(rng, params.lqNoise * (1 - p));
    const lq = isRamp
      ? Math.max(0, Math.min(100, Math.round(lqRaw)))
      : // A negative can never reach 0 — see the docblock. This clamp IS the ground truth.
        Math.max(1, Math.min(100, Math.round(lqRaw)));

    // RSSI: linear in the same latent margin, from cruise to the collapse floor.
    const rssiRaw =
      params.cruiseRssiDbm + p * (COLLAPSE_RSSI_DBM - params.cruiseRssiDbm) + noise(rng, params.rssiNoiseDb);
    const rssi1 = Math.round(rssiRaw);
    // The diversity antenna: a small, stable per-session offset, not a second failure mode.
    const rssi2 = Math.round(rssiRaw - 2 + noise(rng, params.rssiNoiseDb));

    const snrRaw = params.cruiseSnrDb + p * (COLLAPSE_SNR_DB - params.cruiseSnrDb) + noise(rng, 0.4);

    rows.push({
      ts: i * SYNTHETIC_CADENCE_MS,
      rssi1,
      rssi2,
      linkQuality: lq,
      snr: round6(Math.round(snrRaw * 10) / 10),
      // Held constant through the collapse — assumption #5. No invented precursor.
      txPower: params.txPowerMw,
      packetRate: params.packetRateHz,
      lat: null,
      lon: null,
      alt: null,
      sats: null,
      groundSpeed: null,
      heading: null,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Drawing a session
// ---------------------------------------------------------------------------

/** Draw the parameters shared by every class. */
function drawCommon(rng: () => number): Omit<
  SyntheticParams,
  "sampleCount" | "rampStartIndex" | "rampSamples" | "gamma" | "pMax" | "floorLq" | "holdSamples" | "recoverySamples"
> {
  return {
    cruiseLq: uniformInt(rng, 88, 98),
    cruiseRssiDbm: uniformInt(rng, -80, -55),
    cruiseSnrDb: round6(uniform(rng, 4, 10)),
    txPowerMw: pick(rng, TX_POWER_CHOICES),
    packetRateHz: pick(rng, PACKET_RATE_CHOICES),
    lqNoise: round6(uniform(rng, 1, 3)),
    rssiNoiseDb: round6(uniform(rng, 0.5, 2)),
  };
}

/** Ramp duration in samples, drawn from the frozen `[RAMP_MIN_MS, RAMP_MAX_MS]` range. */
function drawRampSamples(rng: () => number): number {
  const ms = uniform(rng, RAMP_MIN_MS, RAMP_MAX_MS);
  return Math.max(2, Math.round(ms / SYNTHETIC_CADENCE_MS));
}

/** A `ramp` positive: collapse to a genuine failsafe and stay there. */
function drawRamp(rng: () => number, n: number): SyntheticSession {
  const common = drawCommon(rng);
  const rampSamples = drawRampSamples(rng);
  const cruiseSamples = uniformInt(rng, 40, 90);
  const holdSamples = uniformInt(rng, 6, 20);
  const tailSamples = uniformInt(rng, 10, 30);

  const params: SyntheticParams = {
    ...common,
    sampleCount: cruiseSamples + rampSamples + holdSamples + tailSamples,
    rampStartIndex: cruiseSamples,
    rampSamples,
    gamma: round6(uniform(rng, 0.8, 2.0)),
    pMax: 1,
    floorLq: 0,
    holdSamples: holdSamples + tailSamples,
    recoverySamples: 0,
  };

  const idx = String(n).padStart(2, "0");
  return {
    synthetic: true,
    sessionId: `synthetic/ramp/ramp-${idx}.csv`,
    file: `ramp/ramp-${idx}.csv`,
    cls: "ramp",
    band: null,
    failsafe: true,
    params,
    rows: renderRows(params, true, rng),
  };
}

/**
 * A `nearMiss` negative: **the same ramp family**, bottoming out at `floorLq` and recovering.
 *
 * The ramp duration, shape, noise and cruise level are drawn from **the identical
 * distributions** the positives use. That is what makes the negatives confusable, and it is
 * the entire reason this class exists.
 */
function drawNearMiss(
  rng: () => number,
  n: number,
  band: NearMissBand,
  floorLqMin: number,
  floorLqMax: number
): SyntheticSession {
  const common = drawCommon(rng);
  const rampSamples = drawRampSamples(rng);
  const cruiseSamples = uniformInt(rng, 40, 90);
  const holdSamples = uniformInt(rng, 4, 14);
  const recoverySamples = uniformInt(rng, 25, 70);
  const tailSamples = uniformInt(rng, 20, 50);
  const floorLq = uniformInt(rng, floorLqMin, floorLqMax);

  // The latent collapse depth that lands link quality on `floorLq`: lq = cruiseLq · (1 − p).
  const pMax = round6(Math.max(0, Math.min(0.99, 1 - floorLq / common.cruiseLq)));

  const params: SyntheticParams = {
    ...common,
    sampleCount: cruiseSamples + rampSamples + holdSamples + recoverySamples + tailSamples,
    rampStartIndex: cruiseSamples,
    rampSamples,
    gamma: round6(uniform(rng, 0.8, 2.0)),
    pMax,
    floorLq,
    holdSamples,
    recoverySamples,
  };

  const idx = String(n).padStart(2, "0");
  return {
    synthetic: true,
    sessionId: `synthetic/near-miss/near-miss-${band}-${idx}.csv`,
    file: `near-miss/near-miss-${band}-${idx}.csv`,
    cls: "nearMiss",
    band,
    failsafe: false,
    params,
    rows: renderRows(params, false, rng),
  };
}

/** A `steady` negative: a clean cruise, no collapse at all. */
function drawSteady(rng: () => number, n: number): SyntheticSession {
  const common = drawCommon(rng);
  const params: SyntheticParams = {
    ...common,
    sampleCount: uniformInt(rng, 200, 380),
    rampStartIndex: Number.MAX_SAFE_INTEGER, // never reached ⇒ p is 0 everywhere
    rampSamples: 1,
    gamma: 1,
    pMax: 0,
    floorLq: 0,
    holdSamples: 0,
    recoverySamples: 0,
  };

  const idx = String(n).padStart(2, "0");
  return {
    synthetic: true,
    sessionId: `synthetic/steady/steady-${idx}.csv`,
    file: `steady/steady-${idx}.csv`,
    cls: "steady",
    band: null,
    failsafe: false,
    params,
    rows: renderRows(params, false, rng),
  };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** Thrown when the generator produces a corpus that violates its own ground truth. */
export class SyntheticCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyntheticCorpusError";
  }
}

/**
 * Generate the whole corpus. **Seeded and deterministic**: the same seed yields
 * byte-identical rows, in a fixed class order (`ramp` → `nearMiss` by band → `steady`) from a
 * **single** RNG stream, so the corpus is reproducible as a whole and not merely per session.
 *
 * @throws {SyntheticCorpusError} if a `nearMiss` or `steady` session would contain a failsafe,
 *   or a `ramp` session would not. The ground truth is verified, not assumed — see
 *   `assertGroundTruth` below.
 */
export function generateSyntheticCorpus(seed: number = DEFAULT_SEED): SyntheticSession[] {
  const rng = createRng(seed);
  const sessions: SyntheticSession[] = [];

  for (let i = 1; i <= SYNTHETIC_RAMP_COUNT; i++) sessions.push(drawRamp(rng, i));
  for (const { band, count, floorLqMin, floorLqMax } of NEAR_MISS_BANDS) {
    for (let i = 1; i <= count; i++) {
      sessions.push(drawNearMiss(rng, i, band, floorLqMin, floorLqMax));
    }
  }
  for (let i = 1; i <= SYNTHETIC_STEADY_COUNT; i++) sessions.push(drawSteady(rng, i));

  return sessions;
}

/** Parse a generated session back into the `ParsedLog` every other module consumes. */
export function syntheticLog(session: SyntheticSession): ParsedLog {
  return parsedLogFromTelemetryRows(session.rows);
}

/** Serialize one session to its CSV bytes — via the **existing** M11 writer, not a new one. */
export function syntheticSessionToCsv(session: SyntheticSession): string {
  return `${telemetrySessionToCsv(session.rows)}\n`;
}

// ---------------------------------------------------------------------------
// Fingerprint — its own, and provably not the real corpus's
// ---------------------------------------------------------------------------

/** One 32-bit FNV-1a lane. Mirrors `baseline.ts` — the same hash, over a different corpus. */
function fnv1a(text: string, offsetBasis: number, prime: number): number {
  let h = offsetBasis | 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, prime);
  }
  return h >>> 0;
}

/** Zero-padded 8-hex-digit rendering of a uint32. */
function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/**
 * A 64-bit content fingerprint of the synthetic corpus, in the same 16-hex-digit format
 * `baseline.ts::fingerprintCorpus` produces — so the two are directly comparable, and
 * `tests/unit/ml/predictive.test.ts` asserts they are **different**, and that the real
 * corpus's frozen fingerprint has not moved.
 *
 * Deliberately **not** the same function: `fingerprintCorpus` takes `BaselineFixture[]`, and
 * making a synthetic session fit that type is exactly the coercion this module exists to
 * prevent. The hash is shared; the input type is not.
 */
export function fingerprintSyntheticCorpus(sessions: readonly SyntheticSession[]): string {
  const ordered = [...sessions].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const parts: string[] = [`synthetic:${SYNTHETIC_CORPUS_SCHEMA_VERSION}:${ordered.length}`];
  for (const s of ordered) {
    parts.push(`${s.file}|${s.cls}|${s.band ?? "-"}|${s.failsafe ? 1 : 0}`);
    for (const r of s.rows) {
      parts.push(`${r.ts},${r.rssi1},${r.rssi2},${r.linkQuality},${r.snr},${r.txPower},${r.packetRate}`);
    }
  }
  const text = parts.join("\n");
  return `${hex8(fnv1a(text, 0x811c9dc5, 0x01000193))}${hex8(fnv1a(text, 0x7fffffff, 0x85ebca6b))}`;
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One session's manifest entry. */
export interface SyntheticManifestEntry {
  file: string;
  sessionId: string;
  cls: SyntheticClass;
  band: NearMissBand | null;
  /** Ground truth: does this session contain a failsafe onset? */
  failsafe: boolean;
  sampleCount: number;
  /** The draw. Numbers only — the session is fully auditable from its manifest entry. */
  params: SyntheticParams;
}

/**
 * The synthetic corpus manifest. Its **schema is deliberately not the real manifest's**: it
 * has no `expectClean`, no `expectedFindings`, and no `label` — and it has `synthetic` and
 * `notFieldEvidence`, which the real one does not. A loader written for one cannot silently
 * consume the other.
 */
export interface SyntheticManifest {
  schemaVersion: string;
  /** `true`. A literal. */
  synthetic: true;
  /** `true`. **No number measured against this corpus is evidence of field performance.** */
  notFieldEvidence: true;
  /** `false`. **No number measured against this corpus is an M59 acceptance pass.** */
  isAcceptanceEvidence: false;
  /** The warning, carried in the data so it travels with any copy of it. */
  warning: string[];
  generator: {
    module: string;
    seed: number;
    /** Every assumption the generator makes, as data. See the module header. */
    assumptions: string[];
  };
  /** 64-bit content fingerprint. Provably different from the real corpus's. */
  fingerprint: string;
  counts: {
    total: number;
    ramp: number;
    nearMiss: number;
    steady: number;
    /** Sessions with no failsafe — the false-alarm denominator. */
    negatives: number;
    /** `100 / negatives` — the smallest step the synthetic FP rate can move by. */
    fpRateQuantumPp: number;
    /** The same, over the near-miss negatives alone: the number that actually matters. */
    nearMissFpRateQuantumPp: number;
    byBand: Record<string, number>;
  };
  sessions: SyntheticManifestEntry[];
}

/**
 * Verify the generated corpus satisfies its own ground truth, using the **frozen** onset rule
 * (`baseline.ts::findFailsafeOnsetIndices`) — the app's own definition of "the link was gone",
 * not a second one invented here.
 *
 * This is not a defensive flourish. If a `nearMiss` contained a failsafe, it would be a
 * positive mislabelled as a negative, and **every false-alarm number this corpus produces
 * would be wrong in the flattering direction**. The check runs at generation time and the
 * generator throws rather than emit a corpus it cannot vouch for.
 *
 * `onsetsOf` is injected to keep this module free of a cycle through `baseline.ts`.
 */
export function assertGroundTruth(
  sessions: readonly SyntheticSession[],
  onsetsOf: (log: ParsedLog) => number[]
): void {
  for (const s of sessions) {
    const onsets = onsetsOf(syntheticLog(s));
    if (s.failsafe && onsets.length !== 1) {
      throw new SyntheticCorpusError(
        `${s.sessionId}: a 'ramp' positive must contain exactly 1 failsafe onset, found ${onsets.length}`
      );
    }
    if (!s.failsafe && onsets.length !== 0) {
      throw new SyntheticCorpusError(
        `${s.sessionId}: a '${s.cls}' NEGATIVE must contain 0 failsafe onsets, found ${onsets.length}. ` +
          `A mislabelled negative would make every false-alarm number from this corpus wrong, in the flattering direction.`
      );
    }
  }
}

/** Build the manifest for a generated corpus. Pure; no clock, so it is byte-reproducible. */
export function buildSyntheticManifest(
  sessions: readonly SyntheticSession[],
  seed: number = DEFAULT_SEED
): SyntheticManifest {
  const ordered = [...sessions].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const negatives = ordered.filter((s) => !s.failsafe).length;
  const nearMiss = ordered.filter((s) => s.cls === "nearMiss").length;

  const byBand: Record<string, number> = {};
  for (const { band } of NEAR_MISS_BANDS) {
    byBand[band] = ordered.filter((s) => s.band === band).length;
  }

  return {
    schemaVersion: SYNTHETIC_CORPUS_SCHEMA_VERSION,
    synthetic: true,
    notFieldEvidence: true,
    isAcceptanceEvidence: false,
    warning: [
      "SYNTHETIC. Every session in this corpus was DRAWN BY A GENERATOR, alongside the predictor it is used to exercise. It contains no real flight data.",
      "NOT FIELD EVIDENCE. A number measured against this corpus answers 'can the detector find a ramp we drew?', not 'can the detector predict a real failsafe?'. It is INDICATIVE ONLY and is NOT an M59 acceptance pass.",
      "M59's real acceptance is measured on the REAL corpus (data/fixtures/diagnostics/), where it is UNMET: the median lead time available to ANY predictor is 0 ms against a 2000 ms target. See data/ml/model-eval-m59.json -> realCorpus.leadCeiling.",
      "The generator draws exactly ONE failure mode: a smooth, monotone collapse of a single latent link margin (flying out of range). It does NOT draw the instantaneous failures the real 'wiring' fixtures contain, which are unpredictable by construction. A predictor scored here is being scored on the one failure mode that is predictable BY ASSUMPTION.",
      "Do not merge this corpus into data/fixtures/diagnostics/. Do not score it through characterizeBaselines. Its sessions are a distinct type with a distinct manifest schema and a distinct fingerprint, on purpose.",
    ],
    generator: {
      module: "src/lib/ml/syntheticCorpus.ts",
      seed,
      assumptions: [
        "A failsafe is preceded by a MONOTONE collapse of a single latent link margin driving LQ, RSSI and SNR together. This is the physics of flying out of range. It is NOT the physics of a loose connector, RF interference, a brownout, or a firmware fault - all of which kill a link INSTANTLY. The real corpus's 'wiring' class is exactly that instantaneous kind, and this generator does not draw it.",
        `The collapse ramp lasts ${RAMP_MIN_MS}-${RAMP_MAX_MS} ms. This choice ALONE is what makes a 2000 ms lead time available at all. If real degradation ramps are 300 ms, every lead-time number measured here is fiction.`,
        "The collapse is smooth: a power law p = (elapsed/duration)^gamma, gamma in [0.8, 2.0]. Real links are lumpier.",
        "Noise is small, symmetric, bounded and stationary (+/-1-3 % LQ, +/-0.5-2 dB RSSI). Real telemetry has dropouts, bursts, and heteroscedastic noise. This corpus is CLEANER than reality, which flatters any detector run on it.",
        "TX power and packet rate are held CONSTANT through the collapse. A real radio may ramp TX power as the link erodes, which would be a free precursor signal. It is deliberately withheld: handing the predictor a signal the generator invented would be handing it the answer.",
        "One failsafe event per positive session, so lead-time attribution is unambiguous.",
        "The near-miss negatives are drawn from the SAME ramp family as the positives - same duration, shape and noise distributions - and differ ONLY in what happens after the bottom. Before the bottom, a deep near-miss and a positive are THE SAME SIGNAL. Lead time and false alarms on confusable negatives are therefore in direct physical tension, and any predictor that buys one buys the other.",
      ],
    },
    fingerprint: fingerprintSyntheticCorpus(ordered),
    counts: {
      total: ordered.length,
      ramp: ordered.filter((s) => s.cls === "ramp").length,
      nearMiss,
      steady: ordered.filter((s) => s.cls === "steady").length,
      negatives,
      fpRateQuantumPp: negatives > 0 ? round6(100 / negatives) : 0,
      nearMissFpRateQuantumPp: nearMiss > 0 ? round6(100 / nearMiss) : 0,
      byBand,
    },
    sessions: ordered.map((s) => ({
      file: s.file,
      sessionId: s.sessionId,
      cls: s.cls,
      band: s.band,
      failsafe: s.failsafe,
      sampleCount: s.params.sampleCount,
      params: s.params,
    })),
  };
}

/** Serialize the manifest to the exact checked-in bytes: 2-space JSON + a trailing newline. */
export function serializeSyntheticManifest(manifest: SyntheticManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
