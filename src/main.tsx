// SPDX-License-Identifier: GPL-3.0-or-later
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/*
 * SELF-HOSTED WEBFONTS (@fontsource, OFL-1.1) — the three families of the
 * "Signal Lab" type system, in exactly the weights `index.css` asks for:
 *   Inter          400/500/600/700  → --font-sans
 *   IBM Plex Mono  400/500/600/700 + 400 italic → --font-mono
 *   Space Grotesk  400/500/600/700  → --font-display
 *
 * Through 3.0.2 these came from Google's font CDN via a `<link>` in
 * `index.html`. That was wrong twice over. It contradicted the product's own
 * claim — an account-free, server-free, no-telemetry tool that phoned a third
 * party with the user's IP on every single launch — and it broke the
 * OFFLINE-FIRST policy (AGENTS.md §4/§8) in the field: at a flying site with no
 * signal the request just failed and the design system fell back to system fonts.
 *
 * Each `@fontsource/<family>/<weight>.css` carries the same set of subsets and
 * `unicode-range`s the CDN was serving (latin, latin-ext, cyrillic, cyrillic-ext,
 * greek, greek-ext, vietnamese) with `font-display: swap`, so rendering is
 * unchanged — the bytes now ship inside the app instead of being fetched. Vite
 * emits the referenced woff2/woff as build assets.
 *
 * DO NOT re-add a font `<link>` to `index.html`; keep this list and the weights
 * declared in `index.css` (`--font-sans` / `--font-mono` / `--font-display`) in
 * step with each other.
 *
 * These are `@font-face` rules only — no selectors — so unlike a component-level
 * stylesheet import they carry no cascade-layer hazard (contrast the MapLibre
 * note in `index.css`), and importing them here keeps Vite's asset-URL rebasing
 * on the well-trodden path.
 */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
