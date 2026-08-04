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
 *
 * It ALSO asserts that the map is not merely present but actually *working*:
 * that the MapLibre style loaded, that the track layers were added, that the
 * camera framed the track and that the drawing buffer is not one flat colour.
 * Every earlier assertion in this file — attached, visible, non-zero box — is
 * blind to a map whose style failed to parse, which is exactly how 3.0.3 shipped
 * a permanently blank map with this spec green. See the block that adds them.
 */
test.describe("Offline flight map", () => {
  test("renders with a GPS track, themed empty bg, no broken-tile error", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const tileErrors: string[] = [];
    const mapErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Anything FlightMap's own `error` listener classified as NOT expected
      // offline tile noise — i.e. a style/layer/configuration failure. In 3.0.3
      // that listener was unconditional (`map.on("error", () => {})`), so the
      // style-spec rejection of an `oklch()` paint colour produced literally no
      // output anywhere and the map went blank in silence.
      if (text.includes("[FlightMap]")) {
        mapErrors.push(text);
        return; // classified; never double-count it as broken-tile noise
      }
      // Chromium logs `Failed to load resource: net::ERR_UNKNOWN_URL_SCHEME`
      // when the `omnitiles://` scheme is unreachable because the offline
      // fallback failed to install — the precise `err_unknown_url_scheme`
      // token is the signature this test must catch if the fallback regresses.
      // The generic `failed to load resource` string is deliberately NOT
      // matched here: it is too broad to attribute to the tile layer, and
      // offline.spec classifies that same string as benign noise.
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
    // present and carries the `bg-muted` backdrop.
    //
    // These used to be `toBeAttached()` assertions, and that is precisely how a
    // completely blank map shipped in 3.0.2 with this spec green: `maplibre-gl`
    // was imported from JS, so its UNLAYERED `.maplibregl-map{position:relative}`
    // beat the host's layered `absolute inset-0` utility, the host collapsed to
    // height 0, and the wrapper's `overflow-hidden` clipped the canvas and the
    // zoom controls out of sight. `toBeAttached()` passes on a zero-height,
    // fully-clipped element — it only proves the node is in the DOM.
    //
    // So assert what a user can actually see: the host must be VISIBLE and must
    // have a real, non-zero laid-out box. Height is the axis that regressed
    // (width came from the panel either way), so it is asserted explicitly.
    await expect(page.getByTestId("flight-map")).toBeVisible();
    const host = page.getByTestId("flight-map-empty");
    await expect(host).toBeVisible();
    await expect(host).toHaveClass(/bg-muted/);
    const hostBox = await host.boundingBox();
    expect(
      hostBox?.height ?? 0,
      `map host collapsed: ${JSON.stringify(hostBox)} — the map is in the DOM but has no height (see the maplibre-gl.css cascade-layer note in src/index.css)`
    ).toBeGreaterThan(0);

    // MapLibre genuinely initialised — a real GL canvas mounts inside the host —
    // which means its `omnitiles://` tile requests were actually issued and
    // resolved by the transparent fallback rather than the unreachable browser
    // scheme. If the fallback regressed, those requests would fail with
    // `net::ERR_UNKNOWN_URL_SCHEME` broken-tile console errors caught above.
    //
    // Same visible + non-zero-box treatment as the host: a canvas that exists,
    // has a backing drawing buffer and paints into a clipped 0px-tall parent is
    // exactly the blank-map failure mode, and `toBeAttached()` cannot see it.
    const canvas = host.locator("canvas.maplibregl-canvas");
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    expect(
      canvasBox?.height ?? 0,
      `map canvas clipped away: ${JSON.stringify(canvasBox)}`
    ).toBeGreaterThan(0);

    // The MapLibre zoom controls are children of the same host and were clipped
    // by the very same collapse, so pin one as an independent witness that the
    // map's own chrome is on screen and hittable, not just laid out.
    await expect(
      page.getByTestId("flight-map").locator(".maplibregl-ctrl-zoom-in")
    ).toBeVisible();

    // ---------------------------------------------------------------------
    // The blank-map blind spot (3.0.3). EVERY assertion above passes while the
    // map paints nothing at all: the host is visible, correctly sized, has a
    // real canvas and real zoom buttons — and the MapLibre style never loaded,
    // because a theme colour resolved to `oklch(...)`, which the style spec
    // rejects. `load` therefore never fired, no source or layer was ever added,
    // `fitBounds` never ran, and the canvas stayed empty over the DOM
    // `bg-muted` backdrop. Layout assertions are structurally blind to that.
    //
    // So assert the map's own state, not its box.
    // ---------------------------------------------------------------------

    // 1. `data-map-ready` mirrors MapLibre's `load` event — false unless the
    //    style parsed AND loaded. Under the 3.0.3 defect this is the first
    //    thing to trip, so it carries the pointer to the likely cause too.
    await expect(
      page.getByTestId("flight-map"),
      "the map never fired MapLibre's `load` event — the style is most likely " +
        "invalid (check the paint colours resolved from CSS tokens; see " +
        "map-style.ts → toMapLibreColor)"
    ).toHaveAttribute("data-map-ready", "true");

    // 2. Interrogate the live map instance (FlightMap publishes it on its host
    //    element for exactly this reason — MapLibre keeps no global registry).
    //
    //    POLLED, never sampled once. `isStyleLoaded()` is `Style.loaded()`,
    //    which is NOT a latch: it returns false again whenever any source has
    //    work in flight (`maplibre-gl` 5.24 — a tile whose state is not yet
    //    `loaded`/`errored` makes the whole style read as unloaded). This map
    //    guarantees exactly that immediately after `load`, because the `load`
    //    handler calls `fitBounds`, easing the camera from the provisional
    //    zoom 1 out to the track's zoom (~12) over several seconds and pulling
    //    a fresh set of `omnitiles` tiles at every step along the way.
    //
    //    Measured on a HEALTHY map, sampling every 100ms from the instant
    //    `data-map-ready` flips true: styleLoaded went false, true, true,
    //    FALSE, true … FALSE … FALSE … true, still flapping ~2.3s in, while
    //    zoom climbed 1.01 → 11.89. So the old single `page.evaluate` snapshot
    //    was reading a coin flip: it landed in a `true` window locally and in
    //    a `false` window on the CI runner, failing run 30677368881 twice over
    //    on a map that was working perfectly. Note the difference is NOT the
    //    GL backend — headless Chromium renders through SwiftShader in both
    //    places (verified: identical `WEBGL_debug_renderer_info` string). It
    //    is simply how far into the fitBounds ease a slower, more contended
    //    machine happens to be when the snapshot is taken. The zoom read had
    //    the same blind spot for the same reason: it is 1.01 in the first
    //    frame after `load`, a hair above the `> 1` threshold it is checked
    //    against, and it is exactly 1 the frame before.
    //
    //    Polling every condition together keeps each one's MEANING and makes
    //    the whole check settle-tolerant. A timeout now reports which
    //    invariants never held rather than declaring the colour conversion
    //    broken — "never settled" and "style is invalid" are different
    //    findings and the messages below say which is which.
    const REQUIRED_LAYERS = [
      "background",
      "omnitiles",
      "flight-path-line",
      "signal-heat-line",
    ];

    type MapState =
      | { found: false }
      | { found: true; styleLoaded: boolean; layerIds: string[]; zoom: number };

    const readMapState = () =>
      page.evaluate((): MapState => {
        const host = document.querySelector(
          '[data-testid="flight-map-empty"]'
        ) as (HTMLElement & { _omniMap?: Record<string, unknown> }) | null;
        const map = host?._omniMap as
          | {
              isStyleLoaded(): boolean;
              getStyle(): { layers?: { id: string }[] } | undefined;
              getZoom(): number;
            }
          | undefined;
        if (!map) return { found: false };
        const style = map.getStyle();
        return {
          found: true,
          styleLoaded: map.isStyleLoaded(),
          layerIds: (style?.layers ?? []).map((l) => l.id),
          zoom: map.getZoom(),
        };
      });

    /**
     * Every invariant the live map must satisfy at one and the same moment.
     * Returns the ones that do NOT hold, so an empty array means "working" and
     * a timeout prints exactly what never came true.
     */
    const unmetMapInvariants = (s: MapState): string[] => {
      if (!s.found) return ["no live MapLibre instance on the map host"];
      const unmet: string[] = [];
      if (!s.styleLoaded) {
        unmet.push(
          "style never loaded: isStyleLoaded() did not read true once in the " +
            "whole poll window. Most likely the style is invalid — a paint " +
            "colour MapLibre cannot parse (see map-style.ts → " +
            "toMapLibreColor); it can also mean the map never stopped loading."
        );
      }
      if (s.layerIds.length === 0) {
        unmet.push("map style has no layers — nothing can paint");
      } else {
        // The track layers are only added once `load` fires, so their presence
        // proves the whole chain (style → load → ready → PathLayer /
        // SignalHeatLayer).
        const absent = REQUIRED_LAYERS.filter((id) => !s.layerIds.includes(id));
        if (absent.length > 0) {
          unmet.push(
            `track layers absent: ${absent.join(", ")} (present: ` +
              `${s.layerIds.join(", ") || "none"})`
          );
        }
      }
      // `fitBounds` only runs inside the `load` handler; the provisional camera
      // is zoom 1 at (0,0), so a moved camera proves the track was framed.
      if (!(s.zoom > 1)) {
        unmet.push(
          `camera never left its provisional zoom (${s.zoom}) — fitBounds did ` +
            "not run"
        );
      }
      return unmet;
    };

    await expect
      .poll(async () => unmetMapInvariants(await readMapState()), {
        timeout: 10_000,
        message:
          "the live MapLibre instance never reached a working state — the " +
          "listed invariants stayed unsatisfied for the whole poll window",
      })
      .toEqual([]);

    // 3. Sample the real drawing buffer. The read runs *inside* MapLibre's
    //    `render` event — i.e. still inside the rAF that drew the frame — so the
    //    buffer is valid without forcing `preserveDrawingBuffer` on in
    //    production. A blank map reads back as one flat colour: the themed
    //    `background` layer and nothing else. A working one has track pixels on
    //    top of it, so the count of pixels differing from the dominant colour is
    //    the direct measure of "is the track actually painted".
    //
    //    It is polled, not read once: this is a *live* replay, so the track
    //    grows frame by frame and the first frames legitimately have nothing but
    //    background yet. Only never becoming non-uniform is the failure.
    const samplePaint = () =>
      page.evaluate(
        () =>
          new Promise<{
            ok: boolean;
            reason?: string;
            total?: number;
            distinct?: number;
            nonDominant?: number;
          }>((resolve) => {
            const host = document.querySelector(
              '[data-testid="flight-map-empty"]'
            ) as (HTMLElement & { _omniMap?: Record<string, unknown> }) | null;
            const map = host?._omniMap as
              | {
                  getCanvas(): HTMLCanvasElement;
                  once(ev: string, fn: () => void): void;
                  triggerRepaint(): void;
                }
              | undefined;
            if (!map) return resolve({ ok: false, reason: "no map handle" });
            const canvas = map.getCanvas();
            const gl = (canvas.getContext("webgl2") ??
              canvas.getContext("webgl")) as WebGLRenderingContext | null;
            if (!gl) return resolve({ ok: false, reason: "no WebGL context" });
            const timer = setTimeout(
              () => resolve({ ok: false, reason: "no render frame within 5s" }),
              5_000
            );
            map.once("render", () => {
              clearTimeout(timer);
              const w = canvas.width;
              const h = canvas.height;
              const buf = new Uint8Array(w * h * 4);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
              const counts = new Map<number, number>();
              for (let i = 0; i < buf.length; i += 4) {
                const key = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
                counts.set(key, (counts.get(key) ?? 0) + 1);
              }
              let dominant = 0;
              for (const c of counts.values()) if (c > dominant) dominant = c;
              resolve({
                ok: true,
                total: w * h,
                distinct: counts.size,
                nonDominant: w * h - dominant,
              });
            });
            map.triggerRepaint();
          })
      );

    let paint = await samplePaint();
    await expect
      .poll(
        async () => {
          paint = await samplePaint();
          return paint.ok ? (paint.nonDominant ?? 0) : -1;
        },
        {
          timeout: 20_000,
          message:
            "the map canvas never painted anything but its flat background " +
            "colour — the GPS track is not being drawn (a value of -1 means " +
            "the canvas could not be sampled at all)",
        }
      )
      .toBeGreaterThan(0);
    expect(paint.distinct ?? 0).toBeGreaterThan(1);

    // Give MapLibre a beat to attempt its (offline) tile loads.
    await page.waitForTimeout(800);

    expect(
      mapErrors,
      `MapLibre style/config errors surfaced by FlightMap: ${mapErrors.join(" | ")}`
    ).toEqual([]);
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
