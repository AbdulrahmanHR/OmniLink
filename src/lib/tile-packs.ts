/**
 * Offline tile-pack manifest format + parser (M12, FR-TELEM-07).
 *
 * The map renders from locally-stored raster tiles served by the Rust
 * `omnitiles://` protocol (`src-tauri/src/commands/tiles.rs`). A single bundled
 * **manifest** (`src-tauri/resources/tiles/tile-packs.json`, also read by Rust
 * via serde) is the source of truth for:
 *
 *   - the bundled low-zoom worldwide **base set** (a small solid-colour
 *     placeholder today, ~12 KB; ships with the installer so the map is never
 *     blank offline, pending a real licensed raster tile set), and
 *   - the downloadable regional **packs** (small solid-colour placeholders
 *     today, ~16 KB each, selectable by continent/country; pending real
 *     licensed regional raster sets) the user pulls in Settings for offline
 *     field use.
 *
 * This module owns the canonical TypeScript shape and a strict parser so a
 * malformed manifest fails loudly rather than producing a half-typed object.
 * The Rust side parses the same file independently; the two must stay in sync.
 *
 * ## Manifest format (`schemaVersion: 1`)
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "base": {                         // bundled, always "present"
 *     "id": "base-world",
 *     "name": "World base map",
 *     "minZoom": 0,
 *     "maxZoom": 5,
 *     "sizeBytes": 12381
 *   },
 *   "packs": [
 *     {
 *       "id": "europe-west",
 *       "name": "Western Europe",
 *       "continent": "europe",        // grouping key for the picker
 *       "country": "fr",              // optional ISO-ish code; null = whole continent
 *       "minZoom": 6,
 *       "maxZoom": 12,
 *       "sizeBytes": 16627,
 *       "url": "bundled:packs/europe-west.ompack",
 *       "sha256": "…"                 // optional integrity check
 *     }
 *   ]
 * }
 * ```
 *
 * Packs are downloaded as a single `.ompack` container (a JSON tile directory +
 * concatenated PNG tiles — see `commands/tiles.rs`). The frontend never parses
 * `.ompack`; it only lists/selects packs and triggers Rust to fetch/serve them.
 *
 * ## Pack `url` schemes (resolved by `commands/tiles.rs`)
 *
 *   - `http(s)://…`   — fetched with `reqwest` (a production tile CDN).
 *   - `bundled:<rel>` — a pack shipped in the installer's resource tiles dir
 *     (`resources/tiles/<rel>`); v1.6 sources its regional packs this way since
 *     it ships without a CDN. The Rust worker stream-copies it through the SAME
 *     download pipeline (progress / cancel / magic validation / atomic rename).
 *   - `file://<abs>`  — a local absolute path (used by tests / sideloading).
 */

/** Current manifest schema version this parser understands. */
export const TILE_MANIFEST_SCHEMA_VERSION = 1;

/** The bundled low-zoom worldwide base set (always considered installed). */
export interface TileBaseSet {
  id: string;
  name: string;
  minZoom: number;
  maxZoom: number;
  /** Approximate on-disk size in bytes (for the Settings size readout). */
  sizeBytes: number;
}

/** A downloadable regional tile pack. */
export interface TilePack {
  id: string;
  name: string;
  /** Continent grouping key for the picker (e.g. `"europe"`). */
  continent: string;
  /** Optional country/region code; `null` for a whole-continent pack. */
  country: string | null;
  minZoom: number;
  maxZoom: number;
  /** Download size in bytes. */
  sizeBytes: number;
  /** Source URL of the `.ompack` container. */
  url: string;
  /** Optional SHA-256 of the `.ompack` for integrity verification. */
  sha256: string | null;
}

/** A fully-parsed tile manifest. */
export interface TileManifest {
  schemaVersion: number;
  base: TileBaseSet;
  packs: TilePack[];
}

/** Narrowing helper: a finite number at `obj[key]`, else throw. */
function num(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`tile manifest: "${ctx}.${key}" must be a finite number`);
  }
  return v;
}

/** Narrowing helper: a non-empty string at `obj[key]`, else throw. */
function str(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`tile manifest: "${ctx}.${key}" must be a non-empty string`);
  }
  return v;
}

/** Optional string: missing/`null` → `null`, present → validated string. */
function optStr(
  obj: Record<string, unknown>,
  key: string,
  ctx: string
): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new Error(`tile manifest: "${ctx}.${key}" must be a string or null`);
  }
  return v;
}

function asObject(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`tile manifest: "${ctx}" must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseBase(value: unknown): TileBaseSet {
  const o = asObject(value, "base");
  return {
    id: str(o, "id", "base"),
    name: str(o, "name", "base"),
    minZoom: num(o, "minZoom", "base"),
    maxZoom: num(o, "maxZoom", "base"),
    sizeBytes: num(o, "sizeBytes", "base"),
  };
}

function parsePack(value: unknown, index: number): TilePack {
  const ctx = `packs[${index}]`;
  const o = asObject(value, ctx);
  return {
    id: str(o, "id", ctx),
    name: str(o, "name", ctx),
    continent: str(o, "continent", ctx),
    country: optStr(o, "country", ctx),
    minZoom: num(o, "minZoom", ctx),
    maxZoom: num(o, "maxZoom", ctx),
    sizeBytes: num(o, "sizeBytes", ctx),
    url: str(o, "url", ctx),
    sha256: optStr(o, "sha256", ctx),
  };
}

/**
 * Parse + validate a tile manifest from its raw JSON value (already
 * `JSON.parse`d, or a string which will be parsed here). Throws a descriptive
 * error on any structural mismatch or unsupported schema version.
 */
export function parseTileManifest(input: unknown): TileManifest {
  const raw: unknown = typeof input === "string" ? JSON.parse(input) : input;
  const o = asObject(raw, "manifest");

  const schemaVersion = num(o, "schemaVersion", "manifest");
  if (schemaVersion !== TILE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `tile manifest: unsupported schemaVersion ${schemaVersion} ` +
        `(expected ${TILE_MANIFEST_SCHEMA_VERSION})`
    );
  }

  const packsRaw = o["packs"];
  if (!Array.isArray(packsRaw)) {
    throw new Error(`tile manifest: "packs" must be an array`);
  }

  return {
    schemaVersion,
    base: parseBase(o["base"]),
    packs: packsRaw.map((p, i) => parsePack(p, i)),
  };
}

/** Group packs by continent for the Settings picker, preserving order. */
export function groupPacksByContinent(
  packs: readonly TilePack[]
): Map<string, TilePack[]> {
  const groups = new Map<string, TilePack[]>();
  for (const pack of packs) {
    const list = groups.get(pack.continent);
    if (list) {
      list.push(pack);
    } else {
      groups.set(pack.continent, [pack]);
    }
  }
  return groups;
}

/** Human-readable byte size (binary units) for the size readout. */
export function formatPackSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
