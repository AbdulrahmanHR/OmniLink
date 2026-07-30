import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NFR-PRIV-02 — GDPR-style local data export + erase.
 *
 * Covers the single-source-of-truth inventory and the two privacy-critical pure
 * seams in `@/lib/userData`:
 *  - {@link buildDataExport} — the bundle SHAPE and the security guarantee that
 *    NO API-key value can enter the export (only boolean `apiKeyProviders`);
 *  - {@link eraseAllUserData} — the orchestration drives the FULL canonical
 *    inventory (all localStorage keys + SQLite tables + profiles + every
 *    provider), and a failing step never blocks the rest;
 *  - the impure {@link collectUserDataExport}/{@link wipeAllUserData} wrappers:
 *    graceful off-Tauri degradation and, on-Tauri, that erase reaches the real
 *    SQLite / profile / keychain seams (including custom BYOK key slots).
 *
 * The tauri-facing seams are mocked so the suite runs headlessly in the node env.
 */

const {
  isTauriMock,
  loadMock,
  loadProfilesMock,
  deleteProfileMock,
  deleteBackupsMock,
  aiDeleteAllMock,
  aiHasMock,
} = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  loadMock: vi.fn(),
  loadProfilesMock: vi.fn(),
  deleteProfileMock: vi.fn(),
  deleteBackupsMock: vi.fn(),
  aiDeleteAllMock: vi.fn(),
  aiHasMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: loadMock },
}));
vi.mock("@/lib/tauri", () => ({
  loadProfiles: loadProfilesMock,
  deleteStoredProfile: deleteProfileMock,
  deleteAllBackups: deleteBackupsMock,
}));
vi.mock("@/lib/ai", () => ({
  aiDeleteAllApiKeys: aiDeleteAllMock,
  aiHasApiKey: aiHasMock,
}));

import {
  API_KEYS_EXPORT_NOTE,
  DATA_EXPORT_SCHEMA_VERSION,
  USER_DATA_LOCAL_KEYS,
  USER_DATA_SQLITE_TABLES,
  buildDataExport,
  collectUserDataExport,
  eraseAllUserData,
  wipeAllUserData,
  type EraseUserDataDeps,
} from "@/lib/userData";
import { PROVIDER_IDS } from "@/lib/aiContext";

// A tiny in-memory localStorage stub for the node env (which has none).
function fakeLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
    _store: store,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Canonical inventory
// ---------------------------------------------------------------------------

describe("canonical inventory", () => {
  it("lists all 19 localStorage stores with no duplicates", () => {
    expect(USER_DATA_LOCAL_KEYS).toHaveLength(19);
    expect(new Set(USER_DATA_LOCAL_KEYS).size).toBe(19);
    // Spot-check the audited membership, including the secret-bearing config store.
    for (const k of [
      "omnilink-account",
      "omnilink-byok",
      "omnilink-knowledge",
      "omnilink-language",
      "omnilink-theme",
      "omnilink-retention",
      "omnilink-diagnostics-history",
      // M71: the folder-sync path is a path the user picked, so it is user data.
      "omnilink-profiles",
    ]) {
      expect(USER_DATA_LOCAL_KEYS).toContain(k);
    }
  });

  it("lists exactly the five user-data SQLite tables", () => {
    expect([...USER_DATA_SQLITE_TABLES]).toEqual([
      "telemetry",
      "telemetry_sessions",
      "conversations",
      "messages",
      // M56c: the ML lab's local session labels. A label is a claim the user made
      // about their own recording, so it exports and it erases with everything else.
      "session_labels",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildDataExport (pure)
// ---------------------------------------------------------------------------

describe("buildDataExport", () => {
  const exportedAt = Date.UTC(2026, 6, 3, 12, 0, 0);

  it("assembles a versioned bundle: present stores parsed, absent omitted", () => {
    const bundle = buildDataExport({
      localStorage: {
        "omnilink-theme": JSON.stringify({ state: { mode: "dark" } }),
        "omnilink-language": null, // absent store
        "omnilink-notes": null,
        "not-a-listed-key": "ignored", // not in the inventory
      },
      sqlite: { telemetry: [{ ts: 1 }] },
      profiles: [{ id: "p1", name: "Quad" }],
      apiKeyProviders: { anthropic: true, openai: false },
      exportedAt,
    });

    expect(bundle.schemaVersion).toBe(DATA_EXPORT_SCHEMA_VERSION);
    expect(bundle.exportedAt).toBe(new Date(exportedAt).toISOString());
    expect(bundle.app).toBe("omnilink");
    expect(bundle.note).toBe(API_KEYS_EXPORT_NOTE);

    // Present store parsed from JSON; absent stores + unlisted keys excluded.
    expect(bundle.localStorage).toEqual({
      "omnilink-theme": { state: { mode: "dark" } },
    });
    expect(bundle.localStorage).not.toHaveProperty("omnilink-language");
    expect(bundle.localStorage).not.toHaveProperty("not-a-listed-key");

    // Every SQLite table key present; missing tables default to [].
    expect(Object.keys(bundle.sqlite).sort()).toEqual(
      [...USER_DATA_SQLITE_TABLES].sort()
    );
    expect(bundle.sqlite.telemetry).toEqual([{ ts: 1 }]);
    expect(bundle.sqlite.messages).toEqual([]);

    expect(bundle.profiles).toEqual([{ id: "p1", name: "Quad" }]);
    expect(bundle.apiKeyProviders).toEqual({ anthropic: true, openai: false });
  });

  it("falls back to the raw string for a non-JSON stored value", () => {
    const bundle = buildDataExport({
      localStorage: { "omnilink-language": "es" }, // bare string, not JSON
      sqlite: {},
      profiles: [],
      apiKeyProviders: {},
      exportedAt,
    });
    expect(bundle.localStorage["omnilink-language"]).toBe("es");
  });

  it("NEVER embeds a secret: only boolean key metadata, no key values", () => {
    // The byok store carries config only (base URL + non-secret slot label).
    const byok = JSON.stringify({
      state: {
        credentials: {
          anthropic: { keyId: "work-key", baseUrl: "https://api.anthropic.com" },
        },
        selection: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      version: 0,
    });
    const bundle = buildDataExport({
      localStorage: { "omnilink-byok": byok },
      sqlite: {},
      profiles: [],
      apiKeyProviders: { anthropic: true, openai: true, ollama: true },
      exportedAt,
    });

    // apiKeyProviders is metadata: every value is a boolean, never a string key.
    for (const v of Object.values(bundle.apiKeyProviders)) {
      expect(typeof v).toBe("boolean");
    }
    // A hypothetical secret placed nowhere in the inputs cannot appear.
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("sk-");
    // There is no channel for raw keys — no `apiKeys` field at all.
    expect(bundle).not.toHaveProperty("apiKeys");
  });
});

// ---------------------------------------------------------------------------
// eraseAllUserData (pure orchestration)
// ---------------------------------------------------------------------------

describe("eraseAllUserData", () => {
  function okDeps(order?: string[]): EraseUserDataDeps & {
    clearSqliteTable: ReturnType<typeof vi.fn>;
    deleteAllProfiles: ReturnType<typeof vi.fn>;
    clearAllApiKeys: ReturnType<typeof vi.fn>;
    deleteAllBackups: ReturnType<typeof vi.fn>;
    removeLocalKey: ReturnType<typeof vi.fn>;
  } {
    const mark = (label: string) => order?.push(label);
    return {
      clearSqliteTable: vi.fn(async () => mark("sqlite")),
      deleteAllProfiles: vi.fn(async () => mark("profiles")),
      clearAllApiKeys: vi.fn(async () => mark("keys")),
      deleteAllBackups: vi.fn(async () => mark("backups")),
      removeLocalKey: vi.fn(() => mark("local")),
    };
  }

  it("drives the FULL canonical inventory across A/B/C/D/E", async () => {
    const deps = okDeps();
    const result = await eraseAllUserData(deps);

    // A) every SQLite table.
    expect(deps.clearSqliteTable).toHaveBeenCalledTimes(
      USER_DATA_SQLITE_TABLES.length
    );
    for (const t of USER_DATA_SQLITE_TABLES) {
      expect(deps.clearSqliteTable).toHaveBeenCalledWith(t);
    }
    // C) profiles once. D) keys wholesale once. E) backups once.
    expect(deps.deleteAllProfiles).toHaveBeenCalledTimes(1);
    expect(deps.clearAllApiKeys).toHaveBeenCalledTimes(1);
    expect(deps.deleteAllBackups).toHaveBeenCalledTimes(1);
    // B) every localStorage store.
    expect(deps.removeLocalKey).toHaveBeenCalledTimes(USER_DATA_LOCAL_KEYS.length);
    for (const k of USER_DATA_LOCAL_KEYS) {
      expect(deps.removeLocalKey).toHaveBeenCalledWith(k);
    }

    expect(result.tablesCleared).toEqual([...USER_DATA_SQLITE_TABLES]);
    expect(result.profilesCleared).toBe(true);
    expect(result.apiKeysCleared).toBe(true);
    expect(result.backupsCleared).toBe(true);
    expect(result.localKeysCleared).toEqual([...USER_DATA_LOCAL_KEYS]);
    expect(result.errors).toEqual([]);
  });

  it("clears localStorage LAST, after all backend erase work (resurrection guard)", async () => {
    const order: string[] = [];
    await eraseAllUserData(okDeps(order));

    // Every backend step must precede the first localStorage removal, so no live
    // store can re-persist a key after it is cleared but before the reload.
    const firstLocal = order.indexOf("local");
    expect(firstLocal).toBeGreaterThan(-1);
    expect(order.slice(0, firstLocal)).toContain("sqlite");
    expect(order.slice(0, firstLocal)).toContain("profiles");
    expect(order.slice(0, firstLocal)).toContain("keys");
    expect(order.slice(0, firstLocal)).toContain("backups");
    // Nothing but localStorage removals occur after the first one.
    expect(order.slice(firstLocal).every((s) => s === "local")).toBe(true);
  });

  it("records per-step failures but keeps erasing everything else", async () => {
    const deps = okDeps();
    deps.clearSqliteTable.mockImplementation(async (table: string) => {
      if (table === "messages") throw new Error("db locked");
    });
    deps.clearAllApiKeys.mockRejectedValue(new Error("keychain locked"));

    const result = await eraseAllUserData(deps);

    // The rest still ran — one failure never aborts the sweep.
    expect(result.localKeysCleared).toHaveLength(USER_DATA_LOCAL_KEYS.length);
    expect(result.tablesCleared).not.toContain("messages");
    expect(result.tablesCleared).toContain("telemetry");
    expect(result.profilesCleared).toBe(true);
    expect(result.apiKeysCleared).toBe(false);
    expect(result.backupsCleared).toBe(true);

    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).toContain("db locked");
    expect(result.errors.join("\n")).toContain("keychain locked");
  });
});

// ---------------------------------------------------------------------------
// collectUserDataExport (impure wrapper — off-Tauri degradation)
// ---------------------------------------------------------------------------

describe("collectUserDataExport off-Tauri", () => {
  it("bundles localStorage only; SQLite/profiles/keys stay empty and no IPC fires", async () => {
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({
        "omnilink-theme": JSON.stringify({ state: { mode: "carbon" } }),
        "omnilink-account": JSON.stringify({ state: { id: "acc-1" } }),
      })
    );
    const now = Date.UTC(2026, 6, 3, 9, 30, 0);

    const bundle = await collectUserDataExport(now);

    expect(bundle.exportedAt).toBe(new Date(now).toISOString());
    expect(bundle.localStorage["omnilink-theme"]).toEqual({
      state: { mode: "carbon" },
    });
    expect(bundle.localStorage["omnilink-account"]).toEqual({
      state: { id: "acc-1" },
    });
    // Off-Tauri: no backend touched.
    expect(loadMock).not.toHaveBeenCalled();
    expect(loadProfilesMock).not.toHaveBeenCalled();
    expect(aiHasMock).not.toHaveBeenCalled();
    expect(bundle.profiles).toEqual([]);
    expect(bundle.apiKeyProviders).toEqual({});
    expect(bundle.sqlite.telemetry).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// wipeAllUserData (impure wrapper)
// ---------------------------------------------------------------------------

describe("wipeAllUserData", () => {
  it("off-Tauri clears every localStorage store without touching the backend", async () => {
    const seed: Record<string, string> = {};
    for (const k of USER_DATA_LOCAL_KEYS) seed[k] = "x";
    const ls = fakeLocalStorage(seed);
    vi.stubGlobal("localStorage", ls);

    const result = await wipeAllUserData();

    // All 18 stores gone.
    expect(ls.length).toBe(0);
    expect(result.localKeysCleared).toHaveLength(USER_DATA_LOCAL_KEYS.length);
    // No backend seam engaged off-Tauri.
    expect(loadMock).not.toHaveBeenCalled();
    expect(loadProfilesMock).not.toHaveBeenCalled();
    expect(aiDeleteAllMock).not.toHaveBeenCalled();
    expect(deleteBackupsMock).not.toHaveBeenCalled();
  });

  it("on-Tauri wipes SQLite tables, every profile, backups, and all key slots (default + custom)", async () => {
    isTauriMock.mockReturnValue(true);

    const execMock = vi.fn().mockResolvedValue(undefined);
    const closeMock = vi.fn().mockResolvedValue(undefined);
    loadMock.mockResolvedValue({
      execute: execMock,
      select: vi.fn().mockResolvedValue([]),
      close: closeMock,
    });
    loadProfilesMock.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    deleteProfileMock.mockResolvedValue(undefined);
    deleteBackupsMock.mockResolvedValue(undefined);
    aiDeleteAllMock.mockResolvedValue(undefined);

    // A custom key slot configured for anthropic must ALSO be passed for clearing.
    vi.stubGlobal(
      "localStorage",
      fakeLocalStorage({
        "omnilink-byok": JSON.stringify({
          state: { credentials: { anthropic: { keyId: "work-slot" } } },
          version: 0,
        }),
      })
    );

    const result = await wipeAllUserData();

    // A) DELETE FROM each table on the shared connection, then close.
    for (const table of USER_DATA_SQLITE_TABLES) {
      expect(execMock).toHaveBeenCalledWith(`DELETE FROM ${table}`);
    }
    expect(closeMock).toHaveBeenCalledTimes(1);
    // C) every profile deleted.
    expect(deleteProfileMock).toHaveBeenCalledWith("p1");
    expect(deleteProfileMock).toHaveBeenCalledWith("p2");
    // D) wholesale key erase: slots include every provider default AND the
    // custom slot the user configured.
    expect(aiDeleteAllMock).toHaveBeenCalledTimes(1);
    const slots = aiDeleteAllMock.mock.calls[0][0] as string[];
    for (const p of PROVIDER_IDS) expect(slots).toContain(p);
    expect(slots).toContain("work-slot");
    // E) backups wiped.
    expect(deleteBackupsMock).toHaveBeenCalledTimes(1);

    expect(result.errors).toEqual([]);
    expect(result.tablesCleared).toEqual([...USER_DATA_SQLITE_TABLES]);
    expect(result.profilesCleared).toBe(true);
    expect(result.apiKeysCleared).toBe(true);
    expect(result.backupsCleared).toBe(true);
  });
});
