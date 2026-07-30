import { expect, test } from "@playwright/test";
import { gotoApp, installTauriMock } from "./_helpers";

/**
 * Dev-only feature-flag toggle (punch-list item 8). The "Preview features (dev)"
 * Settings panel renders ONLY in a dev build (`import.meta.env.DEV`; e2e runs
 * `npm run dev`). Toggling `mlLab` persists to the dev-flags override blob and
 * reloads, after which the flag-gated ML lab section becomes reachable — exactly
 * the QA/demo path this panel exists to provide, with no source edit.
 *
 * v3.0 (M69): this spec drove `hostedPresets` until the platform excision removed
 * that flag with its surface. `mlLab` is the only remaining flag, so the panel's
 * behaviour is now pinned through it — same mechanism, same three assertions
 * (starts OFF, toggling reveals the gated surface, reset hides it again).
 */
test.describe("Dev feature-flag toggle panel", () => {
  test.use({ reducedMotion: "reduce" });

  test("panel renders and toggling mlLab reveals the ML lab section", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await gotoApp(page, "/settings");

    // The dev panel is present (dev build) and the flag starts OFF.
    const panel = page.getByTestId("dev-feature-flags");
    await expect(panel).toBeVisible();
    const labSwitch = page.getByTestId("dev-flag-mlLab");
    await expect(labSwitch).toHaveAttribute("aria-checked", "false");

    // The gated section is absent while the flag is OFF.
    await expect(page.getByTestId("ml-lab-panel")).toHaveCount(0);

    // Toggling persists the override + reloads to apply; the switch re-renders ON.
    await labSwitch.click();
    await expect(page.getByTestId("dev-flag-mlLab")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // The gated ML lab section is now mounted.
    await expect(page.getByTestId("ml-lab-panel")).toBeVisible();

    // Reset clears the override; the section disappears again.
    await page.getByTestId("dev-flags-reset").click();
    await expect(page.getByTestId("dev-flag-mlLab")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(page.getByTestId("ml-lab-panel")).toHaveCount(0);
  });
});
