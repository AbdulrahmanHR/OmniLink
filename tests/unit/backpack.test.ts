import { describe, expect, it } from "vitest";
import {
  classifyBackpackSsid,
  backpackSsidToDevice,
  backpackKindLabelKey,
  parseBackpackTargets,
  isBackpackCrossTypeFlash,
  wifiDeviceBackpackKind,
  type BackpackKind,
  type BackpackTarget,
} from "@/lib/backpack";
import { classifyElrsSsid, type WifiDevice } from "@/lib/wifiDiscovery";
import {
  BACKPACK_FIELDS,
  BACKPACK_SETTINGS_KEYS,
  DEFAULT_BACKPACK_SETTINGS,
} from "@/lib/backpackConfig";
import backpackJson from "../../data/targets/backpack.json";

describe("classifyBackpackSsid (accept)", () => {
  it("accepts the canonical TX / VRX Backpack self-AP SSIDs with the right role", () => {
    expect(classifyBackpackSsid("ExpressLRS TX Backpack")).toEqual({
      isBackpack: true,
      kind: "tx-backpack",
    });
    expect(classifyBackpackSsid("ExpressLRS VRX Backpack")).toEqual({
      isBackpack: true,
      kind: "vrx-backpack",
    });
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(classifyBackpackSsid("expresslrs  tx  backpack")).toEqual({
      isBackpack: true,
      kind: "tx-backpack",
    });
    expect(classifyBackpackSsid("EXPRESSLRS VRX BACKPACK")).toEqual({
      isBackpack: true,
      kind: "vrx-backpack",
    });
  });

  it("tolerates a trailing suffix/number", () => {
    expect(classifyBackpackSsid("ExpressLRS TX Backpack 02")).toEqual({
      isBackpack: true,
      kind: "tx-backpack",
    });
    expect(classifyBackpackSsid("ExpressLRS VRX Backpack 02")).toEqual({
      isBackpack: true,
      kind: "vrx-backpack",
    });
  });
});

describe("classifyBackpackSsid (reject)", () => {
  it("rejects plain ELRS, unrelated, empty, and role-less SSIDs", () => {
    const rejected = {
      isBackpack: false,
      kind: null,
    };
    expect(classifyBackpackSsid("ExpressLRS TX")).toEqual(rejected);
    expect(classifyBackpackSsid("ExpressLRS RX 01")).toEqual(rejected);
    expect(classifyBackpackSsid("MyHomeWiFi")).toEqual(rejected);
    expect(classifyBackpackSsid("")).toEqual(rejected);
    // "expresslrs" + nothing else: no backpack token, no role token.
    expect(classifyBackpackSsid("ExpressLRS")).toEqual(rejected);
    // "backpack" + "expresslrs" but neither a VRX nor a whole-word TX token.
    expect(classifyBackpackSsid("ExpressLRS Backpack")).toEqual(rejected);
  });

  // M29 hardening: an SSID that carries both "expresslrs" and "backpack" but only
  // a "txt" NOISE token (not a whole-word "tx") is NOT a classifiable Backpack —
  // a substring role match would wrongly surface it as a TX Backpack.
  it("does not treat 'TXT' noise as a TX-Backpack role (whole-word only)", () => {
    expect(classifyBackpackSsid("ExpressLRS TXT Backpack")).toEqual({
      isBackpack: false,
      kind: null,
    });
  });
});

// THE NON-LEAK INVARIANT: a Backpack SSID is discovered AS a Backpack by the M19
// classifier yet is STILL rejected by the M18 self-AP classifier, so it can
// never leak into the plain ELRS TX/RX list. The two classifiers are exact
// complements on these SSIDs.
describe("non-leak invariant (M18/M19 boundary)", () => {
  it("Backpack SSIDs are accepted by M19 AND rejected by M18 simultaneously", () => {
    for (const ssid of ["ExpressLRS TX Backpack", "ExpressLRS VRX Backpack"]) {
      const backpack = classifyBackpackSsid(ssid);
      const elrs = classifyElrsSsid(ssid);
      // M19 claims it...
      expect(backpack.isBackpack).toBe(true);
      // ...and M18 refuses it (never leaks into the plain TX/RX list).
      expect(elrs.isElrs).toBe(false);
    }
  });

  it("preserves the per-role mapping under the invariant", () => {
    expect(classifyBackpackSsid("ExpressLRS TX Backpack").kind).toBe("tx-backpack");
    expect(classifyBackpackSsid("ExpressLRS VRX Backpack").kind).toBe("vrx-backpack");
    expect(classifyElrsSsid("ExpressLRS TX Backpack").isElrs).toBe(false);
    expect(classifyElrsSsid("ExpressLRS VRX Backpack").isElrs).toBe(false);
  });

  it("plain 'ExpressLRS TX' is the mirror image: M18 accepts, M19 rejects", () => {
    const elrs = classifyElrsSsid("ExpressLRS TX");
    expect(elrs.isElrs).toBe(true);
    expect(elrs.kind).toBe("tx");

    const backpack = classifyBackpackSsid("ExpressLRS TX");
    expect(backpack.isBackpack).toBe(false);
    expect(backpack.kind).toBeNull();
  });
});

describe("backpackSsidToDevice", () => {
  it("maps a Backpack SSID to a source:'ap' device at 10.0.0.1", () => {
    expect(backpackSsidToDevice("ExpressLRS VRX Backpack")).toEqual<WifiDevice>({
      id: "ap:ExpressLRS VRX Backpack",
      name: "ExpressLRS VRX Backpack",
      address: "10.0.0.1",
      source: "ap",
      kind: "vrx-backpack",
    });
  });

  it("keys the id on the raw SSID and infers the TX-backpack role", () => {
    expect(backpackSsidToDevice("ExpressLRS TX Backpack")).toEqual<WifiDevice>({
      id: "ap:ExpressLRS TX Backpack",
      name: "ExpressLRS TX Backpack",
      address: "10.0.0.1",
      source: "ap",
      kind: "tx-backpack",
    });
  });

  it("returns null for a non-Backpack SSID", () => {
    expect(backpackSsidToDevice("ExpressLRS TX")).toBeNull();
    expect(backpackSsidToDevice("MyHomeWiFi")).toBeNull();
  });
});

describe("backpackKindLabelKey", () => {
  it("maps each Backpack role to its i18n key", () => {
    expect(backpackKindLabelKey("tx-backpack")).toBe("backpack.kind.tx");
    expect(backpackKindLabelKey("vrx-backpack")).toBe("backpack.kind.vrx");
  });
});

describe("isBackpackCrossTypeFlash", () => {
  it("allows same-kind flashes (returns false)", () => {
    expect(isBackpackCrossTypeFlash("tx-backpack", "tx-backpack")).toBe(false);
    expect(isBackpackCrossTypeFlash("vrx-backpack", "vrx-backpack")).toBe(false);
  });

  it("BLOCKS cross-type flashes (returns true)", () => {
    // TX firmware onto a VRX device, and vice-versa.
    expect(isBackpackCrossTypeFlash("tx-backpack", "vrx-backpack")).toBe(true);
    expect(isBackpackCrossTypeFlash("vrx-backpack", "tx-backpack")).toBe(true);
  });
});

describe("wifiDeviceBackpackKind", () => {
  // The wizard's cross-FAMILY guard was structurally dead because nothing in
  // src/ ever derived a Backpack role from a discovered WiFi row: the flash
  // request omitted `connectedBackpackKind` entirely, so the Rust guard could
  // never fire and a main-ELRS image could be OTA'd to a Backpack. This is the
  // one narrowing both the disabled-row UI and that request field now share.
  it("narrows the two Backpack rows to their role", () => {
    expect(wifiDeviceBackpackKind("tx-backpack")).toBe("tx-backpack");
    expect(wifiDeviceBackpackKind("vrx-backpack")).toBe("vrx-backpack");
  });

  it("returns null for every non-Backpack row", () => {
    expect(wifiDeviceBackpackKind("tx")).toBeNull();
    expect(wifiDeviceBackpackKind("rx")).toBeNull();
    expect(wifiDeviceBackpackKind("unknown")).toBeNull();
  });
});

// GUARD: BACKPACK_FIELDS is derived from data/elrs_options_schema.json at load
// time, but BackpackSettings (and thus DEFAULT_BACKPACK_SETTINGS, built via a
// type-erasing `as unknown as` cast) is hardcoded. If a schema edit renames,
// adds, or removes a backpack field, the two silently desync with no compile
// error. These assertions turn that desync into a CI failure: every schema-
// derived field key must be a BackpackSettings key and vice-versa.
describe("backpackConfig schema/interface sync guard (M19-002)", () => {
  it("BACKPACK_FIELDS keys are EXACTLY the BackpackSettings keys (both directions)", () => {
    const fieldKeys = BACKPACK_FIELDS.map((f) => f.key).sort();
    const settingsKeys = [...BACKPACK_SETTINGS_KEYS].sort();
    // No schema field missing from the interface, and no interface key missing
    // from the schema-derived fields.
    expect(fieldKeys).toEqual(settingsKeys);
  });

  it("DEFAULT_BACKPACK_SETTINGS has exactly those keys with no undefined defaults", () => {
    expect(Object.keys(DEFAULT_BACKPACK_SETTINGS).sort()).toEqual(
      [...BACKPACK_SETTINGS_KEYS].sort()
    );
    for (const key of BACKPACK_SETTINGS_KEYS) {
      expect(DEFAULT_BACKPACK_SETTINGS[key]).toBeDefined();
    }
  });
});

describe("parseBackpackTargets", () => {
  it("parses the real data/targets/backpack.json into a full valid target list", () => {
    const targets = parseBackpackTargets(backpackJson);
    expect(targets.length).toBeGreaterThan(0);
    const validKinds: BackpackKind[] = ["tx-backpack", "vrx-backpack"];
    for (const t of targets) {
      expect(validKinds).toContain(t.kind);
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.repoAsset.length).toBeGreaterThan(0);
    }
  });

  it("accepts a bare array too", () => {
    const arr: BackpackTarget[] = [
      {
        id: "tx-1",
        name: "TX One",
        kind: "tx-backpack",
        repoAsset: "tx_one.bin",
      },
      {
        id: "vrx-1",
        name: "VRX One",
        kind: "vrx-backpack",
        repoAsset: "vrx_one.bin",
      },
    ];
    expect(parseBackpackTargets(arr)).toEqual(arr);
  });

  it("drops malformed entries and keeps only the valid ones (never throws)", () => {
    const valid: BackpackTarget = {
      id: "tx-good",
      name: "Good TX",
      kind: "tx-backpack",
      repoAsset: "good.bin",
    };
    const raw = {
      targets: [
        valid,
        { id: "", name: "Empty id", kind: "tx-backpack", repoAsset: "x.bin" },
        { id: "no-asset", name: "Missing repoAsset", kind: "vrx-backpack" },
        { id: "bad-kind", name: "Plain TX", kind: "tx", repoAsset: "x.bin" },
        "not-an-object",
        null,
        42,
      ],
    };
    let result: BackpackTarget[] = [];
    expect(() => {
      result = parseBackpackTargets(raw);
    }).not.toThrow();
    expect(result).toEqual([valid]);
  });

  it("returns [] for non-object/garbage input", () => {
    expect(parseBackpackTargets(null)).toEqual([]);
    expect(parseBackpackTargets(undefined)).toEqual([]);
    expect(parseBackpackTargets(42)).toEqual([]);
    expect(parseBackpackTargets("garbage")).toEqual([]);
    // object without a `targets` array.
    expect(parseBackpackTargets({ foo: "bar" })).toEqual([]);
  });
});
