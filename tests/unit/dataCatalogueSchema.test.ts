import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ELRS_BRANDS, REGULATORY_DOMAINS, FLASH_METHODS } from "@/lib/elrsTargets";
import { parseBackpackTargets } from "@/lib/backpack";
import { migrateElrsp } from "@/lib/elrsp";
import { PACKET_RATE_OPTIONS, TX_POWER_OPTIONS } from "@/lib/profileSettings";
import { ALLOWLIST, isSourceAllowed, parseRegistry } from "@/lib/knowledge";

/**
 * Catalogue contribution gate (M74).
 *
 * Adding a radio, a preset, a Backpack target or a documentation pack is the
 * easiest useful pull request this project has, and it needs no hardware to
 * submit. The point of this file is that a malformed catalogue entry fails in
 * CI, in seconds, with a message naming the entry — instead of failing in
 * review, days later, in a solo maintainer's spare time.
 *
 * The rules enforced here are documented for contributors in `data/CONTRIBUTING.md`.
 * If you change one, change that file in the same pull request.
 *
 * Two properties make this a gate rather than a formality:
 *
 *  - **It discovers files.** `data/presets/` is read from disk with `readdirSync`,
 *    so a *new* preset file is validated the moment it is added, without anyone
 *    remembering to register it in a test.
 *  - **It rejects silent drops.** `parseBackpackTargets` is deliberately lenient
 *    at runtime: it discards malformed entries and never throws, so a typo would
 *    make a Backpack target quietly vanish from the picker rather than break the
 *    app. That is right for the app and useless for review, so the count going
 *    in must equal the count coming out here.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, "../../data");

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(DATA_DIR, relative), "utf8"));
}

// ---------------------------------------------------------------------------
// data/targets/backpack.json — Backpack flash targets
// ---------------------------------------------------------------------------

describe("data/targets/backpack.json", () => {
  const raw = readJson("targets/backpack.json") as { targets?: unknown[] };
  const declared = Array.isArray(raw.targets) ? raw.targets : [];
  const parsed = parseBackpackTargets(raw);

  it("declares at least one target under a `targets` array", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("every declared target survives parseBackpackTargets — nothing is dropped", () => {
    // The runtime parser drops malformed entries silently. If these two numbers
    // disagree, one of your entries is invalid: check `kind` is exactly
    // "tx-backpack" or "vrx-backpack", and that id/name/repoAsset are all
    // non-empty strings.
    expect(parsed.length, "a declared Backpack target was dropped as malformed").toBe(
      declared.length
    );
  });

  it("ids are unique", () => {
    const ids = parsed.map((t) => t.id);
    expect(new Set(ids).size, `duplicate Backpack target id in ${ids.join(", ")}`).toBe(
      ids.length
    );
  });

  it("every target names a .bin firmware asset and a non-empty label", () => {
    for (const t of parsed) {
      expect(t.name.trim(), `${t.id}: empty name`).not.toBe("");
      expect(t.repoAsset, `${t.id}: repoAsset must name a .bin`).toMatch(/\.bin$/);
    }
  });

  it("kinds are limited to the two Backpack classes the cross-type guard knows", () => {
    // The flash guard refuses a TX-Backpack image on a VRX-Backpack device by
    // comparing these exact strings. A third value would bypass it.
    for (const t of parsed) {
      expect(["tx-backpack", "vrx-backpack"]).toContain(t.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// src/lib/elrsTargets.ts — the brand / model catalogue ("add my radio")
// ---------------------------------------------------------------------------

describe("ELRS brand and model catalogue", () => {
  const models = ELRS_BRANDS.flatMap((b) => b.models.map((m) => ({ brand: b.id, ...m })));
  const domainIds = REGULATORY_DOMAINS.map((d) => d.id);
  const methodIds = FLASH_METHODS.map((m) => m.id);

  it("every brand has an id, a name and at least one model", () => {
    for (const b of ELRS_BRANDS) {
      expect(b.id, "brand id must be lower-kebab").toMatch(/^[a-z0-9-]+$/);
      expect(b.name.trim(), `${b.id}: empty brand name`).not.toBe("");
      expect(b.models.length, `${b.id}: no models`).toBeGreaterThan(0);
    }
  });

  it("brand ids and model ids are unique across the catalogue", () => {
    const brandIds = ELRS_BRANDS.map((b) => b.id);
    expect(new Set(brandIds).size, "duplicate brand id").toBe(brandIds.length);
    const modelIds = models.map((m) => m.id);
    expect(new Set(modelIds).size, "duplicate model id").toBe(modelIds.length);
  });

  it("every build target appears exactly once", () => {
    // Two models sharing a target would make the pre-flash target guard
    // ambiguous — it compares build targets exactly, on purpose, because
    // BETAFPV_2400_TX and BETAFPV_2400_TX_MICRO_1W are different radios with
    // different PA tables.
    const targets = models.map((m) => m.target);
    const duplicates = targets.filter((t, i) => targets.indexOf(t) !== i);
    expect(duplicates, `build target declared twice: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("every model is well formed", () => {
    for (const m of models) {
      expect(m.id, `${m.id}: model id must be lower-kebab`).toMatch(/^[a-z0-9-]+$/);
      expect(m.name.trim(), `${m.id}: empty model name`).not.toBe("");
      expect(["TX", "RX"], `${m.id}: deviceType`).toContain(m.deviceType);
      // Build targets are the ExpressLRS identifiers — UPPER_SNAKE, as upstream
      // writes them, because the guard compares them literally.
      expect(m.target, `${m.id}: target must be UPPER_SNAKE_CASE`).toMatch(/^[A-Z0-9_]+$/);
      expect(m.mcu.trim(), `${m.id}: empty mcu`).not.toBe("");
      expect(m.domains.length, `${m.id}: no regulatory domains`).toBeGreaterThan(0);
      for (const d of m.domains) expect(domainIds, `${m.id}: unknown domain ${d}`).toContain(d);
      expect(m.flashMethods.length, `${m.id}: no flash methods`).toBeGreaterThan(0);
      for (const f of m.flashMethods) {
        expect(methodIds, `${m.id}: unknown flash method ${f}`).toContain(f);
      }
      expect(m.firmwareVersions.length, `${m.id}: no fallback firmware`).toBeGreaterThan(0);
      for (const v of m.firmwareVersions) {
        expect(v, `${m.id}: firmware "${v}" must be X.Y.Z`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });

  it("a 2.4 GHz model does not also claim a sub-GHz domain", () => {
    // ISM2400 hardware is SX128x; the sub-GHz domains are SX127x. One radio
    // cannot be both, and mixing them would offer an illegal band in the wizard.
    for (const m of models) {
      if (!m.domains.includes("ISM2400")) continue;
      expect(m.domains, `${m.id}: ISM2400 mixed with a sub-GHz domain`).toEqual(["ISM2400"]);
    }
  });
});

// ---------------------------------------------------------------------------
// data/presets/*.json — community config presets
// ---------------------------------------------------------------------------

describe("data/presets/*.json", () => {
  const dir = path.join(DATA_DIR, "presets");
  // Read from disk, not from an import list: a new file must be validated
  // without anyone remembering to add it here.
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("the directory holds at least one preset", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every file parses, migrates to the current .elrsp schema, and is complete", () => {
    for (const file of files) {
      const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<
        string,
        unknown
      >;
      expect(typeof raw.id, `${file}: missing id`).toBe("string");
      expect(typeof raw.name, `${file}: missing name`).toBe("string");
      expect(typeof raw.description, `${file}: missing description`).toBe("string");
      expect(typeof raw.category, `${file}: missing category`).toBe("string");
      if (raw.tags !== undefined) {
        expect(Array.isArray(raw.tags), `${file}: tags must be an array`).toBe(true);
      }

      // Presets are `.elrsp` documents with catalogue metadata bolted on, so the
      // real gate is that the shipped migration accepts them.
      const { doc } = migrateElrsp(raw);
      const s = doc.settings;
      expect(PACKET_RATE_OPTIONS, `${file}: packetRate ${s.packetRate}`).toContain(s.packetRate);
      expect(TX_POWER_OPTIONS, `${file}: txPower ${s.txPower}`).toContain(s.txPower);
      expect(typeof s.telemetryRatio, `${file}: telemetryRatio`).toBe("string");
      expect(typeof s.switchMode, `${file}: switchMode`).toBe("string");
      expect(typeof s.antennaMode, `${file}: antennaMode`).toBe("string");
      expect(typeof s.dynamicPower, `${file}: dynamicPower`).toBe("boolean");
      expect(typeof s.modelMatch, `${file}: modelMatch`).toBe("boolean");
      expect(typeof s.fanThreshold, `${file}: fanThreshold`).toBe("number");
      expect(s.modelId, `${file}: modelId out of range`).toBeGreaterThanOrEqual(0);
      expect(s.modelId, `${file}: modelId out of range`).toBeLessThanOrEqual(63);
      if (raw.firmwareVersion !== undefined) {
        expect(String(raw.firmwareVersion), `${file}: firmwareVersion must be X.Y.Z`).toMatch(
          /^\d+\.\d+\.\d+$/
        );
      }
    }
  });

  it("preset ids are unique and the filename matches the id", () => {
    const ids = new Map<string, string>();
    for (const file of files) {
      const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { id: string };
      const clash = ids.get(raw.id);
      expect(clash, `${file}: id "${raw.id}" already used by ${clash}`).toBeUndefined();
      ids.set(raw.id, file);
      // `preset-racing-pro-500.json` ↔ id `preset-racing-pro-500`: keeps the
      // catalogue greppable and stops two files claiming one identity.
      expect(`${raw.id}.json`.replace(/^preset-/, ""), `${file}: filename must match id`).toBe(
        file
      );
    }
  });

  it("no preset ships a binding phrase that looks like somebody's real one", () => {
    // A binding phrase is a shared secret. Example values are fine — a phrase
    // that reads like a personal one is a leak, and it would also silently bind
    // a contributor's gear to a stranger's link.
    for (const file of files) {
      const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<
        string,
        unknown
      >;
      const { doc } = migrateElrsp(raw);
      const phrase = doc.settings.bindingPhrase;
      expect(phrase, `${file}: bindingPhrase must be a string`).toBeTypeOf("string");
      expect(phrase.length, `${file}: bindingPhrase too long to be an example`).toBeLessThanOrEqual(
        32
      );
      expect(phrase, `${file}: bindingPhrase must not contain an email address`).not.toMatch(
        /@/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// data/knowledge/registry.json — trusted documentation sources
// ---------------------------------------------------------------------------

describe("data/knowledge/registry.json", () => {
  const registry = readJson("knowledge/registry.json");
  const sources = parseRegistry(registry);

  it("parses into at least one source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("every source is admitted by the licence allowlist", () => {
    // A source may not silently re-license itself or escalate its own trust
    // level: the declared licence and trust must match the allowlist entry.
    for (const s of sources) {
      expect(ALLOWLIST[s.id], `${s.id}: not in src/lib/knowledge/allowlist.ts`).toBeDefined();
      expect(isSourceAllowed(s), `${s.id}: licence or trustLevel does not match`).toBe(true);
    }
  });

  it("every source's pack file exists on disk", () => {
    for (const s of sources) {
      const abs = path.join(DATA_DIR, "knowledge", s.path);
      expect(existsSync(abs), `${s.id}: missing pack ${s.path}`).toBe(true);
      expect(readFileSync(abs, "utf8").trim().length, `${s.id}: empty pack`).toBeGreaterThan(0);
    }
  });

  it("no pack file is orphaned — every one is registered", () => {
    const registered = new Set(sources.map((s) => path.basename(s.path)));
    const onDisk = readdirSync(path.join(DATA_DIR, "knowledge", "packs")).filter((f) =>
      f.endsWith(".md")
    );
    for (const f of onDisk) {
      expect(registered, `packs/${f} is not registered in registry.json`).toContain(f);
    }
  });

  it("ids are unique and freshness dates are ISO", () => {
    const ids = sources.map((s) => s.id);
    expect(new Set(ids).size, "duplicate source id").toBe(ids.length);
    for (const s of sources) {
      expect(s.freshnessDate, `${s.id}: freshnessDate must be YYYY-MM-DD`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// data/elrs_options_schema.json — the device-config option catalogue
// ---------------------------------------------------------------------------

interface SchemaField {
  type?: unknown;
  mechanism?: unknown;
  label?: unknown;
  help?: unknown;
  choices?: unknown;
  sensitive?: unknown;
  safety_critical?: unknown;
}

describe("data/elrs_options_schema.json", () => {
  const schema = readJson("elrs_options_schema.json") as {
    _schema?: string;
    mechanisms?: Record<string, unknown>;
    groups?: Record<string, { label?: unknown; fields?: Record<string, SchemaField> }>;
  };

  const entries = Object.entries(schema.groups ?? {}).flatMap(([groupId, group]) =>
    Object.entries(group.fields ?? {}).map(([fieldId, field]) => ({
      where: `${groupId}.${fieldId}`,
      field,
    }))
  );

  it("declares its schema id and mechanism vocabulary", () => {
    expect(schema._schema).toBe("omnilink-options-v1");
    expect(Object.keys(schema.mechanisms ?? {}).sort()).toEqual(["binary_patch", "compile_flag"]);
  });

  it("every group has a label and at least one field", () => {
    for (const [groupId, group] of Object.entries(schema.groups ?? {})) {
      expect(typeof group.label, `${groupId}: missing label`).toBe("string");
      expect(Object.keys(group.fields ?? {}).length, `${groupId}: no fields`).toBeGreaterThan(0);
    }
  });

  it("every field declares a known mechanism, a label and help text", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const { where, field } of entries) {
      expect(["binary_patch", "compile_flag"], `${where}: mechanism`).toContain(field.mechanism);
      expect(typeof field.type, `${where}: missing type`).toBe("string");
      expect(typeof field.label, `${where}: missing label`).toBe("string");
      // Help text is what makes the wizard plain-English; a field without it
      // renders as a bare identifier.
      expect(String(field.help ?? "").length, `${where}: missing help text`).toBeGreaterThan(20);
    }
  });

  it("every enum field offers choices, and no other field does", () => {
    for (const { where, field } of entries) {
      if (field.type === "enum") {
        expect(Array.isArray(field.choices), `${where}: enum without choices`).toBe(true);
        expect((field.choices as unknown[]).length, `${where}: empty choices`).toBeGreaterThan(0);
      } else {
        expect(field.choices, `${where}: choices on a non-enum field`).toBeUndefined();
      }
    }
  });

  it("the sensitive and safety-critical markers stay boolean", () => {
    // These two flags drive real refusals: `sensitive` keeps a value out of the
    // AI payload, `safety_critical` bars the assistant from suggesting it. A
    // string "false" would be truthy in one place and not another.
    for (const { where, field } of entries) {
      if (field.sensitive !== undefined) {
        expect(typeof field.sensitive, `${where}: sensitive must be boolean`).toBe("boolean");
      }
      if (field.safety_critical !== undefined) {
        expect(typeof field.safety_critical, `${where}: safety_critical must be boolean`).toBe(
          "boolean"
        );
      }
    }
  });

  it("the binding phrase is still marked sensitive", () => {
    // Load-bearing, not decorative: this is the flag that keeps a binding phrase
    // out of every AI payload and every exported report.
    const phrase = schema.groups?.binding?.fields?.binding_phrase;
    expect(phrase, "binding.binding_phrase is missing").toBeDefined();
    expect(phrase!.sensitive).toBe(true);
  });
});
