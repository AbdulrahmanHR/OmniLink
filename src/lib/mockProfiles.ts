import type { ProfileSettings } from "./profileSettings";

/**
 * A saved ExpressLRS configuration profile.
 *
 * Mirrors the on-disk `.elrsp` document shape so Phase 2 persistence can read
 * and write these directly: `settings` is the serialisable payload, the rest is
 * file/library metadata. `nameKey`/`descriptionKey` are i18n keys used only by
 * the built-in seed presets so the prototype ships zero hardcoded strings;
 * user-created profiles carry literal `name`/`description` instead.
 */
export interface ConfigProfile {
  id: string;
  /** Literal display name (user-created profiles). */
  name?: string;
  /** Literal description (user-created profiles). */
  description?: string;
  /** i18n key for the name (built-in seed presets). */
  nameKey?: string;
  /** i18n key for the description (built-in seed presets). */
  descriptionKey?: string;
  /** The serialisable profile payload. */
  settings: ProfileSettings;
  /** Last-modified timestamp (ms since epoch). */
  updatedAt: number;
  /** Built-in presets are read-only (cannot be renamed or deleted). */
  builtin?: boolean;
}

// ---------------------------------------------------------------------------
// PROFILE DATA
//
// PRESET_PROFILES — factory presets (`builtin: true`). These are REAL: they ship
// with the product, the same way ELRS presets would. The store (see
// src/stores/profiles.ts) consumes these through a single seam so Phase 2 can
// swap presets/IO to real `.elrsp` file handling mechanically.
// ---------------------------------------------------------------------------

/** Fixed seed timestamps keep diffs/sorting deterministic in the prototype. */
const DAY = 24 * 60 * 60 * 1000;
const SEED_NOW = Date.UTC(2026, 5, 18, 12, 0, 0);

/**
 * Factory presets — REAL data shipped in every build.
 *
 * Read-only (`builtin: true`) seed profiles spanning common ELRS use-cases.
 */
export const PRESET_PROFILES: ConfigProfile[] = [
  {
    id: "preset-racing-500",
    nameKey: "profiles.presets.racing.name",
    descriptionKey: "profiles.presets.racing.description",
    builtin: true,
    updatedAt: SEED_NOW - 1 * DAY,
    settings: {
      packetRate: 500,
      telemetryRatio: "1:128",
      switchMode: "Wide",
      txPower: 250,
      dynamicPower: false,
      modelMatch: true,
      modelId: 1,
      bindingPhrase: "race-quad-01",
      antennaMode: "Diversity",
      fanThreshold: 100,
    },
  },
  {
    id: "preset-longrange-50",
    nameKey: "profiles.presets.longRange.name",
    descriptionKey: "profiles.presets.longRange.description",
    builtin: true,
    updatedAt: SEED_NOW - 3 * DAY,
    settings: {
      packetRate: 50,
      telemetryRatio: "1:8",
      switchMode: "Wide",
      txPower: 1000,
      dynamicPower: true,
      modelMatch: true,
      modelId: 7,
      bindingPhrase: "lr-wing-explorer",
      antennaMode: "Diversity",
      fanThreshold: 250,
    },
  },
  {
    id: "preset-freestyle-250",
    nameKey: "profiles.presets.freestyle.name",
    descriptionKey: "profiles.presets.freestyle.description",
    builtin: true,
    updatedAt: SEED_NOW - 5 * DAY,
    settings: {
      packetRate: 250,
      telemetryRatio: "1:32",
      switchMode: "Wide",
      txPower: 250,
      dynamicPower: true,
      modelMatch: true,
      modelId: 3,
      bindingPhrase: "freestyle-5inch",
      antennaMode: "Diversity",
      fanThreshold: 250,
    },
  },
  {
    id: "preset-default",
    nameKey: "profiles.presets.default.name",
    descriptionKey: "profiles.presets.default.description",
    builtin: true,
    updatedAt: SEED_NOW - 14 * DAY,
    settings: {
      packetRate: 250,
      telemetryRatio: "1:64",
      switchMode: "Hybrid",
      txPower: 100,
      dynamicPower: false,
      modelMatch: false,
      modelId: 0,
      bindingPhrase: "omni-default",
      antennaMode: "Diversity",
      fanThreshold: 250,
    },
  },
];
