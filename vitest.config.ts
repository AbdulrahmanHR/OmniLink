import { defineConfig } from "vitest/config";
import path from "path";

// Vitest config kept separate from vite.config.ts so the Tauri dev-server
// options don't bleed into the test runner. Pure-logic unit tests only.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Pinned at M74. Two specs assert timing budgets —
    // `tests/unit/ml/mlInferenceBudget.test.ts` (a frozen 150 ms inference
    // budget) and `tests/unit/ml/v25PrivacyAudit.test.ts` — and both fail
    // intermittently when the machine is oversubscribed, while passing reliably
    // at two workers and in isolation. Pinning here rather than in the npm
    // script covers EVERY invocation path (`npm test`, bare `vitest`, an IDE
    // runner, CI) and, critically, still allows an explicit
    // `--maxWorkers=<n>` on the command line to override it: vitest hard-errors
    // when the same flag arrives twice, so a flag baked into the npm script
    // would break `npm run test -- --maxWorkers=2`.
    maxWorkers: 2,
    // Pure-logic unit/integration specs only. The Playwright E2E specs under
    // `tests/e2e/` (M20) are driven by `npm run e2e`, NOT vitest — they call
    // Playwright's `test.describe()` and must be excluded from the vitest glob.
    include: ["tests/{unit,integration}/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**"],
  },
});
