import { expect, test, type ConsoleMessage } from "@playwright/test";
import {
  SIM_SESSION_CSV,
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

/**
 * M20 offline flight-map (M12/M13): the `omnitiles://` tile scheme can't resolve
 * in a plain browser, so Agent D's offline transparent-tile fallback must let the
 * map degrade to a themed `bg-muted` backdrop with NO broken-tile error/crash.
 *
 * To get a real GPS track we load a session into the SHARED telemetry store via
 * the simulator, then navigate to /telemetry WITHIN the SPA (a client-side route
 * change, NOT a hard reload) so the in-memory store persists, and reveal the map
 * panel. We collect console errors + pageerrors during the map render and assert
 * none fired. We also assert the graceful no-data state on a fresh /telemetry.
 *
 * CRUCIAL: the GPS-track test installs NO Tauri IPC mock. Installing it would set
 * `__TAURI_INTERNALS__`, which makes `isTauriRuntime()` true and short-circuits
 * `installOfflineTileFallback()` — so the very `omnitiles` fallback under test
 * would never install (this spec previously did exactly that, making the offline
 * assertion vacuous). Without the mock the fallback runs for real; the device
 * store's background `init()` then rejects on the absent event bridge, but that is
 * an *unhandled rejection* (Chromium does not deliver it to `pageerror`) whose
 * text never matches the broken-tile filter. The fresh-/telemetry empty-state
 * test keeps the mock so its stores resolve headlessly.
 */
test.describe("Offline flight map", () => {
  test("renders with a GPS track, themed empty bg, no broken-tile error", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const tileErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Chromium logs `Failed to load resource: net::ERR_UNKNOWN_URL_SCHEME`
      // when the `omnitiles://` scheme is unreachable because the offline
      // fallback failed to install — the precise `err_unknown_url_scheme`
      // token is the signature this test must catch if the fallback regresses.
      // The generic `failed to load resource` string is deliberately NOT
      // matched here: index.html pulls Google Fonts from a CDN, so an offline
      // CI / CDN blip would otherwise trip this filter spuriously (offline.spec
      // classifies that same string as benign noise).
      if (
        /tile|omnitiles|broken|webgl|failed to fetch|err_unknown_url_scheme/i.test(
          text
        )
      ) {
        tileErrors.push(text);
      }
    });

    // NO Tauri IPC mock here, on purpose: that keeps `isTauriRuntime()` false so
    // the production offline tile fallback (the transparent `omnitiles`
    // addProtocol handler in map-style.ts) actually installs — the exact path
    // this test proves. Installing the mock would set `__TAURI_INTERNALS__`,
    // making `installOfflineTileFallback()` early-return so the fallback never
    // runs (the vacuous-test bug this spec previously masked).

    // Load a GPS session into the shared telemetry store via Session Analysis
    // replay, then briefly play so the path grows beyond the first frame.
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", SIM_SESSION_CSV);
    await expect(page.getByTestId("simulator-dashboard")).toBeVisible();
    await page.getByTestId("simulator-playpause").click();

    // SPA navigation (client-side) so the in-memory telemetry store survives the
    // route change — a full reload would wipe it.
    await page.getByRole("link", { name: "Telemetry" }).click();
    await expect(page).toHaveURL(/\/telemetry$/);

    // The map panel Card is always present on the telemetry dashboard.
    const panel = page.getByTestId("flight-map-panel");
    await expect(panel).toBeVisible();

    // Reveal the map sub-panel if the toggle defaults off.
    if ((await page.getByTestId("flight-map").count()) === 0) {
      await page.getByRole("button", { name: "Flight path map" }).click();
    }

    // FlightMap root renders (normal branch); the themed empty-coverage host is
    // present and carries the `bg-muted` backdrop (it is overlaid by MapLibre's
    // canvas once GL paints, so we assert it is present rather than "visible").
    await expect(page.getByTestId("flight-map")).toBeVisible();
    const host = page.getByTestId("flight-map-empty");
    await expect(host).toBeAttached();
    await expect(host).toHaveClass(/bg-muted/);

    // MapLibre genuinely initialised — a real GL canvas mounts inside the host —
    // which means its `omnitiles://` tile requests were actually issued and
    // resolved by the transparent fallback rather than the unreachable browser
    // scheme. If the fallback regressed, those requests would fail with
    // `net::ERR_UNKNOWN_URL_SCHEME` broken-tile console errors caught above.
    await expect(host.locator("canvas.maplibregl-canvas")).toBeAttached();

    // Give MapLibre a beat to attempt its (offline) tile loads.
    await page.waitForTimeout(800);

    expect(
      tileErrors,
      `broken-tile/map console errors: ${tileErrors.join(" | ")}`
    ).toEqual([]);
    expect(
      pageErrors,
      `unhandled page errors during map render: ${pageErrors.join(" | ")}`
    ).toEqual([]);

    // Full-page a11y over the live telemetry dashboard (incl. the SIMULATED badge).
    await expectNoSeriousA11y(page);
  });

  test("fresh /telemetry without data shows a graceful empty state", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await installTauriMock(page, {});
    await gotoApp(page, "/telemetry");

    // No device + no simulation → honest empty state, the map panel (which lives
    // inside the dashboard) is not mounted, and nothing crashes.
    await expect(page.getByText("No telemetry stream")).toBeVisible();
    await expect(page.getByTestId("flight-map-panel")).toHaveCount(0);
    expect(pageErrors).toEqual([]);

    await expectNoSeriousA11y(page);
  });
});
