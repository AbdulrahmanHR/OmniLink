import type { ProfileSettings } from "./profileSettings";
import { type ElrspDocument, ELRSP_SCHEMA_VERSION, migrateElrsp } from "./elrsp";

/**
 * Community preset catalog. Presets ship as bundled JSON under
 * `data/presets/*.json` and are normalised to the current `.elrsp` schema at
 * load time (via {@link migrateElrsp}) so the catalog is always valid and
 * current, regardless of the on-disk schema of any individual file.
 */
export interface CommunityPreset {
  id: string;
  name: string;
  description: string;
  /** "racing" | "long-range" | "freestyle" | "cinematic". */
  category: string;
  tags: string[];
  firmwareVersion?: string;
  settings: ProfileSettings;
}

/**
 * Raw bundled preset JSON. Carries catalog metadata (id/category/tags/…) in
 * addition to the `.elrsp` document fields. Legacy files omit `schemaVersion`
 * and `settings.fanThreshold` and use `savedAt`.
 */
interface RawPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  firmwareVersion?: string;
  [key: string]: unknown;
}

// Vite glob: relative path from src/lib/ up to the repo-root data/presets dir.
const RAW_MODULES = import.meta.glob<{ default: RawPreset }>(
  "../../data/presets/*.json",
  { eager: true }
);

/** Original raw preset objects keyed by their `id` (for migration-on-import). */
const RAW_BY_ID: Record<string, RawPreset> = {};
for (const mod of Object.values(RAW_MODULES)) {
  const preset = mod.default;
  RAW_BY_ID[preset.id] = preset;
}

/** Map a raw preset (post-migration settings) into a catalog entry. */
function toCommunityPreset(raw: RawPreset): CommunityPreset {
  const { doc } = migrateElrsp(raw);
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    category: raw.category,
    tags: raw.tags ?? [],
    firmwareVersion: raw.firmwareVersion,
    settings: doc.settings,
  };
}

/**
 * The bundled community preset catalog, normalised to the current schema.
 * Sorted by id for a stable, deterministic order across builds.
 */
export const COMMUNITY_PRESETS: CommunityPreset[] = Object.values(RAW_BY_ID)
  .map(toCommunityPreset)
  .sort((a, b) => a.id.localeCompare(b.id));

/**
 * Case-insensitive search over name, description, tags, and category.
 * An empty/whitespace query returns all presets (as an array copy).
 */
export function searchPresets(
  presets: readonly CommunityPreset[],
  query: string
): CommunityPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...presets];
  return presets.filter((p) => {
    const haystack = [
      p.name,
      p.description,
      p.category,
      ...p.tags,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Build a current-schema `.elrsp` document from a catalog preset. Pure and
 * deterministic: `updatedAt` is fixed at 0 (no clock access).
 */
export function communityPresetToElrsp(p: CommunityPreset): ElrspDocument {
  const doc: ElrspDocument = {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: p.name,
    description: p.description,
    tags: [...p.tags],
    settings: { ...p.settings },
    updatedAt: 0,
  };
  if (p.firmwareVersion !== undefined) doc.firmwareVersion = p.firmwareVersion;
  return doc;
}

/**
 * Look up the ORIGINAL raw preset JSON by id and run it through
 * {@link migrateElrsp}. For a legacy bundled preset this surfaces
 * `migrated: true`. Throws if the id is unknown.
 */
export function loadCommunityPresetForImport(id: string): {
  doc: ElrspDocument;
  migrated: boolean;
} {
  const raw = RAW_BY_ID[id];
  if (!raw) throw new Error(`unknown community preset: ${id}`);
  return migrateElrsp(raw);
}
