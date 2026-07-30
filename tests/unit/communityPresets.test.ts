import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PRESETS,
  searchPresets,
  communityPresetToElrsp,
  loadCommunityPresetForImport,
  type CommunityPreset,
} from "@/lib/communityPresets";
import { ELRSP_SCHEMA_VERSION, serializeElrsp, parseElrsp, elrspToProfile } from "@/lib/elrsp";

const SETTING_KEYS = [
  "packetRate",
  "telemetryRatio",
  "switchMode",
  "txPower",
  "dynamicPower",
  "modelMatch",
  "modelId",
  "bindingPhrase",
  "antennaMode",
  "fanThreshold",
] as const;

const LEGACY_ID = "preset-cinematic-smooth-150";

describe("COMMUNITY_PRESETS catalog", () => {
  it("is non-empty", () => {
    expect(COMMUNITY_PRESETS.length).toBeGreaterThan(0);
  });

  it("every entry is a valid, fully-migrated CommunityPreset", () => {
    for (const p of COMMUNITY_PRESETS) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.name).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(typeof p.category).toBe("string");
      expect(Array.isArray(p.tags)).toBe(true);
      for (const key of SETTING_KEYS) {
        expect(p.settings[key]).toBeDefined();
      }
      // Catalog is post-migration: even legacy presets carry fanThreshold.
      expect(typeof p.settings.fanThreshold).toBe("number");
    }
  });
});

describe("searchPresets", () => {
  const sample: CommunityPreset[] = [
    {
      id: "a",
      name: "Racing Beast",
      description: "low latency",
      category: "racing",
      tags: ["fast", "competition"],
      settings: COMMUNITY_PRESETS[0].settings,
    },
    {
      id: "b",
      name: "Cruiser",
      description: "smooth long flights",
      category: "cinematic",
      tags: ["calm"],
      settings: COMMUNITY_PRESETS[0].settings,
    },
  ];

  it("matches case-insensitively over name", () => {
    expect(searchPresets(sample, "racing beast").map((p) => p.id)).toEqual(["a"]);
  });

  it("matches over description, tags, and category", () => {
    expect(searchPresets(sample, "LATENCY").map((p) => p.id)).toEqual(["a"]);
    expect(searchPresets(sample, "calm").map((p) => p.id)).toEqual(["b"]);
    expect(searchPresets(sample, "CINEMATIC").map((p) => p.id)).toEqual(["b"]);
  });

  it("returns all for an empty/whitespace query", () => {
    expect(searchPresets(sample, "")).toHaveLength(2);
    expect(searchPresets(sample, "   ")).toHaveLength(2);
  });

  it("returns [] when nothing matches", () => {
    expect(searchPresets(sample, "zzz-no-match")).toEqual([]);
  });
});

describe("communityPresetToElrsp -> elrspToProfile round-trip", () => {
  it("preset -> ElrspDocument preserves settings at current schema", () => {
    const p = COMMUNITY_PRESETS[0];
    const doc = communityPresetToElrsp(p);
    expect(doc.schemaVersion).toBe(ELRSP_SCHEMA_VERSION);
    expect(doc.settings).toEqual(p.settings);
  });

  it("ElrspDocument -> profile preserves settings", () => {
    const p = COMMUNITY_PRESETS[0];
    const profile = elrspToProfile(communityPresetToElrsp(p));
    expect(profile.settings).toEqual(p.settings);
  });
});

describe("loadCommunityPresetForImport", () => {
  it("surfaces migrated:true for the legacy bundled preset and yields a valid doc", () => {
    const { doc, migrated } = loadCommunityPresetForImport(LEGACY_ID);
    expect(migrated).toBe(true);
    expect(doc.settings.fanThreshold).toBeDefined();
    // Valid current-schema document: serialise + parse must succeed.
    expect(() => parseElrsp(serializeElrsp(doc))).not.toThrow();
  });

  it("reports migrated:false for a current-schema preset", () => {
    const current = COMMUNITY_PRESETS.find((p) => p.id !== LEGACY_ID);
    expect(current).toBeDefined();
    const { migrated } = loadCommunityPresetForImport(current!.id);
    expect(migrated).toBe(false);
  });

  it("throws on an unknown id", () => {
    expect(() => loadCommunityPresetForImport("does-not-exist")).toThrow();
  });
});
