import { expect, test } from "@playwright/test";
import {
  FLIGHT_LOG_CSV,
  SIM_SESSION_CSV,
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

/**
 * M28 — Accessibility gate.
 *
 * Drives every primary flow (connect → telemetry, flash wizard, profiles,
 * logs import + session browse, settings) and asserts axe-core reports **no
 * serious/critical violations** via the shared {@link expectNoSeriousA11y}
 * helper (the bar the M20 release gate already enforces elsewhere). The scans
 * run in the app's default (dark) Signal Lab theme.
 *
 * Beyond the static route scans this spec exercises two behaviours that a
 * snapshot scan can't prove on its own:
 *  - the **skip link** is the first tab stop and is keyboard-reachable, so a
 *    keyboard user can bypass the sidebar/device-bar chrome; and
 *  - the custom modal **Dialog** (M28 focus management) takes an accessible
 *    name, moves focus inside on open, and **restores focus to its trigger** on
 *    Escape — with a dialog-open axe scan to catch `aria-dialog-name` etc.
 *
 * The Tauri IPC bridge is mocked ({@link installTauriMock}) so the production
 * Zustand stores resolve headlessly; the file-import flows are pure-browser.
 */
test.describe("Accessibility — no serious/critical axe violations", () => {
  // Scan with reduced motion so axe reads the settled final state, never a
  // mid-animation (faded/zooming) frame — the app honors prefers-reduced-motion
  // throughout, so overlays render at full opacity instantly. Keeps the gate
  // deterministic (no flaky transient contrast reads during fade/zoom-in).
  test.use({ reducedMotion: "reduce" });

  test("home / connect surface is keyboard-operable + axe-clean", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/");

    // The skip link is the very first tab stop and keyboard-reachable, so a
    // keyboard user can jump past the persistent sidebar + device bar.
    await page.keyboard.press("Tab");
    const skip = page.locator('a[href="#main-content"]');
    await expect(skip).toBeFocused();

    await expectNoSeriousA11y(page);
  });

  test("telemetry empty state is axe-clean", async ({ page }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/telemetry");
    // Anchor the scan to the intended surface: the honest empty state must
    // actually render (not some valid-but-wrong page) before axe evaluates it.
    await expect(page.getByText("No telemetry stream")).toBeVisible();
    await expectNoSeriousA11y(page);
  });

  test("live telemetry dashboard (PolarPlot + map + transport) is axe-clean", async ({
    page,
  }) => {
    // Replaying a session CSV through Session Analysis renders the SAME live
    // dashboard the connected path shows: the D3 PolarPlot (role=img + title),
    // the timeline charts, the flight-path map, and the keyboard-operable
    // unified transport controls.
    await installTauriMock(page, {});
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", SIM_SESSION_CSV);
    await expect(page.getByTestId("simulator-dashboard")).toBeVisible();
    await expect(page.getByTestId("simulator-playpause")).toBeVisible();
    await expectNoSeriousA11y(page);
  });

  test("flash wizard is axe-clean", async ({ page }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/flash");
    // Anchor the scan to the wizard surface: its heading must render before we
    // assert the scan is clean, so the test pins the flash wizard specifically.
    await expect(
      page.getByRole("heading", { name: "Flashing Wizard" })
    ).toBeVisible();
    await expectNoSeriousA11y(page);
  });

  test("profiles + modal dialog (focus trap/restore, accessible name) are axe-clean", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/profiles");
    await expectNoSeriousA11y(page);

    // Open the "Save As" dialog and prove the M28 modal semantics:
    const trigger = page.getByRole("button", { name: /save as/i });
    await trigger.click();

    // The dialog exposes an accessible name (its DialogTitle, auto-wired).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Focus moved INTO the dialog (its first field) — not left on the trigger.
    const firstField = dialog.locator("input").first();
    await expect(firstField).toBeFocused();

    // Dialog-open axe scan, scoped to the dialog subtree: catches
    // aria-dialog-name / contrast / structure issues on the modal itself. We do
    // NOT re-scan the whole page here — `aria-modal="true"` already makes the
    // background inert to assistive tech, but axe still composites the 80%
    // overlay scrim over the (intentionally dimmed) page behind it, which is a
    // false positive for content the user isn't meant to read.
    await expectNoSeriousA11y(page, '[role="dialog"]');

    // Escape closes the dialog AND restores focus to the trigger.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("logs import + session browse is axe-clean (empty and imported)", async ({
    page,
  }) => {
    // No Tauri mock here (matches logs.spec.ts): the import path is pure-browser
    // and the SQLite session browser degrades to its honest empty placeholder
    // outside Tauri — both are valid a11y targets.
    await gotoApp(page, "/analysis");

    // Empty state: the import dropzone + the session-browse picker.
    await expect(page.getByTestId("session-analysis-page")).toBeVisible();
    await expectNoSeriousA11y(page);

    // Imported state: synchronized timeline charts + shared scrubber + map.
    await uploadFile(page, "logs-import-input", FLIGHT_LOG_CSV);
    await expect(page.getByTestId("logs-timeline-charts")).toBeVisible();
    await expectNoSeriousA11y(page);
  });

  test("assistant chat panel + per-chat sources control is axe-clean", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/");

    // Open Omnia's chat panel (the launcher is global app chrome).
    await page.getByRole("button", { name: /open omnia assistant/i }).click();
    // The inline provider picker proves the panel mounted.
    await expect(page.getByTestId("chat-provider-select")).toBeVisible();

    // Expand the M52 "Sources for this chat" control so its per-source switches
    // (role=switch, aria-checked, labelled) are in the scanned DOM.
    const sources = page.getByText("Sources for this chat");
    await expect(sources).toBeVisible();
    await sources.click();
    await expect(page.getByRole("switch").first()).toBeVisible();

    await expectNoSeriousA11y(page);
  });

  test("settings (incl. AI credentials) is axe-clean", async ({ page }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/settings");

    // The keys-only BYOK card (v1.7.2) renders one labelled credential row per
    // provider directly (no on-demand form) — assert it mounted, then scan so
    // the labelled key inputs + status badges are axe-covered.
    await expect(page.getByTestId("ai-settings-card")).toBeVisible();
    await expect(page.getByTestId("ai-key-row-anthropic")).toBeVisible();
    await expect(page.getByTestId("ai-key-input-anthropic")).toBeVisible();
    await expectNoSeriousA11y(page);
  });
});
