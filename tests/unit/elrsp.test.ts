import { describe, expect, it } from "vitest";
import {
  ELRSP_SCHEMA_VERSION,
  type ElrspDocument,
  serializeElrsp,
  parseElrsp,
  migrateElrsp,
  firmwareCompat,
  elrspToProfile,
} from "@/lib/elrsp";
import type { ProfileSettings } from "@/lib/profileSettings";

const settings: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: true,
  modelId: 7,
  bindingPhrase: "omni-test",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

function fullDoc(): ElrspDocument {
  return {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: "Test Profile",
    description: "a description",
    tags: ["racing", "fast"],
    firmwareVersion: "3.4.1",
    settings: { ...settings },
    updatedAt: 1700000000000,
  };
}

describe("serializeElrsp / parseElrsp", () => {
  it("round-trips a full current-schema document", () => {
    const doc = fullDoc();
    const parsed = parseElrsp(serializeElrsp(doc));
    expect(parsed).toEqual(doc);
  });

  it("serialises to pretty, human-readable JSON (2-space indent)", () => {
    const json = serializeElrsp(fullDoc());
    expect(json).toContain("\n  ");
    expect(json).toContain('"schemaVersion": 1');
  });

  it("rejects non-JSON garbage", () => {
    expect(() => parseElrsp("not json at all {{{")).toThrow();
  });

  it("rejects a document missing a settings key", () => {
    const doc = fullDoc();
    const raw = JSON.parse(serializeElrsp(doc)) as Record<string, unknown>;
    delete (raw.settings as Record<string, unknown>).fanThreshold;
    expect(() => parseElrsp(JSON.stringify(raw))).toThrow();
  });

  it("rejects an unknown future schema version", () => {
    const raw = JSON.parse(serializeElrsp(fullDoc())) as Record<string, unknown>;
    raw.schemaVersion = 2;
    expect(() => parseElrsp(JSON.stringify(raw))).toThrow();
  });
});

describe("migrateElrsp", () => {
  it("upgrades a legacy v0 document and reports migrated:true", () => {
    const { fanThreshold: _omit, ...legacySettings } = settings;
    const legacy = {
      name: "Legacy Profile",
      description: "old",
      settings: legacySettings,
      savedAt: 123,
    };
    const { doc, migrated } = migrateElrsp(legacy);
    expect(migrated).toBe(true);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.settings.fanThreshold).toBe(250);
    expect(doc.updatedAt).toBe(123);
    expect(doc.tags).toEqual([]);
  });

  it("passes through a current document with migrated:false", () => {
    const doc = fullDoc();
    const result = migrateElrsp(doc);
    expect(result.migrated).toBe(false);
    expect(result.doc).toEqual(doc);
  });

  it("throws on an unsupported future schema version", () => {
    expect(() => migrateElrsp({ ...fullDoc(), schemaVersion: 2 })).toThrow();
  });
});

describe("firmwareCompat", () => {
  it("ok when same major and minor", () => {
    expect(firmwareCompat("3.4.1", "3.4.9")).toBe("ok");
  });

  it("ok within one minor", () => {
    expect(firmwareCompat("3.4.0", "3.5.0")).toBe("ok");
  });

  it("warn when minor differs by more than one", () => {
    expect(firmwareCompat("3.2.0", "3.5.0")).toBe("warn");
  });

  it("warn when major differs", () => {
    expect(firmwareCompat("2.9.0", "3.0.0")).toBe("warn");
  });

  it("unknown when a side is undefined", () => {
    expect(firmwareCompat(undefined, "3.4.0")).toBe("unknown");
    expect(firmwareCompat("3.4.0", undefined)).toBe("unknown");
  });

  it("unknown when a side is unparseable", () => {
    expect(firmwareCompat("abc", "3.4.0")).toBe("unknown");
  });

  it("unknown when the device reported no version at all", () => {
    // FWCHK: `DeviceInfo.firmwareVersion` is `null` when the device sent no
    // firmware word (a Betaflight FC answering our ping on the shared CRSF UART
    // sends an all-zero triple). The backend used to substitute "0.0.0", which
    // parses fine and made EVERY import a permanent major-version "warn" — the
    // compat warning became noise instead of signal.
    expect(firmwareCompat("3.5.3", null)).toBe("unknown");
    expect(firmwareCompat("3.5.3", "0.0.0")).toBe("warn");
  });

  it("parses a v-prefixed version instead of silently giving up", () => {
    // FWCHK-6: `.elrsp` files are user-authored and the hosted-preset form lets
    // firmwareVersion be typed freely, so "v3.5.3" really turns up. The anchored
    // /^(\d+)\.(\d+)/ made it "unknown", which suppressed the import mismatch
    // warning entirely — the failure mode is silence, not a wrong answer.
    expect(firmwareCompat("v3.2.0", "3.5.0")).toBe("warn");
    expect(firmwareCompat("3.2.0", "v3.5.0")).toBe("warn");
    expect(firmwareCompat("v2.9.0", "v3.0.0")).toBe("warn");
    // …and it must not start reporting false mismatches for compatible pairs.
    expect(firmwareCompat("v3.4.1", "3.4.9")).toBe("ok");
    expect(firmwareCompat("V3.4.0", "v3.5.0")).toBe("ok");
    // Whitespace is still tolerated around the prefix form.
    expect(firmwareCompat("  v3.4.1  ", "3.4.9")).toBe("ok");
    // A leading letter that ISN'T the version `v` stays unparseable.
    expect(firmwareCompat("x3.4.0", "3.4.0")).toBe("unknown");
    expect(firmwareCompat("v", "3.4.0")).toBe("unknown");
  });
});

describe("elrspToProfile", () => {
  it("carries settings/name/description/updatedAt and mints a string id", () => {
    const doc = fullDoc();
    const profile = elrspToProfile(doc);
    expect(profile.settings).toEqual(doc.settings);
    expect(profile.name).toBe(doc.name);
    expect(profile.description).toBe(doc.description);
    expect(profile.updatedAt).toBe(doc.updatedAt);
    expect(typeof profile.id).toBe("string");
    expect(profile.id.length).toBeGreaterThan(0);
    expect(profile.builtin).toBeUndefined();
    expect(profile.nameKey).toBeUndefined();
  });
});
