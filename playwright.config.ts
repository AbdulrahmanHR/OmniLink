import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for OmniLink (M20 release-gate hardening).
 *
 * The app is a Tauri 2 + Vite front-end. We drive the *web* build headlessly in
 * Chromium and stub the Tauri IPC/event bridge from the test side (see
 * `tests/e2e/_helpers.ts → installTauriMock`), so the real Zustand stores run
 * unchanged against a fake `@tauri-apps/api` runtime.
 *
 * The Vite dev server is fixed to port 1420 (`strictPort`) — see `vite.config.ts`.
 */
const PORT = 1420;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  // Fail the build on a stray `test.only` in CI; allow it locally.
  forbidOnly: !!process.env.CI,
  // Flaky-retry once in CI, never locally (keeps local runs deterministic).
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  // Pinned at M74. The suite flakes under Playwright's default worker count
  // (MapLibre/GPU contention, most visibly on WSL2) and is stable at two, which
  // still keeps the shared dev server from being swamped. Pinned here rather
  // than in the npm script so every invocation path inherits it — `npm run
  // e2e`, a bare `npx playwright test`, an IDE runner and CI — while an
  // explicit `--workers=<n>` on the command line still overrides it.
  workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    timeout: 7_000,
  },
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The app ships on WebKitGTK (Linux) and WKWebView (macOS). Chromium alone
      // cannot see engine-level differences in those two — `3.0.3` shipped a
      // flight map that had painted nothing since `3.0.2` because a CSS colour
      // serialised as `oklch(...)` in WebKit and `rgb(...)` in Chromium.
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      // WebKit runs this app roughly 2x slower than Chromium, uniformly rather
      // than on one hot path — the axe sweeps go 7.0s → 17.2s and 9.5s → 20.8s,
      // and the heaviest offline test 7.7s alone → over the 7s per-assertion
      // budget once the full suite is competing for two workers. The budgets
      // below are widened for that engine ONLY: every assertion is unchanged,
      // and Chromium keeps the tight 7s as a performance canary, so a real
      // regression still trips there. The 2x gap is itself unmeasured on real
      // hardware and is worth its own investigation.
      expect: { timeout: 20_000 },
      timeout: 90_000,
    },
  ],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
