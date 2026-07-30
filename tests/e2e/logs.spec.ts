import { expect, test } from "@playwright/test";
import {
  FLIGHT_LOG_CSV,
  expectNoSeriousA11y,
  gotoApp,
  uploadFile,
} from "./_helpers";

/**
 * Session Analysis — forensic half (v1.7.0, was the M14/M15 Logs spec).
 * Browse-import a Betaflight blackbox CSV through the ONE unified import on-ramp →
 * synchronized timeline charts → the single shared scrub cursor → detected-anomaly
 * markers. Migrated from the old standalone /logs page to the merged /analysis
 * surface (the single position index now also drives the dashboard).
 *
 * This is a PURE-BROWSER path (File API `File.text()`), so no Tauri mock is
 * needed. Anti-false-positive: the analysis surface (charts/scrubber/anomalies)
 * exists ONLY after a log is parsed, so the spec asserts they are ABSENT before
 * the upload and PRESENT after — proving it actually drove the real import flow.
 */
test.describe("Session Analysis — forensic scrub", () => {
  test("import → charts → scrub → anomaly markers", async ({ page }) => {
    await gotoApp(page, "/analysis");

    // Before/after (real-flow) guard: no analysis surface until a log loads.
    await expect(page.getByTestId("session-analysis-page")).toBeVisible();
    await expect(page.getByTestId("logs-timeline-charts")).toHaveCount(0);
    await expect(page.getByTestId("logs-scrubber")).toHaveCount(0);
    await expect(page.getByTestId("logs-anomaly-panel")).toHaveCount(0);

    // Drive the pure-browser CSV import path via the hidden file input.
    await uploadFile(page, "logs-import-input", FLIGHT_LOG_CSV);

    // Charts + scrubber + anomaly panel now render off the parsed log.
    await expect(page.getByTestId("logs-timeline-charts")).toBeVisible();
    const scrubber = page.getByTestId("logs-scrubber-input");
    await expect(scrubber).toBeVisible();
    await expect(page.getByTestId("logs-anomaly-panel")).toBeVisible();

    // The shared scrub cursor can be moved: focus the range + arrow it forward
    // and assert the bound store value advances (the cursor really moved).
    const before = await scrubber.inputValue();
    expect(before).toBe("0");
    await scrubber.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(scrubber).not.toHaveValue("0");
    const after = Number(await scrubber.inputValue());
    expect(after).toBeGreaterThan(Number(before));

    // The RSSI dropout in the fixture trips at least one anomaly; a marker is
    // drawn per anomaly per eligible channel chart (count >= 1, never exactly 1).
    const markers = page.getByTestId("logs-anomaly-marker");
    expect(await markers.count()).toBeGreaterThanOrEqual(1);

    await expectNoSeriousA11y(page);
  });
});
