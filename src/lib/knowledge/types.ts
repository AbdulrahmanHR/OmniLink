/**
 * Trusted knowledge source model (M49, v2.4.0).
 *
 * The shared types for the D16 source registry: the immutable per-source
 * metadata that ships in `data/knowledge/registry.json`, plus the loaded
 * {@link KnowledgeSource} the app lists, serves offline, and (D17) refreshes.
 *
 * Everything here is pure data — no clock, no I/O, no network. Adding a new
 * outbound path is explicitly out of scope for M49; these types describe only
 * bundled/cached content.
 */

/**
 * How much a source is trusted.
 *
 * `official` (ExpressLRS reference docs) and `omnilink-notes` (OmniLink's OWN
 * curated notes) are the only levels legal to BUNDLE by default (D16); anything
 * else must be admitted through the allowlist first.
 *
 * `user-imported` (M52, D18) is a THIRD, strictly-lower level for docs the user
 * imports locally. It is NEVER bundled and NEVER admitted through the registry/
 * allowlist path — it is stamped by construction at import time and can never be
 * escalated to `official`/`omnilink-notes`. Imported content is always treated
 * as untrusted and is visually distinct from trusted sources.
 */
export type TrustLevel = "official" | "omnilink-notes" | "user-imported";

/** Every trust level, for validation and exhaustive UI rendering. */
export const TRUST_LEVELS: readonly TrustLevel[] = [
  "official",
  "omnilink-notes",
  "user-imported",
];

/**
 * The trust levels a BUNDLED registry source may legally declare (D16). This is
 * a STRICT SUBSET of {@link TRUST_LEVELS} — it deliberately excludes
 * `user-imported`, so a bundled `registry.json` entry can never claim to be a
 * user-imported source (or vice versa). The registry parser validates against
 * THIS set, keeping the imported-doc path and the trusted-pack path disjoint.
 */
export const BUNDLED_TRUST_LEVELS: readonly TrustLevel[] = [
  "official",
  "omnilink-notes",
];

/**
 * The licenses a bundled source may declare (D16 "recorded license metadata").
 * Official ELRS reference packs ship under the ExpressLRS project license
 * (GPL-3.0-or-later); OmniLink's own notes ship under CC-BY-4.0. The registry
 * parser rejects any source whose license is not one of these.
 */
export const SOURCE_LICENSES = ["GPL-3.0-or-later", "CC-BY-4.0"] as const;
export type SourceLicense = (typeof SOURCE_LICENSES)[number];

/**
 * Immutable metadata for one trusted source, as authored in
 * `data/knowledge/registry.json`. `path` points at a bundled pack under
 * `data/knowledge/` (e.g. `packs/elrs-binding.md`); `url` is the upstream
 * reference, present for official docs and optional for OmniLink notes.
 */
export interface SourceMetadata {
  /** Stable id (also the allowlist key). */
  id: string;
  /** Human title shown in the sources list. */
  title: string;
  /** Source content version (semver `MAJOR.MINOR.PATCH`). */
  version: string;
  /** Bundled pack path relative to `data/knowledge/`. */
  path: string;
  /** Upstream reference URL (official docs); omitted for local-only notes. */
  url?: string;
  /** ISO-8601 date (`YYYY-MM-DD`) the content was last known fresh. */
  freshnessDate: string;
  /** Recorded license metadata (D16). */
  license: SourceLicense;
  /** Recorded trust level (D16). */
  trustLevel: TrustLevel;
}

/**
 * A trusted source resolved for use: its {@link SourceMetadata} plus the loaded
 * pack text and the cached/offline flags the store and UI read.
 *
 * `cached` is true when the pack content is present locally (bundled fresh per
 * release, D17). `offline` mirrors it here — a bundled source is always usable
 * with no network — and is kept as a distinct flag so a future fetched-but-not
 * -yet-cached state can be represented without changing the shape.
 */
export interface KnowledgeSource {
  metadata: SourceMetadata;
  /** Loaded pack prose (Markdown). Empty string when the pack file is missing. */
  content: string;
  /** True when the pack content is available locally. */
  cached: boolean;
  /** True when the source can be served with zero network. */
  offline: boolean;
}
