import { expect, test } from "@playwright/test";
import {
  SIM_SESSION_CSV,
  expectNoSeriousA11y,
  gotoApp,
  uploadFile,
} from "./_helpers";

/**
 * Session Analysis — replay half (v1.7.0, was the M16 simulator spec). Load a
 * recorded session CSV through the ONE unified import on-ramp → it replays
 * through the shared live dashboard → the persistent SIMULATED badge + the
 * unified transport (play↔pause toggle, stop = halt-and-rewind). Migrated from
 * the old standalone /simulator page to the merged /analysis surface.
 *
 * Pure-browser path (no Tauri). Anti-false-positive: the SIMULATED badge and the
 * dashboard exist ONLY once a session is loaded (`isSimulating`), so the spec
 * asserts they are ABSENT before the upload and PRESENT after. Transport Stop is
 * a non-destructive halt-and-rewind (pauses + returns to the first sample but
 * KEEPS the session loaded); the destructive teardown is the explicit "Load
 * another log" control, after which the badge + dashboard are ABSENT again —
 * together proving it drove the real replay lifecycle, not a static UI. It also
 * proves the v1.7.0 win: the anomaly list + "analyze" action (formerly
 * Logs-only) are available during replay because both read the one index.
 */
test.describe("Session Analysis — replay", () => {
  test("load CSV → replay → transport → SIMULATED badge", async ({ page }) => {
    await gotoApp(page, "/analysis");

    await expect(page.getByTestId("session-analysis-page")).toBeVisible();
    // Nothing simulated yet: no badge, no dashboard.
    await expect(page.getByTestId("simulated-badge")).toHaveCount(0);
    await expect(page.getByTestId("simulator-dashboard")).toHaveCount(0);

    // Drive the pure-browser session-CSV load via the unified import input.
    await uploadFile(page, "logs-import-input", SIM_SESSION_CSV);

    // Loading a session activates the dashboard + the persistent badge.
    await expect(page.getByTestId("simulator-dashboard")).toBeVisible();
    await expect(page.getByTestId("simulated-badge")).toBeVisible();

    const playpause = page.getByTestId("simulator-playpause");
    await expect(playpause).toBeVisible();

    // Transport: the single Play↔Pause toggle flips its accessible label as the
    // replay starts and pauses (the control is genuinely driving the engine).
    const idleLabel = await playpause.getAttribute("aria-label");
    await playpause.click();
    await expect(playpause).not.toHaveAttribute("aria-label", idleLabel ?? "");
    const playingLabel = await playpause.getAttribute("aria-label");

    // v1.7.0 win-unlocked: while REPLAYING, the analysis surface (anomaly list +
    // "analyze selected range" action) is available — both read the one index.
    await expect(page.getByTestId("logs-anomaly-panel")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /analyze selected range/i })
    ).toBeVisible();

    await playpause.click();
    await expect(playpause).toHaveAttribute("aria-label", idleLabel ?? "");
    expect(playingLabel).not.toBe(idleLabel);

    // Dashboard is live + a11y-clean while a simulation feeds it (full-page scan).
    await expectNoSeriousA11y(page);

    // Stop = halt-and-rewind (NOT teardown): playback is paused and the position
    // returns to the first sample, but the session STAYS loaded so the badge +
    // dashboard remain. (Replay advanced the index past 0 above, so the scrubber
    // snapping back to "0" proves Stop genuinely rewound.)
    await page.getByTestId("simulator-stop").click();
    await expect(playpause).toHaveAttribute("aria-label", idleLabel ?? "");
    await expect(page.getByTestId("logs-scrubber-input")).toHaveValue("0");
    await expect(page.getByTestId("simulated-badge")).toBeVisible();
    await expect(page.getByTestId("simulator-dashboard")).toBeVisible();

    // Full teardown is the explicit "Load another log" control — only now do the
    // badge + dashboard disappear (honest empty), closing the replay lifecycle.
    await page
      .getByRole("button", { name: /load another log/i })
      .click();
    await expect(page.getByTestId("simulated-badge")).toHaveCount(0);
    await expect(page.getByTestId("simulator-dashboard")).toHaveCount(0);
  });

  test("old /simulator and /logs routes redirect to /analysis", async ({
    page,
  }) => {
    await gotoApp(page, "/simulator");
    await expect(page).toHaveURL(/\/analysis$/);
    await expect(page.getByTestId("session-analysis-page")).toBeVisible();

    await gotoApp(page, "/logs");
    await expect(page).toHaveURL(/\/analysis$/);
    await expect(page.getByTestId("session-analysis-page")).toBeVisible();
  });
});
