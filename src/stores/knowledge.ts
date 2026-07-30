import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildIndex,
  loadAllowedSources,
  loadCorpusChunks,
  MAX_IMPORTED_DOCS,
  parseImportedDoc,
  updatePack,
  type Chunk,
  type ImportedSource,
  type ImportResult,
  type KnowledgeSource,
  type PackUpdateResult,
  type RetrievalIndex,
} from "@/lib/knowledge";

/**
 * Trusted knowledge source store (M49, v2.4.0).
 *
 * Holds the list of allowlist-admitted, offline-usable knowledge sources
 * (composed by {@link loadAllowedSources}: parse registry -> D16 allowlist gate
 * -> exclusion filter -> load bundled pack content) and drives the D17 on-demand
 * pack update.
 *
 * The `sources` list is DERIVED from bundled data, so it is recomputed on init
 * and on `refresh` rather than persisted — only the per-source last-update
 * timestamps (`lastUpdated`) are persisted, following the same zustand `persist`
 * + `partialize` convention as `stores/notifications.ts` / `stores/cloudMock.ts`.
 * `updating` is a runtime-only in-flight map. Pure JS/localStorage, so it
 * populates identically on web and in the Tauri webview.
 */

/**
 * Honest tally of a global "Update all" run so the UI can give truthful
 * feedback. With today's bundled sources every entry is `upToDate` (the D17
 * seam performs no real fetch); the `updated` count only rises once the deferred
 * real network refresh lands.
 */
export interface UpdateAllSummary {
  /** Sources that fetched a genuinely newer pack (reserved; real fetch deferred). */
  updated: number;
  /** Sources whose bundled/cached content was already the freshest available. */
  upToDate: number;
  /** Ids that were not allowlisted sources — nothing to update. */
  unavailable: number;
}

interface KnowledgeState {
  /** The trusted sources the app may list and serve offline (derived). */
  sources: KnowledgeSource[];
  /**
   * User-imported docs (M52, D18). Persisted LOCALLY, NEVER uploaded; each
   * carries `trustLevel: "user-imported"` and joins the retrieval index. The
   * escalation guard: nothing here is ever `official`/`omnilink-notes`.
   */
  importedSources: ImportedSource[];
  /** Per-source last on-demand update timestamp (ms since epoch); persisted. */
  lastUpdated: Record<string, number>;
  /** Per-source in-flight update flag (runtime-only, not persisted). */
  updating: Record<string, boolean>;
  /**
   * Sources the user has turned OFF for retrieval, scoped PER CONVERSATION
   * (M52 per-chat). The outer key is a conversation id — or the transient
   * {@link DRAFT_CONVERSATION_KEY} for toggles made in a fresh chat before its
   * first turn opens a real conversation; the inner map holds the disabled
   * source ids (trusted OR imported) for THAT conversation. An absent inner key
   * ⇒ enabled, so a brand-new conversation disables NOTHING (all sources on).
   * Persisted (minus the draft bucket) so each chat's choices survive restarts.
   * Retrieval (`retrieveForChat`) scopes to a conversation's enabled set, so
   * disabling a source in one chat never affects another.
   */
  disabledByConversation: Record<string, Record<string, true>>;
  /**
   * Enable/disable a source (trusted or imported) for RAG retrieval WITHIN one
   * conversation (per-chat). Writes only that conversation's disabled set.
   */
  setSourceEnabled: (conversationId: string, id: string, enabled: boolean) => void;
  /**
   * Carry the transient draft disabled-set ({@link DRAFT_CONVERSATION_KEY} —
   * toggles made before a fresh chat opened a real conversation) onto a
   * just-created conversation id, then consume the draft. Called when the first
   * turn lazily opens the conversation so its first answer honors the pre-send
   * per-chat source choices. A no-op when the draft is empty.
   */
  promoteDraftSources: (conversationId: string) => void;
  /**
   * Discard the transient draft disabled-set — unsent per-chat toggles made in a
   * fresh chat. Called when that chat is ABANDONED (a "New chat" clear, or
   * switching to a stored conversation) so a later brand-new chat truly starts
   * with NOTHING disabled and no orphaned draft is silently promoted onto it. A
   * no-op when there is no draft.
   */
  clearDraftSources: () => void;
  /**
   * Import a local `.txt`/`.md` note (M52). Pure: the caller supplies the file
   * name + already-read text (via the Rust `knowledge_read_doc` seam or the
   * browser File API). Enforces {@link MAX_IMPORTED_DOCS}; parses through
   * `parseImportedDoc` (which stamps `user-imported` by construction) and, on
   * success, appends the source and re-indexes. Returns the parse outcome so the
   * UI can surface a localized rejection reason. Fully offline + account-free.
   */
  importDoc: (fileName: string, content: string, now?: number) => ImportResult;
  /** Delete an imported source and re-index (its chunks leave retrieval). */
  deleteImportedSource: (id: string) => void;
  /** Recompute the source list from the bundled registry. */
  refresh: () => void;
  /**
   * Trigger the D17 on-demand update for one source. Records an update
   * timestamp ONLY on a genuine content refresh (`status === "updated"`);
   * `"up-to-date"` (today's bundled reality) and `"unavailable"` leave the map
   * untouched, so the panel never fabricates a "Refreshed {date}". Returns the
   * seam's result; the cached content stays usable throughout.
   */
  updateSource: (id: string, now?: number) => Promise<PackUpdateResult>;
  /**
   * Update every listed source in turn (the global "Update all" action) and
   * return an honest tally so the UI can report what actually happened.
   */
  updateAll: (now?: number) => Promise<UpdateAllSummary>;
  /** Reset to the initial (freshly-loaded) state (test seam + a hard clear). */
  reset: () => void;
}

/**
 * Transient conversation key for per-chat source toggles made BEFORE the first
 * turn opens a real conversation (a fresh / "new" chat has no id yet). It is
 * never a real conversation id (those are minted as `c-…`) and is stripped from
 * persistence, so a draft never leaks across restarts. `promoteDraftSources`
 * moves it onto the real id the moment the conversation is created.
 */
export const DRAFT_CONVERSATION_KEY = "__draft__";

function initialSources(): KnowledgeSource[] {
  return loadAllowedSources();
}

/** Strip the transient draft bucket so it is never persisted (session-only). */
function stripDraftBucket(
  map: Record<string, Record<string, true>>,
): Record<string, Record<string, true>> {
  if (!(DRAFT_CONVERSATION_KEY in map)) return map;
  const rest = { ...map };
  delete rest[DRAFT_CONVERSATION_KEY];
  return rest;
}

/**
 * The bundled trusted corpus chunks, memoized (they never change at runtime).
 * The combined retrieval index is built from these plus the imported chunks.
 */
let bundledChunks: Chunk[] | null = null;
function getBundledChunks(): Chunk[] {
  if (bundledChunks === null) bundledChunks = loadCorpusChunks();
  return bundledChunks;
}

/** A cheap signature of the imported set — its ids + chunk counts. */
function importedSignature(sources: readonly ImportedSource[]): string {
  return sources.map((s) => `${s.id}:${s.chunks.length}`).join("|");
}

/**
 * Memoized combined index (bundled trusted chunks + imported chunks), rebuilt
 * only when the imported set changes (import/delete). Imported docs join the
 * SAME BM25 index and retrieval path as trusted packs — there is no separate,
 * weaker path for imported content.
 */
let indexCache: { sig: string; index: RetrievalIndex } | null = null;
export function buildKnowledgeIndex(
  importedSources: readonly ImportedSource[],
): RetrievalIndex {
  const sig = importedSignature(importedSources);
  if (indexCache !== null && indexCache.sig === sig) return indexCache.index;
  const importedChunks = importedSources.flatMap((s) => s.chunks);
  const index = buildIndex([...getBundledChunks(), ...importedChunks]);
  indexCache = { sig, index };
  return index;
}

/** The persisted slice of the knowledge store (see `partialize` below). */
type PersistedKnowledge = Pick<
  KnowledgeState,
  "lastUpdated" | "disabledByConversation" | "importedSources"
>;

/** Current persisted-schema version (bumped from the implicit 0 shipped in M49). */
export const KNOWLEDGE_PERSIST_VERSION = 2;

/**
 * Persist migration, chained v0 → v1 → v2.
 *
 * **v0 → v1 (honesty fix).** The v0 store (shipped since M49 / v2.4.0) STAMPED
 * `lastUpdated[id] = now` on the always-`"up-to-date"` bundled result, so any
 * released build could persist a FABRICATED timestamp the panel then renders as
 * a fake "Refreshed {date}". The real fetch that would legitimately set a
 * timestamp (`status === "updated"`) is still deferred, so NO genuine stamp can
 * exist yet — we clear `lastUpdated` outright on upgrade (lossless).
 *
 * **v1 → v2 (per-chat scoping).** The enable/disable toggle became PER
 * CONVERSATION (M52 per-chat): `disabledByConversation` replaces the old GLOBAL
 * `disabledSources` map. That global map disabled a source EVERYWHERE, keyed off
 * no conversation, so it has no honest per-conversation meaning — pinning it onto
 * every existing chat would fabricate choices the user never made. We therefore
 * DROP it: the per-conversation model starts with nothing disabled and the user
 * re-scopes per chat. Imported notes are preserved untouched.
 */
export function migrateKnowledgePersisted(
  persisted: unknown,
  version: number,
): PersistedKnowledge {
  if (persisted === null || typeof persisted !== "object") {
    return persisted as PersistedKnowledge;
  }
  let p = persisted as Record<string, unknown>;
  if (version < 1) {
    p = { ...p, lastUpdated: {} };
  }
  if (version < 2) {
    // Drop the legacy global `disabledSources`; seed the per-conversation map.
    const rest = { ...p };
    delete rest.disabledSources;
    rest.disabledByConversation = {};
    p = rest;
  }
  return p as unknown as PersistedKnowledge;
}

export const useKnowledgeStore = create<KnowledgeState>()(
  persist(
    (set, get) => ({
      sources: initialSources(),
      importedSources: [],
      lastUpdated: {},
      updating: {},
      disabledByConversation: {},

      setSourceEnabled: (conversationId, id, enabled) =>
        set((state) => {
          const next = { ...(state.disabledByConversation[conversationId] ?? {}) };
          if (enabled) delete next[id];
          else next[id] = true;
          const disabledByConversation = { ...state.disabledByConversation };
          // Prune an emptied conversation bucket so the map stays tidy (an empty
          // bucket is indistinguishable from "all enabled" anyway).
          if (Object.keys(next).length === 0) delete disabledByConversation[conversationId];
          else disabledByConversation[conversationId] = next;
          return { disabledByConversation };
        }),

      promoteDraftSources: (conversationId) =>
        set((state) => {
          const draft = state.disabledByConversation[DRAFT_CONVERSATION_KEY];
          if (!draft || Object.keys(draft).length === 0) return {};
          const disabledByConversation = { ...state.disabledByConversation };
          delete disabledByConversation[DRAFT_CONVERSATION_KEY];
          // Merge draft under the (brand-new) conversation, letting any existing
          // per-conversation choice win — for a just-created id there is none.
          disabledByConversation[conversationId] = {
            ...draft,
            ...(disabledByConversation[conversationId] ?? {}),
          };
          return { disabledByConversation };
        }),

      clearDraftSources: () =>
        set((state) => {
          if (!(DRAFT_CONVERSATION_KEY in state.disabledByConversation)) return {};
          const disabledByConversation = { ...state.disabledByConversation };
          delete disabledByConversation[DRAFT_CONVERSATION_KEY];
          return { disabledByConversation };
        }),

      importDoc: (fileName, content, now = Date.now()) => {
        // Bound the imported set BEFORE parsing — a full library rejects new
        // imports rather than silently unbounded growth.
        if (get().importedSources.length >= MAX_IMPORTED_DOCS) {
          return { ok: false, reason: "limit" };
        }
        const result = parseImportedDoc(fileName, content, now);
        if (!result.ok) return result;
        // Appending changes the imported signature, so the next
        // `buildKnowledgeIndex` rebuilds the combined index (re-index on import).
        set((state) => ({
          importedSources: [...state.importedSources, result.source],
        }));
        return result;
      },

      deleteImportedSource: (id) =>
        set((state) => {
          const importedSources = state.importedSources.filter((s) => s.id !== id);
          // Drop any lingering disabled flag for this id across ALL conversations
          // so a re-import of the same id (new uuid, so unlikely) never inherits a
          // stale per-chat toggle; prune buckets that empty out.
          const disabledByConversation: Record<string, Record<string, true>> = {};
          for (const [convId, disabled] of Object.entries(state.disabledByConversation)) {
            if (!disabled[id]) {
              disabledByConversation[convId] = disabled;
              continue;
            }
            const next = { ...disabled };
            delete next[id];
            if (Object.keys(next).length > 0) disabledByConversation[convId] = next;
          }
          // The signature changes ⇒ the combined index rebuilds WITHOUT this
          // doc's chunks on the next retrieval (delete + re-index).
          return { importedSources, disabledByConversation };
        }),

      refresh: () => set({ sources: initialSources() }),

      updateSource: async (id, now = Date.now()) => {
        set((state) => ({ updating: { ...state.updating, [id]: true } }));
        try {
          const result = await updatePack(id);
          set((state) => {
            const updating = { ...state.updating };
            delete updating[id];
            // Stamp a timestamp ONLY on a GENUINE content refresh (`"updated"`,
            // reserved for the future real fetch behind the D17 isTauri() fence).
            // An `"up-to-date"` result means the bundled pack IS the freshest —
            // no remote check happened, so stamping "now" would fabricate a
            // "Refreshed {date}" for work that never ran. `"unavailable"` has
            // nothing to stamp either. In both cases the panel honestly falls
            // back to the bundled `metadata.freshnessDate`.
            const lastUpdated =
              result.status === "updated"
                ? { ...state.lastUpdated, [id]: now }
                : state.lastUpdated;
            return { updating, lastUpdated };
          });
          return result;
        } catch (error) {
          set((state) => {
            const updating = { ...state.updating };
            delete updating[id];
            return { updating };
          });
          throw error;
        }
      },

      updateAll: async (now = Date.now()) => {
        const ids = get().sources.map((s) => s.metadata.id);
        const summary: UpdateAllSummary = {
          updated: 0,
          upToDate: 0,
          unavailable: 0,
        };
        for (const id of ids) {
          const result = await get().updateSource(id, now);
          if (result.status === "updated") summary.updated += 1;
          else if (result.status === "up-to-date") summary.upToDate += 1;
          else summary.unavailable += 1;
        }
        return summary;
      },

      reset: () => {
        // Also invalidate the memoized combined index so a reset store retrieves
        // over the bundled corpus only.
        indexCache = null;
        set({
          sources: initialSources(),
          importedSources: [],
          lastUpdated: {},
          updating: {},
          disabledByConversation: {},
        });
      },
    }),
    {
      name: "omnilink-knowledge",
      // Bumped as the schema evolved: v1 dropped fabricated `lastUpdated` stamps;
      // v2 replaced the global `disabledSources` with the per-conversation map.
      version: KNOWLEDGE_PERSIST_VERSION,
      migrate: migrateKnowledgePersisted,
      // Persist the update timestamps, the user's per-CONVERSATION enable choices
      // (minus the transient draft bucket), and the imported docs (LOCAL only —
      // never uploaded); the trusted source list + action surface are recomputed
      // from bundled data on load.
      partialize: (state): PersistedKnowledge => ({
        lastUpdated: state.lastUpdated,
        disabledByConversation: stripDraftBucket(state.disabledByConversation),
        importedSources: state.importedSources,
      }),
    },
  ),
);

/** Sources that are cached and usable with no network (the offline set). */
export function selectOfflineSources(state: KnowledgeState): KnowledgeSource[] {
  return state.sources.filter((s) => s.offline);
}

/**
 * Ids of the sources ENABLED for retrieval IN A GIVEN CONVERSATION (M52
 * per-chat): every listed trusted source AND every imported source, minus the
 * disabled set the passed conversation turned off. Retrieval scopes grounding to
 * this set, so a source disabled in ONE chat still grounds answers in another.
 *
 * `conversationId === null` (e.g. a fresh panel with no active conversation, or
 * the non-chat wizard) means "no conversation scope" ⇒ nothing is filtered and
 * every source is enabled — never silently disable everything.
 */
export function selectEnabledSourceIdsFor(
  state: KnowledgeState,
  conversationId: string | null,
): Set<string> {
  const disabled =
    conversationId === null ? undefined : state.disabledByConversation[conversationId];
  const out = new Set<string>();
  for (const s of state.sources) {
    if (!disabled?.[s.metadata.id]) out.add(s.metadata.id);
  }
  for (const s of state.importedSources) {
    if (!disabled?.[s.id]) out.add(s.id);
  }
  return out;
}

/**
 * The all-enabled baseline: every listed trusted + imported source id with NO
 * per-conversation filtering (equivalent to `selectEnabledSourceIdsFor(state,
 * null)`). Used where grounding is not scoped to a chat — e.g. the wizard
 * rationale citations — or as the default before a conversation exists.
 */
export function selectEnabledSourceIds(state: KnowledgeState): Set<string> {
  return selectEnabledSourceIdsFor(state, null);
}

/** The user's imported sources (M52), in import order. */
export function selectImportedSources(state: KnowledgeState): ImportedSource[] {
  return state.importedSources;
}

/**
 * The combined retrieval index (bundled trusted chunks + imported chunks),
 * memoized and rebuilt only when the imported set changes (M52). Both the send
 * path (`sendMessage`) and the pre-send preview score against THIS index, so
 * imported docs are retrievable and citations/grounding never diverge.
 */
export function selectRetrievalIndex(state: KnowledgeState): RetrievalIndex {
  return buildKnowledgeIndex(state.importedSources);
}
