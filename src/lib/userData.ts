/**
 * GDPR-style local data portability + erasure (NFR-PRIV-02).
 *
 * OmniLink keeps ALL user data on-device — there is no server — so "Export My
 * Data" and "Delete All My Data" are pure local operations over four stores:
 *
 *  - **A) SQLite `omnilink.db`** (`tauri-plugin-sql`): the five user tables
 *    {@link USER_DATA_SQLITE_TABLES} — telemetry frames, recording sessions,
 *    chat conversations + messages (GPS lives as columns inside `telemetry`), and
 *    the M56c ML session labels.
 *  - **B) localStorage** stores: the {@link USER_DATA_LOCAL_KEYS} persisted
 *    Zustand/i18n blobs.
 *  - **C) Config profiles**: `<app_config_dir>/profiles/<id>.json`, read via the
 *    `load_profiles` command and removed with `delete_profile`.
 *  - **D) BYOK API keys**: OS keychain / `0600` file. The erase uses the
 *    wholesale `delete_all_api_keys` command — it deletes the `ai_keys.json` file
 *    outright (clearing orphan slots the frontend can't name after the legacy
 *    multi-config migration) and clears every known keychain slot.
 *  - **E) Device-config backups**: `<app_data_dir>/backups/*.elrsp` (the user's
 *    own device config = personal data), wiped via `delete_all_backups`. Export
 *    does NOT bundle these (they are already user-exportable `.elrsp` files); the
 *    erase clears them.
 *
 * This module is the SINGLE SOURCE OF TRUTH for that inventory: Export and Delete
 * both drive the SAME constant lists ({@link USER_DATA_LOCAL_KEYS},
 * {@link USER_DATA_SQLITE_TABLES}, {@link PROVIDER_IDS}) so the two can never
 * drift and miss a store. The privacy-critical shape — {@link buildDataExport}
 * (what goes IN the bundle) and {@link eraseAllUserData} (what gets wiped) — are
 * pure/dependency-injected so they are unit-testable without a real DB, IPC or
 * localStorage; the thin impure wrappers ({@link collectUserDataExport},
 * {@link wipeAllUserData}) inject the real seams.
 *
 * SECURITY: the export NEVER contains a decrypted API key. Key *values* live
 * backend-side and are never returned to the webview; the bundle carries only the
 * non-secret metadata of WHICH providers have a key configured
 * (`apiKeyProviders`, from `ai_has_api_key`) plus an explicit {@link
 * API_KEYS_EXPORT_NOTE}. The `omnilink-byok` localStorage store holds provider
 * *config* only (selected provider/model, base-URL overrides, and non-secret
 * key-slot labels) — no secret — so it is safe to include verbatim.
 *
 * Every seam degrades gracefully: outside Tauri (browser dev / e2e) the SQLite /
 * profile / keychain IPC is skipped or its rejection is swallowed, so Export
 * still bundles whatever IS available (localStorage) and Delete still clears it,
 * never crashing.
 */

import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { TELEMETRY_DB_URL } from "@/lib/telemetry-db";
import { loadProfiles, deleteStoredProfile, deleteAllBackups } from "@/lib/tauri";
import { aiDeleteAllApiKeys, aiHasApiKey } from "@/lib/ai";
import { PROVIDER_IDS, type AIProvider } from "@/lib/aiContext";

// ---------------------------------------------------------------------------
// Canonical inventory — the SINGLE SOURCE OF TRUTH shared by export + erase.
// ---------------------------------------------------------------------------

/**
 * Every `localStorage` key holding persisted user data (Zustand stores + the
 * i18n language choice). Grep-verified against the audited NFR-PRIV-02 inventory.
 * Export reads each; Delete `removeItem`s each.
 *
 * NOTE: `omnilink-notes` is carried per the audited inventory for completeness.
 * It currently backs no live store (it is also the knowledge trust-level label),
 * so `removeItem` is a harmless no-op and export simply omits an absent key —
 * but keeping it here future-proofs the erase and keeps this list identical to
 * the reviewed data-store map.
 */
export const USER_DATA_LOCAL_KEYS = [
  "omnilink-account",
  "omnilink-alerts",
  "omnilink-announcements",
  "omnilink-billing",
  "omnilink-byok",
  "omnilink-cloud-mock",
  "omnilink-dashboard-panels",
  "omnilink-dev-flags",
  "omnilink-diagnostics",
  "omnilink-diagnostics-history",
  "omnilink-knowledge",
  "omnilink-language",
  "omnilink-notes",
  "omnilink-notifications",
  "omnilink-preset-library",
  // M71: the chosen folder-sync path. It is a filesystem path the user picked,
  // which on most systems contains their account name, so an erase must clear
  // it. Only the path is stored — the `.elrsp` files in that folder are the
  // user's own and are deliberately never touched by this erase.
  "omnilink-profiles",
  "omnilink-retention",
  "omnilink-sync",
  "omnilink-theme",
] as const;

/**
 * Every user-data table in `omnilink.db` (`tauri-plugin-sql`). Fixed allow-list
 * — NEVER user input — so it is safe to interpolate into `SELECT * FROM <t>` /
 * `DELETE FROM <t>`. GPS is columns inside `telemetry`, not a separate table.
 */
export const USER_DATA_SQLITE_TABLES = [
  "telemetry",
  "telemetry_sessions",
  "conversations",
  "messages",
  // v2.5 / M56c: the ML lab's local session labels (migration v6). A label is a
  // human assertion the user made about their own recording, so it is their data:
  // it exports with the bundle and it is erased by "delete all my data", like every
  // other local table. It never leaves the device by any other path.
  "session_labels",
] as const;

/** Bundle schema version (bump on any breaking change to the export shape). */
export const DATA_EXPORT_SCHEMA_VERSION = 1;

/** Stable, honest note embedded in every export re: excluded secrets. */
export const API_KEYS_EXPORT_NOTE =
  "API keys are never exported. They stay in this device's OS keychain / local " +
  "secret store; the bundle lists only which providers have a key configured.";

// ---------------------------------------------------------------------------
// Export — pure bundle builder.
// ---------------------------------------------------------------------------

/** Injected inputs for {@link buildDataExport} (kept pure/DB-free for testing). */
export interface DataExportInputs {
  /** Raw `localStorage` string per key (`null` when the store is absent). */
  localStorage: Record<string, string | null>;
  /** Rows per SQLite table (missing/failed table → treated as empty). */
  sqlite: Record<string, unknown[]>;
  /** Config profiles as returned by `load_profiles`. */
  profiles: unknown[];
  /**
   * Non-secret metadata: provider id → whether a key is configured. NEVER a key
   * value (from `ai_has_api_key`, which only ever returns a boolean).
   */
  apiKeyProviders: Record<string, boolean>;
  /** Export timestamp (ms since epoch); injected so tests are deterministic. */
  exportedAt: number;
}

/** The versioned JSON bundle written to disk by "Export My Data". */
export interface DataExportBundle {
  schemaVersion: number;
  exportedAt: string;
  app: "omnilink";
  /** Parsed value per present localStorage store (absent stores omitted). */
  localStorage: Record<string, unknown>;
  /** Rows per SQLite table (always the four keys; `[]` when empty). */
  sqlite: Record<string, unknown[]>;
  profiles: unknown[];
  /** Which providers have a key configured — metadata only, never a secret. */
  apiKeyProviders: Record<string, boolean>;
  /** Explicit "no secrets here" note ({@link API_KEYS_EXPORT_NOTE}). */
  note: string;
}

/**
 * Parse a persisted localStorage value as JSON, falling back to the raw string
 * when it is not JSON (so a stray non-JSON value still round-trips).
 */
function parseStored(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Assemble the versioned export bundle from already-gathered inputs. Pure: no
 * IO, deterministic given its inputs, so the bundle SHAPE + the security
 * guarantee (no key values, only `apiKeyProviders` metadata) are unit-testable.
 *
 * Absent localStorage stores are omitted (a `null` value is not serialized);
 * every SQLite table key is always present (empty array when there are no rows)
 * so a consumer can rely on the four keys existing.
 */
export function buildDataExport(inputs: DataExportInputs): DataExportBundle {
  const localStorage: Record<string, unknown> = {};
  for (const key of USER_DATA_LOCAL_KEYS) {
    const raw = inputs.localStorage[key];
    if (raw == null) continue; // absent store — omit it from the bundle
    localStorage[key] = parseStored(raw);
  }

  const sqlite: Record<string, unknown[]> = {};
  for (const table of USER_DATA_SQLITE_TABLES) {
    const rows = inputs.sqlite[table];
    sqlite[table] = Array.isArray(rows) ? rows : [];
  }

  return {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(inputs.exportedAt).toISOString(),
    app: "omnilink",
    localStorage,
    sqlite,
    profiles: inputs.profiles,
    apiKeyProviders: inputs.apiKeyProviders,
    note: API_KEYS_EXPORT_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Erase — pure orchestrator.
// ---------------------------------------------------------------------------

/** Effectful seams the erase drives; injected so orchestration is testable. */
export interface EraseUserDataDeps {
  /** `DELETE FROM` one SQLite table. */
  clearSqliteTable: (table: string) => Promise<void>;
  /** Delete every config profile. */
  deleteAllProfiles: () => Promise<void>;
  /** Wholesale-clear every BYOK key (file + all known keychain slots). */
  clearAllApiKeys: () => Promise<void>;
  /** Wipe every device-config `.elrsp` backup. */
  deleteAllBackups: () => Promise<void>;
  /** Remove one localStorage store. */
  removeLocalKey: (key: string) => void;
}

/** What the erase actually cleared, plus any per-step errors (never thrown). */
export interface EraseUserDataResult {
  tablesCleared: string[];
  profilesCleared: boolean;
  apiKeysCleared: boolean;
  backupsCleared: boolean;
  localKeysCleared: string[];
  /** Human-readable per-step failures; the erase continues past each. */
  errors: string[];
}

/** Best-effort message extraction for the error log. */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Erase ALL local user data across A/B/C/D/E, driving the canonical inventory so
 * nothing is skipped. Every step is best-effort and INDEPENDENT: a failing seam
 * is recorded in `errors` and the erase continues, so one rejected IPC call
 * (e.g. off-Tauri) never blocks clearing the stores that ARE available.
 *
 * Order matters: the slow awaited BACKEND work (SQLite, profiles, keys, backups)
 * runs FIRST, and the 18 localStorage stores are cleared LAST — immediately
 * before the caller reloads. Clearing localStorage first would open a window in
 * which a still-live persisted Zustand store could `set()` and re-write its key,
 * resurrecting it across the reload; clearing it last closes that window.
 */
export async function eraseAllUserData(
  deps: EraseUserDataDeps
): Promise<EraseUserDataResult> {
  const result: EraseUserDataResult = {
    tablesCleared: [],
    profilesCleared: false,
    apiKeysCleared: false,
    backupsCleared: false,
    localKeysCleared: [],
    errors: [],
  };

  // A) SQLite tables.
  for (const table of USER_DATA_SQLITE_TABLES) {
    try {
      await deps.clearSqliteTable(table);
      result.tablesCleared.push(table);
    } catch (e) {
      result.errors.push(`sqlite ${table}: ${errMessage(e)}`);
    }
  }

  // C) Config profiles.
  try {
    await deps.deleteAllProfiles();
    result.profilesCleared = true;
  } catch (e) {
    result.errors.push(`profiles: ${errMessage(e)}`);
  }

  // D) BYOK API keys — wholesale (file + every known keychain slot).
  try {
    await deps.clearAllApiKeys();
    result.apiKeysCleared = true;
  } catch (e) {
    result.errors.push(`apiKeys: ${errMessage(e)}`);
  }

  // E) Device-config backups.
  try {
    await deps.deleteAllBackups();
    result.backupsCleared = true;
  } catch (e) {
    result.errors.push(`backups: ${errMessage(e)}`);
  }

  // B) localStorage stores — LAST, so no live store can re-persist a key after
  // it is cleared but before the reload.
  for (const key of USER_DATA_LOCAL_KEYS) {
    try {
      deps.removeLocalKey(key);
      result.localKeysCleared.push(key);
    } catch (e) {
      result.errors.push(`localStorage ${key}: ${errMessage(e)}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Impure seams — wire the pure core to real localStorage / SQLite / IPC.
// ---------------------------------------------------------------------------

/** Read one localStorage value (`null` when absent / unavailable). */
function readLocal(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Remove one localStorage value (no-op when unavailable). */
function removeLocal(key: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    /* ignore — best-effort */
  }
}

/**
 * Read every user-data SQLite table for the export. Best-effort: outside Tauri
 * (no backend) returns `{}`; a failed open/select is logged and yields an empty
 * table, never thrown. Table names come from the fixed {@link
 * USER_DATA_SQLITE_TABLES} allow-list, so the interpolation is injection-safe.
 */
async function readAllSqliteTables(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  if (!isTauri()) return out;
  let db: Database | null = null;
  try {
    db = await Database.load(TELEMETRY_DB_URL);
    for (const table of USER_DATA_SQLITE_TABLES) {
      try {
        const rows = await db.select<unknown[]>(`SELECT * FROM ${table}`);
        out[table] = Array.isArray(rows) ? rows : [];
      } catch (e) {
        console.error(`[userData] failed to read table ${table}`, e);
      }
    }
  } catch (e) {
    console.error("[userData] failed to open SQLite for export", e);
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (e) {
        console.error("[userData] failed to close SQLite database", e);
      }
    }
  }
  return out;
}

/** Load all config profiles for the export (best-effort; `[]` off-Tauri). */
async function readAllProfiles(): Promise<unknown[]> {
  if (!isTauri()) return [];
  try {
    return await loadProfiles();
  } catch (e) {
    console.error("[userData] failed to load profiles for export", e);
    return [];
  }
}

/**
 * Probe which providers have a key configured — NON-SECRET metadata only
 * (`ai_has_api_key` returns a boolean; the key is never exposed). Off-Tauri
 * returns `{}` (no backend to probe).
 */
async function readApiKeyProviders(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  if (!isTauri()) return out;
  await Promise.all(
    PROVIDER_IDS.map(async (p) => {
      try {
        out[p] = await aiHasApiKey(p);
      } catch {
        out[p] = false;
      }
    })
  );
  return out;
}

/**
 * Gather and assemble the full export bundle from the real seams. Degrades
 * gracefully off-Tauri: localStorage is always read; SQLite / profiles / key
 * metadata short-circuit to empty rather than crashing.
 */
export async function collectUserDataExport(
  now: number = Date.now()
): Promise<DataExportBundle> {
  const localStorage: Record<string, string | null> = {};
  for (const key of USER_DATA_LOCAL_KEYS) localStorage[key] = readLocal(key);

  const [sqlite, profiles, apiKeyProviders] = await Promise.all([
    readAllSqliteTables(),
    readAllProfiles(),
    readApiKeyProviders(),
  ]);

  return buildDataExport({
    localStorage,
    sqlite,
    profiles,
    apiKeyProviders,
    exportedAt: now,
  });
}

/**
 * Read the custom key-slot label per provider from the persisted `omnilink-byok`
 * blob (non-secret slot ids, e.g. a user-named second key). Captured BEFORE the
 * erase wipes localStorage so those custom slots can also be cleared — otherwise
 * a key stored under a non-default slot would survive the wipe.
 *
 * The persist middleware wraps state as `{ state: {...}, version }`; a missing /
 * malformed blob yields no overrides.
 */
function readByokKeyIds(raw: string | null): Partial<Record<AIProvider, string>> {
  const out: Partial<Record<AIProvider, string>> = {};
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as {
      state?: { credentials?: Record<string, { keyId?: unknown }> };
    };
    const creds = parsed?.state?.credentials;
    if (!creds) return out;
    for (const provider of PROVIDER_IDS) {
      const keyId = creds[provider]?.keyId;
      if (typeof keyId === "string" && keyId.trim().length > 0) {
        out[provider] = keyId;
      }
    }
  } catch {
    /* malformed blob — no custom slots to clear */
  }
  return out;
}

/**
 * Open a single SQLite connection for the erase (best-effort). Returns `null`
 * outside Tauri or when the open fails, so the DELETE seam becomes a no-op.
 */
async function openDbForErase(): Promise<Database | null> {
  if (!isTauri()) return null;
  try {
    return await Database.load(TELEMETRY_DB_URL);
  } catch (e) {
    console.error("[userData] failed to open SQLite for erase", e);
    return null;
  }
}

/**
 * Delete every config profile (best-effort). Off-Tauri `load_profiles` rejects
 * and this becomes a no-op; a per-profile delete failure is swallowed so the
 * rest still delete.
 */
async function deleteAllProfilesImpl(): Promise<void> {
  if (!isTauri()) return;
  const profiles = await loadProfiles();
  for (const profile of profiles) {
    try {
      await deleteStoredProfile(profile.id);
    } catch (e) {
      console.error(`[userData] failed to delete profile ${profile.id}`, e);
    }
  }
}

/**
 * The keychain slots to clear for the wholesale key erase: every provider's
 * DEFAULT slot (its id) plus any custom `keyId`s the user configured, read from
 * the persisted `omnilink-byok` blob. The backend ALSO deletes `ai_keys.json`
 * outright (covering file-backed orphans), so this list only needs the slots the
 * frontend can still name for the keychain path.
 */
function collectKeySlots(): string[] {
  const byokKeyIds = readByokKeyIds(readLocal("omnilink-byok"));
  const slots = new Set<string>(PROVIDER_IDS);
  for (const keyId of Object.values(byokKeyIds)) {
    if (keyId) slots.add(keyId);
  }
  return [...slots];
}

/**
 * Irreversibly erase ALL local user data (A/B/C/D/E), wiring the real seams into
 * {@link eraseAllUserData}. Off-Tauri the SQLite / profile / keychain / backup
 * seams are inert, so only localStorage is cleared — no crash. The caller should
 * reload the app immediately afterwards so no stale in-memory Zustand state
 * remains (localStorage is cleared LAST so nothing re-persists before the reload).
 */
export async function wipeAllUserData(): Promise<EraseUserDataResult> {
  // Capture the key slots BEFORE the erase (localStorage is cleared last, so the
  // byok blob is still present here regardless).
  const keySlots = collectKeySlots();
  const db = await openDbForErase();

  try {
    return await eraseAllUserData({
      clearSqliteTable: async (table) => {
        if (!db) return; // no backend — inert
        await db.execute(`DELETE FROM ${table}`);
      },
      deleteAllProfiles: deleteAllProfilesImpl,
      clearAllApiKeys: async () => {
        if (!isTauri()) return; // no backend — inert
        await aiDeleteAllApiKeys(keySlots);
      },
      deleteAllBackups: async () => {
        if (!isTauri()) return; // no backend — inert
        await deleteAllBackups();
      },
      removeLocalKey: removeLocal,
    });
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (e) {
        console.error("[userData] failed to close SQLite database", e);
      }
    }
  }
}
