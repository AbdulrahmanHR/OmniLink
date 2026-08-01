/**
 * MapLibre style + theme helpers for the offline flight map (M12).
 *
 * The map must render with **zero network access**: its only raster source is
 * the `omnitiles://` custom URI scheme served by the Rust side
 * (`src-tauri/src/commands/tiles.rs`) from locally-stored tiles. A `background`
 * layer underneath guarantees the canvas is never blank even before tiles load
 * (e.g. in the pure-browser dev server, where the protocol is absent).
 *
 * Colours are pulled from the live Signal Lab CSS custom properties so the map
 * matches the active theme (dark/light/carbon) — WebGL can't consume CSS
 * classes, so we resolve each token to a concrete colour string here, converting
 * it into a syntax MapLibre's style parser actually accepts
 * ({@link toMapLibreColor} — read its note before touching it).
 */

import maplibregl, {
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";

/* -------------------------------------------------------------------------- */
/* CSS colour → MapLibre colour                                               */
/* -------------------------------------------------------------------------- */

/**
 * Colour syntaxes MapLibre's style spec parses natively (verified against
 * `@maplibre/maplibre-gl-style-spec`'s `Color.parse`): hex (3/4/6/8 digits),
 * `rgb()`/`rgba()` and `hsl()`/`hsla()`, in both legacy-comma and CSS Color 4
 * space-separated form. Anything matching this is handed through untouched.
 *
 * `oklch()`, `oklab()`, `lab()`, `hwb()` and `color()` are **not** in that list —
 * `Color.parse` returns `undefined` for them, which is what makes a style
 * invalid. See {@link toMapLibreColor}.
 */
const MAPLIBRE_PARSEABLE = /^(?:#[0-9a-f]{3,8}$|rgba?\(|hsla?\()/i;

/** Matches `oklch(...)` / `oklab(...)`, capturing the argument list. */
const OK_COLOR = /^(oklch|oklab)\(([^)]*)\)$/i;

/** `100%` chroma means `0.4` in `oklch()` (CSS Color 4 §7.3). */
const OKLCH_CHROMA_FULL = 0.4;

/** `100%` a/b means `0.4` in `oklab()` (CSS Color 4 §7.2). */
const OKLAB_AB_FULL = 0.4;

/**
 * Parse a `<number>` / `<percentage>` / `none` component. `none` is a genuinely
 * missing component, which CSS Color 4 says behaves as zero outside of
 * interpolation — that is what we need here, since we are converting, not
 * interpolating.
 */
function parseComponent(raw: string, percentBasis: number): number | null {
  const s = raw.trim().toLowerCase();
  if (s === "none") return 0;
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * percentBasis : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `<hue>` (unitless or `deg`/`rad`/`grad`/`turn`, or `none`) to degrees. */
function parseHue(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (s === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "rad") return (n * 180) / Math.PI;
  if (m[2] === "grad") return n * 0.9;
  if (m[2] === "turn") return n * 360;
  return n;
}

/**
 * sRGB transfer function (linear-light → encoded), sign-preserving so
 * out-of-gamut negatives survive to the clamp below instead of becoming `NaN`
 * via `Math.pow` of a negative base.
 */
function srgbEncode(c: number): number {
  const a = Math.abs(c);
  const enc = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return c < 0 ? -enc : enc;
}

/** Clamp a 0–1 encoded channel into an integer 0–255. */
function to8Bit(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/**
 * OKLab → gamma-encoded sRGB, using the CSS Color 4 reference matrices
 * (OKLab → LMS' → LMS → linear sRGB). Verified by the two fixed points the
 * matrices must reproduce exactly: `(0,0,0)` → black and `(1,0,0)` → white
 * (each linear-sRGB row of the LMS matrix sums to 1).
 *
 * Out-of-gamut results are clipped per channel by {@link to8Bit} rather than
 * chroma-reduced. Every Signal Lab token is well inside sRGB, and a clip can
 * only ever be a slightly-too-saturated colour — never a style-invalidating
 * string, which is the whole point of this file.
 */
function oklabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    srgbEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    srgbEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    srgbEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * Convert **any** CSS colour string into one MapLibre's style spec can parse,
 * falling back to `fallback` rather than ever returning something unparseable.
 *
 * Why this exists — do not "simplify" it away: this project's theme tokens in
 * `src/index.css` are authored in `oklch()`, and current engines (WebKitGTK
 * 2.52, Chromium 149) return the **computed** value of `background-color` as
 * `oklch(...)` too. MapLibre's colour parser has no OKLCH support, so feeding it
 * one makes the whole style invalid:
 *
 *     layers[0].paint.background-color: color expected, "oklch(0.2 0.012 240)" found
 *
 * An invalid style never loads → `map.on("load")` never fires → no layers, no
 * `fitBounds`, a permanently blank canvas. That shipped in 3.0.3. Converting
 * here, deterministically and without a DOM, keeps the whole path unit-testable.
 *
 * - Already-MapLibre-parseable input (hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`)
 *   is returned verbatim — no double conversion, no precision loss.
 * - `oklch()`/`oklab()` are converted to `rgb()`/`rgba()`.
 * - Anything else (unknown/blank/malformed) yields `fallback`. This function
 *   never throws.
 */
export function toMapLibreColor(
  value: string | null | undefined,
  fallback: string
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  if (MAPLIBRE_PARSEABLE.test(raw)) return raw;

  const fn = OK_COLOR.exec(raw);
  if (!fn) return fallback;

  // `oklch(L C H)` / `oklab(L a b)`, optionally `/ <alpha>`. Both are CSS
  // Color 4 space-separated syntax; commas are tolerated defensively.
  const [head, ...alphaParts] = fn[2].split("/");
  if (alphaParts.length > 1) return fallback;
  const parts = head.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 3) return fallback;

  const isLch = fn[1].toLowerCase() === "oklch";
  // L is 0–1, where `100%` = 1.
  const L = parseComponent(parts[0], 1);
  const c1 = parseComponent(parts[1], isLch ? OKLCH_CHROMA_FULL : OKLAB_AB_FULL);
  const c2 = isLch
    ? parseHue(parts[2])
    : parseComponent(parts[2], OKLAB_AB_FULL);
  if (L === null || c1 === null || c2 === null) return fallback;

  let alpha = 1;
  if (alphaParts.length === 1) {
    const a = parseComponent(alphaParts[0], 1);
    if (a === null) return fallback;
    alpha = Math.min(1, Math.max(0, a));
  }

  // OKLCH → OKLab is polar → cartesian; oklab() is already cartesian.
  const rad = (c2 * Math.PI) / 180;
  const [r, g, b] = isLch
    ? oklabToSrgb(L, c1 * Math.cos(rad), c1 * Math.sin(rad))
    : oklabToSrgb(L, c1, c2);

  const rgb = `${to8Bit(r)}, ${to8Bit(g)}, ${to8Bit(b)}`;
  return alpha >= 1
    ? `rgb(${rgb})`
    : `rgba(${rgb}, ${Math.round(alpha * 1000) / 1000})`;
}

/**
 * Whether a computed `background-color` means "this custom property did not
 * resolve". An undefined or invalid `var()` leaves `background-color` at its
 * initial value, which every engine serialises as fully-transparent black.
 * Painting that into the style would silently blank the layer — the exact class
 * of bug this module now guards — so callers treat it as unresolved and use
 * their explicit `fallback` instead.
 */
function isUnresolvedColor(value: string): boolean {
  const s = value.trim().toLowerCase();
  if (!s || s === "transparent") return true;
  return /^rgba\(\s*0\s*[\s,]\s*0\s*[\s,]\s*0\s*[,/]\s*0(?:\.0+)?\s*\)$/.test(s);
}

/**
 * Resolve a Signal Lab CSS custom property (e.g. `--background`) to a concrete
 * colour string MapLibre can parse, by reading it back through a hidden probe's
 * computed `background-color`.
 *
 * The computed value is **not** guaranteed to be `rgb()`: since CSS Color 4,
 * engines preserve the authored colour space, so an `oklch()` token computes to
 * `oklch(...)` (measured: WebKitGTK 2.52.3 and Chromium 149 both do). MapLibre
 * cannot parse that, so the result is normalised through
 * {@link toMapLibreColor}. Returns `fallback` when there is no DOM (should never
 * happen at runtime; the map only mounts client-side) or when the token does not
 * resolve.
 */
export function resolveThemeColor(token: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  if (!resolved || isUnresolvedColor(resolved)) return fallback;
  return toMapLibreColor(resolved, fallback);
}

/**
 * The worst→best signal colour ramp resolved from theme status tokens. Linear
 * interpolation in {@link rampColor} fills the gradient between these stops.
 */
export function resolveSignalRamp(): string[] {
  return [
    resolveThemeColor("--status-critical", "#d4382f"),
    resolveThemeColor("--status-warning", "#e0b341"),
    resolveThemeColor("--status-good", "#33a852"),
  ];
}

/** URL template MapLibre uses to request tiles from the Rust `omnitiles` scheme. */
export const OMNITILES_URL_TEMPLATE = "omnitiles://tiles/{z}/{x}/{y}.png";

/**
 * Build an offline-only MapLibre style: a themed background plus a single raster
 * source served from local tiles. `maxzoom` is capped to the highest zoom any
 * locally-stored pack provides so MapLibre over-zooms (scales) the deepest tile
 * rather than requesting a non-existent one.
 */
export function buildOfflineStyle(maxLocalZoom: number): StyleSpecification {
  const background = resolveThemeColor("--muted", "#0b1220");
  return {
    version: 8,
    // No glyphs/sprite — we render no text/symbol layers, keeping the map fully
    // self-contained offline.
    sources: {
      omnitiles: {
        type: "raster",
        tiles: [OMNITILES_URL_TEMPLATE],
        tileSize: 256,
        minzoom: 0,
        maxzoom: maxLocalZoom,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": background },
      },
      {
        id: "omnitiles",
        type: "raster",
        source: "omnitiles",
        // Slightly dim the base so the signal path reads clearly on top.
        paint: { "raster-opacity": 0.85 },
      },
    ],
  };
}

/**
 * Whether we're running inside the Tauri runtime (where the webview natively
 * resolves the `omnitiles://` custom protocol). Outside Tauri — a plain browser
 * or the headless E2E runner — that scheme is unreachable.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * A 1×1 fully-transparent PNG, used as the blank fallback tile so the themed
 * `background` layer shows through as an empty-coverage backdrop.
 */
const BLANK_TILE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Decode {@link BLANK_TILE_PNG_BASE64} into raw PNG bytes for MapLibre. */
function blankTileBytes(): ArrayBuffer {
  const binary = atob(BLANK_TILE_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let offlineFallbackInstalled = false;

/**
 * Make the offline map degrade gracefully **outside** Tauri.
 *
 * In the Tauri runtime the webview resolves `omnitiles://` natively and
 * `commands/tiles.rs` serves a blank tile for missing coverage — so we must NOT
 * intercept there (a global `addProtocol` handler would shadow the real one and
 * break live tile loading). In a plain browser / headless E2E runner the scheme
 * is unreachable, so MapLibre would emit `error` events for every tile request.
 * We register a fallback `omnitiles` protocol that resolves to a transparent
 * tile, so MapLibre never errors and the themed `background` layer renders as an
 * "empty-coverage" backdrop instead of a broken-tile state. Idempotent.
 */
export function installOfflineTileFallback(): void {
  if (offlineFallbackInstalled) return;
  if (isTauriRuntime()) return;
  if (typeof maplibregl.addProtocol !== "function") return;
  if (typeof atob === "undefined") return;
  offlineFallbackInstalled = true;
  maplibregl.addProtocol("omnitiles", async () => ({ data: blankTileBytes() }));
}

/**
 * Whether a MapLibre instance is still usable, i.e. has not been `remove()`d.
 *
 * `Map.remove()` calls `setStyle(null)`, so afterwards `map.style` is undefined
 * and every style-touching method — `getLayer`, `getSource`, `removeLayer`,
 * `removeSource` — throws `Cannot read properties of undefined`.
 *
 * The layer overlays need this in their effect **cleanups**: `FlightMap` tears
 * the map down (`map.remove()`) and only then publishes `null` through the
 * context, so a child's cleanup is always handed a map that is already gone.
 * React's dev StrictMode double-invoke makes that happen on every single mount,
 * and the resulting throw unmounts the whole telemetry dashboard. It stayed
 * invisible for as long as the 3.0.3 blank-map defect kept `ready` false, so the
 * overlays never registered a cleanup at all.
 */
export function isMapAlive(map: MapLibreMap | null | undefined): boolean {
  return !!map && !map._removed && !!map.style;
}

/**
 * Classify a MapLibre `error` event as *expected offline noise* rather than a
 * defect.
 *
 * MapLibre reports everything through `error` events instead of throwing: a tile
 * that 404s, a source that can't be fetched, **and** a style that fails
 * validation all arrive on the same channel. Blanket-ignoring the channel is how
 * a completely blank map shipped in 3.0.3 — the style-spec rejection of an
 * `oklch()` paint colour was fired here and silently dropped.
 *
 * Expected (quiet): anything attributable to a *source or tile* — those are
 * normal with no network and are already handled by
 * {@link installOfflineTileFallback} plus the themed empty-coverage backdrop.
 * MapLibre tags such events with `sourceId`/`tile`, or carries an AJAX error
 * (with `status`/`url`).
 *
 * Everything else — style validation, layer/paint configuration, WebGL setup —
 * is a real bug and must be surfaced by the caller.
 */
export function isExpectedTileError(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const e = event as {
    sourceId?: unknown;
    tile?: unknown;
    error?: { message?: unknown; status?: unknown; url?: unknown };
  };
  if (typeof e.sourceId === "string" && e.sourceId.length > 0) return true;
  if (e.tile) return true;
  const err = e.error;
  if (err && typeof err === "object") {
    // `AjaxError` from MapLibre's request pipeline.
    if (typeof err.status === "number" || typeof err.url === "string") {
      return true;
    }
    if (typeof err.message === "string") {
      return /failed to fetch|networkerror|load failed|err_unknown_url_scheme|network error|aborted/i.test(
        err.message
      );
    }
  }
  return false;
}

/** Whether the user has asked for reduced motion (map animations become instant). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
