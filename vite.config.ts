import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Ship only `.woff2` for the self-hosted webfonts (`src/main.tsx`).
 *
 * Every `@fontsource/<family>/<weight>.css` declares each face twice:
 *
 *   src: url(./files/inter-latin-400-normal.woff2) format('woff2'),
 *        url(./files/inter-latin-400-normal.woff)  format('woff');
 *
 * Vite resolves both URLs and emits both files, so the `.woff` half rode along
 * as ~866 KiB of dead weight across 65 files — a fallback for browsers that
 * predate 2016. OmniLink only ever runs in a Tauri webview: WebKitGTK on Linux,
 * WKWebView on macOS, WebView2 on Windows. All three support `woff2`, none of
 * them can reach the fallback, and there is no browser build to serve.
 *
 * This strips the fallback `src` entry from the third-party CSS *before* Vite
 * rewrites its URLs, which is the only seam where the file simply never enters
 * the graph — deleting the emitted assets afterwards would leave the built CSS
 * pointing at 404s. `enforce: "pre"` is what puts this ahead of `vite:css`.
 * It applies to `vite dev` and `vite build` alike, and it touches nothing but
 * `@fontsource` — do not hand-edit `node_modules`.
 *
 * If `@fontsource` ever reformats these rules the pattern stops matching, so
 * the guard below fails the build rather than silently letting 866 KiB back in.
 */
function fontsourceWoff2Only(): Plugin {
  const WOFF_FALLBACK = /\s*,\s*url\([^)]+\.woff\)\s*format\((['"])woff\1\)/g;
  const ANY_WOFF_URL = /url\([^)]+\.woff\)/;

  return {
    name: "omnilink:fontsource-woff2-only",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".css") || !file.includes("@fontsource")) return null;

      const stripped = code.replace(WOFF_FALLBACK, "");
      if (ANY_WOFF_URL.test(stripped)) {
        this.error(
          `${file} still references a .woff after stripping the fallback src. ` +
            `@fontsource has changed its @font-face format — update WOFF_FALLBACK ` +
            `in vite.config.ts.`
        );
      }
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), fontsourceWoff2Only()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        // Isolate the heavy charting libs (recharts + d3) into their own vendor
        // chunk. They are only referenced from the lazily-loaded telemetry
        // route, so this chunk stays out of the initial bundle.
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (
              id.includes("recharts") ||
              id.includes("/d3-") ||
              id.includes("victory-vendor")
            ) {
              return "charts";
            }
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
