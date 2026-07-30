import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y, gotoApp, uploadFile } from "./_helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Telemetry-session CSV with a sustained RSSI dropout (rssi1/rssi2 ≤ −104 for
 * four frames after a healthy start, then recovery). Two independent subsystems
 * react to it, and BOTH feed the one notification center:
 *  - **M37 diagnostics** analyze the whole session on import, raising one critical
 *    `rssi-floor` finding (the primary antenna sat at the floor) → a "Signal
 *    diagnostic" notification the instant the log loads; and
 *  - **M26 live alerts** re-evaluate each frame as it is scrubbed through, so the
 *    default `signalLoss` trip (−100 dBm, 3-frame debounce) fires its transient
 *    toast and enqueues a "Low signal" notification when the cursor enters the
 *    dropout, then recovers — both verified in `notificationFeed`/store units.
 */
const DROPOUT_CSV = path.join(__dirname, "fixtures", "alert-dropout.csv");

test.describe("Notification center", () => {
  // Deterministic axe + exercise the prefers-reduced-motion panel path.
  test.use({ reducedMotion: "reduce" });

  test("import diagnostic + a scrubbed live alert both surface, persist, and clear", async ({
    page,
  }) => {
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", DROPOUT_CSV);

    // Session loaded → the scrubber (one position index) is available.
    const scrubber = page.getByTestId("logs-scrubber-input");
    await expect(scrubber).toBeVisible();
    const lastIndex = (await scrubber.getAttribute("max")) ?? "";

    // M37: analyzing the imported session surfaces its critical link finding in
    // the notification center immediately — before any frame is scrubbed, and
    // without any live-alert toast (that path only fires on a played/scrubbed
    // frame). So the badge reads exactly 1 from the import-time diagnostic.
    await expect(page.getByTestId("notification-badge")).toHaveText("1");
    await expect(page.getByTestId("live-alert-signalLoss")).toHaveCount(0);

    // Scrub INTO the dropout: seeking forward pushes the passed frames through
    // the SAME live-alert evaluation the connected stream uses, so signalLoss
    // fires — surfacing the live toast AND enqueuing a SECOND notification. (Arrow
    // keys advance the range one step at a time, the proven scrub idiom.)
    await scrubber.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(scrubber).toHaveValue("6");
    await expect(page.getByTestId("live-alert-signalLoss")).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toHaveText("2");

    // Scrub to the end: the link recovers, so the transient toast clears — but
    // BOTH notifications PERSIST in the center (the whole point of this slice).
    await page.keyboard.press("End");
    await expect(scrubber).toHaveValue(lastIndex);
    await expect(page.getByTestId("live-alert-signalLoss")).toHaveCount(0);
    await expect(page.getByTestId("notification-badge")).toHaveText("2");

    // Open the dropdown: it lists both notifications, newest-first.
    await page.getByTestId("notification-bell").click();
    const panel = page.getByTestId("notification-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("notification-item")).toHaveCount(2);
    // The live alert: title is the reused alerts.type key, body the reused
    // alerts.message key rendered with its params (proves i18n, not frozen copy).
    await expect(panel.getByText("Low signal", { exact: true })).toBeVisible();
    await expect(panel.getByText(/RSSI fell to/)).toBeVisible();
    // The import diagnostic: title resolved from the diagnostics.* namespace.
    await expect(panel.getByText("Signal diagnostic", { exact: true })).toBeVisible();

    // The open, focus-trapped panel is accessible.
    await expectNoSeriousA11y(page);

    // Per-item mark-read: clearing the unread items one at a time decrements the
    // badge, proving it tracks the live unread COUNT (not a boolean).
    await panel.getByTestId("notification-mark-read").first().click();
    await expect(page.getByTestId("notification-badge")).toHaveText("1");
    await panel.getByTestId("notification-mark-read").first().click();
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
    // Both items stay in the list (read), so clear-all is still available.
    await expect(panel.getByTestId("notification-item")).toHaveCount(2);

    // Clear all empties the center.
    await panel.getByTestId("notification-clear-all").click();
    await expect(panel.getByTestId("notification-item")).toHaveCount(0);
    await expect(panel.getByTestId("notification-empty")).toBeVisible();
  });
});
