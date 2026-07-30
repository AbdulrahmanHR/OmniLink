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
 * classes, so we resolve each token to a concrete `rgb()` string here.
 */

import maplibregl, { type StyleSpecification } from "maplibre-gl";

/**
 * Resolve a Signal Lab CSS custom property (e.g. `--background`) to a concrete
 * `rgb()`/`rgba()` string MapLibre can parse. We read it back through
 * `background-color`, whose computed value is always serialised as `rgb()` in
 * every engine even when the source token is OKLCH — so this works regardless of
 * MapLibre's colour-parser gamut support. Returns `fallback` when there is no
 * DOM (should never happen at runtime; the map only mounts client-side).
 */
export function resolveThemeColor(token: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.backgroundColor = `var(${token})`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved || fallback;
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

/** Whether the user has asked for reduced motion (map animations become instant). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
