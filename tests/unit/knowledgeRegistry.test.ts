import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  EXCLUSION_LIST,
  IncompatibleRegistrySchemaError,
  REGISTRY_SCHEMA_VERSION,
  SOURCE_LICENSES,
  TRUST_LEVELS,
  filterAllowed,
  filterExcluded,
  isSourceAllowed,
  loadAllowedSources,
  loadSource,
  parseRegistry,
  parseSourceMetadata,
  type SourceMetadata,
} from "@/lib/knowledge";
import registryJson from "../../data/knowledge/registry.json";

/** A minimal well-formed, allowlisted source (matches a real registry entry). */
function validMeta(over: Partial<SourceMetadata> = {}): SourceMetadata {
  return {
    id: "elrs-binding",
    title: "ExpressLRS — Binding",
    version: "1.0.0",
    path: "packs/elrs-binding.md",
    url: "https://www.expresslrs.org/quick-start/binding/",
    freshnessDate: "2026-06-01",
    license: "GPL-3.0-or-later",
    trustLevel: "official",
    ...over,
  };
}

describe("parseRegistry — valid manifest", () => {
  it("parses the real data/knowledge/registry.json into valid source metadata", () => {
    const sources = parseRegistry(registryJson);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(s.path.length).toBeGreaterThan(0);
      expect(s.freshnessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(SOURCE_LICENSES).toContain(s.license);
      expect(TRUST_LEVELS).toContain(s.trustLevel);
    }
  });

  it("ships only the two D16-legal trust levels (official + omnilink-notes)", () => {
    const sources = parseRegistry(registryJson);
    const levels = new Set(sources.map((s) => s.trustLevel));
    expect([...levels].sort()).toEqual(["official", "omnilink-notes"].sort());
  });

  it("accepts a bare array of sources too", () => {
    expect(parseRegistry([validMeta()])).toEqual([validMeta()]);
  });
});

describe("parseRegistry — rejects malformed metadata", () => {
  it("drops entries with a missing or invalid required field, keeping the valid ones", () => {
    const good = validMeta();
    const raw = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      sources: [
        good,
        { ...validMeta(), id: "" }, // empty id
        { ...validMeta(), id: "no-title", title: "   " }, // whitespace title
        { ...validMeta(), id: "bad-version", version: "1.0" }, // not semver-lite
        { ...validMeta(), id: "bad-date", freshnessDate: "June 2026" }, // not ISO
        { ...validMeta(), id: "bad-license", license: "MIT" }, // not a recorded license
        { ...validMeta(), id: "bad-trust", trustLevel: "community" }, // not a trust level
        { ...validMeta(), id: "bad-url", url: "" }, // present-but-empty url
        "not-an-object",
        null,
        42,
      ],
    };
    let result: SourceMetadata[] = [];
    expect(() => {
      result = parseRegistry(raw);
    }).not.toThrow();
    expect(result).toEqual([good]);
  });

  it("parseSourceMetadata returns null for each malformed shape", () => {
    expect(parseSourceMetadata(null)).toBeNull();
    expect(parseSourceMetadata(42)).toBeNull();
    expect(parseSourceMetadata({ ...validMeta(), version: "v1" })).toBeNull();
    expect(parseSourceMetadata({ ...validMeta(), license: "" })).toBeNull();
    expect(
      parseSourceMetadata({ ...validMeta(), trustLevel: "official-ish" }),
    ).toBeNull();
    // A valid entry survives and drops an unknown extra field.
    expect(parseSourceMetadata({ ...validMeta(), extra: 1 })).toEqual(
      validMeta(),
    );
  });

  it("returns [] for non-object / garbage input", () => {
    expect(parseRegistry(null)).toEqual([]);
    expect(parseRegistry(undefined)).toEqual([]);
    expect(parseRegistry("garbage")).toEqual([]);
    expect(parseRegistry({ foo: "bar" })).toEqual([]);
  });
});

describe("parseRegistry — version compatibility", () => {
  it("rejects a registry declaring a newer schema than this build understands", () => {
    const future = {
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      sources: [validMeta()],
    };
    expect(() => parseRegistry(future)).toThrow(
      IncompatibleRegistrySchemaError,
    );
  });

  it("accepts the current schema version and a missing (implicit) one", () => {
    expect(
      parseRegistry({ schemaVersion: REGISTRY_SCHEMA_VERSION, sources: [validMeta()] }),
    ).toEqual([validMeta()]);
    expect(parseRegistry({ sources: [validMeta()] })).toEqual([validMeta()]);
  });
});

describe("allowlist gate (D16)", () => {
  it("admits a source only when its id is on the allowlist", () => {
    expect(isSourceAllowed(validMeta())).toBe(true);
    // A well-formed source NOT on the allowlist is rejected.
    expect(
      isSourceAllowed(validMeta({ id: "totally-legit-docs" })),
    ).toBe(false);
  });

  it("rejects an allowlisted id that claims a mismatched license or trust", () => {
    // 'elrs-binding' is recorded as GPL-3.0-or-later / official.
    expect(isSourceAllowed(validMeta({ license: "CC-BY-4.0" }))).toBe(false);
    expect(
      isSourceAllowed(validMeta({ trustLevel: "omnilink-notes" })),
    ).toBe(false);
  });

  it("filterAllowed drops every non-allowlisted source", () => {
    const rogue = validMeta({ id: "rogue-source" });
    const filtered = filterAllowed([validMeta(), rogue]);
    expect(filtered.map((s) => s.id)).toEqual(["elrs-binding"]);
  });

  it("every allowlist id resolves to a recorded license + trust level", () => {
    for (const [id, entry] of Object.entries(ALLOWLIST)) {
      expect(id.length).toBeGreaterThan(0);
      expect(SOURCE_LICENSES).toContain(entry.license);
      expect(TRUST_LEVELS).toContain(entry.trustLevel);
    }
  });
});

describe("exclusion list (D16 unsafe/low-confidence filter)", () => {
  it("ships empty by default so no legitimate source is hidden", () => {
    expect(EXCLUSION_LIST.size).toBe(0);
  });

  it("filterExcluded drops ids on the exclusion set and keeps the rest", () => {
    const sources = [validMeta(), validMeta({ id: "elrs-packet-rates" })];
    const excluded = new Set(["elrs-packet-rates"]);
    expect(filterExcluded(sources, excluded).map((s) => s.id)).toEqual([
      "elrs-binding",
    ]);
    // With the default (empty) set nothing is dropped.
    expect(filterExcluded(sources)).toEqual(sources);
  });
});

describe("loadSource — offline/cached behavior", () => {
  it("loads bundled pack content and marks a real source cached + offline", () => {
    const meta = parseRegistry(registryJson).find(
      (s) => s.id === "elrs-binding",
    );
    expect(meta).toBeDefined();
    const source = loadSource(meta!);
    expect(source.cached).toBe(true);
    expect(source.offline).toBe(true);
    // The bundled prose is present (chunk-able ELRS content).
    expect(source.content.length).toBeGreaterThan(0);
    expect(source.content).toContain("binding phrase");
  });

  it("marks a source with no bundled pack not-cached and not-offline (empty content)", () => {
    const source = loadSource(validMeta({ id: "ghost", path: "packs/ghost.md" }));
    expect(source.cached).toBe(false);
    expect(source.offline).toBe(false);
    expect(source.content).toBe("");
  });
});

describe("loadAllowedSources — composed parse -> allowlist -> exclusion -> load", () => {
  it("lists the bundled trusted sources, all cached and usable offline", () => {
    const sources = loadAllowedSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(isSourceAllowed(s.metadata)).toBe(true);
      expect(s.cached).toBe(true);
      expect(s.offline).toBe(true);
      expect(s.content.length).toBeGreaterThan(0);
    }
  });

  it("rejects a well-formed source that is not on the allowlist", () => {
    const withRogue = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      sources: [
        ...registryJson.sources,
        validMeta({
          id: "malicious-scraped-forum",
          title: "Scraped forum dump",
          license: "CC-BY-4.0",
          trustLevel: "omnilink-notes",
        }),
      ],
    };
    const ids = loadAllowedSources(withRogue).map((s) => s.metadata.id);
    expect(ids).not.toContain("malicious-scraped-forum");
    // The genuine allowlisted sources still come through.
    expect(ids).toContain("elrs-binding");
  });
});
