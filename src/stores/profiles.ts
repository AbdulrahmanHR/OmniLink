import { create, type StateCreator } from "zustand";
// Aliased: this module already has a local `persist(profile)` helper (the
// fire-and-forget disk write for one profile), which predates the middleware.
import { persist as persistMiddleware } from "zustand/middleware";
import { isTauri } from "@tauri-apps/api/core";
import {
  PRESET_PROFILES,
  type ConfigProfile,
} from "@/lib/mockProfiles";
import type { ProfileSettings } from "@/lib/profileSettings";
import {
  loadProfiles,
  saveProfile,
  deleteStoredProfile,
  grantSyncFolder,
  revokeSyncFolder,
  listSyncFolder,
  readSyncFolderFile,
  writeSyncFolderFile,
  deleteSyncFolderFile,
  type StoredProfileDto,
} from "@/lib/tauri";
import {
  elrspToProfile,
  migrateElrsp,
  serializeElrsp,
  ELRSP_SCHEMA_VERSION,
  type ElrspDocument,
} from "@/lib/elrsp";
import {
  diffFolderSync,
  isValidProfileFileName,
  keepBothFileName,
  keepBothProfileName,
  parseFolderSyncError,
  type FolderFileSide,
  type FolderSyncEntry,
  type LocalProfileSide,
} from "@/lib/folderSync";

/**
 * Generate a stable unique id for a newly created profile.
 * Falls back gracefully if `crypto.randomUUID` is unavailable.
 */
function newProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `profile-${crypto.randomUUID()}`;
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Deep-ish copy of a settings record (flat primitives only). */
function cloneSettings(settings: ProfileSettings): ProfileSettings {
  return { ...settings };
}

/** Clone a profile (including its settings) so seed data is never mutated. */
function cloneProfile(profile: ConfigProfile): ConfigProfile {
  return { ...profile, settings: cloneSettings(profile.settings) };
}

/**
 * Neutral diff baseline used in the real app. The device's applied settings are
 * unknown until a device provides them, so the diff compares against this sane
 * factory-neutral config rather than mock data.
 */
const NEUTRAL_SETTINGS: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: false,
  modelId: 0,
  bindingPhrase: "",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

/**
 * Build the visible profile list from the persistent inputs. Factory presets
 * are always present (REAL). User-saved profiles come first so the newest is at
 * the top.
 */
function deriveProfiles(userProfiles: ConfigProfile[]): ConfigProfile[] {
  return [...userProfiles, ...PRESET_PROFILES.map(cloneProfile)];
}

/**
 * Project a user profile onto its persistent on-disk DTO. User profiles always
 * carry a literal `name` (renameProfile strips any i18n key), so `name` is taken
 * verbatim with an empty-string fallback that never occurs in practice.
 */
function profileToStoredDto(profile: ConfigProfile): StoredProfileDto {
  const dto: StoredProfileDto = {
    id: profile.id,
    name: profile.name ?? "",
    settings: { ...profile.settings },
    updatedAt: profile.updatedAt,
  };
  if (profile.description !== undefined) dto.description = profile.description;
  return dto;
}

/** Inflate a persisted DTO back into a literal (non-builtin) user profile. */
function storedDtoToProfile(dto: StoredProfileDto): ConfigProfile {
  const profile: ConfigProfile = {
    id: dto.id,
    name: dto.name,
    settings: { ...dto.settings },
    updatedAt: dto.updatedAt,
  };
  if (dto.description !== undefined) profile.description = dto.description;
  return profile;
}

/**
 * Fire-and-forget persist. Ordered after the state mutation by the caller but
 * never awaited, so the UI is never blocked.
 *
 * Distinguishes the two failure modes: running outside Tauri (no backend to
 * write to — the expected browser/dev case) returns early and silently, whereas
 * a genuine backend write failure (disk full, permission denied) surfaces as a
 * `persistError` i18n key the UI can show. A successful write clears any stale
 * error left by a prior attempt.
 */
function persist(profile: ConfigProfile): void {
  if (!isTauri()) return;
  void saveProfile(profileToStoredDto(profile)).then(
    () => {
      if (useProfilesStore.getState().persistError !== null) {
        useProfilesStore.setState({ persistError: null });
      }
    },
    () =>
      useProfilesStore.setState({ persistError: "profiles.errors.saveFailed" })
  );
}

/** Find the profile whose settings exactly match the active config, if any. */
function matchAppliedId(
  profiles: ConfigProfile[],
  active: ProfileSettings
): string | null {
  const active_ = JSON.stringify(active);
  return (
    profiles.find((p) => JSON.stringify(p.settings) === active_)?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// M71 — folder sync (decision D37). A folder-backed SOURCE alongside the local
// store, never a replacement for it: the local library stays the source of
// truth, and every transfer is one explicit user action.
// ---------------------------------------------------------------------------

/** localStorage key for the persisted slice (the chosen folder path only). */
export const PROFILES_STORAGE_KEY = "omnilink-profiles";

/** A folder file that could not be parsed as an `.elrsp` document. */
export interface FolderUnreadable {
  fileName: string;
  /** Backend error code, or "parse" when the bytes are not a valid document. */
  code: string;
  detail: string;
}

/** Lifecycle of the folder-backed source. `idle` = no folder configured. */
export type FolderSyncPhase = "idle" | "loading" | "ready" | "error";

/** A localisable failure from the folder-sync backend. */
export interface FolderSyncFailure {
  code: string;
  detail: string;
}

/**
 * Project a USER profile onto the `.elrsp` document that would be written.
 *
 * This is `profileToElrsp` minus the i18n label resolution, because folder sync
 * only ever handles user-created profiles: their `name` is literal text (a
 * rename strips the i18n keys), whereas the factory presets are bundled with
 * every install and carry `nameKey`s — mirroring them into a shared folder would
 * write English into a Spanish user's directory and sync nothing of value.
 */
function profileToFolderDoc(profile: ConfigProfile): ElrspDocument {
  const doc: ElrspDocument = {
    schemaVersion: ELRSP_SCHEMA_VERSION,
    name: profile.name ?? "",
    settings: cloneSettings(profile.settings),
    updatedAt: profile.updatedAt,
  };
  if (profile.description !== undefined) doc.description = profile.description;
  return doc;
}

/** The local side of the diff: user profiles only, in library order. */
function localSides(userProfiles: readonly ConfigProfile[]): LocalProfileSide[] {
  return userProfiles.map((profile) => ({
    id: profile.id,
    name: profile.name ?? "",
    doc: profileToFolderDoc(profile),
  }));
}

/** Normalise a rejected `invoke` into the localisable code + detail contract. */
function toFolderFailure(error: unknown): FolderSyncFailure {
  const message = error instanceof Error ? error.message : String(error);
  return parseFolderSyncError(message);
}

interface ProfilesState {
  /** All visible profiles (user-created + factory presets). */
  profiles: ConfigProfile[];
  /** User-created profiles only — the persistent source for save/delete/rename. */
  userProfiles: ConfigProfile[];
  /** The device's current/applied configuration (diff baseline). */
  activeSettings: ProfileSettings;
  /** Currently selected profile id (drives the detail + diff panes). */
  selectedId: string | null;
  /** Id of the profile whose settings currently match `activeSettings`, if any. */
  appliedId: string | null;
  /**
   * I18n KEY of the last genuine persistence failure (a real backend write or
   * delete error), or null. A non-Tauri host is NOT an error and never sets
   * this; the UI reads it to surface the failure.
   */
  persistError: string | null;

  /** Select a profile for preview (does not change the device config). */
  selectProfile: (id: string | null) => void;
  /** Dismiss the current persistence error (clears `persistError`). */
  clearPersistError: () => void;
  /** Apply a profile — copies its settings into the active config. */
  applyProfile: (id: string) => void;
  /** Save the current active config as a new named profile. Returns its id. */
  saveCurrentAsProfile: (name: string, description?: string) => string;
  /** Delete a profile (no-op for built-in presets). */
  deleteProfile: (id: string) => void;
  /** Rename / re-describe a profile (no-op for built-in presets). */
  renameProfile: (id: string, name: string, description?: string) => void;
  /**
   * Import an `.elrsp` document as a new user profile: mints an id, prepends it
   * to the library, selects it, and persists it. Returns the new id. The diff
   * preview / migration / firmware decisions happen in the UI before this call.
   */
  importProfile: (doc: ElrspDocument) => string;
  /**
   * Restore an `.elrsp` document under a SPECIFIC id (M43 cloud restore): upserts
   * by id so a cloud profile keeps its identity across machines — overwriting the
   * matching local profile if present, otherwise prepending it. Distinct from
   * `importProfile` (which always mints a fresh id for a brand-new duplicate).
   * Returns the id. The restore preview / conflict resolution happen before this.
   */
  restoreProfile: (id: string, doc: ElrspDocument) => string;

  // -- M71 folder sync (opt-in; every field below is inert until a folder is
  // -- chosen, so an untouched install behaves exactly as it did at 3.0.0) ----

  /** The chosen sync folder (PERSISTED), or null when the feature is unused. */
  folderPath: string | null;
  /** Parsed `.elrsp` documents currently in that folder (runtime only). */
  folderFiles: FolderFileSide[];
  /** Files in the folder that are not readable `.elrsp` documents. */
  folderUnreadable: FolderUnreadable[];
  /** Lifecycle of the folder source. */
  folderPhase: FolderSyncPhase;
  /** Last folder-sync failure (code + detail), or null. */
  folderError: FolderSyncFailure | null;
  /** File name of the transfer in flight, or null. Disables its row's buttons. */
  folderBusy: string | null;

  /**
   * Grant + read a folder the user picked in the native dialog. Persists the
   * path on success; on failure the path is KEPT (an unplugged drive is not a
   * reason to forget the user's choice) and the error is surfaced.
   */
  chooseFolder: (path: string) => Promise<void>;
  /** Re-read the folder. Manual only — there is no watcher and no timer. */
  refreshFolder: () => Promise<void>;
  /** Revoke the grant and forget the path. Never touches the files. */
  forgetFolder: () => Promise<void>;
  /** Write one local profile into the folder under `fileName`. */
  pushToFolder: (fileName: string, profileId: string) => Promise<void>;
  /** Copy one folder file into the local library (upsert by matching name). */
  pullFromFolder: (fileName: string) => Promise<void>;
  /**
   * Conflict resolution that loses nothing: the LOCAL profile is renamed to a
   * free `<name> (n)` and pushed under the matching file name, then the folder's
   * version is pulled in under the original name. Both sides end up holding both
   * profiles, so the next diff is two `same` rows rather than a fresh conflict.
   */
  keepBothFromFolder: (fileName: string) => Promise<void>;
  /** Delete one file from the folder (never touches the local library). */
  removeFromFolder: (fileName: string) => Promise<void>;
  /** Dismiss the current folder-sync error. */
  clearFolderError: () => void;
}

/**
 * The four-way diff from its two inputs. PURE, and exported separately from the
 * selector below because a zustand v5 selector must return a cached snapshot —
 * components memoise this on `userProfiles` + `folderFiles` instead of computing
 * a fresh array inside the subscription.
 */
export function folderEntriesFrom(
  userProfiles: readonly ConfigProfile[],
  folderFiles: readonly FolderFileSide[]
): FolderSyncEntry[] {
  return diffFolderSync(localSides(userProfiles), folderFiles);
}

/** The four-way diff for a whole state snapshot (derived, never stored). */
export function selectFolderEntries(state: ProfilesState): FolderSyncEntry[] {
  return folderEntriesFrom(state.userProfiles, state.folderFiles);
}

/** The persisted slice: the chosen folder path and nothing else. */
type PersistedProfiles = Pick<ProfilesState, "folderPath">;

/**
 * Phase 1 prototype store. Factory presets are real; the diff baseline starts
 * from a neutral factory-default config until a connected device supplies its
 * applied settings. The action surface (apply/save/delete/rename) is the seam
 * Phase 2 swaps to real `.elrsp` file IO without changing components.
 *
 * M71 wrapped it in zustand `persist` for ONE field — the chosen folder-sync
 * path (kept a named creator so the body's shape is unchanged). Nothing else is
 * persisted here (profiles themselves live on disk via `commands/config.rs`),
 * and with no folder chosen the persisted slice is `{ folderPath: null }`: the
 * store then behaves exactly as it did at `3.0.0`.
 */
const createProfilesState: StateCreator<
  ProfilesState,
  [["zustand/persist", unknown]],
  []
> = (set, get) => {
  const initialProfiles = deriveProfiles([]);
  const initialActive = cloneSettings(NEUTRAL_SETTINGS);

  /** Read one folder file and parse it (migrating a legacy doc if needed). */
  const readFolderFile = async (
    file: { name: string; modifiedAt: number }
  ): Promise<
    | { ok: true; side: FolderFileSide }
    | { ok: false; unreadable: FolderUnreadable }
  > => {
    try {
      const raw = await readSyncFolderFile(file.name);
      // The ONE `.elrsp` implementation (lib/elrsp.ts) parses it — folder sync
      // does not invent a container format, and Rust never parses it either.
      const { doc } = migrateElrsp(JSON.parse(raw));
      return {
        ok: true,
        side: { fileName: file.name, doc, modifiedAt: file.modifiedAt },
      };
    } catch (error) {
      const failure = toFolderFailure(error);
      return {
        ok: false,
        unreadable: {
          fileName: file.name,
          code: failure.code === "io" ? "parse" : failure.code,
          detail: failure.detail,
        },
      };
    }
  };

  /**
   * List + read the whole folder. A file that will not parse is reported, never
   * skipped silently and never deleted — it is the user's own file.
   */
  const loadFolder = async (): Promise<void> => {
    set({ folderPhase: "loading" });
    try {
      const files = await listSyncFolder();
      const sides: FolderFileSide[] = [];
      const unreadable: FolderUnreadable[] = [];
      for (const file of files) {
        // Defence in depth: the backend already refuses these names, so a name
        // that gets here is a contract violation, not user error.
        if (!isValidProfileFileName(file.name)) continue;
        const result = await readFolderFile(file);
        if (result.ok) sides.push(result.side);
        else unreadable.push(result.unreadable);
      }
      set({
        folderFiles: sides,
        folderUnreadable: unreadable,
        folderPhase: "ready",
        folderError: null,
      });
    } catch (error) {
      set({
        folderPhase: "error",
        folderError: toFolderFailure(error),
      });
    }
  };

  return {
    profiles: initialProfiles,
    userProfiles: [],
    activeSettings: initialActive,
    selectedId: initialProfiles[0]?.id ?? null,
    appliedId: matchAppliedId(initialProfiles, initialActive),
    persistError: null,

    folderPath: null,
    folderFiles: [],
    folderUnreadable: [],
    folderPhase: "idle",
    folderError: null,
    folderBusy: null,

    selectProfile: (id) => set({ selectedId: id }),
    clearPersistError: () => set({ persistError: null }),

    applyProfile: (id) => {
      const profile = get().profiles.find((p) => p.id === id);
      if (!profile) return;
      set({
        activeSettings: cloneSettings(profile.settings),
        appliedId: id,
      });
    },

    saveCurrentAsProfile: (name, description) => {
      const id = newProfileId();
      const profile: ConfigProfile = {
        id,
        name,
        description,
        settings: cloneSettings(get().activeSettings),
        updatedAt: Date.now(),
      };
      set((state) => {
        const userProfiles = [profile, ...state.userProfiles];
        return {
          userProfiles,
          profiles: deriveProfiles(userProfiles),
          selectedId: id,
        };
      });
      // Persist the new profile (ordered after the set, never blocking).
      persist(profile);
      return id;
    },

    deleteProfile: (id) => {
      // Only user-created profiles are persisted/deletable; presets are seeds.
      const isUser = get().userProfiles.some((p) => p.id === id);
      set((state) => {
        if (!state.userProfiles.some((p) => p.id === id)) return state;
        const userProfiles = state.userProfiles.filter((p) => p.id !== id);
        const profiles = deriveProfiles(userProfiles);
        return {
          userProfiles,
          profiles,
          selectedId:
            state.selectedId === id
              ? (profiles[0]?.id ?? null)
              : state.selectedId,
          appliedId: state.appliedId === id ? null : state.appliedId,
        };
      });
      // Mirror persist(): silent outside Tauri, surface genuine delete failures.
      if (isUser && isTauri()) {
        void deleteStoredProfile(id).then(
          () => {
            if (get().persistError !== null) set({ persistError: null });
          },
          () => set({ persistError: "profiles.errors.deleteFailed" })
        );
      }
    },

    renameProfile: (id, name, description) => {
      let updated: ConfigProfile | null = null;
      set((state) => {
        if (!state.userProfiles.some((p) => p.id === id)) return state;
        const userProfiles = state.userProfiles.map((p) => {
          if (p.id !== id) return p;
          updated = {
            ...p,
            name,
            description,
            // Once renamed, drop the i18n keys in favour of literal text.
            nameKey: undefined,
            descriptionKey: undefined,
            updatedAt: Date.now(),
          };
          return updated;
        });
        return {
          userProfiles,
          profiles: deriveProfiles(userProfiles),
        };
      });
      if (updated) persist(updated);
    },

    importProfile: (doc) => {
      const profile = elrspToProfile(doc);
      set((state) => {
        const userProfiles = [profile, ...state.userProfiles];
        return {
          userProfiles,
          profiles: deriveProfiles(userProfiles),
          selectedId: profile.id,
        };
      });
      persist(profile);
      return profile.id;
    },

    restoreProfile: (id, doc) => {
      const profile: ConfigProfile = {
        id,
        name: doc.name,
        settings: cloneSettings(doc.settings),
        updatedAt: doc.updatedAt,
      };
      if (doc.description !== undefined) profile.description = doc.description;
      set((state) => {
        const exists = state.userProfiles.some((p) => p.id === id);
        const userProfiles = exists
          ? state.userProfiles.map((p) => (p.id === id ? profile : p))
          : [profile, ...state.userProfiles];
        return {
          userProfiles,
          profiles: deriveProfiles(userProfiles),
          selectedId: id,
        };
      });
      persist(profile);
      return id;
    },

    // -- M71 folder sync ----------------------------------------------------
    //
    // Every action below is triggered by a click. There is no watcher, no
    // timer, no auto-sync and no network: the only I/O is the six `folder-sync`
    // commands, each confined to the one directory the user granted.

    clearFolderError: () => set({ folderError: null }),

    chooseFolder: async (path) => {
      if (!isTauri()) return;
      set({ folderPhase: "loading", folderError: null });
      try {
        const grant = await grantSyncFolder(path);
        // The canonical path the backend resolved is what gets persisted and
        // shown, so what the user sees is what is actually written to.
        set({ folderPath: grant.path });
        await loadFolder();
      } catch (error) {
        // Keep `folderPath` as-is: an unplugged drive or a folder that moved is
        // not a reason to forget the user's choice.
        set({ folderPhase: "error", folderError: toFolderFailure(error) });
      }
    },

    refreshFolder: async () => {
      if (!isTauri() || get().folderPath === null) return;
      await loadFolder();
    },

    forgetFolder: async () => {
      // Local state first, so the UI is inert even if the revoke rejects.
      set({
        folderPath: null,
        folderFiles: [],
        folderUnreadable: [],
        folderPhase: "idle",
        folderError: null,
        folderBusy: null,
      });
      if (!isTauri()) return;
      try {
        await revokeSyncFolder();
      } catch {
        // Nothing left to report: the folder is already forgotten locally, and
        // the grant dies with the process in the worst case.
      }
    },

    pushToFolder: async (fileName, profileId) => {
      if (!isTauri() || get().folderPath === null) return;
      const profile = get().userProfiles.find((p) => p.id === profileId);
      if (!profile) return;
      set({ folderBusy: fileName, folderError: null });
      try {
        const doc = profileToFolderDoc(profile);
        const written = await writeSyncFolderFile(fileName, serializeElrsp(doc));
        // Reflect the write locally instead of re-reading the whole folder: the
        // bytes we just wrote ARE the document, so the row settles to `same`.
        set((state) => ({
          folderFiles: [
            ...state.folderFiles.filter((f) => f.fileName !== fileName),
            { fileName, doc, modifiedAt: written.modifiedAt },
          ],
          folderUnreadable: state.folderUnreadable.filter(
            (f) => f.fileName !== fileName
          ),
          folderBusy: null,
          folderPhase: "ready",
        }));
      } catch (error) {
        set({ folderBusy: null, folderError: toFolderFailure(error) });
      }
    },

    pullFromFolder: async (fileName) => {
      if (!isTauri() || get().folderPath === null) return;
      const file = get().folderFiles.find((f) => f.fileName === fileName);
      if (!file) return;
      set({ folderBusy: fileName, folderError: null });
      // Upsert: a local profile that the DIFF paired with this file is REPLACED
      // (that is what "pull" means for a conflict), otherwise a new profile is
      // imported. The pairing comes from the same diff the user was looking at,
      // so the action can never resolve to a different profile than the row did.
      // Ids are local only — they are never written into the file.
      const paired = folderEntriesFrom(get().userProfiles, get().folderFiles).find(
        (entry) => entry.fileName === fileName
      );
      if (paired?.local) get().restoreProfile(paired.local.id, file.doc);
      else get().importProfile(file.doc);
      set({ folderBusy: null });
    },

    keepBothFromFolder: async (fileName) => {
      if (!isTauri() || get().folderPath === null) return;
      const file = get().folderFiles.find((f) => f.fileName === fileName);
      if (!file) return;
      // The local side of the row the user acted on (see `pullFromFolder`).
      const paired = folderEntriesFrom(get().userProfiles, get().folderFiles).find(
        (entry) => entry.fileName === fileName
      );
      const mine = paired?.local
        ? get().userProfiles.find((p) => p.id === paired.local?.id)
        : undefined;
      if (!mine) return;

      set({ folderBusy: fileName, folderError: null });
      // 1. Rename MY profile to a free `<name> (n)` — nothing is overwritten.
      const takenNames = get().userProfiles.map((p) => p.name ?? "");
      const renamed = keepBothProfileName(mine.name ?? "", takenNames);
      get().renameProfile(mine.id, renamed, mine.description);

      // 2. Push it under the matching file name (also free in the folder).
      const takenFiles = get().folderFiles.map((f) => f.fileName);
      const newFileName = keepBothFileName(fileName, takenFiles);
      await get().pushToFolder(newFileName, mine.id);
      if (get().folderError !== null) return;

      // 3. Pull the folder's version in under the original name. Both sides now
      //    hold both profiles, so the next diff shows two `same` rows.
      get().importProfile(file.doc);
      set({ folderBusy: null });
    },

    removeFromFolder: async (fileName) => {
      if (!isTauri() || get().folderPath === null) return;
      set({ folderBusy: fileName, folderError: null });
      try {
        await deleteSyncFolderFile(fileName);
        set((state) => ({
          folderFiles: state.folderFiles.filter((f) => f.fileName !== fileName),
          folderUnreadable: state.folderUnreadable.filter(
            (f) => f.fileName !== fileName
          ),
          folderBusy: null,
        }));
      } catch (error) {
        set({ folderBusy: null, folderError: toFolderFailure(error) });
      }
    },
  };
};

export const useProfilesStore = create<ProfilesState>()(
  persistMiddleware(createProfilesState, {
    name: PROFILES_STORAGE_KEY,
    version: 1,
    // ONLY the chosen folder path. The profiles themselves are files on disk,
    // the diff is derived, and the parsed folder contents are runtime state.
    partialize: (state): PersistedProfiles => ({ folderPath: state.folderPath }),
    // A remembered folder is re-granted on the next launch — the grant lives in
    // Rust process state, so it must be re-established before any read. This is
    // the ONLY automatic folder call in the feature, and it reads nothing the
    // user did not already point us at.
    onRehydrateStorage: () => (state) => {
      const path = state?.folderPath ?? null;
      if (path !== null && isTauri()) {
        void useProfilesStore.getState().chooseFolder(path);
      }
    },
  })
);

/**
 * Async hydration (M17, FR-CFG-02). Kicked off WITHOUT blocking store creation:
 * the store is usable immediately with presets + neutral baseline, then the
 * persisted user profiles are merged in once `loadProfiles` resolves. Guarded so
 * a non-Tauri/browser host (where `invoke` rejects) simply yields no profiles
 * rather than throwing (mirrors `stores/device.ts` refreshPorts).
 */
void (async () => {
  try {
    const stored = await loadProfiles();
    const fromDisk = stored.map(storedDtoToProfile);
    useProfilesStore.setState((state) => {
      // Disk is the source of truth on first load. If the user created a profile
      // between store-create and this resolving, keep those local-only entries
      // rather than clobbering them.
      const base =
        state.userProfiles.length === 0
          ? fromDisk
          : (() => {
              const diskIds = new Set(fromDisk.map((p) => p.id));
              const localOnly = state.userProfiles.filter(
                (p) => !diskIds.has(p.id)
              );
              return [...localOnly, ...fromDisk];
            })();
      const profiles = deriveProfiles(base);
      const selectedId = profiles.some((p) => p.id === state.selectedId)
        ? state.selectedId
        : (profiles[0]?.id ?? null);
      return {
        userProfiles: base,
        profiles,
        selectedId,
        appliedId: matchAppliedId(profiles, state.activeSettings),
      };
    });
  } catch {
    // Backend unavailable (e.g. running outside Tauri) — keep the empty list.
  }
})();
