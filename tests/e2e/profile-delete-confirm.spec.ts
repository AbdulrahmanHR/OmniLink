import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y, gotoApp, installTauriMock } from "./_helpers";

/**
 * v3.0.3 defect 3 — deleting a saved profile must take a deliberate second
 * action.
 *
 * Shipped, the Profiles detail card wired `onClick={() => deleteProfile(id)}`
 * straight to a destructive button whose only guard was `disabled` for built-in
 * presets. One stray click on a user profile — a profile that may be the only
 * copy of a tuned setup, and that `.elrsp` export exists precisely to protect —
 * removed it permanently, with no undo anywhere in the app.
 *
 * Every other destructive action here already asks first: the erase-all-data
 * flow makes you type DELETE, and a recorded session's delete opens a confirm
 * dialog. A profile delete is not as catastrophic as erasing everything, so it
 * follows the session precedent: a plain confirm dialog naming what is about to
 * go, cancellable, closing cleanly either way.
 */

const NAME = "Race 250";

test.describe("profile delete confirmation (defect 3)", () => {
  test.use({ reducedMotion: "reduce" });

  test("cancelling the confirm keeps the profile", async ({ page }) => {
    await installTauriMock(page, {
      load_profiles: [],
      save_profile: null,
      delete_profile: null,
    });
    await gotoApp(page, "/profiles");

    // A user profile to delete (the seeded library is built-in presets only,
    // and those stay `disabled` on this button by design).
    await page.getByRole("button", { name: "Save As" }).click();
    await page.getByPlaceholder("e.g. Racing 500Hz").fill(NAME);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("listbox").getByText(NAME)).toBeVisible();

    // The click must NOT delete anything on its own.
    await page.getByTestId("profiles-delete-btn").click();
    await expect(page.getByRole("listbox").getByText(NAME)).toBeVisible();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The dialog names the profile, so it is obvious which one is at stake.
    await expect(dialog).toContainText(NAME);
    await expectNoSeriousA11y(page);

    await page.getByTestId("profiles-delete-cancel-btn").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("listbox").getByText(NAME)).toBeVisible();
  });

  test("confirming deletes it and closes the dialog", async ({ page }) => {
    await installTauriMock(page, {
      load_profiles: [],
      save_profile: null,
      delete_profile: null,
    });
    await gotoApp(page, "/profiles");

    await page.getByRole("button", { name: "Save As" }).click();
    await page.getByPlaceholder("e.g. Racing 500Hz").fill(NAME);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("listbox").getByText(NAME)).toBeVisible();

    await page.getByTestId("profiles-delete-btn").click();
    await page.getByTestId("profiles-delete-confirm-btn").click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("listbox").getByText(NAME)).toHaveCount(0);
  });
});
