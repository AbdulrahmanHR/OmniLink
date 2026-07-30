import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  migrateKnowledgePersisted,
  selectOfflineSources,
  useKnowledgeStore,
} from "@/stores/knowledge";

/**
 * Mock the D17 pack-update seam so the deferred "updated" (genuine refresh)
 * path can be exercised. By default the mock delegates to the REAL `updatePack`
 * (bundled sources → `"up-to-date"`), so the honesty assertions run against
 * production behavior; only the dedicated "genuine refresh" test overrides it to
 * return `"updated"`.
 */
const mocks = vi.hoisted(() => ({
  updatePack: vi.fn(),
  realUpdatePack: null as null | ((id: string) => Promise<unknown>),
}));

vi.mock("@/lib/knowledge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/knowledge")>();
  mocks.realUpdatePack = actual.updatePack;
  return { ...actual, updatePack: mocks.updatePack };
});

const store = () => useKnowledgeStore.getState();

beforeEach(() => {
  mocks.updatePack.mockReset();
  mocks.updatePack.mockImplementation((id: string) => mocks.realUpdatePack!(id));
  store().reset();
});

describe("useKnowledgeStore — listing sources", () => {
  it("lists the allowlist-admitted trusted sources with their metadata", () => {
    const { sources } = store();
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(s.metadata.id.length).toBeGreaterThan(0);
      expect(s.metadata.title.length).toBeGreaterThan(0);
      expect(s.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(s.metadata.license.length).toBeGreaterThan(0);
      expect(["official", "omnilink-notes"]).toContain(s.metadata.trustLevel);
    }
  });

  it("exposes both an official and an omnilink-notes source", () => {
    const levels = new Set(store().sources.map((s) => s.metadata.trustLevel));
    expect(levels.has("official")).toBe(true);
    expect(levels.has("omnilink-notes")).toBe(true);
  });
});

describe("useKnowledgeStore — cached sources are usable offline", () => {
  it("every listed source is cached, offline, and carries loaded content", () => {
    for (const s of store().sources) {
      expect(s.cached).toBe(true);
      expect(s.offline).toBe(true);
      expect(s.content.length).toBeGreaterThan(0);
    }
  });

  it("selectOfflineSources returns the full offline-usable set", () => {
    const offline = selectOfflineSources(store());
    expect(offline.length).toBe(store().sources.length);
  });
});

describe("useKnowledgeStore — D17 update seam", () => {
  it("an up-to-date source stays usable but records NO timestamp (no fabricated refresh)", async () => {
    // The bundled sources never trigger a real fetch, so `updatePack` returns
    // "up-to-date" — NOT a genuine refresh. Stamping "now" here would fabricate a
    // "Refreshed {date}" for work that never ran, so the store must leave
    // `lastUpdated` untouched and let the panel show the honest bundled freshness.
    const id = store().sources[0].metadata.id;
    const result = await store().updateSource(id, 1_720_000_000_000);
    expect(result.status).toBe("up-to-date");
    expect(result.source).not.toBeNull();
    expect(result.source?.metadata.id).toBe(id);
    expect(store().lastUpdated[id]).toBeUndefined();
    // The in-flight flag is cleared after completion.
    expect(store().updating[id]).toBeUndefined();
  });

  it("stamps lastUpdated ONLY on a genuine refresh (status 'updated')", async () => {
    // The reserved future path: once the deferred real fetch returns a newer
    // pack ("updated"), stamping the update time IS honest. Mock the seam so this
    // stamping path stays covered even though bundled sources never hit it today.
    const source = store().sources[0];
    const id = source.metadata.id;
    mocks.updatePack.mockResolvedValueOnce({ id, status: "updated", source });
    const result = await store().updateSource(id, 1_720_000_000_000);
    expect(result.status).toBe("updated");
    expect(store().lastUpdated[id]).toBe(1_720_000_000_000);
    expect(store().updating[id]).toBeUndefined();
  });

  it("reports an unknown id as unavailable and records no timestamp", async () => {
    const result = await store().updateSource("no-such-source", 123);
    expect(result.status).toBe("unavailable");
    expect(result.source).toBeNull();
    expect(store().lastUpdated["no-such-source"]).toBeUndefined();
  });

  it("updateAll does NOT stamp the bundled sources and reports them as up-to-date", async () => {
    const summary = await store().updateAll(999);
    // No fabricated timestamps for the bundled (up-to-date) sources.
    for (const s of store().sources) {
      expect(store().lastUpdated[s.metadata.id]).toBeUndefined();
    }
    // The honest summary counts every bundled source as already current.
    expect(summary.updated).toBe(0);
    expect(summary.unavailable).toBe(0);
    expect(summary.upToDate).toBe(store().sources.length);
  });

  it("refresh recomputes the list from the bundled registry", () => {
    const before = store().sources.map((s) => s.metadata.id);
    store().refresh();
    expect(store().sources.map((s) => s.metadata.id)).toEqual(before);
  });
});

describe("useKnowledgeStore — persist migration (v0/v1 → v2)", () => {
  it("v0: clears fabricated lastUpdated AND drops the legacy global disable map, keeping imports", () => {
    // A released v0 store persisted a fake `lastUpdated` on the always-
    // "up-to-date" bundled result AND a GLOBAL `disabledSources` map. On upgrade
    // the fabricated stamp must be dropped (no fake "Refreshed {date}") and the
    // global disable map — which has no honest per-conversation meaning — is
    // dropped so the per-chat model starts clean; imported notes survive.
    const persistedV0 = {
      lastUpdated: { "elrs-docs": 1_720_000_000_000, "omnilink-notes": 42 },
      disabledSources: { "elrs-docs": true as const },
      importedSources: [{ id: "imported-1", chunks: [] }],
    };

    const migrated = migrateKnowledgePersisted(persistedV0, 0);

    expect(migrated.lastUpdated).toEqual({});
    expect(migrated.disabledByConversation).toEqual({});
    expect(
      (migrated as { disabledSources?: unknown }).disabledSources,
    ).toBeUndefined();
    expect(migrated.importedSources).toEqual([{ id: "imported-1", chunks: [] }]);
  });

  it("v1: keeps a GENUINE lastUpdated stamp but still drops the legacy global disable map", () => {
    const persistedV1 = {
      lastUpdated: { "elrs-docs": 1_720_000_000_000 },
      disabledSources: { "elrs-docs": true as const },
      importedSources: [],
    };

    const migrated = migrateKnowledgePersisted(persistedV1, 1);

    // The v0→v1 clear does NOT run at v1, so a genuine "updated" stamp survives.
    expect(migrated.lastUpdated).toEqual({ "elrs-docs": 1_720_000_000_000 });
    // The v1→v2 step replaces the global map with the empty per-conversation one.
    expect(migrated.disabledByConversation).toEqual({});
    expect(
      (migrated as { disabledSources?: unknown }).disabledSources,
    ).toBeUndefined();
  });

  it("leaves an already-current (v2) persisted state untouched", () => {
    const persistedV2 = {
      lastUpdated: { "elrs-docs": 1_720_000_000_000 },
      disabledByConversation: { "c-1": { "elrs-docs": true as const } },
      importedSources: [],
    };
    // At/after the current version the migration is a no-op passthrough — a
    // GENUINE future stamp and the per-conversation choices must NOT be touched.
    expect(migrateKnowledgePersisted(persistedV2, 2)).toBe(persistedV2);
  });
});
