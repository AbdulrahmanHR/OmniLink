/**
 * D16 license/allowlist gate for the trusted knowledge registry (M49).
 *
 * D16 is explicit: only official ExpressLRS reference docs + OmniLink's own
 * notes ship by default, and NEW sources are admitted ONLY through an explicit
 * allowlist that records each admitted source's license + trust metadata. This
 * module is that gate. A source not in {@link ALLOWLIST} is rejected outright;
 * an allowlisted source whose declared license or trust level does NOT match
 * the recorded metadata is also rejected (a source cannot silently re-license
 * or escalate its own trust).
 *
 * `loadAllowedSources` is the single composed entry point the store uses:
 * parse the bundled registry -> gate through the allowlist -> drop excluded ids
 * -> load bundled pack content.
 */

import type { KnowledgeSource, SourceLicense, SourceMetadata, TrustLevel } from "./types";
import {
  RAW_REGISTRY,
  filterExcluded,
  loadSource,
  parseRegistry,
} from "./registry";

/** One admitted source's recorded license + trust (the D16 record). */
export interface AllowlistEntry {
  license: SourceLicense;
  trustLevel: TrustLevel;
}

/**
 * The admitted sources, keyed by id, with their recorded license + trust
 * metadata (D16). Only the two legal-by-default categories ship here: official
 * ExpressLRS reference packs (GPL-3.0-or-later) and OmniLink's own curated
 * notes (CC-BY-4.0). Admitting a new source is a deliberate edit HERE, not a
 * registry-only change — a registry entry with no allowlist row is rejected.
 */
export const ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  "elrs-getting-started": {
    license: "GPL-3.0-or-later",
    trustLevel: "official",
  },
  "elrs-binding": { license: "GPL-3.0-or-later", trustLevel: "official" },
  "elrs-packet-rates": {
    license: "GPL-3.0-or-later",
    trustLevel: "official",
  },
  "omnilink-notes": { license: "CC-BY-4.0", trustLevel: "omnilink-notes" },
};

/**
 * The D16 gate: `true` iff the source is admitted. The id must be on the
 * {@link ALLOWLIST} AND the source's declared `license` and `trustLevel` must
 * match the recorded entry exactly — so a source cannot claim a license or
 * trust level it was not admitted under. Any source not on the allowlist is
 * rejected.
 */
export function isSourceAllowed(meta: SourceMetadata): boolean {
  const entry = ALLOWLIST[meta.id];
  if (entry === undefined) return false;
  return (
    entry.license === meta.license && entry.trustLevel === meta.trustLevel
  );
}

/** Keep only the allowlist-admitted sources (D16 gate over a metadata list). */
export function filterAllowed(
  sources: readonly SourceMetadata[],
): SourceMetadata[] {
  return sources.filter(isSourceAllowed);
}

/**
 * The composed load path used by the store and UI: parse the bundled registry,
 * apply the D16 allowlist gate, drop excluded ids, then load bundled pack
 * content. The result is the set of trusted sources the app may list and serve
 * offline. Deterministic and network-free.
 *
 * @param raw Registry JSON to parse; defaults to the bundled manifest.
 */
export function loadAllowedSources(raw: unknown = RAW_REGISTRY): KnowledgeSource[] {
  const parsed = parseRegistry(raw);
  const allowed = filterAllowed(parsed);
  const included = filterExcluded(allowed);
  return included.map(loadSource);
}
