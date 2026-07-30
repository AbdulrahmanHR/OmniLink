import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSettings } from "@/lib/profileSettings";

/**
 * v3.0 FREE-CORE REGRESSION GUARD (M69).
 *
 * M69 deletes the entire v2.1/v2.3/v2.4-Managed platform mock stack — accounts,
 * billing, entitlements, cloud sync, sponsors/announcements, hosted presets and
 * the Managed AI answer path. Non-Negotiable Product Rule #4 for the v3.0 line is
 * "no capability regression": nothing a `2.5.2` user can actually reach may stop
 * working.
 *
 * This file is that rule made executable. It pins the six load-bearing free-core
 * surfaces named in the M69 brief and asserts them WITHOUT importing a single
 * module on the excision list, so it compiles and passes identically **before**
 * and **after** the deletion. A guard that only passes afterwards is not a guard:
 * this one was authored and run green on the unmodified `2.5.2` tree first, then
 * re-run after the excision.
 *
 * The six surfaces:
 *  1. the profiles store loads, saves and applies;
 *  2. `.elrsp` round-trips (serialise → parse → profile);
 *  3. the BYOK provider list is complete and contains **no `managed` entry**;
 *  4. the local diagnostic engine evaluates a session;
 *  5. the local knowledge/RAG index answers an in-corpus question;
 *  6. `getFeatureFlag("mlLab")` still exists.
 *
 * Runs OFF-Tauri (pure logic): the persistence seam is mocked so the store's
 * fire-and-forget writes are observable without a backend, a filesystem or a
 * network.
 */

// ---------------------------------------------------------------------------
// Tauri seam — mocked so the profiles store's persistence path is observable.
// ---------------------------------------------------------------------------

const core = vi.hoisted(() => ({ isTauriValue: true }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => core.isTauriValue,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri in test"))),
}));

const tauri = vi.hoisted(() => ({
  saveProfile: vi.fn(() => Promise.resolve()),
  deleteStoredProfile: vi.fn(() => Promise.resolve()),
  loadProfiles: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/tauri", () => ({
  saveProfile: tauri.saveProfile,
  deleteStoredProfile: tauri.deleteStoredProfile,
  loadProfiles: tauri.loadProfiles,
}));

import {
  ELRSP_SCHEMA_VERSION,
  elrspToProfile,
  parseElrsp,
  serializeElrsp,
  type ElrspDocument,
} from "@/lib/elrsp";
import { PROVIDERS, PROVIDER_IDS } from "@/lib/aiContext";
import { evaluateSession } from "@/lib/diagnostics";
import { getRetrievalIndex, retrieve } from "@/lib/knowledge";
import { getFeatureFlag, resetFeatureFlags } from "@/lib/featureFlags";
import { buildLog } from "./diagnostics/fixtures";

/** Fresh module instance per test so the store's initial state resets. */
async function loadProfilesStore() {
  vi.resetModules();
  const mod = await import("@/stores/profiles");
  return mod.useProfilesStore;
}

const SETTINGS: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: true,
  modelId: 7,
  bindingPhrase: "omni-core-intact",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

beforeEach(() => {
  vi.clearAllMocks();
  core.isTauriValue = true;
  resetFeatureFlags();
});

// ---------------------------------------------------------------------------
// 1. Profiles store — load, save, apply.
// ---------------------------------------------------------------------------

describe("free core: the profiles store loads, saves and applies", () => {
  it("hydrates the bundled library with no stored user profiles", async () => {
    const useProfilesStore = await loadProfilesStore();
    const s = useProfilesStore.getState();
    // Factory/bundled presets are real and always present, account-free.
    expect(s.profiles.length).toBeGreaterThan(0);
    expect(s.userProfiles).toHaveLength(0);
    expect(s.selectedId).toBe(s.profiles[0].id);
  });

  it("saves the active config as a user profile and persists it through the seam", async () => {
    const useProfilesStore = await loadProfilesStore();
    const before = useProfilesStore.getState().profiles.length;

    const id = useProfilesStore
      .getState()
      .saveCurrentAsProfile("Core Intact", "written by the v3.0 guard");

    const s = useProfilesStore.getState();
    expect(id).toBeTruthy();
    expect(s.profiles.length).toBe(before + 1);
    expect(s.userProfiles.some((p) => p.id === id)).toBe(true);
    // The local JSON persistence seam was actually driven (no cloud involved).
    expect(tauri.saveProfile).toHaveBeenCalledTimes(1);
  });

  it("applies a profile into the active config and marks it applied", async () => {
    const useProfilesStore = await loadProfilesStore();
    const target = useProfilesStore.getState().profiles.at(-1);
    expect(target).toBeDefined();

    useProfilesStore.getState().applyProfile(target!.id);

    const s = useProfilesStore.getState();
    expect(s.appliedId).toBe(target!.id);
    expect(s.activeSettings).toEqual(target!.settings);
    // Applying is a local operation — nothing is uploaded, nothing errors.
    expect(s.persistError).toBeNull();
  });

  it("imports an .elrsp document as a user profile (the free import on-ramp)", async () => {
    const useProfilesStore = await loadProfilesStore();
    const doc: ElrspDocument = {
      schemaVersion: ELRSP_SCHEMA_VERSION,
      name: "Imported",
      settings: { ...SETTINGS },
      updatedAt: 1_700_000_000_000,
    };

    const id = useProfilesStore.getState().importProfile(doc);

    const s = useProfilesStore.getState();
    expect(s.profiles.find((p) => p.id === id)?.settings).toEqual(SETTINGS);
    expect(s.selectedId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// 2. `.elrsp` round-trip.
// ---------------------------------------------------------------------------

describe("free core: .elrsp round-trips", () => {
  it("serialise → parse returns an identical document", () => {
    const doc: ElrspDocument = {
      schemaVersion: ELRSP_SCHEMA_VERSION,
      name: "Round Trip",
      description: "guarded by v30CoreIntact",
      tags: ["racing", "long-range"],
      firmwareVersion: "3.5.3",
      settings: { ...SETTINGS },
      updatedAt: 1_700_000_000_000,
    };

    expect(parseElrsp(serializeElrsp(doc))).toEqual(doc);
  });

  it("a parsed document converts to a usable profile with its settings intact", () => {
    const doc: ElrspDocument = {
      schemaVersion: ELRSP_SCHEMA_VERSION,
      name: "Round Trip",
      settings: { ...SETTINGS },
      updatedAt: 1_700_000_000_000,
    };

    const profile = elrspToProfile(parseElrsp(serializeElrsp(doc)));
    expect(profile.settings).toEqual(SETTINGS);
    expect(profile.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. BYOK provider list — complete, and free of any `managed` entry.
// ---------------------------------------------------------------------------

describe("free core: the BYOK provider list is complete and account-free", () => {
  it("offers exactly the five BYOK/local providers", () => {
    expect([...PROVIDER_IDS].sort()).toEqual([
      "anthropic",
      "gemini",
      "ollama",
      "openai",
      "openrouter",
    ]);
  });

  it("contains no `managed` entry under any casing", () => {
    for (const id of PROVIDER_IDS) {
      expect(String(id).toLowerCase()).not.toContain("managed");
    }
    expect(Object.keys(PROVIDERS)).not.toContain("managed");
  });

  it("every provider is directly addressable — a real base URL and models", () => {
    for (const id of PROVIDER_IDS) {
      const cfg = PROVIDERS[id];
      expect(cfg.defaultBaseUrl).toMatch(/^https?:\/\//);
      expect(cfg.models.length).toBeGreaterThan(0);
      // No proxy/broker host: every provider is reached by the user's own key.
      expect(cfg.defaultBaseUrl).not.toContain("omnilink");
    }
  });

  it("at least one provider needs no key at all, so AI works with zero accounts", () => {
    expect(PROVIDER_IDS.some((id) => !PROVIDERS[id].requiresKey)).toBe(true);
    expect(PROVIDERS.ollama.requiresKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Local diagnostics evaluate.
// ---------------------------------------------------------------------------

describe("free core: the local diagnostic engine evaluates", () => {
  it("a healthy session scores high and raises no critical finding", () => {
    const report = evaluateSession(
      buildLog({
        linkQuality: Array.from({ length: 400 }, () => 99),
        rssi1: Array.from({ length: 400 }, () => -55),
        snr: Array.from({ length: 400 }, () => 10),
        txPower: Array.from({ length: 400 }, () => 100),
      }),
    );

    expect(report.healthScore).toBeGreaterThan(80);
    expect(report.findings.filter((f) => f.severity === "critical")).toHaveLength(0);
    expect(report.sessionSummary.sampleCount).toBe(400);
  });

  it("a collapsing link produces findings and a lower score", () => {
    const collapse = Array.from({ length: 400 }, (_, i) => (i > 200 ? 5 : 99));
    const report = evaluateSession(
      buildLog({
        linkQuality: collapse,
        rssi1: Array.from({ length: 400 }, (_, i) => (i > 200 ? -119 : -55)),
        snr: Array.from({ length: 400 }, (_, i) => (i > 200 ? -12 : 10)),
        txPower: Array.from({ length: 400 }, () => 100),
      }),
    );

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.healthScore).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// 5. The local knowledge index answers.
// ---------------------------------------------------------------------------

describe("free core: the local knowledge index answers", () => {
  it("an in-corpus question retrieves cited chunks from the bundled index", () => {
    const res = retrieve(
      "How do I bind my receiver to my transmitter?",
      getRetrievalIndex(),
    );

    expect(res.noSourceFound).toBe(false);
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks[0].sourceId).toBeTruthy();
    expect(res.chunks[0].sourceTitle).toBeTruthy();
    expect(res.chunks[0].score).toBeGreaterThan(0);
  });

  it("an out-of-corpus question fabricates nothing (D19 'no source found')", () => {
    const res = retrieve(
      "What is the best pizza topping for dinner?",
      getRetrievalIndex(),
    );

    expect(res.noSourceFound).toBe(true);
    expect(res.chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The `mlLab` flag survives.
// ---------------------------------------------------------------------------

describe("free core: getFeatureFlag('mlLab') still exists", () => {
  it("resolves to a boolean and ships OFF", () => {
    expect(typeof getFeatureFlag("mlLab")).toBe("boolean");
    expect(getFeatureFlag("mlLab")).toBe(false);
  });
});
