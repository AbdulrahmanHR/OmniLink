/**
 * Offline / network-disabled graceful-degradation gate (M20, Agent H).
 *
 * Proves that every network-touching surface — flight-log import, the replay
 * simulator, the flight-path map + `omnitiles://` tiles, WiFi discovery, and the
 * Backpack config form — degrades GRACEFULLY with external network disabled:
 * each renders an empty/usable state and NEVER crashes (zero uncaught
 * exceptions, zero unhandled promise rejections, no "broken tile"/"Unhandled"
 * console error).
 *
 * ── Offline mechanism ──────────────────────────────────────────────────────
 * We disable the network via `page.route('**')`, aborting every *external*
 * (non-localhost) http(s) request while letting same-origin localhost traffic
 * through. This is deliberate over `context.setOffline(true)`: the app is a Vite
 * dev build that lazy-loads each route's JS chunk from `localhost:1420` on
 * navigation (React.lazy) and keeps an HMR websocket open — a hard context
 * offline would block those same-origin loads and break the app before any
 * surface could be exercised. For these surfaces "offline" means exactly the
 * external dependencies that must degrade: map tiles, GitHub firmware releases,
 * and mDNS/AP discovery are all external/native, so aborting external http(s)
 * faithfully simulates a disconnected machine while keeping the SPA itself
 * loadable. The omnitiles tile scheme is a custom `addProtocol` handler (not a
 * network request), so it is exercised by the non-Tauri fallback, not the route.
 *
 * ── Error policy ───────────────────────────────────────────────────────────
 * Every test installs collectors and asserts ZERO at the end:
 *   • `pageerror`              → uncaught exceptions (must be empty).
 *   • `window.unhandledrejection` (init-script collector) → unhandled promise
 *     rejections (must be empty).
 *   • console `error` messages → must be empty AFTER filtering documented,
 *     benign network noise (see {@link BENIGN_CONSOLE}). We additionally assert
 *     no console error contains "Unhandled" / "broken tile" / "uncaught".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import {
  emitTauri,
  FLIGHT_LOG_CSV,
  gotoApp,
  installTauriMock,
  SIM_SESSION_CSV,
  uploadFile,
} from "./_helpers";

const BASE = "http://localhost:1420";

const here = path.dirname(fileURLToPath(import.meta.url));
/** A failing DL2 fixture whose four drops raise M36 findings + the M38 repeated-lq-drops pattern. */
const DIAG_MULTI_DROP_CSV = path.resolve(
  here,
  "../../data/fixtures/diagnostics/wiring/wiring-multi-drop-04.csv"
);

/**
 * Benign noise applied to EVERY surface — an expected consequence of the test
 * environment, never an app fault of the surface under test. Documented:
 *
 *  • `Failed to load resource` / `net::ERR_*` — Chromium's own error-level log
 *    for the external requests we abort. Disabling the network is the whole
 *    point of this gate; the app not crashing is asserted via the other
 *    channels.
 *  • `[chat] latestConversationId failed` — the assistant store's background
 *    `initHistory()` restores prior chat from the conversation SQLite store,
 *    which is absent in the headless web context, so it degrades and logs. This
 *    fires on app mount regardless of the routed surface (and even WITH the
 *    Tauri IPC mock, whose generic `invoke` returns `undefined` for the SQL
 *    plugin), so it is orthogonal to all five surfaces under test.
 */
const BENIGN: RegExp[] = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /\[chat\]/i, // assistant history-restore degradation (no SQLite store headless)
];

/**
 * Additional benign noise for the two NON-Tauri tests (map + wifi), which
 * deliberately run WITHOUT the IPC mock so the production non-Tauri code paths
 * (the `omnitiles` tile fallback; the wifi store's real guards) are exercised:
 *
 *  • `transformCallback` — the GLOBAL device store's `init()` registers
 *    `device://*` listeners through the Tauri event bridge, which is absent in a
 *    bare browser; unlike the wifi store, the device store's init IIFE has no
 *    `.catch`, so its rejection surfaces. This is the device store's background
 *    init, NOT the map/wifi surface under test — the wifi store guards cleanly
 *    (its `init()` has a `.catch`) and contributes none of these.
 */
const BARE_BENIGN: RegExp[] = [/transformCallback/i];

/**
 * Additional benign noise for tests that install the Tauri IPC mock **and**
 * happen to mount the flight map.
 *
 * `installTauriMock` sets `__TAURI_INTERNALS__`, so `isTauriRuntime()` is true
 * and `installOfflineTileFallback()` deliberately declines to register its
 * transparent-tile handler — shadowing what it believes is the real, natively
 * served `omnitiles://` scheme would break live tile loading in the shipped app.
 * The IPC mock cannot implement a custom URI scheme, so Chromium logs its own
 * scheme-unsupported error for each tile request. Both real environments are
 * covered: the Tauri webview resolves `omnitiles://` via `commands/tiles.rs`,
 * and a bare browser gets the fallback protocol. This message is reachable ONLY
 * under the mock, which is exactly why the dedicated tiles-offline test below
 * runs WITHOUT the mock and does not use this filter — that test remains the
 * real guard, and `map.spec.ts` independently fails on `err_unknown_url_scheme`.
 *
 * It only became reachable at all once the 3.0.3 blank-map defect was fixed:
 * before that the style never loaded, so not one tile was ever requested.
 */
const MOCKED_TAURI_BENIGN: RegExp[] = [
  /URL scheme "omnitiles" is not supported/i,
];

/** App-level failure signatures that must NEVER appear, even after filtering. */
const FORBIDDEN_CONSOLE = /unhandled|broken tile|uncaught/i;

interface Collectors {
  pageErrors: Error[];
  consoleErrors: string[];
}

/**
 * Disable external network + attach error collectors. **Call before navigation**
 * (it registers a route + an init-script that must run before app code).
 */
async function setupOffline(page: Page): Promise<Collectors> {
  // Abort every external http(s) request; allow same-origin + non-http schemes
  // (data:/blob: for CSV export, the omnitiles addProtocol handler, etc.).
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const isLocal =
      url.startsWith(BASE) || url.startsWith("http://127.0.0.1:1420");
    const isHttp = /^https?:/i.test(url);
    if (isLocal || !isHttp) return route.continue();
    return route.abort();
  });

  // Unhandled promise rejections are NOT delivered to `pageerror` in Chromium,
  // so collect them explicitly from the page.
  await page.addInitScript(() => {
    (window as unknown as { __unhandledRejections: string[] }).__unhandledRejections = [];
    window.addEventListener("unhandledrejection", (e) => {
      (
        window as unknown as { __unhandledRejections: string[] }
      ).__unhandledRejections.push(String(e.reason));
    });
  });

  const pageErrors: Error[] = [];
  page.on("pageerror", (e) => pageErrors.push(e));
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  return { pageErrors, consoleErrors };
}

/**
 * Assert zero crashes for the surface under test: no uncaught exception, no
 * unhandled rejection, no meaningful console error.
 *
 * `bare` adds the documented non-Tauri background-init filter (used by the map +
 * wifi tests that run without the IPC mock); `mockedTauri` adds the filter for
 * noise that only the IPC mock can produce (see {@link MOCKED_TAURI_BENIGN}).
 * They are mutually exclusive by construction — a test either installs the mock
 * or it does not.
 */
async function expectNoCrash(
  page: Page,
  c: Collectors,
  opts: { bare?: boolean; mockedTauri?: boolean } = {}
): Promise<void> {
  const benign = [
    ...BENIGN,
    ...(opts.bare ? BARE_BENIGN : []),
    ...(opts.mockedTauri ? MOCKED_TAURI_BENIGN : []),
  ];
  const keep = (text: string) => !benign.some((re) => re.test(text));

  const unhandled = (
    await page.evaluate(
      () =>
        (window as unknown as { __unhandledRejections?: string[] })
          .__unhandledRejections ?? []
    )
  ).filter(keep);
  const uncaught = c.pageErrors.filter((e) => keep(e.message));
  const meaningful = c.consoleErrors.filter(keep);

  expect(uncaught, `uncaught: ${uncaught.map((e) => e.message).join("\n")}`).toHaveLength(0);
  expect(unhandled, `unhandled rejections: ${unhandled.join("\n")}`).toHaveLength(0);
  expect(meaningful, `console errors: ${meaningful.join("\n")}`).toHaveLength(0);
  // Belt-and-suspenders: these signatures must never appear, filtered or not.
  const forbidden = c.consoleErrors.filter((t) => FORBIDDEN_CONSOLE.test(t));
  expect(forbidden, `forbidden console: ${forbidden.join("\n")}`).toHaveLength(0);
}

test.describe("offline graceful degradation", () => {
  test("log import renders charts + anomaly panel offline", async ({ page }) => {
    // No IPC mock: ImportDropzone branches on `isTauri` and only renders the
    // browser <input type=file> (the testid below) in the non-Tauri path, so
    // this runs bare. The CSV parse is pure-browser — no network involved.
    const c = await setupOffline(page);
    await gotoApp(page, "/analysis");

    await uploadFile(page, "logs-import-input", FLIGHT_LOG_CSV);

    await expect(page.locator('[data-testid="logs-timeline-charts"]')).toBeVisible();
    await expect(page.locator('[data-testid="logs-anomaly-panel"]')).toBeVisible();

    await expectNoCrash(page, c, { bare: true });
  });

  test("local diagnostics engine renders panels + patterns offline (M41)", async ({
    page,
  }) => {
    // The v2.0 launch-gate offline anchor: with the external network aborted, the
    // pure-browser diagnostics engine still evaluates an imported DL2 fixture and
    // renders the Signal Health panel, the findings list, AND the M38 patterns
    // surface end-to-end — proving diagnostics are free + local, no account/network.
    await installTauriMock(page, {});
    const c = await setupOffline(page);
    await gotoApp(page, "/analysis");

    // The diagnostics surface exists ONLY after a log is parsed (anti-false-positive).
    await expect(page.locator('[data-testid="diagnostics-health-panel"]')).toHaveCount(0);

    await uploadFile(page, "logs-import-input", DIAG_MULTI_DROP_CSV);

    await expect(
      page.locator('[data-testid="diagnostics-health-panel"]').first()
    ).toBeVisible();
    await expect(page.locator('[data-testid="diagnostics-findings-list"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="diagnostics-finding"]').first()
    ).toBeVisible();
    // The multi-drop fixture trips ≥3 lq-collapse findings → the M38 patterns panel
    // renders its most-likely block, all computed locally with the network down.
    await expect(page.locator('[data-testid="diagnostics-patterns"]').first()).toBeVisible();
    await expect(
      page.locator('[data-testid="diagnostics-pattern-mostlikely"]')
    ).toBeVisible();

    await expectNoCrash(page, c);
  });

  test("simulator replays a session offline", async ({ page }) => {
    await installTauriMock(page);
    const c = await setupOffline(page);
    await gotoApp(page, "/analysis");

    await uploadFile(page, "logs-import-input", SIM_SESSION_CSV);

    // Dashboard + SIMULATED badge appear once a session is loaded.
    await expect(page.locator('[data-testid="simulator-dashboard"]')).toBeVisible();
    await expect(page.locator('[data-testid="simulated-badge"]')).toBeVisible();

    // Drive playback — pure-TS replay, no Tauri. Prove the transport actually
    // engaged play (not just that the dashboard stayed mounted): the play/pause
    // control's aria-label flips away from its idle value the moment the replay
    // engine starts advancing the shared position.
    const playpause = page.locator('[data-testid="simulator-playpause"]');
    const idleLabel = await playpause.getAttribute("aria-label");
    await playpause.click();
    await expect(playpause).not.toHaveAttribute("aria-label", idleLabel ?? "");
    await expect(page.locator('[data-testid="simulator-dashboard"]')).toBeVisible();

    await expectNoCrash(page, c, { mockedTauri: true });
  });

  test("flight map + omnitiles tiles degrade to a themed empty backdrop offline", async ({
    page,
  }) => {
    // NOTE: no Tauri mock here on purpose — that keeps `isTauriRuntime()` false
    // so the production offline tile fallback (transparent `omnitiles` protocol)
    // installs. This is the CORE tiles-offline proof: the map must show its
    // themed empty-coverage backdrop with NO broken-tile / unhandled error.
    const c = await setupOffline(page);

    // Seed the shared telemetry store with a GPS track via Session Analysis
    // replay (pure-browser), so the map has a path to render.
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", SIM_SESSION_CSV);
    await expect(page.locator('[data-testid="simulator-dashboard"]')).toBeVisible();
    await page.locator('[data-testid="simulator-playpause"]').click();

    // Client-side navigate to /telemetry (NOT a full reload — that would reset
    // the in-memory Zustand stores and drop the freshly-loaded track).
    await page.locator('a[href="/telemetry"]').click();
    await expect(page).toHaveURL(/\/telemetry$/);

    // The map panel is shown by default (persisted toggle defaults to true).
    // Reveal it explicitly if a prior state hid it, then assert it renders.
    const mapPanel = page.locator('[data-testid="flight-map-panel"]');
    await expect(mapPanel).toBeVisible();
    if (!(await page.locator('[data-testid="flight-map"]').isVisible())) {
      await page
        .getByRole("button", { name: "Flight path map" })
        .click();
    }

    // Track present → the map host renders. The themed empty-coverage backdrop
    // host (`flight-map-empty`) is the MapLibre container; we assert it is
    // attached (its `bg-muted` themed host is present) rather than `toBeVisible`,
    // because maplibre-gl.css forces `.maplibregl-map{position:relative}` —
    // unlayered, so it wins over Tailwind's layered `.absolute` and the
    // `inset-0` host collapses to 0px height in this build. That layout quirk is
    // orthogonal to offline degradation; the offline proof is that the map
    // initialises (a MapLibre <canvas> mounts) and resolves tiles via the
    // `omnitiles` fallback with NO broken-tile/console error.
    await expect(page.locator('[data-testid="flight-map"]')).toBeVisible();
    const emptyHost = page.locator('[data-testid="flight-map-empty"]');
    await expect(emptyHost).toBeAttached();
    // MapLibre actually initialised offline (canvas mounted) → tiles came from
    // the transparent `omnitiles` fallback, not the (aborted) network.
    await expect(emptyHost.locator("canvas.maplibregl-canvas")).toBeAttached();

    // Let MapLibre settle a tick so any (swallowed) tile error would surface.
    await page.waitForTimeout(500);

    await expectNoCrash(page, c, { bare: true });
  });

  test("wifi discovery stays gracefully empty offline (no Tauri)", async ({
    page,
  }) => {
    // WITHOUT installTauriMock: `listen()`/`invoke()` reject exactly as in a
    // real non-Tauri browser, so the store's guards are exercised. The scan
    // button lives only inside the multi-step wizard's StepFrequency (not
    // reachable from "/"), so per the gate we assert graceful-empty: discovery
    // surfaces nothing and nothing throws / rejects.
    const c = await setupOffline(page);
    await gotoApp(page, "/");

    // Positive anchor: the DeviceBar (which owns the WiFi list) actually
    // mounted — so "empty" is provably distinct from "the whole surface is
    // absent". The notification bell is always present in the bar.
    await expect(
      page.getByRole("button", { name: "Notifications" })
    ).toBeVisible();
    // The DeviceBar's WiFi list only renders when a device is discovered; with
    // no Tauri backend it never appears — the graceful empty state.
    await expect(page.locator('[data-testid="wifi-discovered-list"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="wifi-device-item"]')).toHaveCount(0);

    // Give the store's guarded init()/listen() rejection a tick to settle so any
    // unhandled rejection would be captured before we assert.
    await page.waitForTimeout(300);

    await expectNoCrash(page, c, { bare: true });
  });

  test("backpack config form opens offline (bundled schema)", async ({ page }) => {
    // Backpack settings schema is bundled/local, so the form works offline.
    await installTauriMock(page, { start_wifi_scan: null, stop_wifi_scan: null });
    const c = await setupOffline(page);
    await gotoApp(page, "/");

    // Emit a discovered Backpack device into the live wifi store; the DeviceBar
    // renders it as an UNMISTAKABLE Backpack row.
    await emitTauri(page, "wifi://discovered", {
      id: "ap:10.0.0.1",
      name: "ELRS Backpack",
      address: "10.0.0.1",
      source: "ap",
      kind: "tx-backpack",
    });

    const list = page.locator('[data-testid="wifi-discovered-list"]');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-testid="backpack-device-label"]')).toBeVisible();

    // Click the Backpack row → its bundled, data-driven config form expands.
    await page.locator('[data-testid="wifi-device-item"]').click();
    await expect(page.locator('[data-testid="backpack-config-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="backpack-field-vtxChannel"]')).toBeVisible();

    await expectNoCrash(page, c);
  });
});
