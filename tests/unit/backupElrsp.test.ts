import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ELRSP_SCHEMA_VERSION,
  elrspToProfile,
  migrateElrsp,
  parseElrsp,
} from "@/lib/elrsp";

/**
 * FLASH-5 cross-language round trip for the pre-flash device backup.
 *
 * `src-tauri/src/flash/backup.rs` writes an `.elrsp` snapshot of the connected
 * device before every flash — and `run_flash` HARD-FAILS the flash when it
 * cannot be written. The document it wrote (`{"_schema": "elrsp-v1", "target":
 * …, "user_defines": {}}`) had no `schemaVersion`, no `settings` and no
 * `updatedAt`, so the app's OWN importer rejected it: `parseElrsp` threw
 * "missing schemaVersion", and `migrateElrsp` — the path the Profiles page file
 * import actually takes — treated it as a legacy v0 document and died on the
 * `settings` block it did not have. The engine was paying a hard-fail for an
 * artifact nothing could restore.
 *
 * `tests/fixtures/preflash-backup.elrsp` is the document the Rust writer
 * produces for a known device + timestamp, and
 * `flash::backup::tests::document_matches_the_shared_round_trip_fixture` asserts
 * the writer still emits exactly it. So: if Rust changes the shape, the Rust
 * test fails; when the fixture is regenerated, THIS test proves the new shape
 * still imports through the real parser. Neither side can drift alone.
 */
const FIXTURE_PATH = new URL(
  "../fixtures/preflash-backup.elrsp",
  import.meta.url
);
const fixtureJson = readFileSync(FIXTURE_PATH, "utf8");

describe("pre-flash backup .elrsp round trip", () => {
  it("parses through the current-schema parser", () => {
    const doc = parseElrsp(fixtureJson);

    expect(doc.schemaVersion).toBe(ELRSP_SCHEMA_VERSION);
    expect(doc.name).toContain("BETAFPV_2400_TX");
    expect(doc.firmwareVersion).toBe("3.5.2");
    expect(doc.updatedAt).toBe(1735689600000);
    expect(doc.tags).toEqual(["auto-backup"]);
    // All ten settings survive validation with the right types.
    expect(doc.settings).toEqual({
      packetRate: 250,
      telemetryRatio: "1:64",
      switchMode: "Hybrid",
      txPower: 100,
      dynamicPower: false,
      modelMatch: false,
      modelId: 0,
      bindingPhrase: "",
      antennaMode: "Diversity",
      fanThreshold: 250,
    });
  });

  it("imports through the exact path the Profiles page file picker uses", () => {
    // ProfilesPage.handleFileChange: JSON.parse -> migrateElrsp -> preview.
    const { doc, migrated } = migrateElrsp(JSON.parse(fixtureJson));

    expect(migrated).toBe(false); // already current schema, nothing to upgrade
    expect(doc.name).toContain("BETAFPV_2400_TX");
    // …and the preview can be confirmed into a real profile.
    const profile = elrspToProfile(doc);
    expect(profile.settings.packetRate).toBe(250);
    expect(profile.name).toBe(doc.name);
  });

  it("tells the user the settings are defaults, not a read-back", () => {
    // The live parameter values still cannot be read from the device (that
    // needs the CRSF config-read path), so the document must SAY so rather than
    // passing ExpressLRS defaults off as the device's configuration.
    const doc = parseElrsp(fixtureJson);
    expect(doc.description).toMatch(/defaults/i);
    // The identity that IS genuinely known rides along in the raw document.
    const raw = JSON.parse(fixtureJson) as {
      device: Record<string, unknown>;
    };
    expect(raw.device).toEqual({
      target: "BETAFPV_2400_TX",
      deviceType: "TX",
      firmwareVersion: "3.5.2",
      port: "/dev/ttyUSB0",
    });
  });

  it("rejects the old, unimportable backup shape", () => {
    // The exact document the engine used to write. Both importer entry points
    // must still refuse it — this is the defect, pinned.
    const legacy = {
      _schema: "elrsp-v1",
      name: "Auto-backup — BETAFPV_2400_TX",
      tags: ["auto-backup"],
      isAutoBackup: true,
      target: {
        name: "BETAFPV_2400_TX",
        firmware_version: "3.5.2",
        device_type: "TX",
      },
      user_defines: {},
    };
    expect(() => parseElrsp(JSON.stringify(legacy))).toThrow(/schemaVersion/);
    // The migration path treats it as a legacy v0 doc, then dies on the
    // `settings` block it does not have.
    expect(() => migrateElrsp(legacy)).toThrow(/missing setting/);
  });
});
