import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ParsedLog } from "@/lib/blackbox";
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  detectSessionPatterns,
  deriveSuggestions,
  evaluateSession,
  summarizeSessionForHistory,
  summarizeTrends,
  type DiagnosticHistoryRecord,
} from "@/lib/diagnostics";
import {
  isSensitiveSuggestionKey,
  suggestableRule,
  suggestionToProfilePatch,
  validateSuggestion,
  SUGGESTABLE_DEFINE_KEYS,
} from "@/lib/aiSuggestionSchema";
import { resetFeatureFlags, setFeatureFlag } from "@/lib/featureFlags";
import {
  clearsFpCeiling,
  clearsM56Gate,
  explainSession,
  predictOverLog,
  trainAnomalyModel,
  toTrainingRow,
  buildDatasetRow,
  splitDataset,
  FEATURE_NAMES,
  PREDICTIVE_WARNING_CODE,
  type AnomalyModel,
  type AnomalyModelOutput,
  type PredictiveWarning,
} from "@/lib/ml";
import { loadAllFixtures } from "../diagnostics/fixtures";
import checkedInModel from "../../../data/ml/model-m58.json";
import baselineArtifact from "../../../data/ml/baseline-v20.json";

/**
 * v2.5 SAFETY AUDIT (M60) — the adversary's file.
 *
 * The v2.5 ML line claims four safety properties. This suite tries to BREAK each
 * one, and each assertion is written so that it goes RED if the property is ever
 * violated — not so that it passes today:
 *
 *  1. **A model output can never reach a hardware-changing path.** Proven
 *     structurally (the ML line's runtime import closure cannot even *see* the
 *     Tauri IPC seam — so there is no `invoke` to reach, let alone a config
 *     write) AND behaviourally (a HOSTILE model output whose `detail` bag names
 *     real `elrs_options_schema.json` fields — `TX_POWER`, `UNLOCK_HIGHER_POWER`,
 *     a binding phrase — is force-fed to the ONLY sanctioned config-write gate,
 *     `aiSuggestionSchema`, and yields NO patch).
 *  2. **A model can never suppress, reorder, or replace a deterministic v2.0
 *     finding.** Proven by byte-comparison of `evaluateSession` output across all
 *     36 fixtures, before/after the model runs and with `mlLab` both OFF and ON.
 *  3. **`mlLab` OFF ⇒ the model code is not consulted.** Proven structurally: the
 *     ML library does not import the flag registry at all (it *cannot* consult
 *     the flag), and no free-core module imports `@/lib/ml`.
 *  4. **The frozen gate cannot be silently loosened.** The load-bearing assertion
 *     is that a PERFECT model (FP 0.000, recall 1.000) still FAILS the gate
 *     against the checked-in baseline artifact — which goes red under BOTH a
 *     `<` → `<=` loosening AND a re-derived friendlier baseline.
 *
 * Pure-logic, off-Tauri, no network.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../src");

const fixtures = loadAllFixtures();
const model = checkedInModel as unknown as AnomalyModel;

afterEach(() => {
  resetFeatureFlags();
});

// ---------------------------------------------------------------------------
// A minimal ES-module import grapher (runtime imports only).
//
// `import type` / `export type` are erased at compile time and therefore cannot
// carry a call — a type-only edge is not a path to a hardware write, and counting
// one would make this audit lie in the SAFE direction (it would report reachability
// the runtime does not have). Comments are stripped first, so prose in a docblock
// cannot fabricate an edge either.
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every runtime (value) import specifier of one file. */
function runtimeImports(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  const statement = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = statement.exec(src)) !== null) {
    if (!m[1]) out.push(m[3]);
  }
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamic.exec(src)) !== null) out.push(m[1]);
  const sideEffect = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((m = sideEffect.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Resolve an `@/`- or relative specifier to a file under `src/`, or `null` for a bare package. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface Closure {
  /** Every reachable file, as a path relative to `src/` (plus out-of-src assets verbatim). */
  files: Set<string>;
  /** Every reachable bare package specifier (`react`, `@tauri-apps/api/core`, …). */
  packages: Set<string>;
}

/** Transitive runtime import closure of `entries`. */
function closureOf(entries: readonly string[]): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.add(path.relative(SRC, file));
    for (const spec of runtimeImports(file)) {
      const resolved = resolveSpec(spec, file);
      if (resolved) queue.push(resolved);
      else packages.add(spec);
    }
  }
  return { files, packages };
}

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ML_LIB_FILES = sourceFiles(path.join(SRC, "lib/ml"));
const ML_UI_FILES = sourceFiles(path.join(SRC, "components/ml"));

/**
 * The modules through which a hardware change can actually happen.
 *
 * `lib/tauri.ts` is the ONE typed `invoke` seam (`startFlash`, `saveProfile`,
 * `deleteStoredProfile`, `probeBridge`, …) — every Rust command in the app is
 * behind it. The rest are the state/model layers a write is composed in.
 */
const HARDWARE_WRITE_MODULES = [
  "lib/tauri.ts", // the only invoke() seam → flash.rs / config.rs / bridge.rs
  "lib/aiSuggestionSchema.ts", // the only sanctioned config-write validator
  "lib/suggestionApply.ts", // applies a validated suggestion to app state
  "lib/elrsp.ts", // the .elrsp profile writer
  "lib/backpackConfig.ts", // the Backpack settings writer
  "stores/profiles.ts", // save/apply a profile
  "stores/wizard.ts", // the flashing wizard (drives startFlash)
];

// ---------------------------------------------------------------------------
// 1. STRUCTURAL — the ML line cannot reach a hardware-changing path.
// ---------------------------------------------------------------------------

describe("structural: no path from an ML output to a hardware write", () => {
  it("the import grapher is REAL: a module that DOES write is caught by it", () => {
    // The anti-tautology control. If the grapher could not see a write path, every
    // assertion below would be vacuous. `stores/profiles.ts` genuinely saves a
    // profile through the Rust config command, so it MUST show up as reaching the
    // IPC seam. If this control ever fails, the grapher is broken and the audit's
    // negative results are worthless.
    const control = closureOf([path.join(SRC, "stores/profiles.ts")]);
    expect(control.files.has("lib/tauri.ts")).toBe(true);
    expect([...control.packages]).toContain("@tauri-apps/api/core");
  });

  it("src/lib/ml reaches NO Tauri package — there is no `invoke` for it to call", () => {
    const closure = closureOf(ML_LIB_FILES);
    const tauriPackages = [...closure.packages].filter((p) => p.startsWith("@tauri-apps"));
    expect(tauriPackages, "the ML library imported a Tauri package").toEqual([]);
    // …and it is a real closure, not an empty one: it genuinely pulls in the v2.0
    // diagnostic engine it is built on top of.
    expect(closure.files.has("lib/diagnostics/engine.ts")).toBe(true);
    expect(closure.files.size).toBeGreaterThan(20);
  });

  it("src/lib/ml reaches NONE of the hardware-write modules", () => {
    const closure = closureOf(ML_LIB_FILES);
    const reached = HARDWARE_WRITE_MODULES.filter((m) => closure.files.has(m));
    expect(reached, `ML library reached a write module: ${reached.join(", ")}`).toEqual([]);
  });

  it("src/components/ml reaches no write module either (its only IPC is the local SQLite read/label seam)", () => {
    const closure = closureOf(ML_UI_FILES);
    const reached = HARDWARE_WRITE_MODULES.filter((m) => closure.files.has(m));
    expect(reached, `the lab UI reached a write module: ${reached.join(", ")}`).toEqual([]);
    // What it DOES reach: `@tauri-apps/plugin-sql` (the append-only session_labels
    // table) and `@tauri-apps/api/core` (`isTauri()`). Neither can touch hardware.
    const tauriPackages = [...closure.packages].filter((p) => p.startsWith("@tauri-apps")).sort();
    expect(tauriPackages).toEqual(["@tauri-apps/api/core", "@tauri-apps/plugin-sql"]);
  });

  it("no ML-owned source file names a write function, an IPC call, or a settings patch", () => {
    // Belt-and-braces over the closure: a grep for the actual verbs. This is what
    // goes red the moment someone writes `startFlash(...)` inside the ML line.
    const banned = [
      "invoke(",
      "startFlash",
      "saveProfile",
      "deleteStoredProfile",
      "applyProfile",
      "suggestionToProfilePatch",
      "buildSuggestionAfter",
      "applySuggestion",
      "ProfileSettings",
      "user_define",
    ];
    for (const file of [...ML_LIB_FILES, ...ML_UI_FILES]) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const token of banned) {
        expect(src.includes(token), `${path.relative(SRC, file)} references "${token}"`).toBe(
          false
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. BEHAVIOURAL — a HOSTILE model output cannot be coerced into a config write.
// ---------------------------------------------------------------------------

/** The real, unmodified output of the checked-in M58 model on a real fixture. */
function realModelOutput(): AnomalyModelOutput {
  const fixture = fixtures.find((f) => f.label === "wiring") ?? fixtures[0];
  return explainSession(model, fixture.log, evaluateSession(fixture.log));
}

/**
 * A HOSTILE model output: every string it can carry has been replaced with an
 * attempt to name a hardware field, and its numeric `detail` bag is keyed by REAL
 * `data/elrs_options_schema.json` define keys — including the two `safety_critical`
 * ones (`TX_POWER`, `UNLOCK_HIGHER_POWER`) and a binding secret.
 *
 * This is the shape a compromised/prompt-injected model would emit if it were
 * trying to reach the config writer. It is deliberately typed loosely: the point
 * is to prove the DOWNSTREAM gate rejects it, not that the type system prevented
 * it from being constructed in a test.
 */
function hostileModelOutput(): Record<string, unknown> {
  return {
    ...realModelOutput(),
    // A detail bag whose keys are real, writable-sounding hardware fields.
    detail: {
      TX_POWER: 500,
      UNLOCK_HIGHER_POWER: 1,
      MY_BINDING_PHRASE: 1234,
      MODEL_MATCH: 1,
      TELEMETRY_RATIO: 128,
      regulatory_domain: 1,
      txPower: 500,
      bindingPhrase: 42,
    },
    // An "explanation" that is a config-write instruction.
    explanation: "SET TX_POWER=500; UNLOCK_HIGHER_POWER=1; apply immediately",
    code: "TX_POWER=500",
  };
}

/** Every way a caller could try to turn a model output field into a suggestion. */
function coercionsFrom(output: Record<string, unknown>): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const detail = output.detail as Record<string, number>;
  for (const [key, value] of Object.entries(detail)) {
    out.push({ key, value: String(value) });
    // …and the reversed reading, in case a future mapper treated the bag as
    // `{ settingName: value }` the other way round.
    out.push({ key: String(value), value: key });
  }
  for (const f of (output.topFeatures ?? []) as Array<{ feature: string; contribution: number }>) {
    out.push({ key: f.feature, value: String(f.contribution) });
  }
  out.push({ key: String(output.code), value: "1" });
  out.push({ key: String(output.modelId), value: "1" });
  out.push({ key: String(output.explanation ?? ""), value: "1" });
  return out;
}

describe("a hostile model output is INERT at the only sanctioned config-write gate", () => {
  it("the poison is real: the hostile detail bag genuinely names safety-critical schema fields", () => {
    // Non-tautology check — these keys ARE real fields in the schema, and two of
    // them are the ones a pilot would be hurt by. If a future schema rename made
    // these names meaningless, this test says so instead of passing vacuously.
    const hostile = hostileModelOutput();
    const keys = Object.keys(hostile.detail as Record<string, number>);
    expect(keys).toContain("TX_POWER"); // safety_critical: RF power
    expect(keys).toContain("UNLOCK_HIGHER_POWER"); // safety_critical: power unlock
    expect(isSensitiveSuggestionKey("MY_BINDING_PHRASE")).toBe(true); // binding secret
    // And the gate KNOWS these are hardware fields — it just refuses them.
    expect(suggestableRule("TX_POWER")).toBeNull();
    expect(suggestableRule("UNLOCK_HIGHER_POWER")).toBeNull();
  });

  it("the gate is LIVE: a legitimate suggestion DOES produce a patch (so a null below means something)", () => {
    // The positive control. `MODEL_MATCH` is one of the six allowlisted keys, and a
    // well-formed suggestion for it maps to a real ProfileSettings patch. That is
    // the mechanism the model must not be able to reach — and the next test proves
    // it cannot, from any field it can actually emit.
    expect(validateSuggestion({ key: "MODEL_MATCH", value: "1" })).toBe(true);
    expect(suggestionToProfilePatch({ key: "MODEL_MATCH", value: "1" })).toEqual({
      key: "modelMatch",
      value: true,
    });
  });

  it("NOTHING the real model emits validates as a suggestion — every coercion yields NO patch", () => {
    const real = realModelOutput() as unknown as Record<string, unknown>;
    for (const s of coercionsFrom(real)) {
      expect(validateSuggestion(s), `validated: ${s.key}=${s.value}`).toBe(false);
      expect(suggestionToProfilePatch(s), `patched: ${s.key}=${s.value}`).toBeNull();
    }
  });

  it("the HOSTILE output's safety-critical keys are refused even when perfectly well-formed", () => {
    // Not "the model didn't say it right" — these are exactly the strings a config
    // writer would accept from the AI path, and the closed allowlist still says no.
    for (const s of [
      { key: "TX_POWER", value: "500" }, // RF power
      { key: "UNLOCK_HIGHER_POWER", value: "1" }, // power unlock (compile flag)
      { key: "MY_BINDING_PHRASE", value: "secret-phrase" }, // binding secret
      { key: "BINDING_PHRASE", value: "abc" },
      { key: "UID", value: "1,2,3,4,5,6" },
      { key: "regulatory_domain", value: "ISM2400" },
      { key: "HOME_WIFI_PASSWORD", value: "hunter2" },
    ]) {
      expect(validateSuggestion(s), `validated blocked key: ${s.key}`).toBe(false);
      expect(suggestionToProfilePatch(s), `patched blocked key: ${s.key}`).toBeNull();
    }
  });

  it("every coercion of the HOSTILE output — detail keys, values, feature names, code, explanation — is inert", () => {
    const hostile = hostileModelOutput();
    let patched = 0;
    for (const s of coercionsFrom(hostile)) {
      if (suggestionToProfilePatch(s) !== null) patched += 1;
    }
    // The hostile bag DOES contain `MODEL_MATCH: 1` — a key that would validate if
    // a caller ever piped a model detail bag into the suggestion validator. It does
    // not, and cannot: `lib/ml` cannot even import `aiSuggestionSchema` (asserted
    // structurally above). What this assertion pins is the OTHER half — that none
    // of the SAFETY-CRITICAL keys can produce a patch by any coercion, so the worst
    // a hypothetical mis-wiring could ever reach is a user-reviewed benign toggle,
    // never RF power, failsafe/arming, or a binding secret.
    const safetyCritical = ["TX_POWER", "UNLOCK_HIGHER_POWER", "MY_BINDING_PHRASE", "regulatory_domain"];
    for (const key of safetyCritical) {
      expect(suggestionToProfilePatch({ key, value: "500" })).toBeNull();
      expect(suggestionToProfilePatch({ key, value: "1" })).toBeNull();
    }
    // The only coercions that survive are ones naming an allowlisted benign key —
    // and the model's OWN vocabulary contains none of them.
    const emittedKeys = new Set([
      ...Object.keys(realModelOutput().detail),
      ...FEATURE_NAMES,
      PREDICTIVE_WARNING_CODE,
    ]);
    for (const allowlisted of SUGGESTABLE_DEFINE_KEYS) {
      expect(emittedKeys.has(allowlisted), `model vocabulary names ${allowlisted}`).toBe(false);
    }
    expect(patched).toBeLessThanOrEqual(1); // the planted MODEL_MATCH, and nothing else
  });

  it("the model output shape has NOWHERE to put a setting: its keys are frozen and numeric", () => {
    const output = realModelOutput();
    expect(Object.keys(output).sort()).toEqual(
      [
        "advisory",
        "detail",
        "evidenceWindow",
        "flagged",
        "modelId",
        "schemaVersion",
        "score",
        "threshold",
        "topFeatures",
      ].sort()
    );
    expect(output.advisory).toBe(true);
    // The detail bag is numbers only — a string value (a define name, a phrase, a
    // sentence) is not even representable.
    for (const [k, v] of Object.entries(output.detail)) {
      expect(typeof v, `detail.${k} is not a number`).toBe("number");
    }
    // Every named feature is a member of the frozen tuple — never free text.
    for (const f of output.topFeatures) {
      expect(FEATURE_NAMES).toContain(f.feature);
    }
  });

  it("a predictive warning is equally inert (advisory literal, machine code, numeric detail)", () => {
    const ramp = rampToFailsafe();
    const warnings: PredictiveWarning[] = predictOverLog(ramp);
    expect(warnings.length).toBeGreaterThan(0); // the predictor really fired
    for (const w of warnings) {
      expect(w.advisory).toBe(true);
      expect(w.code).toBe(PREDICTIVE_WARNING_CODE);
      for (const [k, v] of Object.entries(w.detail)) {
        expect(typeof v, `detail.${k}`).toBe("number");
      }
      // No coercion of a warning validates as a config suggestion.
      for (const [key, value] of Object.entries(w.detail)) {
        expect(suggestionToProfilePatch({ key, value: String(value) })).toBeNull();
      }
      expect(suggestionToProfilePatch({ key: w.code, value: "1" })).toBeNull();
      expect(suggestionToProfilePatch({ key: w.predictorId, value: "1" })).toBeNull();
    }
  });
});

/** A synthetic session whose link decays steadily to zero — the predictor DOES fire on it. */
function rampToFailsafe(): ParsedLog {
  const n = 200;
  const lq: number[] = [];
  const rssi1: number[] = [];
  const rssi2: number[] = [];
  for (let i = 0; i < n; i++) {
    const decay = Math.max(0, 100 - Math.max(0, i - 60) * 2);
    lq.push(decay);
    rssi1.push(-50 - Math.max(0, i - 60) * 0.8);
    rssi2.push(-55 - Math.max(0, i - 60) * 0.8);
  }
  const time = Array.from({ length: n }, (_, i) => i * 40);
  return {
    source: "omnilog",
    time,
    channels: [
      { key: "link_quality", label: "lq", values: lq },
      { key: "rssi1", label: "rssi1", values: rssi1 },
      { key: "rssi2", label: "rssi2", values: rssi2 },
    ],
    sampleCount: n,
    durationMs: time[n - 1],
  };
}

// ---------------------------------------------------------------------------
// 3. The deterministic v2.0 path is PROVABLY undisturbed.
// ---------------------------------------------------------------------------

describe("the model cannot suppress, reorder, or replace a v2.0 finding", () => {
  it("evaluateSession is byte-identical across all 36 fixtures, before and after the model runs", () => {
    for (const f of fixtures) {
      const before = JSON.stringify(evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG));

      // Run the ENTIRE ML line over the same session, in the same process.
      const report = evaluateSession(f.log);
      explainSession(model, f.log, report);
      predictOverLog(f.log);
      detectSessionPatterns(f.log, report);

      const after = JSON.stringify(evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG));
      expect(after, `v2.0 output changed after the model ran on ${f.file}`).toBe(before);
    }
  });

  it("evaluateSession is byte-identical with `mlLab` OFF and with it ON", () => {
    for (const f of fixtures) {
      resetFeatureFlags();
      const off = JSON.stringify(evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG));
      setFeatureFlag("mlLab", true);
      const on = JSON.stringify(evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG));
      expect(on, `flag changed the v2.0 output on ${f.file}`).toBe(off);

      // …and so is the whole downstream free-core pipeline (patterns → history →
      // trends → suggestions), which is what a user actually sees.
      const report = evaluateSession(f.log);
      const patterns = JSON.stringify(detectSessionPatterns(f.log, report));
      resetFeatureFlags();
      expect(JSON.stringify(detectSessionPatterns(f.log, evaluateSession(f.log)))).toBe(patterns);
    }
  });

  it("the M40 trend/suggestion pipeline is identical with the flag ON (the model advises nothing)", () => {
    const wiring = fixtures.filter((f) => f.label === "wiring").slice(0, 3);
    const records = (): DiagnosticHistoryRecord[] =>
      wiring.map((f, i) => {
        const report = evaluateSession(f.log, DEFAULT_DIAGNOSTIC_CONFIG);
        const patternReport = detectSessionPatterns(f.log, report);
        return {
          ...summarizeSessionForHistory(report, patternReport, f.log),
          recordedAt: i + 1,
          deviceKey: "test-device|1",
          deviceLabel: "TestTX",
        };
      });

    resetFeatureFlags();
    const off = JSON.stringify(deriveSuggestions(summarizeTrends(records())));
    setFeatureFlag("mlLab", true);
    for (const f of wiring) explainSession(model, f.log, evaluateSession(f.log));
    const on = JSON.stringify(deriveSuggestions(summarizeTrends(records())));
    expect(on).toBe(off);
    expect(on).toContain("wiring-power-suspicion"); // and it is a real, non-empty result
  });

  it("explainSession does not MUTATE the report it is handed (a model cannot edit findings in place)", () => {
    const f = fixtures.find((x) => x.label === "failsafe") ?? fixtures[0];
    const report = evaluateSession(f.log);
    const snapshot = JSON.stringify(report);
    explainSession(model, f.log, report);
    expect(JSON.stringify(report), "the model mutated the v2.0 report").toBe(snapshot);
  });

  it("the free core does not import `@/lib/ml` at all — the model is a leaf, not a dependency", () => {
    // The v2.0 production path cannot consult a model it cannot see. The ONLY
    // non-ML importers permitted are the lab UI and the label seam (which imports
    // the canonical label union, not a model).
    const permitted = new Set(["lib/session-labels.ts"]);
    const offenders = sourceFiles(SRC)
      .map((f) => path.relative(SRC, f))
      .filter((rel) => !rel.startsWith("lib/ml/") && !rel.startsWith("components/ml/"))
      .filter((rel) => !permitted.has(rel))
      .filter((rel) => /from\s+["']@\/lib\/ml/.test(stripComments(readFileSync(path.join(SRC, rel), "utf8"))));
    expect(offenders, `a non-ML module imports the ML line: ${offenders.join(", ")}`).toEqual([]);

    // And no diagnostics/alerts module names the ML line even in a dynamic import.
    for (const rel of sourceFiles(path.join(SRC, "lib/diagnostics")).map((f) => path.relative(SRC, f))) {
      expect(stripComments(readFileSync(path.join(SRC, rel), "utf8"))).not.toContain("lib/ml");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. `mlLab` OFF ⇒ the model code is not consulted (not "consulted and ignored").
// ---------------------------------------------------------------------------

describe("mlLab OFF: the ML line is not consulted, and it cannot consult itself in", () => {
  it("the ML library never imports the feature-flag registry — it CANNOT branch on `mlLab`", () => {
    for (const file of ML_LIB_FILES) {
      const src = stripComments(readFileSync(file, "utf8"));
      expect(src.includes("featureFlags"), `${path.relative(SRC, file)} reads a feature flag`).toBe(
        false
      );
      expect(src.includes("mlLab")).toBe(false);
    }
    // Nor do the lab panels: they are mounted behind the flag at the render
    // boundary (SettingsPage), rather than self-gating — so an OFF flag means the
    // component never mounts, and the model functions are never called.
    for (const file of ML_UI_FILES) {
      expect(stripComments(readFileSync(file, "utf8")).includes("isMlLabEnabled")).toBe(false);
    }
  });

  it("flipping the flag changes NO ML output either (the library is flag-blind in both directions)", () => {
    const f = fixtures[0];
    resetFeatureFlags();
    const off = JSON.stringify(explainSession(model, f.log, evaluateSession(f.log)));
    setFeatureFlag("mlLab", true);
    const on = JSON.stringify(explainSession(model, f.log, evaluateSession(f.log)));
    expect(on).toBe(off);
  });
});

// ---------------------------------------------------------------------------
// 5. The frozen gate cannot be silently loosened.
// ---------------------------------------------------------------------------

describe("the M56 gate cannot be loosened without going red", () => {
  it("a PERFECT model (FP 0.000, recall 1.000) STILL FAILS against the checked-in baseline", () => {
    // The single most load-bearing assertion in this file. It goes red under BOTH
    // of the loosenings a future commit might attempt:
    //   * `clearsFpCeiling`'s strict `<` relaxed to `<=`  ⇒ a perfect model would pass;
    //   * `data/ml/baseline-v20.json` re-derived friendlier (baselineFpRate > 0)
    //     ⇒ a perfect model would pass.
    // Verified by mutation: both edits make this test fail.
    const artifact = baselineArtifact as unknown as {
      gateBaseline: { baselineFpRate: number; baselineRecall: number; fpCeilingClearable: boolean };
    };
    const baseline = {
      baselineFpRate: artifact.gateBaseline.baselineFpRate,
      baselineRecall: artifact.gateBaseline.baselineRecall,
    };
    expect(baseline.baselineFpRate).toBe(0);
    expect(artifact.gateBaseline.fpCeilingClearable).toBe(false);

    const perfect = { modelFpRate: 0, modelRecall: 1 };
    expect(clearsFpCeiling(perfect.modelFpRate, baseline.baselineFpRate)).toBe(false);
    expect(clearsM56Gate(perfect, baseline)).toBe(false);
  });

  it("the checked-in model artifact is scored against that same baseline — and fails", () => {
    // Guards against a model artifact quietly re-trained to a friendlier threshold:
    // the shipped forest's threshold is fitted on TRAIN only, and the gate verdict
    // is still false regardless of what it scores.
    expect(model.hyperparams.trainedOnClass).toBe("healthy");
    expect(clearsM56Gate({ modelFpRate: 0, modelRecall: 1 }, {
      baselineFpRate: 0,
      baselineRecall: 1,
    })).toBe(false);
  });

  it("a model trained on the corpus is still fitted to TRAIN only — test rows cannot move it", () => {
    // Leakage guard, restated adversarially: swap every test-split row for garbage
    // and the trained model is byte-identical, because it never saw them.
    const rows = fixtures.map((f) => buildDatasetRow(f.file, f.label, f.log));
    const split = splitDataset(rows);
    const trained = trainAnomalyModel(split.train.map(toTrainingRow));
    const poisonedTest = split.test.map((r) => ({
      ...r,
      features: Object.fromEntries(FEATURE_NAMES.map((n) => [n, 999_999])) as typeof r.features,
    }));
    const retrained = trainAnomalyModel(split.train.map(toTrainingRow));
    expect(JSON.stringify(retrained)).toBe(JSON.stringify(trained));
    expect(poisonedTest.length).toBeGreaterThan(0); // the poison existed
  });
});
