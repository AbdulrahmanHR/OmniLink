/**
 * Trusted knowledge registry parsing + bundled pack loading (M49, D16/D17).
 *
 * `parseRegistry` validates the `data/knowledge/registry.json` manifest into a
 * list of {@link SourceMetadata}: it checks the registry SCHEMA version for
 * compatibility (throwing on an incompatible one) and DROPS any source whose
 * metadata is malformed (missing/invalid required field, bad version, unknown
 * license or trust level) — mirroring the defensive `parseBackpackTargets`
 * precedent, so a single bad entry never poisons the whole registry.
 *
 * Pack content is bundled at build time via `import.meta.glob` (the same
 * mechanism `communityPresets.ts` uses for preset JSON), so every registered
 * source is available offline with no network. An {@link EXCLUSION_LIST} filters
 * out sources flagged unsafe or low-confidence.
 */

import {
  SOURCE_LICENSES,
  BUNDLED_TRUST_LEVELS,
  type KnowledgeSource,
  type SourceLicense,
  type SourceMetadata,
  type TrustLevel,
} from "./types";
import registryRaw from "../../../data/knowledge/registry.json";

/**
 * The registry schema version this build understands. `parseRegistry` rejects a
 * manifest declaring a NEWER major schema (forward-incompatible) so a future
 * pack format cannot be silently mis-read by an old app.
 */
export const REGISTRY_SCHEMA_VERSION = 1;

/**
 * Source ids excluded from the served set regardless of the registry — the D16
 * "unsafe or low-confidence content" exclusion list. An id here is filtered out
 * by {@link filterExcluded} (and therefore by `loadAllowedSources`) even if it
 * is otherwise well-formed and allowlisted. Empty by default; entries are added
 * when a specific pack is found unsafe.
 */
export const EXCLUSION_LIST: ReadonlySet<string> = new Set<string>([]);

/** Thrown when the registry declares a schema version this build cannot read. */
export class IncompatibleRegistrySchemaError extends Error {
  constructor(
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `incompatible knowledge registry schema: found ${found}, expected <= ${expected}`,
    );
    this.name = "IncompatibleRegistrySchemaError";
  }
}

// Vite glob: relative path from src/lib/knowledge/ up to the repo-root
// data/knowledge/packs dir. `?raw` yields each pack's text as a string, eagerly
// bundled so sources resolve synchronously and offline.
const PACK_MODULES = import.meta.glob<string>(
  "../../../data/knowledge/packs/*.md",
  { query: "?raw", import: "default", eager: true },
);

/** Pack text keyed by basename (e.g. `elrs-binding.md`). */
const PACK_CONTENT: Record<string, string> = {};
for (const [globPath, text] of Object.entries(PACK_MODULES)) {
  const base = globPath.split("/").pop();
  if (base) PACK_CONTENT[base] = text;
}

/** Narrow an unknown value to a non-empty, non-whitespace string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A valid content version is semver-lite `MAJOR.MINOR.PATCH`. */
function isValidVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

/** A valid freshness date is an ISO calendar date `YYYY-MM-DD`. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function isSourceLicense(value: unknown): value is SourceLicense {
  return (
    typeof value === "string" &&
    (SOURCE_LICENSES as readonly string[]).includes(value)
  );
}

// A BUNDLED source may only declare a bundled-legal trust level (never
// `user-imported`), so a crafted registry entry can't masquerade as an imported
// source or an imported doc leak into the bundled/allowlisted path.
function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    typeof value === "string" &&
    (BUNDLED_TRUST_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Validate one raw entry into {@link SourceMetadata}, or `null` when it is
 * malformed. Every required field must be present and well-typed; `version`
 * must be semver-lite, `freshnessDate` an ISO date, and `license`/`trustLevel`
 * exactly one of the recorded values. `url` is optional but, when present, must
 * be a non-empty string.
 */
export function parseSourceMetadata(raw: unknown): SourceMetadata | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;

  if (
    !isNonEmptyString(entry.id) ||
    !isNonEmptyString(entry.title) ||
    !isValidVersion(entry.version) ||
    !isNonEmptyString(entry.path) ||
    !isIsoDate(entry.freshnessDate) ||
    !isSourceLicense(entry.license) ||
    !isTrustLevel(entry.trustLevel)
  ) {
    return null;
  }
  // `url` is optional; if present it must be a non-empty string.
  if (entry.url !== undefined && !isNonEmptyString(entry.url)) return null;

  const meta: SourceMetadata = {
    id: entry.id,
    title: entry.title,
    version: entry.version,
    path: entry.path,
    freshnessDate: entry.freshnessDate,
    license: entry.license,
    trustLevel: entry.trustLevel,
  };
  if (entry.url !== undefined) meta.url = entry.url;
  return meta;
}

/**
 * Parse the raw parsed-JSON of `data/knowledge/registry.json` into a validated
 * {@link SourceMetadata} list.
 *
 * Version compatibility: a wrapped registry may declare a `schemaVersion`. If it
 * is a number GREATER than {@link REGISTRY_SCHEMA_VERSION} the whole registry is
 * rejected with {@link IncompatibleRegistrySchemaError}; a missing version is
 * treated as the current one. Accepts either the wrapped `{ sources: [...] }`
 * shape or a bare array. Malformed source entries are dropped (never thrown);
 * non-object/non-array input yields `[]`.
 */
export function parseRegistry(raw: unknown): SourceMetadata[] {
  let list: unknown;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const wrapper = raw as Record<string, unknown>;
    const declared = wrapper.schemaVersion;
    if (typeof declared === "number" && declared > REGISTRY_SCHEMA_VERSION) {
      throw new IncompatibleRegistrySchemaError(
        declared,
        REGISTRY_SCHEMA_VERSION,
      );
    }
    list = wrapper.sources;
  } else {
    return [];
  }

  if (!Array.isArray(list)) return [];

  const sources: SourceMetadata[] = [];
  for (const item of list) {
    const meta = parseSourceMetadata(item);
    if (meta !== null) sources.push(meta);
  }
  return sources;
}

/**
 * Drop any source whose id is on the exclusion set (the D16 "unsafe or
 * low-confidence content" filter). Defaults to the shipped {@link EXCLUSION_LIST}
 * (empty); a custom set is accepted so the mechanism is unit-testable without
 * shipping a non-empty default.
 */
export function filterExcluded(
  sources: readonly SourceMetadata[],
  excluded: ReadonlySet<string> = EXCLUSION_LIST,
): SourceMetadata[] {
  return sources.filter((meta) => !excluded.has(meta.id));
}

/** Basename of a source `path` (`packs/elrs-binding.md` -> `elrs-binding.md`). */
function packBasename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** True when a bundled pack exists for this source's `path`. */
export function hasPackContent(meta: SourceMetadata): boolean {
  return packBasename(meta.path) in PACK_CONTENT;
}

/**
 * Resolve one {@link SourceMetadata} into a {@link KnowledgeSource} by loading
 * its bundled pack text. A source with a matching bundled pack is `cached` and
 * `offline`; a source whose pack is missing loads with empty content and both
 * flags false (so the UI can surface it as unavailable rather than crash).
 */
export function loadSource(meta: SourceMetadata): KnowledgeSource {
  const content = PACK_CONTENT[packBasename(meta.path)];
  const cached = content !== undefined;
  return {
    metadata: meta,
    content: content ?? "",
    cached,
    offline: cached,
  };
}

/** The raw bundled registry JSON (for the composing `allowlist.ts` + tests). */
export const RAW_REGISTRY: unknown = registryRaw;
