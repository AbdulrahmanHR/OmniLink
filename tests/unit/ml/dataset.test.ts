import { describe, expect, it } from "vitest";
import type { LogGpsFix, ParsedLog } from "@/lib/blackbox";
import {
  DEFAULT_SEED,
  DEFAULT_SPLIT_RATIOS,
  FEATURE_COUNT,
  FEATURE_NAMES,
  GPS_FREE_PATTERN_IDS,
  InvalidDatasetError,
  MANIFEST_LABEL_TO_ML_LABEL,
  MIN_LABELED_SESSIONS_PER_CLASS,
  MIN_TEST_SESSIONS_PER_CLASS,
  ML_DATASET_SCHEMA_VERSION,
  ML_LABELS,
  buildDatasetRow,
  createRng,
  extractFeatures,
  shuffled,
  splitDataset,
  toFeatureArray,
  toMlLabel,
  toTrainingRow,
  type DatasetRow,
  type MlLabel,
} from "@/lib/ml";
import { buildLargeSessionLog } from "@/lib/diagnostics";
import { buildLog, loadAllFixtures, loadManifest } from "../diagnostics/fixtures";

/**
 * THE ML DATASET SCHEMA + SPLIT (M56).
 *
 * Mirrors the separation in `tests/unit/knowledgeEval.test.ts` — corpus/dataset
 * INTEGRITY first (is the thing we are about to score even well-formed?), then the
 * behaviour of the machinery that scores it. The load-bearing guards here are:
 *
 *  - **determinism** (invariant #7): same seed ⇒ byte-identical split; same log ⇒
 *    byte-identical feature vector. Without this the M56 gate means nothing.
 *  - **no leakage**: no session may appear in two partitions. A frame-level split
 *    would put near-duplicate 40 ms neighbours in train AND test.
 *  - **zero identifiers**: features are numeric-only and `log.gps` is NEVER read —
 *    proven against a log that actually carries a GPS track, not against the
 *    fixture CSVs (whose lat/lon happen to be blank, which would prove nothing).
 *  - **the degenerate corpus is stated, not dressed up**: the real 36-fixture split
 *    must come back `adequate: false` with the right warnings.
 */

// ---------------------------------------------------------------------------
// The real corpus, loaded once (reuses the M36 fixture loader — no duplicate).
// ---------------------------------------------------------------------------

const fixtures = loadAllFixtures();
const corpus: DatasetRow[] = fixtures.map((f) => buildDatasetRow(f.file, f.label, f.log));

// ---------------------------------------------------------------------------
// Seeded RNG — the determinism substrate everything else rests on.
// ---------------------------------------------------------------------------

describe("seeded RNG", () => {
  it("is a pure function of its seed — same seed, same stream", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const seqA = Array.from({ length: 64 }, () => a());
    const seqB = Array.from({ length: 64 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds give different streams", () => {
    const a = Array.from({ length: 32 }, createRng(1));
    const b = Array.from({ length: 32 }, createRng(2));
    expect(a).not.toEqual(b);
  });

  it("emits floats in [0, 1)", () => {
    const rng = createRng(DEFAULT_SEED);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("shuffles deterministically, permutes rather than loses, and does not mutate", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const once = shuffled(items, createRng(7));
    const twice = shuffled(items, createRng(7));
    expect(once).toEqual(twice);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // input untouched
    expect([...once].sort((x, y) => x - y)).toEqual(items); // a permutation
    expect(once).not.toEqual(items); // ...and actually shuffled
  });

  it("pins the default seed so every reported metric names one split", () => {
    expect(DEFAULT_SEED).toBe(2551);
  });
});

// ---------------------------------------------------------------------------
// Label mapping — total, explicit, never a silent coercion.
// ---------------------------------------------------------------------------

describe("manifest-label → canonical-label mapping", () => {
  it("pins the canonical label union (the v2.0 labels + an explicit `unknown`)", () => {
    expect([...ML_LABELS]).toEqual([
      "healthy",
      "warning",
      "failsafe",
      "wiringSuspicion",
      "antennaSuspicion",
      "unknown",
    ]);
  });

  it("maps every one of the manifest's 5 label strings", () => {
    const manifestLabels = new Set(loadManifest().fixtures.map((f) => f.label));
    expect(manifestLabels.size).toBe(5);
    for (const label of manifestLabels) {
      expect(MANIFEST_LABEL_TO_ML_LABEL[label], `unmapped manifest label: ${label}`).toBeDefined();
      expect(toMlLabel(label)).not.toBe("unknown");
    }
  });

  it("maps the two that are NOT identity — `wiring`/`antenna` gain their 'suspicion'", () => {
    expect(toMlLabel("healthy")).toBe("healthy");
    expect(toMlLabel("warning")).toBe("warning");
    expect(toMlLabel("failsafe")).toBe("failsafe");
    expect(toMlLabel("wiring")).toBe("wiringSuspicion");
    expect(toMlLabel("antenna")).toBe("antennaSuspicion");
  });

  it("sends an UNKNOWN label to `unknown` — never silently into a real class", () => {
    expect(toMlLabel("patterns")).toBe("unknown"); // the orphaned corpus, not a 6th class
    expect(toMlLabel("wiringSuspicion")).toBe("unknown"); // canonical name is not a manifest name
    expect(toMlLabel("")).toBe("unknown");
    expect(toMlLabel("healthy ")).toBe("unknown"); // no trimming, no fuzzy matching
  });

  it("never maps anything into `unknown` by accident — the map's image is the 5 real classes", () => {
    const image = new Set(Object.values(MANIFEST_LABEL_TO_ML_LABEL));
    expect(image.has("unknown")).toBe(false);
    expect(image.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Feature extraction — purity, numeric-only, zero identifiers.
// ---------------------------------------------------------------------------

/** A log with link channels + a heading sweep, and OPTIONALLY a real GPS track. */
function buildLogWithOptionalGps(withGps: boolean): ParsedLog {
  const n = 240;
  const base = buildLog({
    rssi1: Array.from({ length: n }, (_, i) => (i % 60 < 6 ? -104 : -62 + Math.sin(i / 9) * 4)),
    rssi2: Array.from({ length: n }, (_, i) => (i % 60 < 6 ? -101 : -70 + Math.sin(i / 11) * 3)),
    link_quality: Array.from({ length: n }, (_, i) => (i % 60 < 6 ? 8 : 95 + Math.sin(i / 7) * 3)),
    snr: Array.from({ length: n }, (_, i) => (i % 60 < 6 ? -4 : 9 + Math.sin(i / 5) * 2)),
    tx_power: Array.from({ length: n }, (_, i) => (i % 60 < 6 ? 500 : 100)),
    packet_rate: Array.from({ length: n }, (_, i) => (i % 37 === 0 ? 500 : 250)),
    heading: Array.from({ length: n }, (_, i) => (i * 5) % 360),
  });
  if (!withGps) return base;

  // A LOOPING track over a handful of cells: exactly the shape that makes M38's
  // `gps-area-degradation` detector fire. If any GPS-derived signal leaked into a
  // feature, THIS is the log that would expose it.
  const gps: Array<LogGpsFix | null> = Array.from({ length: n }, (_, i) => {
    const cell = i % 6;
    return { lat: 47.3769 + cell * 0.0006, lon: 8.5417 + cell * 0.0006 };
  });
  return { ...base, gps };
}

describe("extractFeatures — purity and determinism", () => {
  it("is deterministic: the same log twice yields a deep-equal vector", () => {
    const log = buildLogWithOptionalGps(false);
    expect(extractFeatures(log)).toEqual(extractFeatures(log));
  });

  it("is deterministic across every real fixture", () => {
    for (const f of fixtures) {
      expect(extractFeatures(f.log), f.file).toEqual(extractFeatures(f.log));
    }
  });

  it("emits exactly the frozen FEATURE_NAMES, in order — index↔name cannot drift", () => {
    const fv = extractFeatures(buildLogWithOptionalGps(false));
    expect(Object.keys(fv)).toEqual([...FEATURE_NAMES]);
    expect(FEATURE_COUNT).toBe(43);
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_COUNT); // no duplicate names
    expect(toFeatureArray(fv)).toHaveLength(FEATURE_COUNT);
    expect(toFeatureArray(fv)).toEqual(FEATURE_NAMES.map((n) => fv[n]));
  });

  it("survives an empty log and a degenerate log without emitting NaN", () => {
    const emptyLog: ParsedLog = {
      source: "omnilog",
      time: [],
      channels: [],
      sampleCount: 0,
      durationMs: 0,
    };
    for (const v of Object.values(extractFeatures(emptyLog))) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // A log whose channels are ALL gaps (the antenna fixtures really do carry
    // blank columns) must also stay finite.
    const gapLog = buildLog({ link_quality: [NaN, NaN, NaN], rssi1: [NaN, NaN, NaN] });
    for (const v of Object.values(extractFeatures(gapLog))) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("extractFeatures — numeric-only, ZERO identifiers", () => {
  it("every feature of every real fixture is a finite number", () => {
    for (const f of fixtures) {
      const fv = extractFeatures(f.log);
      for (const name of FEATURE_NAMES) {
        expect(typeof fv[name], `${f.file}.${name}`).toBe("number");
        expect(Number.isFinite(fv[name]), `${f.file}.${name}`).toBe(true);
      }
    }
  });

  it("EXCLUDES GPS: a log with a real GPS track yields the IDENTICAL vector", () => {
    // The proof. Two logs, identical in every channel; one carries a looping GPS
    // track over a handful of cells. If ANY coordinate — or anything derived from
    // one, including the `gps-area-degradation` pattern flag — reached the feature
    // vector, these two would differ.
    const withGps = buildLogWithOptionalGps(true);
    const withoutGps = buildLogWithOptionalGps(false);
    expect(withGps.gps).toBeDefined();
    expect(withGps.gps).toHaveLength(withGps.sampleCount);
    expect(withoutGps.gps).toBeUndefined();

    expect(extractFeatures(withGps)).toEqual(extractFeatures(withoutGps));
  });

  it("EXCLUDES GPS on the 50k deterministic log too (which has a real track)", () => {
    const big = buildLargeSessionLog(2000);
    expect(big.gps).toBeDefined();
    const stripped: ParsedLog = { ...big };
    delete stripped.gps;
    expect(extractFeatures(big)).toEqual(extractFeatures(stripped));
  });

  it("moving the GPS track to a different continent changes nothing", () => {
    const a = buildLogWithOptionalGps(true);
    const b: ParsedLog = {
      ...a,
      gps: (a.gps ?? []).map((g) => (g ? { lat: -33.86 + g.lat * 0, lon: 151.2 } : null)),
    };
    expect(extractFeatures(a)).toEqual(extractFeatures(b));
  });

  it("the pattern allowlist really does exclude `gps-area-degradation`", () => {
    expect([...GPS_FREE_PATTERN_IDS]).toEqual([
      "repeated-lq-drops",
      "heading-degradation",
      "power-packet-link-events",
    ]);
    expect(GPS_FREE_PATTERN_IDS).not.toContain("gps-area-degradation");
  });

  it("no feature NAME references a coordinate or an identifier", () => {
    const forbidden = [
      "lat",
      "lon",
      "gps",
      "coord",
      "uid",
      "mac",
      "ip",
      "email",
      "serial",
      "binding",
      "session",
      "user",
      "device",
    ];
    for (const name of FEATURE_NAMES) {
      const lower = name.toLowerCase();
      for (const token of forbidden) {
        expect(lower.includes(token), `feature "${name}" contains "${token}"`).toBe(false);
      }
    }
  });

  it("a persisted training row carries the label + numbers and NOTHING else", () => {
    const row = corpus[0];
    const training = toTrainingRow(row);
    expect(Object.keys(training).sort()).toEqual(["features", "label"]);
    expect("sessionId" in training).toBe(false);
    // Serialise it the way an artifact would be written: no strings survive except
    // the label itself.
    const blob = JSON.parse(JSON.stringify(training)) as {
      label: string;
      features: Record<string, unknown>;
    };
    expect(ML_LABELS).toContain(blob.label as MlLabel);
    for (const v of Object.values(blob.features)) expect(typeof v).toBe("number");
  });
});

describe("extractFeatures — the features actually separate the classes", () => {
  const byLabel = (label: MlLabel) => corpus.filter((r) => r.label === label);
  const meanOf = (rows: DatasetRow[], name: (typeof FEATURE_NAMES)[number]) =>
    rows.reduce((a, r) => a + r.features[name], 0) / rows.length;

  it("failsafe sessions have a far lower minimum LQ than healthy ones", () => {
    expect(meanOf(byLabel("failsafe"), "lqMin")).toBeLessThan(
      meanOf(byLabel("healthy"), "lqMin"),
    );
    expect(meanOf(byLabel("failsafe"), "lqFracZero")).toBeGreaterThan(
      meanOf(byLabel("healthy"), "lqFracZero"),
    );
  });

  it("healthy sessions score a higher v2.0 health score than every faulty class", () => {
    const healthy = meanOf(byLabel("healthy"), "healthScore");
    for (const label of ["warning", "failsafe", "wiringSuspicion", "antennaSuspicion"] as const) {
      expect(healthy, label).toBeGreaterThan(meanOf(byLabel(label), "healthScore"));
    }
  });

  it("WIRING is what the RSSI-imbalance feature separates (36 dB vs 4 dB) — not antenna", () => {
    // A loose/broken coax starves ONE antenna, so the diversity imbalance explodes:
    // wiring ~36 dB vs healthy ~4 dB. Antenna sessions sit at ~4 dB — statistically
    // indistinguishable from healthy on this feature. Asserting "antenna > healthy"
    // here would pass on a 0.06 dB margin, i.e. on noise; it is asserted where the
    // signal actually is, and the antenna null is caught by the heading feature below.
    const healthy = meanOf(byLabel("healthy"), "rssiImbalanceMean");
    expect(meanOf(byLabel("wiringSuspicion"), "rssiImbalanceMean")).toBeGreaterThan(healthy * 5);
    expect(
      Math.abs(meanOf(byLabel("antennaSuspicion"), "rssiImbalanceMean") - healthy),
    ).toBeLessThan(1);
  });

  it("ANTENNA is what the heading-sector RSSI-spread feature separates (23 dB vs 2 dB)", () => {
    // An antenna null is DIRECTIONAL: some heading sectors see several dB less
    // signal than others. This is the only feature that can tell an antenna null
    // from a plain weak link, and it is the reason `heading` (a bearing, never a
    // position) is in the vector at all.
    expect(meanOf(byLabel("antennaSuspicion"), "headingSectorRssiSpreadDb")).toBeGreaterThan(
      meanOf(byLabel("healthy"), "headingSectorRssiSpreadDb") * 5,
    );
  });
});

// ---------------------------------------------------------------------------
// Dataset integrity over the REAL corpus.
// ---------------------------------------------------------------------------

describe("dataset integrity — the real 36-fixture corpus", () => {
  it("pins the schema version", () => {
    expect(ML_DATASET_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("is 36 sessions across the 5 real classes (12/7/7/5/5)", () => {
    expect(corpus).toHaveLength(36);
    const counts = new Map<MlLabel, number>();
    for (const r of corpus) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
    expect(counts.get("healthy")).toBe(12);
    expect(counts.get("warning")).toBe(7);
    expect(counts.get("failsafe")).toBe(7);
    expect(counts.get("wiringSuspicion")).toBe(5);
    expect(counts.get("antennaSuspicion")).toBe(5);
    expect(counts.get("unknown")).toBeUndefined();
  });

  it("has a unique sessionId per row (a duplicate would defeat the leakage guard)", () => {
    const ids = corpus.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is nowhere near the D21 minimum — the largest class has 4 % of what is required", () => {
    expect(12).toBeLessThan(MIN_LABELED_SESSIONS_PER_CLASS);
    expect(12 / MIN_LABELED_SESSIONS_PER_CLASS).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// The split.
// ---------------------------------------------------------------------------

const split = splitDataset(corpus);

describe("splitDataset — determinism", () => {
  it("same rows + same seed ⇒ byte-identical split (run twice, deep-equal)", () => {
    const a = splitDataset(corpus);
    const b = splitDataset(corpus);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is independent of the order rows were loaded in", () => {
    const scrambled = shuffled(corpus, createRng(999));
    const fromScrambled = splitDataset(scrambled);
    expect(fromScrambled.train.map((r) => r.sessionId)).toEqual(
      split.train.map((r) => r.sessionId),
    );
    expect(fromScrambled.test.map((r) => r.sessionId)).toEqual(
      split.test.map((r) => r.sessionId),
    );
  });

  it("a different seed produces a different partitioning", () => {
    const other = splitDataset(corpus, { seed: DEFAULT_SEED + 1 });
    expect(other.test.map((r) => r.sessionId)).not.toEqual(split.test.map((r) => r.sessionId));
    // ...but the same SHAPE — stratification is a property of the ratios, not the seed.
    expect(other.perClassCounts).toEqual(split.perClassCounts);
  });

  it("records the seed and ratios it was produced under", () => {
    expect(split.seed).toBe(DEFAULT_SEED);
    expect(split.ratios).toEqual({ ...DEFAULT_SPLIT_RATIOS });
    expect(split.schemaVersion).toBe(ML_DATASET_SCHEMA_VERSION);
  });
});

describe("splitDataset — NO LEAKAGE (the guard that matters most)", () => {
  it("no session appears in two partitions", () => {
    const trainIds = new Set(split.train.map((r) => r.sessionId));
    const valIds = new Set(split.val.map((r) => r.sessionId));
    const testIds = new Set(split.test.map((r) => r.sessionId));

    for (const id of trainIds) {
      expect(valIds.has(id), `${id} in train AND val`).toBe(false);
      expect(testIds.has(id), `${id} in train AND test`).toBe(false);
    }
    for (const id of valIds) {
      expect(testIds.has(id), `${id} in val AND test`).toBe(false);
    }
  });

  it("every session lands in exactly one partition, and none is lost", () => {
    const all = [...split.train, ...split.val, ...split.test].map((r) => r.sessionId);
    expect(all).toHaveLength(corpus.length);
    expect(new Set(all).size).toBe(corpus.length);
    expect([...all].sort()).toEqual(corpus.map((r) => r.sessionId).sort());
  });

  it("rejects a duplicate sessionId outright rather than splitting it into two partitions", () => {
    const dup = [...corpus, { ...corpus[0] }];
    expect(() => splitDataset(dup)).toThrow(InvalidDatasetError);
  });

  it("rejects ratios that do not sum to 1", () => {
    expect(() => splitDataset(corpus, { ratios: { train: 0.7, val: 0.2, test: 0.2 } })).toThrow(
      InvalidDatasetError,
    );
    expect(() => splitDataset(corpus, { ratios: { train: 1.2, val: -0.1, test: -0.1 } })).toThrow(
      InvalidDatasetError,
    );
  });
});

describe("splitDataset — stratification", () => {
  it("holds the per-class proportions as closely as integer counts allow", () => {
    for (const label of ML_LABELS) {
      const c = split.perClassCounts[label];
      expect(c.train + c.val + c.test, label).toBe(c.total);
      if (c.total === 0) continue;
      // floor(n*0.6) / floor(n*0.2) / remainder-to-test.
      expect(c.train, label).toBe(Math.floor(c.total * DEFAULT_SPLIT_RATIOS.train));
      expect(c.val, label).toBe(Math.floor(c.total * DEFAULT_SPLIT_RATIOS.val));
      expect(c.test, label).toBe(c.total - c.train - c.val);
      // Every partition's share is within one session of its ideal.
      expect(Math.abs(c.train / c.total - DEFAULT_SPLIT_RATIOS.train), label).toBeLessThan(
        1 / c.total + 1e-9,
      );
    }
  });

  it("produces the exact per-class counts the 36-fixture corpus forces", () => {
    expect(split.perClassCounts.healthy).toEqual({ total: 12, train: 7, val: 2, test: 3 });
    expect(split.perClassCounts.warning).toEqual({ total: 7, train: 4, val: 1, test: 2 });
    expect(split.perClassCounts.failsafe).toEqual({ total: 7, train: 4, val: 1, test: 2 });
    expect(split.perClassCounts.wiringSuspicion).toEqual({ total: 5, train: 3, val: 1, test: 1 });
    expect(split.perClassCounts.antennaSuspicion).toEqual({ total: 5, train: 3, val: 1, test: 1 });
    expect(split.perClassCounts.unknown).toEqual({ total: 0, train: 0, val: 0, test: 0 });

    expect(split.train).toHaveLength(21);
    expect(split.val).toHaveLength(6);
    expect(split.test).toHaveLength(9);
  });

  it("every class the corpus has is represented in every partition it can be", () => {
    const labelsIn = (rows: DatasetRow[]) => new Set(rows.map((r) => r.label));
    for (const label of ["healthy", "warning", "failsafe", "wiringSuspicion", "antennaSuspicion"] as const) {
      expect(labelsIn(split.train).has(label), `train missing ${label}`).toBe(true);
      expect(labelsIn(split.val).has(label), `val missing ${label}`).toBe(true);
      expect(labelsIn(split.test).has(label), `test missing ${label}`).toBe(true);
    }
  });
});

describe("splitDataset — the degenerate corpus is STATED, not dressed up", () => {
  it("comes back `adequate: false` on the real corpus", () => {
    expect(split.adequate).toBe(false);
    expect(split.warnings.length).toBeGreaterThan(0);
  });

  it("flags all 5 classes as below the D21 minimum", () => {
    const flagged = split.warnings
      .filter((w) => w.code === "class-below-d21-minimum")
      .map((w) => w.label);
    expect(new Set(flagged)).toEqual(
      new Set(["healthy", "warning", "failsafe", "wiringSuspicion", "antennaSuspicion"]),
    );
    for (const w of split.warnings.filter((w) => w.code === "class-below-d21-minimum")) {
      expect(w.detail.required).toBe(MIN_LABELED_SESSIONS_PER_CLASS);
      expect(w.detail.total).toBeLessThan(MIN_LABELED_SESSIONS_PER_CLASS);
    }
  });

  it("flags all 5 test splits as statistically insignificant (largest is 3 vs a floor of 60)", () => {
    const flagged = split.warnings.filter((w) => w.code === "test-split-below-significance");
    expect(flagged).toHaveLength(5);
    for (const w of flagged) {
      expect(w.detail.required).toBe(MIN_TEST_SESSIONS_PER_CLASS);
      expect(w.detail.test).toBeLessThanOrEqual(3);
    }
  });

  it("names the TWO classes whose test set is a SINGLE session — wiring and antenna", () => {
    // 5 sessions, 60/20/20 ⇒ 3/1/1. A one-session test set means that class's
    // recall can only ever read 0 % or 100 %. This is the finding, not a bug.
    const single = split.warnings
      .filter((w) => w.code === "single-session-test-class")
      .map((w) => w.label);
    expect(new Set(single)).toEqual(new Set(["wiringSuspicion", "antennaSuspicion"]));
    expect(single).toHaveLength(2);
  });

  it("does NOT flag an empty partition (the 3/1/1 split at least fills all three)", () => {
    expect(split.warnings.filter((w) => w.code === "empty-partition")).toHaveLength(0);
  });

  it("does NOT flag `unknown` as an absent class — it is the escape hatch, not a class", () => {
    expect(split.warnings.filter((w) => w.code === "absent-class")).toHaveLength(0);
  });

  it("DOES flag a genuinely missing real class", () => {
    const noAntenna = corpus.filter((r) => r.label !== "antennaSuspicion");
    const partial = splitDataset(noAntenna);
    const absent = partial.warnings.filter((w) => w.code === "absent-class");
    expect(absent).toHaveLength(1);
    expect(absent[0].label).toBe("antennaSuspicion");
  });

  it("every warning's detail bag is numeric-only (no identifiers can ride along)", () => {
    for (const w of split.warnings) {
      for (const v of Object.values(w.detail)) expect(typeof v).toBe("number");
    }
  });

  it("would come back `adequate: true` only at the D21 corpus size", () => {
    // Synthesise a corpus that MEETS D21 and prove the warnings are not just
    // hardcoded pessimism — the gate genuinely tracks the data.
    const template = corpus[0].features;
    const big: DatasetRow[] = [];
    for (const label of ["healthy", "warning", "failsafe", "wiringSuspicion", "antennaSuspicion"] as const) {
      for (let i = 0; i < MIN_LABELED_SESSIONS_PER_CLASS; i++) {
        big.push({ sessionId: `${label}-${String(i).padStart(4, "0")}`, label, features: template });
      }
    }
    const healthySplit = splitDataset(big);
    expect(healthySplit.warnings).toEqual([]);
    expect(healthySplit.adequate).toBe(true);
    expect(healthySplit.perClassCounts.healthy).toEqual({
      total: 300,
      train: 180,
      val: 60,
      test: 60,
    });
  });
});
