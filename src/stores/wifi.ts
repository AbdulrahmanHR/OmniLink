import { create } from "zustand";
import {
  onWifiDiscovered,
  onWifiScanComplete,
  onWifiScanError,
  startWifiScan,
  stopWifiScan,
} from "@/lib/tauri";
import type { WifiScanErrorPayload } from "@/lib/tauri";
import type { WifiDevice } from "@/lib/wifiDiscovery";

// ---------------------------------------------------------------------------
// M18: WiFi device-discovery store (FR-DISC-02).
//
// A parallel store to `stores/device.ts` (serial/CRSF) — it never touches the
// serial seam. It listens to the streaming `wifi://*` events: each discovered
// device is added/replaced by id (last-write-wins), and a scan error stops the
// scan. Every Tauri call is guarded so running outside Tauri (browser/dev or a
// machine with no WiFi adapter) yields a graceful empty list and never throws.
//
// A picked device's `address` feeds the wizard's `deviceIp`, so the existing
// WiFi-OTA path runs USB-free with no manually-typed IP. The listener
// registration mirrors `device.ts`: a module-level guard makes `init()`
// idempotent and it returns a cleanup that removes the listeners.
// ---------------------------------------------------------------------------

interface WifiState {
  /** Devices found so far this session, deduped by id (last-write-wins). */
  discovered: WifiDevice[];
  /** Whether a scan is currently running. */
  scanning: boolean;
  /** Id of the device the user has picked (e.g. in the wizard), if any. */
  selectedId: string | null;
  /**
   * Latest scan failure, or null. Cleared when a fresh scan starts. M20:
   * structured + categorized (`{ category, summaryKey, detail }`) so the UI can
   * render a localized message via `t(\`wifi.errors.${summaryKey}\`)`.
   */
  error: WifiScanErrorPayload | null;

  /**
   * Register the `wifi://*` event listeners. Idempotent — safe to call once on
   * app start, and safe to call again from a re-mount: concurrent callers share
   * one registration. Returns a cleanup that releases THIS caller's hold; the
   * last one out removes the listeners and clears the cache, so a later `init()`
   * registers a live set again instead of handing back a spent cleanup (CONN-9).
   */
  init: () => Promise<() => void>;
  /** Start (or restart) the discovery scan; clears stale results first. */
  startScan: () => Promise<void>;
  /** Stop the discovery scan. */
  stopScan: () => Promise<void>;
  /** Mark a discovered device as the user's pick. */
  select: (id: string | null) => void;
  /** Clear discovered devices + selection (does not stop a running scan). */
  clear: () => void;
}

/** Guards against registering the event listeners more than once. */
let listenersReady: Promise<() => void> | null = null;

/**
 * How many live `init()` callers share {@link listenersReady} (CONN-9). Reset
 * whenever a fresh registration is created, so a count left behind by a failed
 * or fully-disposed one is never carried forward.
 */
let listenerRefs = 0;

/**
 * Build the per-caller cleanup `init()` hands back — refcounted, so the last
 * holder to let go removes the listeners AND clears the cache (CONN-9). Without
 * clearing it, a later `init()` returned the cached promise and with it an
 * already-spent cleanup, silently leaving the app deaf to every `wifi://` event.
 * Extra calls are no-ops, and a cleanup from a PREVIOUS registration is inert
 * (the identity check) so it can never tear down the current one.
 */
function makeDispose(
  owned: Promise<() => void>,
  unlistenAll: () => void
): () => void {
  let released = false;
  return () => {
    if (released || listenersReady !== owned) return;
    released = true;
    listenerRefs -= 1;
    if (listenerRefs > 0) return;
    unlistenAll();
    listenersReady = null;
  };
}

/**
 * Monotonic scan token. A cancelled Rust worker still emits its `wifi://done`
 * ~300ms after `stopScan`; on a quick start→stop→start, that stale `done` from
 * the OLD worker would otherwise clear the NEW scan's spinner. Each `startScan`
 * bumps this and threads it to the backend, which echoes it back on `wifi://done`
 * — so a `done` whose generation isn't the current one is ignored.
 */
let scanGeneration = 0;
/**
 * The generation of the scan the store currently considers live. Set
 * SYNCHRONOUSLY inside `startScan` BEFORE any `await`, so no in-flight `done`
 * event can race ahead of it. A `done` only clears `scanning` when its
 * generation equals this.
 */
let currentScanGen = 0;

/** Add or replace a device by id (last-write-wins), preserving order. */
function upsertById(list: WifiDevice[], device: WifiDevice): WifiDevice[] {
  const index = list.findIndex((d) => d.id === device.id);
  if (index === -1) return [...list, device];
  const next = list.slice();
  next[index] = device;
  return next;
}

export const useWifiStore = create<WifiState>()((set, get) => ({
  discovered: [],
  scanning: false,
  selectedId: null,
  error: null,

  init: () => {
    if (!listenersReady) {
      // A fresh registration owns a fresh refcount; whatever a failed or
      // fully-disposed predecessor left behind is dead.
      listenerRefs = 0;
      listenersReady = (async () => {
        // CONN-8: `allSettled`, never `all`. With `all`, a rejection from the
        // 2nd/3rd `listen()` discarded the handles that HAD resolved — never
        // collected, never removed — and the `.catch` below then reset the guard
        // so the next `init()` registered a SECOND copy of each survivor.
        const results = await Promise.allSettled([
          // `WifiDeviceDto` is structurally identical to `WifiDevice`.
          onWifiDiscovered((dto) =>
            set((s) => ({ discovered: upsertById(s.discovered, dto) }))
          ),
          onWifiScanError((payload) =>
            set({ scanning: false, error: payload })
          ),
          // The single-pass worker emits `wifi://done` on every exit path; clear
          // `scanning` so the Scan button leaves its "Stop"/"Scanning…" state —
          // but ONLY for the live scan. A stale `done` from a cancelled older
          // worker (different generation) is ignored so it can't clear a newer
          // scan's spinner mid-flight.
          onWifiScanComplete((generation) => {
            if (generation === currentScanGen) set({ scanning: false });
          }),
        ]);
        const unlisteners = results.flatMap((r) =>
          r.status === "fulfilled" ? [r.value] : []
        );
        const failure = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        if (failure) {
          // Partial registration: remove what DID land before failing, so the
          // retry in the `.catch` starts from zero listeners.
          unlisteners.forEach((un) => un());
          throw failure.reason;
        }
        return () => unlisteners.forEach((un) => un());
      })().catch(() => {
        // `listen()` rejects outside Tauri (browser/dev). Reset the guard so a
        // later real attempt can retry, and hand back a no-op cleanup so the
        // store init never produces an unhandled rejection.
        listenersReady = null;
        return () => {};
      });
    }

    const owned = listenersReady;
    listenerRefs += 1;
    return owned.then((unlistenAll) => makeDispose(owned, unlistenAll));
  },

  startScan: async () => {
    if (get().scanning) return;
    // Claim a fresh generation SYNCHRONOUSLY, before any await, so a late
    // `wifi://done` from a previous worker can't slip in as the "current" scan.
    const gen = ++scanGeneration;
    currentScanGen = gen;
    // Drop stale results from a previous scan so the list reflects what's live.
    set({ scanning: true, error: null, discovered: [] });
    try {
      await startWifiScan(gen);
    } catch {
      // Backend unavailable (e.g. running outside Tauri) — no scan, no devices.
      set({ scanning: false });
    }
  },

  stopScan: async () => {
    try {
      await stopWifiScan();
    } catch {
      // Ignore — fall through to a clean local state regardless.
    }
    set({ scanning: false });
  },

  select: (selectedId) => set({ selectedId }),

  clear: () => set({ discovered: [], selectedId: null }),
}));
