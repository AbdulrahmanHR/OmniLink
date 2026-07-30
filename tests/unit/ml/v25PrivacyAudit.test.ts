import { readFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LogGpsFix, ParsedLog } from "@/lib/blackbox";
import { detectSessionPatterns, evaluateSession } from "@/lib/diagnostics";
import type { AlertFrame } from "@/lib/liveAlerts";
import {
  buildDatasetRow,
  explainSession,
  extractFeatures,
  extractWindowFeatures,
  runPredictor,
  serializeAnomalyModel,
  splitDataset,
  toTrainingRow,
  trainAnomalyModel,
  FEATURE_NAMES,
  GPS_FREE_PATTERN_IDS,
  ML_LABELS,
  ANOMALY_MODEL_ID,
  type AnomalyModel,
  type DatasetRow,
} from "@/lib/ml";
import {
  buildInsertLabelStatement,
  dbRowToSessionLabel,
  toCanonicalLabel,
} from "@/lib/session-labels";
import { loadAllFixtures, buildLog } from "../diagnostics/fixtures";
import {
  INJECTED,
  INJECTED_LITERALS,
  assertZeroIdentifiers,
  collectKeys,
  collectNumbers,
  collectStrings,
  type KeyPolicy,
} from "../_privacy";
import checkedInModel from "../../../data/ml/model-m58.json";

/**
 * The ML payload key policy.
 *
 * **`modelId` is exempted, and this is the one place in the audit that relaxes a
 * rule — so it is argued, not waved through.** The shared forbidden-key list
 * carries `modelid` because in ELRS that spelling means the per-user **device
 * model id**, a binding-adjacent secret. The ML line uses the SAME spelling for
 * the **ML model's** identity — `"m58-isolation-forest"` — a build-time constant
 * with no user in it. A key-name scanner cannot tell them apart; a value check
 * can, so every ML payload that carries a `modelId` has its VALUE asserted equal
 * to the frozen `ANOMALY_MODEL_ID` below.
 *
 * (Worth knowing, and reported: a generic scrubber that DROPS `modelId` — the
 * v2.3 sync sanitizer does exactly that — would strip an ML artifact's identity
 * if one were ever routed through it. Nothing routes one through it today.)
 */
const ML_PAYLOAD_KEYS: KeyPolicy = { exempt: ["modelid"] };

/** A model artifact must not carry a session key at all — a training row has none to give it. */
const MODEL_ARTIFACT_KEYS: KeyPolicy = {
  exempt: ["modelid"],
  extraForbidden: ["sessionid", "session_id", "lat", "lon", "latitude", "longitude", "gps", "note"],
};

/**
 * v2.5 PRIVACY AUDIT (M60) — ZERO identifiers anywhere in the ML line.
 *
 * Reuses the shared `assertZeroIdentifiers` harness (`tests/unit/_privacy.ts`,
 * extracted this milestone from the two copies in the v2.3/v2.4 audits), and adds
 * the two checks a NUMERIC payload needs, which a string-shape detector cannot
 * give you:
 *
 *  - a **differential**: the same session, with and without a real GPS track,
 *    must produce a byte-identical feature vector. A leak into a *number*
 *    (`meanLat = 37.7749`) has no string for a shape detector to catch — only the
 *    differential catches it.
 *  - a **hostile GPS track that the v2.0 engine genuinely reacts to**. This is the
 *    part the existing `dataset.test.ts` GPS test does NOT do: its looping track
 *    spreads the low-LQ samples evenly across all six cells, so M38's
 *    `gps-area-degradation` detector **never fires on it** (verified) and the
 *    pattern-allowlist path it claims to prove is therefore never exercised. The
 *    track built here DOES fire it (confidence 1.0, asserted), so
 *    `GPS_FREE_PATTERN_IDS` is under real load: were the pattern flag or a
 *    max-over-all-patterns confidence to leak in, `patternMaxConfidence` would read
 *    1.0 with GPS and 0.8 without, and the two vectors would differ.
 *
 * Runs off-Tauri, pure logic, no network. The `session_labels` half runs the REAL
 * migration-v6 DDL (read out of `src-tauri/src/db/mod.rs`, not copy-pasted) in an
 * in-memory SQLite and tries to store an identifier in it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
const SRC = path.join(REPO, "src");

const fixtures = loadAllFixtures();
const model = checkedInModel as unknown as AnomalyModel;

// ---------------------------------------------------------------------------
// The hostile session: a real, distinctive lat/lon path that the v2.0 engine
// genuinely reacts to — plus raw coordinate CHANNELS, in case a future feature
// ever iterates `log.channels` generically instead of resolving by name.
// ---------------------------------------------------------------------------

/** The poison coordinates: the same literals every other OmniLink privacy audit injects. */
const LAT = Number(INJECTED.gpsLat); //  37.7749
const LON = Number(INJECTED.gpsLon); // -122.4194

/**
 * A session that flies a loop between a GOOD area (LQ 95) and a BAD area (LQ 40),
 * revisiting the bad patch four times.
 *
 * `withGps` toggles ONLY the `gps` array and the coordinate channels — every
 * link-health channel is identical in both variants. So any difference between the
 * two feature vectors can only have come from location data.
 */
function hostileGpsSession(withGps: boolean): ParsedLog {
  const n = 240;
  const inBadArea = (i: number): boolean => i % 60 >= 30;
  const lq = Array.from({ length: n }, (_, i) => (inBadArea(i) ? 40 : 95));
  const channels: Record<string, number[]> = {
    link_quality: lq,
    rssi1: lq.map((v) => (v < 50 ? -95 : -60)),
    rssi2: lq.map((v) => (v < 50 ? -97 : -63)),
  };

  if (withGps) {
    // Raw coordinate columns, exactly as a Betaflight/OmniLog CSV carries them.
    channels.lat = Array.from({ length: n }, (_, i) => (inBadArea(i) ? LAT + 0.002 : LAT));
    channels.lon = Array.from({ length: n }, (_, i) => (inBadArea(i) ? LON + 0.002 : LON));
    channels["GPS_coord[0]"] = channels.lat;
    channels["GPS_coord[1]"] = channels.lon;
    channels.gps_lat = channels.lat;
    channels.gps_lon = channels.lon;
    channels.home_lat = Array.from({ length: n }, () => LAT);
  }

  const log = buildLog(channels);
  if (!withGps) return log;

  const gps: Array<LogGpsFix | null> = Array.from({ length: n }, (_, i) =>
    inBadArea(i) ? { lat: LAT + 0.002, lon: LON + 0.002 } : { lat: LAT, lon: LON }
  );
  return { ...log, gps };
}

describe("the poison is REAL: the hostile session's GPS is present, distinctive, and DETECTED", () => {
  it("carries the injected coordinates in `log.gps` AND in raw coordinate channels", () => {
    const withGps = hostileGpsSession(true);
    expect(withGps.gps).toHaveLength(withGps.sampleCount);
    expect(withGps.gps?.[0]).toEqual({ lat: LAT, lon: LON });
    // The raw literals really are in the source log — so a leak has something to leak.
    const raw = JSON.stringify(withGps);
    expect(raw).toContain(INJECTED.gpsLat);
    expect(raw).toContain(INJECTED.gpsLon);
    expect(withGps.channels.map((c) => c.key)).toContain("GPS_coord[0]");
  });

  it("makes M38's GPS-derived `gps-area-degradation` pattern ACTUALLY FIRE (confidence 1.0)", () => {
    // Without this, the exclusion below would be proving nothing: a pattern that
    // never fires cannot leak. The v2.0 engine reads `log.gps` here and raises a
    // location-correlated finding — and the ML feature vector must still not see it.
    const withGps = hostileGpsSession(true);
    const patterns = detectSessionPatterns(withGps, evaluateSession(withGps)).patterns;
    const gpsPattern = patterns.find((p) => p.patternId === "gps-area-degradation");
    expect(gpsPattern, "the hostile GPS track did not trigger the GPS pattern").toBeDefined();
    expect(gpsPattern!.confidence).toBeGreaterThan(0.8);

    // And it is the STRONGEST pattern in the session — so a `max` taken over ALL
    // patterns (rather than over the GPS-free allowlist) would read a different
    // number than one taken over the allowlist. That difference is the leak this
    // audit is hunting.
    const withoutGps = hostileGpsSession(false);
    const clean = detectSessionPatterns(withoutGps, evaluateSession(withoutGps)).patterns;
    expect(clean.some((p) => p.patternId === "gps-area-degradation")).toBe(false);
    const maxAll = Math.max(...patterns.map((p) => p.confidence));
    const maxAllowlisted = Math.max(...clean.map((p) => p.confidence));
    expect(maxAll).toBeGreaterThan(maxAllowlisted); // 1.0 vs 0.8 — a real difference to leak
  });
});

// ---------------------------------------------------------------------------
// 1. Feature vectors + dataset rows.
// ---------------------------------------------------------------------------

describe("feature vectors: GPS is excluded BY CONSTRUCTION, under real load", () => {
  it("a session WITH a firing GPS pattern yields a BYTE-IDENTICAL vector to one without", () => {
    const withGps = extractFeatures(hostileGpsSession(true));
    const withoutGps = extractFeatures(hostileGpsSession(false));
    expect(withGps).toEqual(withoutGps);
    // Byte-identical, not merely deep-equal: key order is part of the contract too.
    expect(JSON.stringify(withGps)).toBe(JSON.stringify(withoutGps));
  });

  it("moving the whole flight to another continent changes not one number", () => {
    const home = hostileGpsSession(true);
    const away: ParsedLog = {
      ...home,
      gps: (home.gps ?? []).map((g) => (g ? { lat: -33.8688, lon: 151.2093 } : null)),
      channels: home.channels.map((c) =>
        c.key === "lat" || c.key === "gps_lat" || c.key === "GPS_coord[0]" || c.key === "home_lat"
          ? { ...c, values: c.values.map(() => -33.8688) }
          : c.key === "lon" || c.key === "gps_lon" || c.key === "GPS_coord[1]"
            ? { ...c, values: c.values.map(() => 151.2093) }
            : c
      ),
    };
    expect(extractFeatures(away)).toEqual(extractFeatures(home));
  });

  it("no feature VALUE is any of the injected coordinates, and no key names a location", () => {
    const fv = extractFeatures(hostileGpsSession(true));
    assertZeroIdentifiers(fv);
    // The numeric check the string-shape detector cannot do: no number in the
    // vector equals a poison coordinate (or its negation/rounding).
    for (const n of collectNumbers(fv)) {
      for (const poison of [LAT, LON, -LAT, -LON, Math.abs(LON)]) {
        expect(Math.abs(n - poison), `feature value equals a coordinate: ${n}`).toBeGreaterThan(
          1e-6
        );
      }
    }
    expect(GPS_FREE_PATTERN_IDS).not.toContain("gps-area-degradation");
  });

  it("every fixture's vector is numeric-only and identifier-free (the whole real corpus)", () => {
    for (const f of fixtures) {
      const fv = extractFeatures(f.log);
      assertZeroIdentifiers(fv);
      for (const name of FEATURE_NAMES) expect(typeof fv[name]).toBe("number");
    }
  });
});

describe("dataset rows: the corpus key is stripped before anything is trained or written", () => {
  /** Dataset rows whose session keys are themselves identifiers — the hostile ingest. */
  function poisonedRows(): DatasetRow[] {
    const keys = [
      INJECTED.email,
      `/home/pilot/${INJECTED.mac}/flight.csv`,
      `${INJECTED.gpsLat},${INJECTED.gpsLon}`,
      INJECTED.bindingPhrase,
      INJECTED.ipv4,
    ];
    return fixtures.map((f, i) =>
      buildDatasetRow(keys[i % keys.length] + `#${i}`, f.label, f.log)
    );
  }

  it("`toTrainingRow` strips the session key — the poison never reaches the model's input", () => {
    const rows = poisonedRows();
    // The poison is genuinely present in the DatasetRow…
    expect(JSON.stringify(rows)).toContain(INJECTED.email);
    // …and gone from every training row.
    const training = rows.map(toTrainingRow);
    assertZeroIdentifiers(training, MODEL_ARTIFACT_KEYS);
    for (const row of training) {
      expect(Object.keys(row).sort()).toEqual(["features", "label"]);
    }
  });

  it("a model TRAINED on poisoned session keys serializes with zero trace of them", () => {
    const rows = poisonedRows();
    const split = splitDataset(rows);
    const trained = trainAnomalyModel(split.train.map(toTrainingRow));
    const serialized = serializeAnomalyModel(trained);
    for (const lit of INJECTED_LITERALS) {
      expect(serialized, `model artifact leaked ${lit}`).not.toContain(lit);
    }
    expect(serialized).not.toContain("/home/");
    const parsed: unknown = JSON.parse(serialized);
    assertZeroIdentifiers(parsed, MODEL_ARTIFACT_KEYS);
    expect((parsed as AnomalyModel).modelId).toBe(ANOMALY_MODEL_ID); // the exempted key, value-checked
  });
});

// ---------------------------------------------------------------------------
// 2. Model output + explainability/evidence.
// ---------------------------------------------------------------------------

describe("model output + evidence carry zero identifiers", () => {
  it("the output of the checked-in model on the HOSTILE GPS session is identifier-free", () => {
    const log = hostileGpsSession(true);
    const output = explainSession(model, log, evaluateSession(log));
    assertZeroIdentifiers(output, ML_PAYLOAD_KEYS);
    expect(output.modelId).toBe(ANOMALY_MODEL_ID); // the exempted key, value-checked

    // It is also IDENTICAL to the output on the GPS-stripped twin — the model saw
    // no location, so it cannot have reacted to one.
    const clean = hostileGpsSession(false);
    expect(JSON.stringify(explainSession(model, clean, evaluateSession(clean)))).toBe(
      JSON.stringify(output)
    );
    // The explanation is feature NAMES from the frozen tuple + an index window —
    // there is no free text to hide a coordinate in.
    for (const f of output.topFeatures) expect(FEATURE_NAMES).toContain(f.feature);
    expect(Object.values(output.detail).every((v) => typeof v === "number")).toBe(true);
  });

  it("the evidence window is a SAMPLE INDEX range — never a timestamp, never a place", () => {
    const log = hostileGpsSession(true);
    const output = explainSession(model, log, evaluateSession(log));
    expect(Number.isInteger(output.evidenceWindow.startIndex)).toBe(true);
    expect(Number.isInteger(output.evidenceWindow.endIndex)).toBe(true);
    expect(output.evidenceWindow.endIndex).toBeLessThan(log.sampleCount);
  });
});

// ---------------------------------------------------------------------------
// 3. The predictive path (M59) — `AlertFrame.gps` exists, and is never read.
// ---------------------------------------------------------------------------

describe("predictive warnings: frames DO carry GPS; the predictor never reads it", () => {
  /** A decaying link, with or without a real fix on every frame. */
  function decayFrames(withGps: boolean): AlertFrame[] {
    return Array.from({ length: 60 }, (_, i) => ({
      t: i * 40,
      rssi1: -50 - i * 0.9,
      rssi2: -55 - i * 0.9,
      linkQuality: Math.max(0, 100 - i * 2),
      gps: withGps ? { lat: LAT + i * 0.0001, lon: LON - i * 0.0001 } : null,
    })) as AlertFrame[];
  }

  it("the poison is real: the GPS-bearing frames genuinely contain the injected coordinates", () => {
    expect(JSON.stringify(decayFrames(true))).toContain(INJECTED.gpsLat);
    expect(JSON.stringify(decayFrames(false))).not.toContain(INJECTED.gpsLat);
  });

  it("window features are byte-identical with and without a GPS track", () => {
    const withGps = extractWindowFeatures(decayFrames(true));
    const withoutGps = extractWindowFeatures(decayFrames(false));
    expect(JSON.stringify(withGps)).toBe(JSON.stringify(withoutGps));
    assertZeroIdentifiers(withGps);
  });

  it("the warnings raised are identical, and carry zero identifiers", () => {
    const warned = runPredictor(decayFrames(true));
    expect(warned.length).toBeGreaterThan(0); // it really fired — not a vacuous pass
    expect(JSON.stringify(warned)).toBe(JSON.stringify(runPredictor(decayFrames(false))));
    assertZeroIdentifiers(warned);
    for (const w of warned) {
      expect(Object.values(w.detail).every((v) => typeof v === "number")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Persisted labels — the CHECK constraint, executed for real.
// ---------------------------------------------------------------------------

/** The REAL migration-v6 DDL, read out of the Rust source (never copy-pasted). */
function migrationV6Sql(): string {
  const rust = readFileSync(path.join(REPO, "src-tauri/src/db/mod.rs"), "utf8");
  const match = /version:\s*6,[\s\S]*?sql:\s*"([\s\S]*?)",\s*\n\s*kind:/.exec(rust);
  expect(match, "migration v6 not found in src-tauri/src/db/mod.rs").not.toBeNull();
  return match![1];
}

describe("session_labels: free text is PHYSICALLY unstorable (real SQLite, real DDL)", () => {
  function freshDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(
      "CREATE TABLE telemetry_sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL)"
    );
    db.exec(migrationV6Sql());
    db.prepare("INSERT INTO telemetry_sessions (session_id, started_at) VALUES (?, ?)").run(
      "sess-1",
      1
    );
    return db;
  }

  it("the six canonical labels — and only those — are storable", () => {
    const db = freshDb();
    const insert = db.prepare(
      "INSERT INTO session_labels (session_id, label, revision, labeled_at) VALUES (?, ?, ?, ?)"
    );
    ML_LABELS.forEach((label, i) => {
      expect(() => insert.run("sess-1", label, i + 1, 1000 + i)).not.toThrow();
    });
    const rows = db
      .prepare("SELECT session_id, label, revision, labeled_at FROM session_labels")
      .all() as Array<Record<string, string | number>>;
    expect(rows).toHaveLength(ML_LABELS.length);
    expect(rows.map((r) => dbRowToSessionLabel(r).label).sort()).toEqual([...ML_LABELS].sort());
  });

  it("storing an IDENTIFIER as a label is REJECTED by the database, not by a lint", () => {
    const db = freshDb();
    const insert = db.prepare(
      "INSERT INTO session_labels (session_id, label, revision, labeled_at) VALUES (?, ?, ?, ?)"
    );
    const hostileLabels = [
      INJECTED.email,
      INJECTED.mac,
      INJECTED.ipv4,
      INJECTED.bindingPhrase,
      `${INJECTED.gpsLat},${INJECTED.gpsLon}`,
      "flew at the old airfield behind Dave's house",
      "healthy; DROP TABLE session_labels;--",
      "Healthy", // not even a case variant slips through
      "",
    ];
    for (const label of hostileLabels) {
      expect(
        () => insert.run("sess-1", label, 1, 1000),
        `SQLite STORED a non-canonical label: "${label}"`
      ).toThrow(/CHECK|constraint/i);
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM session_labels").get() as { n: number }).n
    ).toBe(0);
  });

  it("there is NO column to put free text in — a note column does not exist", () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          "INSERT INTO session_labels (session_id, label, revision, labeled_at, note) VALUES (?,?,?,?,?)"
        )
        .run("sess-1", "healthy", 1, 1, "pilot: Dave, site: home field")
    ).toThrow();
    const columns = (
      db.prepare("SELECT name FROM pragma_table_info('session_labels')").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(columns.sort()).toEqual(["id", "label", "labeled_at", "revision", "session_id"]);
  });

  it("deleting the recording deletes its labels (a label cannot outlive its session)", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO session_labels (session_id, label, revision, labeled_at) VALUES (?,?,?,?)"
    ).run("sess-1", "warning", 1, 1);
    db.prepare("DELETE FROM telemetry_sessions WHERE session_id = ?").run("sess-1");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM session_labels").get() as { n: number }).n
    ).toBe(0);
  });

  it("the write seam binds the label as a PARAMETER — no string can be concatenated into SQL", () => {
    const stmt = buildInsertLabelStatement("sess-1", toCanonicalLabel("healthy"), 1, 1000);
    expect(stmt.sql).not.toContain("healthy");
    expect(stmt.sql).toContain("$2");
    expect(stmt.params).toEqual(["sess-1", "healthy", 1, 1000]);
    // …and an identifier offered as a label degrades to `unknown` before it is bound.
    expect(toCanonicalLabel(INJECTED.email)).toBe("unknown");
    expect(toCanonicalLabel("healthy; DROP TABLE session_labels")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 5. Every checked-in artifact — scanned on disk, as bytes.
// ---------------------------------------------------------------------------

const ML_ARTIFACTS = [
  "data/ml/baseline-v20.json",
  "data/ml/model-m58.json",
  "data/ml/model-eval-m58.json",
  "data/ml/model-eval-m59.json",
];

/** Every file under `dir`, recursively (absolute paths). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

const SYNTHETIC_FILES = filesUnder(path.join(REPO, "data/fixtures/ml-synthetic"));

/** Raw-byte shape detectors — applied to the file as text, JSON or CSV alike. */
const BYTE_PATTERNS: Array<[string, RegExp]> = [
  ["MAC address", /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/],
  ["IPv4 address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ["IPv6 address", /\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]*\b/],
  ["email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["absolute POSIX home path", /\/(?:home|Users)\/[A-Za-z0-9._-]+/],
  ["absolute Windows path", /[A-Za-z]:\\{1,2}Users\\{1,2}/],
];

describe("checked-in artifacts carry zero identifiers (scanned as bytes on disk)", () => {
  it("all four ML artifacts + the whole synthetic corpus are on disk and non-empty", () => {
    for (const rel of ML_ARTIFACTS) {
      expect(statSync(path.join(REPO, rel)).size).toBeGreaterThan(0);
    }
    expect(SYNTHETIC_FILES.length).toBe(73); // 72 CSVs + the manifest
  });

  it("no artifact byte matches a MAC / IP / email / home-directory shape", () => {
    for (const rel of [...ML_ARTIFACTS, ...SYNTHETIC_FILES.map((f) => path.relative(REPO, f))]) {
      const text = readFileSync(path.join(REPO, rel), "utf8");
      for (const [name, re] of BYTE_PATTERNS) {
        const hit = re.exec(text);
        expect(hit, `${rel} contains a ${name}: ${hit?.[0]}`).toBeNull();
      }
    }
  });

  it("the TRAINED MODEL's entire string vocabulary is closed: 43 feature names + 6 labels + ids", () => {
    // The strongest artifact check available, and the one that would go red if a
    // session key, a filename, a note, a device id or a coordinate string ever rode
    // into a model artifact: the forest is allowed to contain NO string outside this
    // closed set. (Split values are numbers; feature names are indices into the
    // frozen tuple; the only strings are the ones enumerated here.)
    const allowed = new Set<string>([
      ...FEATURE_NAMES,
      ...ML_LABELS,
      ANOMALY_MODEL_ID,
      "1.0.0", // schemaVersion / datasetSchemaVersion
    ]);
    const forest: unknown = JSON.parse(
      readFileSync(path.join(REPO, "data/ml/model-m58.json"), "utf8")
    );
    const strings = collectStrings(forest);
    for (const s of strings) {
      expect(allowed.has(s), `model-m58.json contains an out-of-vocabulary string: "${s}"`).toBe(
        true
      );
    }
    expect(strings.length).toBeGreaterThan(0); // it does have strings — not a vacuous pass
    // …and no session key rode in as a KEY either.
    assertZeroIdentifiers(forest, MODEL_ARTIFACT_KEYS);
    expect(collectKeys(forest)).not.toContain("sessionId");
  });

  it("the eval + baseline artifacts pass the shared identifier harness", () => {
    for (const rel of ML_ARTIFACTS) {
      const parsed: unknown = JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));
      // NOTE the policy: `modelId` is exempted (it is the ML model's id, not a
      // device's — see ML_PAYLOAD_KEYS). `sessionId` is NOT forbidden here, because
      // the eval artifacts deliberately name WHICH corpus fixture failed so a human
      // can go and look — and the very next test proves every one of those values is
      // a corpus-local fixture key and never a path off someone's machine.
      assertZeroIdentifiers(parsed, ML_PAYLOAD_KEYS);
    }
  });

  it("every string in the eval artifacts is a corpus-local key, an id, or honest prose — never a path", () => {
    const corpusFiles = new Set(fixtures.map((f) => f.file));
    for (const rel of ["data/ml/baseline-v20.json", "data/ml/model-eval-m58.json", "data/ml/model-eval-m59.json"]) {
      const parsed: unknown = JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));
      for (const s of collectStrings(parsed)) {
        // A fixture key must be a real corpus file, not an arbitrary path from the
        // machine that built the artifact.
        if (s.endsWith(".csv") && !s.startsWith("synthetic/")) {
          expect(
            corpusFiles.has(s) || s.startsWith("ramp/") || s.startsWith("near-miss/") || s.startsWith("steady/"),
            `${rel}: unknown csv key "${s}"`
          ).toBe(true);
        }
        expect(s.startsWith("/"), `${rel}: absolute path "${s}"`).toBe(false);
      }
    }
  });

  it("the synthetic corpus's GPS columns exist but are EMPTY in every row of every file", () => {
    // The generator writes the full OmniLog column set — including `lat`/`lon`/`alt`
    // — so this is not "there was nothing to leak". Every geo cell must be blank.
    let checkedRows = 0;
    for (const file of SYNTHETIC_FILES.filter((f) => f.endsWith(".csv"))) {
      const [header, ...rows] = readFileSync(file, "utf8").trim().split("\n");
      const columns = header.split(",");
      const geo = ["lat", "lon", "alt", "sats", "ground_speed"].map((c) => columns.indexOf(c));
      expect(geo.every((i) => i >= 0), `${file} lost its geo columns`).toBe(true);
      for (const row of rows) {
        const cells = row.split(",");
        for (const i of geo) {
          expect(cells[i]?.trim(), `${file} carries a coordinate`).toBe("");
        }
        checkedRows += 1;
      }
    }
    expect(checkedRows).toBeGreaterThan(10_000); // the scan really covered the corpus
  });
});

// ---------------------------------------------------------------------------
// 6. What the ML path LOGS.
// ---------------------------------------------------------------------------

describe("the ML path logs nothing about a session", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("`src/lib/ml` contains no console call at all", () => {
    for (const file of sourceFiles(path.join(SRC, "lib/ml"))) {
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(/console\.\w+\(/.test(src), `${path.relative(SRC, file)} logs`).toBe(false);
    }
  });

  it("the lab UI + the label seam log only a constant message + the caught error — never data", () => {
    const surfaces = [
      ...sourceFiles(path.join(SRC, "components/ml")),
      path.join(SRC, "lib/session-labels.ts"),
    ];
    for (const file of surfaces) {
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const calls = src.match(/console\.\w+\([^)]*\)/g) ?? [];
      for (const call of calls) {
        // Only `console.error("[labels] …", e)` is permitted: a literal message and
        // the caught error. No session id, no label, no feature vector, no template
        // interpolation of anything.
        expect(call, `unexpected log in ${path.relative(SRC, file)}: ${call}`).toMatch(
          /^console\.error\("\[labels\] [^"$`]*", e\)$/
        );
      }
    }
  });
});
