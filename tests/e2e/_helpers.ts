/**
 * Shared Playwright E2E fixtures for OmniLink (M20 release-gate hardening).
 *
 * Spec files (Agent G/H) import everything from here. The crown jewel is
 * {@link installTauriMock}, which installs a faithful Tauri v2 IPC + event
 * bridge into the page *before navigation* so the production Zustand stores
 * — which call `@tauri-apps/api`'s `invoke`/`listen` — run unchanged headlessly.
 *
 * Contract reverse-engineered from the installed `@tauri-apps/api`:
 *  - `invoke(cmd,args)`        → `window.__TAURI_INTERNALS__.invoke(cmd,args,opts)`
 *  - `transformCallback(cb,o)` → `window.__TAURI_INTERNALS__.transformCallback`
 *  - `listen(event,handler)`   → `invoke('plugin:event|listen',{event,target,handler})`
 *  - unlisten                  → `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CSV fixtures
// ---------------------------------------------------------------------------

/** Absolute path to the fixtures directory. */
export const FIXTURES_DIR = path.join(__dirname, "fixtures");

/**
 * Betaflight-style decoded blackbox CSV for the Logs page (browse import path).
 * Carries a GPS track and an RSSI dropout that trips the `signalLoss` anomaly.
 */
export const FLIGHT_LOG_CSV = path.join(FIXTURES_DIR, "flight-log.csv");

/**
 * Canonical M11 telemetry-session CSV for the Simulator replay source. Pure-TS
 * replay — no Tauri commands involved.
 */
export const SIM_SESSION_CSV = path.join(FIXTURES_DIR, "sim-session.csv");

/**
 * A **SYNTHETIC** degradation ramp: link quality decaying smoothly into a failsafe.
 * Copied verbatim from `data/fixtures/ml-synthetic/ramp/ramp-01.csv`, which a seeded
 * generator DREW (`src/lib/ml/syntheticCorpus.ts`) — it is **not a real flight**.
 *
 * It exists here for exactly one purpose: the M59 predictive surface only renders a warning
 * when a session actually contains a degradation ramp, and **OmniLink's real reference
 * corpus contains none** (its failsafes are instantaneous — that null result is M59's
 * headline finding). So a UI test that wants to see the predicted state has to feed it drawn
 * data. Doing so proves **the surface renders**. It proves nothing whatever about field
 * performance, and `ml-predictive.spec.ts` asserts that the panel says so.
 */
export const SYNTHETIC_RAMP_CSV = path.join(FIXTURES_DIR, "synthetic-ramp.csv");

// ---------------------------------------------------------------------------
// Tauri v2 IPC + event mock
// ---------------------------------------------------------------------------

/**
 * A map of Tauri command name → the value its `invoke` should resolve to. Values
 * must be plain-serializable (they cross into the page via `addInitScript`); the
 * mock deep-clones each value before returning it, so a handler's return is never
 * mutated by the store under test.
 */
export type TauriHandlers = Record<string, unknown>;

/**
 * Install the Tauri v2 IPC/event mock into the page. **Call before navigation**
 * — it uses `page.addInitScript`, which runs in every fresh document before any
 * app code, so `"__TAURI_INTERNALS__" in window` is true the moment the stores
 * initialise.
 *
 * `handlers` maps each command to a static return value; `invoke(cmd,args)`
 * resolves to a deep clone of `handlers[cmd]` (or `undefined` when absent). The
 * built-in `plugin:event|*` commands are handled internally to drive `listen`.
 *
 * After navigation a spec can push events into the live stores with
 * {@link emitTauri}.
 */
export async function installTauriMock(
  page: Page,
  handlers: TauriHandlers = {}
): Promise<void> {
  await page.addInitScript((serializedHandlers: TauriHandlers) => {
    interface CbEntry {
      cb: (payload: unknown) => void;
      once: boolean;
    }
    interface TauriInternals {
      _cbs: Map<number, CbEntry>;
      _listeners: Map<string, Set<number>>;
      _cbId: number;
      _evId: number;
      // `getCurrentWebview()`/`getCurrentWindow()` (used by ImportDropzone's
      // native drag-drop wiring) read these labels; provide them so the merged
      // Session Analysis import surface mounts under the mock as it would in a
      // real Tauri runtime.
      metadata: {
        currentWindow: { label: string };
        currentWebview: { label: string };
      };
      transformCallback(cb: (payload: unknown) => void, once?: boolean): number;
      unregisterCallback(id: number): void;
      convertFileSrc(p: string): string;
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
    }

    const clone = (v: unknown): unknown =>
      v === undefined ? undefined : JSON.parse(JSON.stringify(v));

    const internals: TauriInternals = {
      _cbs: new Map<number, CbEntry>(),
      _listeners: new Map<string, Set<number>>(),
      _cbId: 0,
      _evId: 0,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback(cb, once = false) {
        const id = ++this._cbId;
        this._cbs.set(id, { cb, once });
        return id;
      },
      unregisterCallback(id) {
        this._cbs.delete(id);
      },
      convertFileSrc(p) {
        return p;
      },
      async invoke(cmd, args = {}) {
        if (cmd === "plugin:event|listen") {
          const event = args.event as string;
          const handler = args.handler as number;
          if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set<number>());
          }
          this._listeners.get(event)!.add(handler);
          return ++this._evId;
        }
        if (cmd === "plugin:event|unlisten") return undefined;
        if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
          return undefined;
        }
        const h = (window as unknown as { __omnilinkHandlers: TauriHandlers })
          .__omnilinkHandlers;
        return cmd in h ? clone(h[cmd]) : undefined;
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__ =
      internals;
    (
      window as unknown as {
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener(event: string, eventId: number): void;
        };
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener() {
        /* no-op: the in-memory listener set is cleared per-document */
      },
    };
    (window as unknown as { __omnilinkHandlers: TauriHandlers }).__omnilinkHandlers =
      serializedHandlers;
    (
      window as unknown as {
        __omnilinkEmit: (event: string, payload: unknown) => void;
      }
    ).__omnilinkEmit = (event, payload) => {
      const ids = internals._listeners.get(event);
      if (!ids) return;
      for (const id of ids) {
        const entry = internals._cbs.get(id);
        if (entry) entry.cb({ event, id, payload });
      }
    };
  }, handlers);
}

/**
 * One `.elrsp` file in the fake sync folder installed by
 * {@link installFolderSyncMock}: the file name and its exact text.
 */
export interface FolderSyncSeedFile {
  name: string;
  contents: string;
}

/**
 * Layer a STATEFUL fake sync folder (M71) over {@link installTauriMock}.
 *
 * The base mock answers each command with a fixed value, which cannot express
 * "push a file, then see it in the next listing". This wraps that mock's
 * `invoke` with an in-page `Map` standing in for the granted directory, so a
 * spec can drive the real store through pick → push → pull and observe the
 * folder actually changing. It also serves `plugin:dialog|open` with
 * `folderPath`, standing in for the native directory picker.
 *
 * Only the six `plugin:folder-sync|*` commands and the dialog are intercepted;
 * everything else falls through to the base mock. Call AFTER
 * {@link installTauriMock} and BEFORE navigation.
 */
export async function installFolderSyncMock(
  page: Page,
  folderPath: string,
  seed: readonly FolderSyncSeedFile[] = []
): Promise<void> {
  await page.addInitScript(
    ([path, files]) => {
      const seeded = files as FolderSyncSeedFile[];
      const store = new Map<string, { contents: string; modifiedAt: number }>();
      let clock = 1_700_000_000_000;
      for (const file of seeded) {
        clock += 1000;
        store.set(file.name, { contents: file.contents, modifiedAt: clock });
      }
      let granted: string | null = null;

      // The real runtime sets this global, and `isTauri()` from
      // `@tauri-apps/api/core` reads exactly it — folder sync (store guards +
      // the surface itself) is desktop-only, so without it the page would show
      // the "needs the desktop app" state. Set here rather than in
      // `installTauriMock` so no existing spec's isTauri() branch changes.
      (globalThis as unknown as { isTauri: boolean }).isTauri = true;

      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      const base = internals.invoke.bind(internals);

      // Exposed so a spec can assert on / seed the folder from the test side.
      (window as unknown as { __omnilinkFolder: typeof store }).__omnilinkFolder =
        store;

      internals.invoke = async (cmd, args = {}) => {
        const name = args.name as string | undefined;
        switch (cmd) {
          case "plugin:dialog|open":
            return path as string;
          case "plugin:folder-sync|grant":
            granted = args.path as string;
            return { path: granted, fileCount: store.size };
          case "plugin:folder-sync|revoke":
            granted = null;
            return undefined;
          case "plugin:folder-sync|list":
            if (granted === null) throw new Error("not-granted: no folder");
            return [...store.entries()]
              .map(([n, f]) => ({
                name: n,
                modifiedAt: f.modifiedAt,
                size: f.contents.length,
              }))
              .sort((a, b) => (a.name < b.name ? -1 : 1));
          case "plugin:folder-sync|read": {
            if (granted === null) throw new Error("not-granted: no folder");
            const file = store.get(name ?? "");
            if (!file) throw new Error(`io: ${name} not found`);
            return file.contents;
          }
          case "plugin:folder-sync|write": {
            if (granted === null) throw new Error("not-granted: no folder");
            clock += 1000;
            const contents = args.contents as string;
            store.set(name ?? "", { contents, modifiedAt: clock });
            return { name, modifiedAt: clock, size: contents.length };
          }
          case "plugin:folder-sync|delete":
            if (granted === null) throw new Error("not-granted: no folder");
            store.delete(name ?? "");
            return undefined;
          default:
            return base(cmd, args);
        }
      };
    },
    [folderPath, seed] as const
  );
}

/** Read the fake sync folder's contents from the test side. */
export async function readFolderSyncMock(
  page: Page
): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const store = (
      window as unknown as {
        __omnilinkFolder: Map<string, { contents: string }>;
      }
    ).__omnilinkFolder;
    const out: Record<string, string> = {};
    for (const [name, file] of store) out[name] = file.contents;
    return out;
  });
}

/**
 * Push a Tauri event into the live stores, exactly as the native side would emit
 * it (e.g. a `wifi://discovered` DTO). Every handler registered via `listen` for
 * `event` fires synchronously inside the page. Call *after* navigation.
 */
export async function emitTauri(
  page: Page,
  event: string,
  payload: unknown
): Promise<void> {
  await page.evaluate(
    ([e, p]) =>
      (
        window as unknown as {
          __omnilinkEmit: (event: string, payload: unknown) => void;
        }
      ).__omnilinkEmit(e as string, p),
    [event, payload] as const
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/**
 * Navigate to `baseURL + path` and wait for the app shell to render (the `<main>`
 * content region becomes visible once React has mounted the routed page).
 */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.locator("#root")).toBeAttached();
  await expect(page.locator("main")).toBeVisible();
}

// ---------------------------------------------------------------------------
// File upload
// ---------------------------------------------------------------------------

/**
 * Set an `<input type="file">` (located by `data-testid`) to the file at
 * `absPath`, driving the app's browse-import path.
 */
export async function uploadFile(
  page: Page,
  testid: string,
  absPath: string
): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).setInputFiles(absPath);
}

// ---------------------------------------------------------------------------
// Accessibility (axe-core)
// ---------------------------------------------------------------------------

/** A single axe violation, as returned by {@link axeScan}. */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: unknown[];
}

/**
 * Run an axe-core scan over the page (optionally scoped to `selector`) and return
 * only the `serious` + `critical` violations — the bar the release gate enforces.
 */
export async function axeScan(
  page: Page,
  selector?: string
): Promise<AxeViolation[]> {
  let builder = new AxeBuilder({ page });
  if (selector) builder = builder.include(selector);
  const results = await builder.analyze();
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  ) as AxeViolation[];
}

/**
 * Assert the page (optionally scoped to `selector`) has no `serious`/`critical`
 * accessibility violations. On failure the violation ids are surfaced in the
 * assertion message.
 */
export async function expectNoSeriousA11y(
  page: Page,
  selector?: string
): Promise<void> {
  const violations = await axeScan(page, selector);
  expect(
    violations,
    `serious/critical a11y violations: ${violations.map((v) => v.id).join(", ")}`
  ).toEqual([]);
}
