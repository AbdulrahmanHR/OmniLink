import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v2.5 OFFLINE REGRESSION (M60) — **nothing in the ML path touches the network.**
 *
 * D22 says training and inference are ON-DEVICE. This proves it the way the v2.4
 * offline regression proves its half: not by grepping for a comment, but by
 * driving the WHOLE ML line — feature extraction over the real 36-fixture corpus,
 * the seeded split, training an isolation forest from scratch, scoring +
 * explaining a session, the M59 predictor, the eval harness, the readiness report
 * — with:
 *
 *  - the Tauri IPC seam mocked OFF (`isTauri()` false, every `invoke` rejects);
 *  - the SQLite plugin mocked OFF (`Database.load` rejects);
 *  - **every network API on the global object replaced by a spy that throws**:
 *    `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`.
 *
 * Every spy must record ZERO calls. The spies are proven live by a control test
 * that trips each one deliberately — so a passing run means "the ML line made no
 * network call", not "the harness cannot see network calls".
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.reject(new Error("offline"))),
}));
const sql = vi.hoisted(() => ({
  load: vi.fn(() => Promise.reject(new Error("no database offline"))),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: sql.load },
}));

import { isTauri } from "@tauri-apps/api/core";
import { evaluateSession } from "@/lib/diagnostics";
import {
  buildDatasetRow,
  buildReadinessReport,
  countLabels,
  explainSession,
  extractFeatures,
  predictOverLog,
  runMlEval,
  serializeAnomalyModel,
  splitDataset,
  toMlLabel,
  toTrainingRow,
  trainAnomalyModel,
  DEFAULT_SEED,
  type MlGroundTruth,
  type MlPredictions,
} from "@/lib/ml";
import { listSessionLabels, setSessionLabel } from "@/lib/session-labels";
import { loadAllFixtures } from "../diagnostics/fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../src");
const fixtures = loadAllFixtures();

// ---------------------------------------------------------------------------
// The network trap: every egress API on the global object, replaced by a spy.
// ---------------------------------------------------------------------------

interface NetworkTrap {
  fetch: ReturnType<typeof vi.fn>;
  xhrOpen: ReturnType<typeof vi.fn>;
  websocket: ReturnType<typeof vi.fn>;
  eventSource: ReturnType<typeof vi.fn>;
  sendBeacon: ReturnType<typeof vi.fn>;
  /** Total calls across every egress API. */
  total(): number;
}

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown> = {};
let trap: NetworkTrap;

function installNetworkTrap(): NetworkTrap {
  const t: NetworkTrap = {
    fetch: vi.fn(() => {
      throw new Error("network call attempted (fetch)");
    }),
    xhrOpen: vi.fn(() => {
      throw new Error("network call attempted (XMLHttpRequest)");
    }),
    websocket: vi.fn(() => {
      throw new Error("network call attempted (WebSocket)");
    }),
    eventSource: vi.fn(() => {
      throw new Error("network call attempted (EventSource)");
    }),
    sendBeacon: vi.fn(() => {
      throw new Error("network call attempted (sendBeacon)");
    }),
    total: () =>
      t.fetch.mock.calls.length +
      t.xhrOpen.mock.calls.length +
      t.websocket.mock.calls.length +
      t.eventSource.mock.calls.length +
      t.sendBeacon.mock.calls.length,
  };

  // `navigator` is a getter-only global in Node, so every override goes through
  // `defineProperty` (and is restored the same way in afterEach).
  const install = (key: string, value: unknown): void => {
    saved[key] = Object.getOwnPropertyDescriptor(g, key);
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  };

  saved = {};
  install("fetch", t.fetch);
  install(
    "XMLHttpRequest",
    class {
      open(...args: unknown[]) {
        return t.xhrOpen(...(args as []));
      }
      send() {
        return t.xhrOpen();
      }
    }
  );
  install(
    "WebSocket",
    class {
      constructor(...args: unknown[]) {
        t.websocket(...(args as []));
      }
    }
  );
  install(
    "EventSource",
    class {
      constructor(...args: unknown[]) {
        t.eventSource(...(args as []));
      }
    }
  );
  install("navigator", { ...(g.navigator as object), sendBeacon: t.sendBeacon });
  return t;
}

beforeEach(() => {
  trap = installNetworkTrap();
  tauri.invoke.mockClear();
  sql.load.mockClear();
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor === undefined) delete g[key];
    else Object.defineProperty(g, key, descriptor as PropertyDescriptor);
  }
});

// ---------------------------------------------------------------------------
// The control — the trap can actually see a network call.
// ---------------------------------------------------------------------------

describe("the network trap is LIVE (without this, every assertion below is vacuous)", () => {
  it("catches a deliberate fetch / XHR / WebSocket / EventSource / sendBeacon", () => {
    const G = globalThis as unknown as {
      fetch: (u: string) => unknown;
      XMLHttpRequest: new () => { open: (m: string, u: string) => void };
      WebSocket: new (u: string) => unknown;
      EventSource: new (u: string) => unknown;
      navigator: { sendBeacon: (u: string) => boolean };
    };
    expect(() => G.fetch("https://example.test/telemetry")).toThrow(/network call/);
    expect(() => new G.XMLHttpRequest().open("POST", "https://example.test")).toThrow(
      /network call/
    );
    expect(() => new G.WebSocket("wss://example.test")).toThrow(/network call/);
    expect(() => new G.EventSource("https://example.test")).toThrow(/network call/);
    expect(() => G.navigator.sendBeacon("https://example.test")).toThrow(/network call/);
    expect(trap.total()).toBe(5);
  });

  it("the Tauri + SQLite seams are genuinely mocked OFF", () => {
    expect(isTauri()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The whole ML line, driven end to end, offline.
// ---------------------------------------------------------------------------

describe("the ENTIRE ML line runs on-device: zero network, zero IPC (D22)", () => {
  it("features → split → TRAIN → score → explain → predict → eval, with the trap armed", () => {
    // 1. Feature extraction over the real corpus.
    const rows = fixtures.map((f) => buildDatasetRow(f.file, f.label, f.log));
    expect(rows).toHaveLength(36);
    expect(Object.keys(rows[0].features)).toHaveLength(43);

    // 2. The seeded, session-level split.
    const split = splitDataset(rows, { seed: DEFAULT_SEED });
    expect(split.train.length).toBeGreaterThan(0);

    // 3. TRAINING — the part D22 is actually about. On-device, from scratch.
    const trained = trainAnomalyModel(split.train.map(toTrainingRow));
    expect(trained.trees).toHaveLength(100);
    expect(serializeAnomalyModel(trained).length).toBeGreaterThan(1000);

    // 4. Inference + explanation.
    const f = fixtures.find((x) => x.label === "failsafe")!;
    const report = evaluateSession(f.log);
    const output = explainSession(trained, f.log, report);
    expect(output.advisory).toBe(true);
    expect(output.topFeatures).toHaveLength(5);

    // 5. The M59 predictor over a recorded session.
    predictOverLog(f.log);

    // 6. The eval harness + the readiness report.
    const truth: MlGroundTruth = {
      sessions: fixtures.map((x) => ({
        sessionId: x.file,
        label: toMlLabel(x.label),
        clean: x.expectClean,
      })),
      findings: [],
    };
    const predictions: MlPredictions = {
      sessions: fixtures.map((x) => ({
        sessionId: x.file,
        flagged: !x.expectClean,
        findingCount: x.expectedFindings.length,
      })),
    };
    const evalReport = runMlEval(predictions, truth);
    expect(evalReport.perSession.recall.value).toBe(1);
    expect(buildReadinessReport(countLabels(["healthy", "warning"])).verdict).toBe(
      "not-enough-data"
    );

    // 7. THE PROOF: nothing left the machine, and no IPC command was invoked.
    expect(trap.fetch).not.toHaveBeenCalled();
    expect(trap.xhrOpen).not.toHaveBeenCalled();
    expect(trap.websocket).not.toHaveBeenCalled();
    expect(trap.eventSource).not.toHaveBeenCalled();
    expect(trap.sendBeacon).not.toHaveBeenCalled();
    expect(trap.total()).toBe(0);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("training is deterministic offline: same rows + same seed ⇒ byte-identical model", () => {
    const rows = fixtures.map((f) => buildDatasetRow(f.file, f.label, f.log));
    const train = splitDataset(rows, { seed: DEFAULT_SEED }).train.map(toTrainingRow);
    expect(serializeAnomalyModel(trainAnomalyModel(train))).toBe(
      serializeAnomalyModel(trainAnomalyModel(train))
    );
    expect(trap.total()).toBe(0);
  });

  it("inference over every fixture in the corpus touches nothing external", () => {
    const rows = fixtures.map((f) => buildDatasetRow(f.file, f.label, f.log));
    const model = trainAnomalyModel(
      splitDataset(rows).train.map(toTrainingRow)
    );
    for (const f of fixtures) {
      extractFeatures(f.log);
      explainSession(model, f.log, evaluateSession(f.log));
      predictOverLog(f.log);
    }
    expect(trap.total()).toBe(0);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("the label seam degrades silently off-Tauri — no DB, no IPC, no throw", async () => {
    await expect(listSessionLabels()).resolves.toEqual([]);
    await expect(setSessionLabel("sess-1", "healthy", 1000)).resolves.toBeUndefined();
    expect(sql.load).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(trap.total()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Source-level: no ML file can even NAME a network API.
//
// The runtime trap proves today's code makes no call. This proves tomorrow's
// cannot slip one in unnoticed — it is the assertion that goes red on the commit
// that adds `fetch(...)` to the ML line, even if that call sits on a branch the
// test corpus never takes.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ML_FILES = [
  ...sourceFiles(path.join(SRC, "lib/ml")),
  ...sourceFiles(path.join(SRC, "components/ml")),
  path.join(SRC, "lib/session-labels.ts"),
];

const NETWORK_TOKENS = [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "@tauri-apps/plugin-http",
  "plugin-upload",
  "axios",
  "http://",
  "https://",
];

describe("no ML source file names a network API (the guard against a FUTURE fetch)", () => {
  it("holds for every file in src/lib/ml, src/components/ml, and the label seam", () => {
    for (const file of ML_FILES) {
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const token of NETWORK_TOKENS) {
        expect(
          src.includes(token),
          `${path.relative(SRC, file)} references a network API: "${token}"`
        ).toBe(false);
      }
    }
    expect(ML_FILES.length).toBeGreaterThan(13); // the sweep really covered the line
  });

  it("the lab UI's only dynamic imports are LOCAL checked-in artifacts (not a remote model fetch)", () => {
    // The panels lazily `import()` the model + report JSON so a flag-off user never
    // pays for them. A dynamic import of a *URL* would be a model download; these
    // are relative paths into the repo, bundled at build time.
    for (const file of sourceFiles(path.join(SRC, "components/ml"))) {
      const src = readFileSync(file, "utf8");
      const dynamic = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
      for (const spec of dynamic) {
        expect(spec.startsWith("."), `remote dynamic import: ${spec}`).toBe(true);
        expect(spec.endsWith(".json")).toBe(true);
      }
    }
  });
});
