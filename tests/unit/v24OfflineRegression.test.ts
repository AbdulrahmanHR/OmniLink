import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlashErrorPayload,
  FlashLogPayload,
  FlashProgressPayload,
} from "@/lib/tauri";

/**
 * v2.4 OFFLINE REGRESSION (M55) — the free local core (static wizard + local RAG
 * + BYOK) works offline and account-free.
 *
 * With Tauri mocked OFF/offline this proves the launch-gate acceptance clause
 * "the static wizard remains available offline and account-free," plus:
 *  - local RAG retrieval + citations work with no network/account;
 *  - user-imported docs import → retrieve → delete offline, account-free;
 *  - the BYOK/local send path is REACHABLE without an account (a key-less local
 *    provider is always offerable; the send target resolves purely).
 *
 * v3.0 (M69): the Managed answer path was deleted, so its four assertions were
 * trimmed from this file — the free/BYOK/local offline coverage that remains is
 * load-bearing and untouched, which is why the file is trimmed rather than
 * deleted with the rest of the platform suites.
 *
 * v3.0 (M71): folder sync — cloud sync's zero-infrastructure replacement — joins
 * the same gate at the bottom of this file. Its acceptance is *structural*: no
 * `fetch` and no `reqwest` may be reachable from any folder-sync path, on either
 * side of the seam. That belongs here, in the offline regression, rather than in
 * a parallel test of its own.
 *
 * Runs OFF-Tauri (pure logic) — the Tauri seams are mocked inert so the real
 * stores load and no network is touched.
 */

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri in test"))),
}));

const handlers = vi.hoisted(() => ({
  startFlash: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  startFlash: handlers.startFlash,
  cancelFlash: vi.fn(() => Promise.resolve()),
  onFlashProgress: (_h: (p: FlashProgressPayload) => void) => Promise.resolve(() => {}),
  onFlashLog: (_h: (l: FlashLogPayload) => void) => Promise.resolve(() => {}),
  onFlashDone: (_h: () => void) => Promise.resolve(() => {}),
  onFlashError: (_h: (e: FlashErrorPayload) => void) => Promise.resolve(() => {}),
  onFlashCancelled: (_h: () => void) => Promise.resolve(() => {}),
  saveProfile: vi.fn(() => Promise.resolve()),
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve()),
  disconnectDevice: vi.fn(() => Promise.resolve()),
  onDeviceConnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceError: vi.fn(() => Promise.resolve(() => {})),
  onLinkStats: vi.fn(() => Promise.resolve(() => {})),
}));

import { isWizardStepValid, useWizardStore } from "@/stores/wizard";
import { buildWizardSuggestion, applyWizardSuggestion } from "@/lib/wizardAssist";
import { getRetrievalIndex } from "@/lib/knowledge";
import { retrieveForChat } from "@/lib/ragRetrieval";
import {
  selectEnabledSourceIds,
  selectEnabledSourceIdsFor,
  selectRetrievalIndex,
  useKnowledgeStore,
} from "@/stores/knowledge";
import { activeSend, availableProviders } from "@/stores/assistant";
import { resetFeatureFlags } from "@/lib/featureFlags";

const wizard = () => useWizardStore.getState();
const knowledge = () => useKnowledgeStore.getState();

beforeEach(() => {
  wizard().reset();
  knowledge().reset();
  resetFeatureFlags();
  handlers.startFlash.mockClear();
});

afterEach(() => {
  resetFeatureFlags();
});

// ---------------------------------------------------------------------------
// Static wizard works offline + account-free.
// ---------------------------------------------------------------------------

describe("the static wizard works offline + account-free", () => {
  it("a full manual selection reaches review with no network/account and no flash", () => {
    wizard().setWizardMode("static");
    const s0 = wizard();
    s0.selectBrand("betafpv");
    s0.selectModel("betafpv-nano-tx-2400");
    s0.selectDomain("ISM2400");
    s0.selectFirmware("3.5.3");
    s0.selectFlashMethod("uart");
    s0.setUseTraditionalBinding(true);
    s0.goToStep("review");

    const s = wizard();
    expect(s.step).toBe("review");
    for (const step of ["brand", "model", "frequency", "binding"] as const) {
      expect(isWizardStepValid(s, step)).toBe(true);
    }
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("the deterministic AI suggestion is built + applied entirely offline", () => {
    // buildWizardSuggestion is pure (catalogue-only) — no network needed.
    const suggestion = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "freestyle",
      region: "eu",
    });
    applyWizardSuggestion(suggestion, wizard());
    expect(wizard().step).toBe("review");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Local RAG retrieval + citations work offline.
// ---------------------------------------------------------------------------

describe("local RAG retrieval + citations work offline + account-free", () => {
  it("an in-corpus question returns cited chunks from the bundled index", () => {
    const res = retrieveForChat("How do I bind my receiver to my transmitter?", {
      index: getRetrievalIndex(),
    });
    expect(res.noSourceFound).toBe(false);
    expect(res.chunks.length).toBeGreaterThan(0);
    // Citation cards carry a source + a score; outbound docs carry no score.
    const top = res.chunks[0];
    expect(top.sourceId).toBeTruthy();
    expect(top.sourceTitle).toBeTruthy();
    expect(top.score).toBeGreaterThan(0);
    expect(res.docs[0]).not.toHaveProperty("score");
  });

  it("an out-of-corpus question returns 'no source found' (no fabricated citation)", () => {
    const res = retrieveForChat("What is the best pizza topping for dinner?", {
      index: getRetrievalIndex(),
    });
    expect(res.noSourceFound).toBe(true);
    expect(res.chunks).toHaveLength(0);
    expect(res.docs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Imported docs: import → retrieve → delete, offline + account-free.
// ---------------------------------------------------------------------------

describe("user-imported docs import/retrieve/delete offline + account-free", () => {
  it("an imported note is retrievable, then leaves retrieval on delete", () => {
    const res = knowledge().importDoc(
      "quokka-note.md",
      "# Quokka tuning\nThe quokka widget uses a 250 Hz packet rate for freestyle.",
    );
    expect(res.ok).toBe(true);
    const s1 = knowledge();
    const id = s1.importedSources[0].id;
    expect(s1.importedSources[0].trustLevel).toBe("user-imported");

    // Retrievable through the SAME pipeline as trusted packs.
    const hit = retrieveForChat("quokka widget packet rate", {
      enabledSourceIds: selectEnabledSourceIds(s1),
      index: selectRetrievalIndex(s1),
    });
    expect(hit.chunks.some((c) => c.sourceId === id)).toBe(true);

    // Delete + re-index → its chunks are gone from retrieval.
    knowledge().deleteImportedSource(id);
    const s2 = knowledge();
    expect(s2.importedSources).toHaveLength(0);
    const after = retrieveForChat("quokka widget packet rate", {
      enabledSourceIds: selectEnabledSourceIds(s2),
      index: selectRetrievalIndex(s2),
    });
    expect(after.chunks.some((c) => c.sourceId === id)).toBe(false);
  });

  it("disabling a source in a chat removes it from grounding without deleting it", () => {
    const res = knowledge().importDoc(
      "quokka-note.md",
      "# Quokka\nThe quokka widget calibrates the antenna.",
    );
    const id = (res.ok && res.source.id) as string;
    const conv = "c-offline";
    knowledge().setSourceEnabled(conv, id, false);
    const s = knowledge();
    // Excluded for THIS chat, but still enabled in the all-sources baseline.
    expect(selectEnabledSourceIdsFor(s, conv).has(id)).toBe(false);
    expect(selectEnabledSourceIds(s).has(id)).toBe(true);
    const hit = retrieveForChat("quokka widget antenna", {
      enabledSourceIds: selectEnabledSourceIdsFor(s, conv),
      index: selectRetrievalIndex(s),
    });
    expect(hit.chunks.some((c) => c.sourceId === id)).toBe(false);
    // The doc still exists (not deleted) — just excluded from grounding.
    expect(s.importedSources.some((d) => d.id === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BYOK / local send path is REACHABLE without an account.
// ---------------------------------------------------------------------------

describe("BYOK / local send path is reachable account-free", () => {
  it("a key-less local provider (Ollama) is always offerable with no stored keys", () => {
    // availableProviders({}) — no keys stored at all — still offers the local
    // provider, so the free local send path never requires an account or key.
    expect(availableProviders({})).toContain("ollama");
  });

  it("the send target resolves purely from the selection + credentials (no account)", () => {
    const target = activeSend({
      selection: { provider: "ollama", model: "llama3.1" },
      credentials: {},
    });
    expect(target.provider).toBe("ollama");
    expect(target.model).toBe("llama3.1");
    // Local base URL — the key-slot defaults to the provider id (no account id).
    expect(target.baseUrl).toContain("localhost");
    expect(target.keyId).toBe("ollama");
  });
});

// ---------------------------------------------------------------------------
// The free core still resolves with no Managed transport in the build at all.
// ---------------------------------------------------------------------------

describe("the free core is complete on its own", () => {
  it("local RAG + the static wizard + BYOK are all usable with no managed path", () => {
    // Local RAG still answers.
    expect(
      retrieveForChat("What packet rate should I use for freestyle?", {
        index: getRetrievalIndex(),
      }).noSourceFound,
    ).toBe(false);
    // Static wizard still reaches review.
    applyWizardSuggestion(
      buildWizardSuggestion({ deviceRole: "RX", useCase: "racing", region: "us" }),
      wizard(),
    );
    expect(wizard().step).toBe("review");
    // BYOK/local send target still resolves.
    expect(availableProviders({})).toContain("ollama");
  });
});

// ---------------------------------------------------------------------------
// M71 — folder sync never touches the network.
//
// A structural proof, not a behavioural one: the whole reachable import closure
// of the folder-sync surface is scanned for a network verb, and the Rust module
// that owns the six filesystem commands is scanned for an HTTP client. A
// behavioural test could only show that no call happened on the paths it drove;
// this shows there is no call to make.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../src");
const TAURI_SRC = path.resolve(here, "../../src-tauri/src");

/** Comments stripped first, so prose in a docblock cannot fabricate a hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every RUNTIME (value) import specifier of one file — type-only edges cannot
 * carry a call, so counting them would report reachability the runtime lacks. */
function runtimeImports(file: string): string[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  const statement = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = statement.exec(src)) !== null) if (!m[1]) out.push(m[3]);
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamic.exec(src)) !== null) out.push(m[1]);
  const sideEffect = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((m = sideEffect.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** Resolve an `@/` or relative specifier under `src/`, or null for a package. */
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
  files: Set<string>;
  packages: Set<string>;
}

/** Transitive runtime import closure of `entries` (paths relative to `src/`). */
function closureOf(entries: readonly string[]): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = entries.map((e) => path.join(SRC, e));
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

/** Anything that would take a byte off this machine, plus endpoint literals. */
const NETWORK_VERB =
  /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection|https?:\/\//;

/** Every entry point through which folder sync can be reached. */
const FOLDER_SYNC_ENTRIES = [
  "lib/folderSync.ts", // the pure diff model
  "stores/profiles.ts", // the folder-backed source + its actions
  "components/config/FolderSync.tsx", // the surface
  "lib/tauri.ts", // the typed wrappers around the six commands
];

describe("M71 folder sync is structurally incapable of a network call", () => {
  it("the scanner is REAL: a module that names a network endpoint is caught", () => {
    // Anti-tautology control. `lib/aiContext.ts` carries the BYOK provider base
    // URLs, so it MUST trip the scan; if it stops doing so, every negative
    // result below is worthless.
    const control = closureOf(["lib/aiContext.ts"]);
    const hits = [...control.files].filter((rel) =>
      NETWORK_VERB.test(stripComments(readFileSync(path.join(SRC, rel), "utf8")))
    );
    expect(hits).toContain("lib/aiContext.ts");
  });

  it("the closure is REAL: it reaches the seam and the `.elrsp` model", () => {
    const closure = closureOf(FOLDER_SYNC_ENTRIES);
    // Not an empty/short-circuited closure: folder sync genuinely goes through
    // the ONE invoke seam and reuses the existing `.elrsp` serialisation.
    expect(closure.files.has("lib/tauri.ts")).toBe(true);
    expect(closure.files.has("lib/elrsp.ts")).toBe(true);
    expect(closure.files.has("lib/folderSync.ts")).toBe(true);
    expect(closure.files.size).toBeGreaterThan(10);
  });

  it("no `fetch`/socket/endpoint is reachable from any folder-sync path", () => {
    const closure = closureOf(FOLDER_SYNC_ENTRIES);
    const offenders = [...closure.files]
      .sort()
      .filter((rel) =>
        NETWORK_VERB.test(stripComments(readFileSync(path.join(SRC, rel), "utf8")))
      );
    expect(offenders, "a folder-sync path can reach the network").toEqual([]);
  });

  it("no HTTP client package is reachable from any folder-sync path", () => {
    const closure = closureOf(FOLDER_SYNC_ENTRIES);
    const networkPackages = [...closure.packages].filter((p) =>
      /http|fetch|axios|ws|socket/i.test(p)
    );
    expect(networkPackages).toEqual([]);
    // The only Tauri packages it may use are the IPC seam, the event seam and
    // the dialog plugin that supplies the folder picker.
    expect([...closure.packages].filter((p) => p.startsWith("@tauri-apps")).sort()).toEqual([
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/plugin-dialog",
    ]);
  });

  it("the Rust side owns no HTTP client either", () => {
    // `commands/config.rs` is the entire Rust surface of folder sync (the
    // `folder_sync` module lives in it), and `lib.rs` is where it is registered.
    // Needles are assembled so this file's own text cannot satisfy the search.
    const forbidden = [
      ["req", "west"],
      ["ur", "eq"],
      ["Tcp", "Stream"],
      ["Udp", "Socket"],
      ["http", "://"],
    ].map(([a, b]) => `${a}${b}`);

    const configRs = readFileSync(path.join(TAURI_SRC, "commands/config.rs"), "utf8");
    // Control: the module really is a filesystem module.
    expect(configRs).toContain("std::fs");
    for (const needle of forbidden) {
      expect(configRs.includes(needle), `commands/config.rs mentions ${needle}`).toBe(
        false
      );
    }

    // The plugin registration wires only the six commands — nothing network-y.
    const libRs = readFileSync(path.join(TAURI_SRC, "lib.rs"), "utf8");
    const registration = libRs.slice(
      libRs.indexOf("folder_sync::PLUGIN_NAME"),
      libRs.indexOf("folder_sync::delete")
    );
    expect(registration.length).toBeGreaterThan(0);
    for (const needle of forbidden) {
      expect(registration.includes(needle)).toBe(false);
    }
  });
});
