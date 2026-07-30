import type {
  ProfileSettings,
  TelemetryRatio,
  SwitchMode,
  AntennaMode,
} from "./profileSettings";
import type { ConfigProfile } from "./mockProfiles";
import type { TFunction } from "i18next";
import { profileName, profileDescription } from "./profileLabels";

/**
 * `.elrsp` document format — the persistence-facing wrapper around a
 * {@link ProfileSettings} payload, plus library metadata (name, tags,
 * firmware target) used by the profile library and community catalog.
 *
 * All transforms here are PURE and deterministic: timestamps are passed in,
 * never read from the clock. The single exception is {@link elrspToProfile},
 * which mints a fresh profile id (the only place identity is created).
 */

/** Current `.elrsp` schema version. Bump when the on-disk shape changes. */
export const ELRSP_SCHEMA_VERSION = 1;

/** Default fan power threshold (mW) injected when migrating pre-fan v0 docs. */
const DEFAULT_FAN_THRESHOLD = 250;

export interface ElrspDocument {
  schemaVersion: number;
  name: string;
  description?: string;
  /** Free-form library tags (FR-CFG-01). */
  tags?: string[];
  /** Semver-ish firmware target ("3.4.1") for the compat matrix (FR-CFG-07). */
  firmwareVersion?: string;
  /** The serialisable radio/link configuration. */
  settings: ProfileSettings;
  /** Last-modified timestamp (ms since epoch). */
  updatedAt: number;
}

/** Allowed token values, used for runtime primitive validation. */
const TELEMETRY_RATIOS: readonly TelemetryRatio[] = [
  "Off",
  "1:128",
  "1:64",
  "1:32",
  "1:16",
  "1:8",
  "1:4",
  "1:2",
  "Std",
];
const SWITCH_MODES: readonly SwitchMode[] = ["Hybrid", "Wide"];
const ANTENNA_MODES: readonly AntennaMode[] = [
  "Diversity",
  "Antenna 1",
  "Antenna 2",
];

/**
 * Serialise an `.elrsp` document to a stable, human-readable JSON string.
 *
 * Keys are emitted in interface field order by constructing the literal in
 * that order; optional fields are only included when present.
 */
export function serializeElrsp(doc: ElrspDocument): string {
  const ordered: ElrspDocument = {
    schemaVersion: doc.schemaVersion,
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    ...(doc.tags !== undefined ? { tags: doc.tags } : {}),
    ...(doc.firmwareVersion !== undefined
      ? { firmwareVersion: doc.firmwareVersion }
      : {}),
    settings: doc.settings,
    updatedAt: doc.updatedAt,
  };
  return JSON.stringify(ordered, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and narrow an unknown value into {@link ProfileSettings}, picking
 * exactly the 10 known keys (extra keys are dropped, not passed through).
 */
function parseSettings(raw: unknown): ProfileSettings {
  if (!isRecord(raw)) throw new Error("invalid settings: not an object");

  const req = (key: string): unknown => {
    if (!(key in raw)) throw new Error(`missing setting: ${key}`);
    return raw[key];
  };
  const num = (key: string): number => {
    const v = req(key);
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new Error(`invalid setting (expected number): ${key}`);
    }
    return v;
  };
  const bool = (key: string): boolean => {
    const v = req(key);
    if (typeof v !== "boolean") {
      throw new Error(`invalid setting (expected boolean): ${key}`);
    }
    return v;
  };
  const str = (key: string): string => {
    const v = req(key);
    if (typeof v !== "string") {
      throw new Error(`invalid setting (expected string): ${key}`);
    }
    return v;
  };
  const oneOf = <T extends string>(
    key: string,
    allowed: readonly T[]
  ): T => {
    const v = str(key);
    if (!(allowed as readonly string[]).includes(v)) {
      throw new Error(`invalid setting value: ${key}`);
    }
    return v as T;
  };

  return {
    packetRate: num("packetRate"),
    telemetryRatio: oneOf("telemetryRatio", TELEMETRY_RATIOS),
    switchMode: oneOf("switchMode", SWITCH_MODES),
    txPower: num("txPower"),
    dynamicPower: bool("dynamicPower"),
    modelMatch: bool("modelMatch"),
    modelId: num("modelId"),
    bindingPhrase: str("bindingPhrase"),
    antennaMode: oneOf("antennaMode", ANTENNA_MODES),
    fanThreshold: num("fanThreshold"),
  };
}

/**
 * Parse a CURRENT-schema `.elrsp` JSON string into a validated document.
 *
 * Throws a plain (translation-friendly) Error on malformed input or on an
 * unknown future schema version. Legacy docs must be run through
 * {@link migrateElrsp} first.
 */
export function parseElrsp(json: string): ElrspDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("invalid .elrsp: not valid JSON");
  }
  return validateDocument(raw);
}

/** Shared validation for an already-parsed unknown value. */
function validateDocument(raw: unknown): ElrspDocument {
  if (!isRecord(raw)) throw new Error("invalid .elrsp: not an object");

  if (typeof raw.schemaVersion !== "number") {
    throw new Error("invalid .elrsp: missing schemaVersion");
  }
  if (raw.schemaVersion > ELRSP_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${raw.schemaVersion}`);
  }
  if (typeof raw.name !== "string") {
    throw new Error("invalid .elrsp: missing name");
  }

  const settings = parseSettings(raw.settings);

  const doc: ElrspDocument = {
    schemaVersion: raw.schemaVersion,
    name: raw.name,
    settings,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };

  if (typeof raw.description === "string") doc.description = raw.description;
  if (Array.isArray(raw.tags)) {
    doc.tags = raw.tags.filter((t): t is string => typeof t === "string");
  }
  if (typeof raw.firmwareVersion === "string") {
    doc.firmwareVersion = raw.firmwareVersion;
  }

  return doc;
}

/**
 * Migration primitive. Upgrades a legacy v0 document to the current schema and
 * returns whether an upgrade actually occurred.
 *
 * Legacy v0 shape: no `schemaVersion`, a `savedAt` timestamp instead of
 * `updatedAt`, and `settings` missing `fanThreshold` (predates fan control).
 */
export function migrateElrsp(raw: unknown): {
  doc: ElrspDocument;
  migrated: boolean;
} {
  if (!isRecord(raw)) throw new Error("invalid .elrsp: not an object");

  const version = raw.schemaVersion;

  if (typeof version === "number") {
    if (version > ELRSP_SCHEMA_VERSION) {
      throw new Error(`unsupported schema version ${version}`);
    }
    // Already current: validate as-is, no upgrade performed.
    return { doc: validateDocument(raw), migrated: false };
  }

  // No schemaVersion → treat as legacy v0 and upgrade.
  const legacySettings = isRecord(raw.settings) ? raw.settings : {};
  const upgradedSettings: Record<string, unknown> = {
    ...legacySettings,
    fanThreshold:
      typeof legacySettings.fanThreshold === "number"
        ? legacySettings.fanThreshold
        : DEFAULT_FAN_THRESHOLD,
  };

  const savedAt =
    typeof raw.savedAt === "number"
      ? raw.savedAt
      : typeof raw.updatedAt === "number"
        ? raw.updatedAt
        : 0;

  const upgraded: Record<string, unknown> = {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: raw.name,
    description: raw.description,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    firmwareVersion: raw.firmwareVersion,
    settings: upgradedSettings,
    updatedAt: savedAt,
  };

  return { doc: validateDocument(upgraded), migrated: true };
}

/**
 * Extract the integer major/minor from a semver-ish string, or null.
 *
 * A leading `v` is tolerated (FWCHK-6): `.elrsp` files are user-authored and the
 * hosted-preset form lets `firmwareVersion` be typed freely, so `"v3.5.3"` is a
 * shape that really turns up. Anchored without it, that parsed to null, made
 * {@link firmwareCompat} return "unknown", and silently swallowed the import
 * mismatch warning it exists to raise.
 */
function parseVersion(
  version: string | null | undefined
): { major: number; minor: number } | null {
  if (!version) return null;
  const match = /^v?(\d+)\.(\d+)/i.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Firmware compatibility classifier (FR-CFG-07): warn, never block.
 *
 * Returns "unknown" if either version is missing/unparseable, "warn" if the
 * major differs or the minor differs by more than one, otherwise "ok".
 *
 * `deviceFw` accepts `null` — the store's honest "the device reported no
 * version" (see `DeviceInfo.firmwareVersion`). That is *absence*, so it must
 * classify as "unknown": the backend once substituted `"0.0.0"` there, which
 * parsed fine and made every import a permanent major-version "warn".
 */
export function firmwareCompat(
  profileFw: string | undefined,
  deviceFw: string | null | undefined
): "ok" | "warn" | "unknown" {
  const a = parseVersion(profileFw);
  const b = parseVersion(deviceFw);
  if (!a || !b) return "unknown";
  if (a.major !== b.major) return "warn";
  if (Math.abs(a.minor - b.minor) > 1) return "warn";
  return "ok";
}

/**
 * Convert a library {@link ConfigProfile} into an `.elrsp` document, resolving
 * preset i18n labels via the profileLabels helpers so seed presets export with
 * real text. `ConfigProfile` carries neither tags nor firmware target.
 */
export function profileToElrsp(profile: ConfigProfile, t: TFunction): ElrspDocument {
  const description = profileDescription(profile, t) || undefined;
  const doc: ElrspDocument = {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: profileName(profile, t),
    settings: { ...profile.settings },
    updatedAt: profile.updatedAt,
  };
  if (description !== undefined) doc.description = description;
  return doc;
}

/** Mint a stable id for a freshly imported profile (mirrors stores/profiles.ts). */
function freshId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `profile-${crypto.randomUUID()}`;
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Convert an `.elrsp` document into a literal (non-builtin) user profile.
 * Mints a fresh id — the only non-deterministic operation in this module.
 */
export function elrspToProfile(doc: ElrspDocument): ConfigProfile {
  const profile: ConfigProfile = {
    id: freshId(),
    name: doc.name,
    settings: { ...doc.settings },
    updatedAt: doc.updatedAt,
  };
  if (doc.description !== undefined) profile.description = doc.description;
  return profile;
}
