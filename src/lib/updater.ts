/**
 * In-app self-update state machine (M22).
 *
 * A pure, dependency-injected controller behind the Settings → App Update card.
 * It wraps the Tauri updater/process plugins so the phase transitions can be
 * unit-tested headlessly (vitest, node env) with mocked plugins — the
 * `AppUpdateSettings` component is a thin view over `createUpdaterController`.
 *
 * The flow (driven by the streamed updater download events):
 *   idle → checking → upToDate                            (no newer release)
 *   idle → checking → available → downloading → ready     (newer release found)
 *                                              → relaunch()
 *   idle → checking → notConfigured                       (no updater runtime)
 *   (any) → error                                         (a genuine failure)
 *
 * Config note: the live feed + key live in `tauri.conf.json` →
 * `plugins.updater` — `endpoints` points at this repo's GitHub Releases
 * `latest.json`, and `pubkey` is the minisign public key that MUST correspond
 * to the `TAURI_SIGNING_PRIVATE_KEY` the M21 release workflow signs artifacts
 * with (a mismatch makes every downloaded bundle fail verification). These are
 * real values, not placeholders.
 *
 * `notConfigured` is intentionally distinct from `error`: a dev/browser/
 * non-Tauri host has no updater runtime at all, and an installed build whose
 * updater endpoint/pubkey are missing isn't something the user can act on — so
 * it gets its own calm state instead of a red error banner.
 */
import {
  check as defaultCheck,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch as defaultRelaunch } from "@tauri-apps/plugin-process";
import { isTauri as defaultIsTauri } from "@tauri-apps/api/core";

/** Discrete phases the update card renders. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "upToDate"
  | "downloading"
  | "ready"
  | "notConfigured"
  | "error";

/** The full state the card renders from. */
export interface UpdaterState {
  phase: UpdatePhase;
  update: Update | null;
  /** Download completion, 0–100. */
  progress: number;
  /** Raw failure detail (only meaningful in the `error` phase). */
  error: string;
}

export const initialUpdaterState: UpdaterState = {
  phase: "idle",
  update: null,
  progress: 0,
  error: "",
};

/**
 * The Tauri seam the controller depends on. Defaults bind the real plugins;
 * tests inject fakes (and toggle `isTauri`) so no Tauri runtime is required.
 */
export interface UpdaterDeps {
  check: typeof defaultCheck;
  relaunch: typeof defaultRelaunch;
  isTauri: () => boolean;
}

const defaultDeps: UpdaterDeps = {
  check: defaultCheck,
  relaunch: defaultRelaunch,
  isTauri: defaultIsTauri,
};

/**
 * Patterns that mark a `check()` failure as "the updater simply isn't wired
 * here" rather than a genuine, actionable error. The robust *primary* guard is
 * `isTauri()` (a dev/browser host has no updater runtime at all); this is the
 * secondary net for an installed build with no endpoints configured or whose
 * updater plugin isn't registered (the non-desktop `cfg` branch in `lib.rs`).
 *
 * These match the strings the **pinned** crates actually emit, not plausible
 * paraphrases of them:
 *   - `tauri-plugin-updater` 2.10.1 `Error::EmptyEndpoints` renders as
 *     "Updater does not have any endpoints set." — the only variant of that
 *     enum that means "not wired" rather than "this attempt failed".
 *   - `tauri` 2.11.3 rejects an invoke aimed at an unregistered plugin from
 *     `PluginStore::extend_api` with "plugin updater not found"; the generic
 *     `Command {cmd} not found` rejection is kept as a second, targeted pattern
 *     so a host that never reaches the plugin store is covered too.
 *
 * Deliberately NOT matched: bare "endpoints" / "not configured" / "updater not".
 * Those are broad enough to swallow a real, actionable failure and show the calm
 * "auto-update unavailable in this build" copy in its place.
 */
const UNAVAILABLE_SIGNATURES = [
  /updater does not have any endpoints set/i,
  /plugin updater not found/i,
  /command plugin:updater\|\w+ not found/i,
];

/** True when a `check()` failure means "auto-update isn't available here". */
export function isUpdaterUnavailable(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return UNAVAILABLE_SIGNATURES.some((sig) => sig.test(message));
}

/** Imperative handle returned by {@link createUpdaterController}. */
export interface UpdaterController {
  /** Check the feed: → upToDate / available / notConfigured / error. */
  checkForUpdates(): Promise<void>;
  /** Download + verify + install the found update, then relaunch. */
  installAndRestart(): Promise<void>;
  /** Read the current internal state (the source of truth). */
  getState(): UpdaterState;
}

/**
 * Build a self-update controller. `onChange` is invoked with the new state on
 * every transition (the React view passes its `setState`); `deps` overrides the
 * Tauri seam for tests. The controller owns the canonical state — the view is a
 * pure mirror of it.
 */
export function createUpdaterController(
  onChange: (state: UpdaterState) => void,
  deps: Partial<UpdaterDeps> = {}
): UpdaterController {
  const d: UpdaterDeps = { ...defaultDeps, ...deps };
  let state: UpdaterState = initialUpdaterState;

  const set = (patch: Partial<UpdaterState>): void => {
    state = { ...state, ...patch };
    onChange(state);
  };

  const checkForUpdates = async (): Promise<void> => {
    set({ phase: "checking", error: "", progress: 0, update: null });
    // Primary guard: a non-Tauri (dev/browser/unsigned-shell) host has no
    // updater runtime, so checking is meaningless — surface the calm
    // "unavailable" state rather than letting the plugin throw a red error.
    if (!d.isTauri()) {
      set({ phase: "notConfigured" });
      return;
    }
    try {
      const found = await d.check();
      if (found) set({ update: found, phase: "available" });
      else set({ phase: "upToDate" });
    } catch (e) {
      // Secondary net: an installed build whose endpoints/pubkey/plugin are
      // missing reports "unavailable", not a generic error.
      if (isUpdaterUnavailable(e)) {
        set({ phase: "notConfigured" });
      } else {
        set({
          phase: "error",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  const installAndRestart = async (): Promise<void> => {
    const update = state.update;
    if (!update) return;
    set({ phase: "downloading", error: "", progress: 0 });
    try {
      let downloaded = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({ progress: Math.round((downloaded / contentLength) * 100) });
            }
            break;
          case "Finished":
            set({ progress: 100 });
            break;
        }
      });
      set({ phase: "ready" });
      // Restart into the freshly-installed (signature-verified) binary.
      await d.relaunch();
    } catch (e) {
      set({
        phase: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return { checkForUpdates, installAndRestart, getState: () => state };
}
