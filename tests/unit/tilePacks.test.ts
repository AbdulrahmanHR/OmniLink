import { describe, expect, it } from "vitest";
import {
  TILE_MANIFEST_SCHEMA_VERSION,
  formatPackSize,
  groupPacksByContinent,
  parseTileManifest,
  type TileManifest,
} from "@/lib/tile-packs";

const VALID = {
  schemaVersion: 1,
  base: {
    id: "base-world",
    name: "World base map",
    minZoom: 0,
    maxZoom: 5,
    sizeBytes: 52428800,
  },
  packs: [
    {
      id: "europe-west",
      name: "Western Europe",
      continent: "europe",
      country: "fr",
      minZoom: 6,
      maxZoom: 12,
      sizeBytes: 367001600,
      url: "https://tiles.omnilink.app/packs/europe-west.ompack",
      sha256: "abc",
    },
    {
      id: "europe-east",
      name: "Eastern Europe",
      continent: "europe",
      country: null,
      minZoom: 6,
      maxZoom: 12,
      sizeBytes: 300000000,
      url: "https://tiles.omnilink.app/packs/europe-east.ompack",
    },
    {
      id: "asia-east",
      name: "East Asia",
      continent: "asia",
      country: null,
      minZoom: 6,
      maxZoom: 12,
      sizeBytes: 419430400,
      url: "https://tiles.omnilink.app/packs/asia-east.ompack",
    },
  ],
};

describe("parseTileManifest", () => {
  it("parses a valid manifest object", () => {
    const m = parseTileManifest(VALID);
    expect(m.schemaVersion).toBe(TILE_MANIFEST_SCHEMA_VERSION);
    expect(m.base.id).toBe("base-world");
    expect(m.base.maxZoom).toBe(5);
    expect(m.packs).toHaveLength(3);
  });

  it("parses an equivalent JSON string", () => {
    const fromString = parseTileManifest(JSON.stringify(VALID));
    const fromObject = parseTileManifest(VALID);
    expect(fromString).toEqual<TileManifest>(fromObject);
  });

  it("normalises a missing country to null", () => {
    const m = parseTileManifest(VALID);
    expect(m.packs[0].country).toBe("fr");
    expect(m.packs[1].country).toBeNull(); // explicit null
    expect(m.packs[2].country).toBeNull(); // absent key
  });

  it("carries the optional sha256 through (null when absent)", () => {
    const m = parseTileManifest(VALID);
    expect(m.packs[0].sha256).toBe("abc");
    expect(m.packs[1].sha256).toBeNull();
  });

  it("rejects an unsupported schema version", () => {
    expect(() => parseTileManifest({ ...VALID, schemaVersion: 99 })).toThrow(
      /unsupported schemaVersion/
    );
  });

  it("rejects a non-array packs field", () => {
    expect(() => parseTileManifest({ ...VALID, packs: {} })).toThrow(/packs/);
  });

  it("rejects a pack missing a required string field", () => {
    const bad = { ...VALID, packs: [{ ...VALID.packs[0], id: 123 }] };
    expect(() => parseTileManifest(bad)).toThrow(/packs\[0\]\.id/);
  });

  it("rejects a non-finite numeric field", () => {
    const bad = { ...VALID, base: { ...VALID.base, maxZoom: "five" } };
    expect(() => parseTileManifest(bad)).toThrow(/base\.maxZoom/);
  });

  it("rejects a non-object input", () => {
    expect(() => parseTileManifest(null)).toThrow();
    expect(() => parseTileManifest([])).toThrow();
  });
});

describe("groupPacksByContinent", () => {
  it("groups packs by continent preserving order", () => {
    const groups = groupPacksByContinent(parseTileManifest(VALID).packs);
    expect([...groups.keys()]).toEqual(["europe", "asia"]);
    expect(groups.get("europe")).toHaveLength(2);
    expect(groups.get("asia")).toHaveLength(1);
  });
});

describe("formatPackSize", () => {
  it("formats bytes in binary units", () => {
    expect(formatPackSize(512)).toBe("512 B");
    expect(formatPackSize(1024)).toBe("1 KB");
    expect(formatPackSize(52428800)).toBe("50 MB");
    expect(formatPackSize(367001600)).toBe("350 MB");
    expect(formatPackSize(2147483648)).toBe("2.0 GB");
  });
});
