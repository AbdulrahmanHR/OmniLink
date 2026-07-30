import { expect, test, type Page } from "@playwright/test";
import { gotoApp, installTauriMock } from "./_helpers";

/**
 * NFR-PRIV-02 — GDPR-style local "Export My Data" / "Delete All My Data",
 * driven end-to-end through the new Privacy / Your data Settings card.
 *
 *  - **Export** produces a single downloadable JSON bundle (no server call).
 *  - **Delete** is gated behind a typed destructive confirm; confirming clears
 *    every localStorage store and reloads the app.
 *
 * The e2e IPC mock sets `__TAURI_INTERNALS__` (so `invoke` works) but NOT
 * `window.isTauri`, which `@tauri-apps/api`'s `isTauri()` reads — so this runs on
 * the OFF-Tauri graceful-degradation path: the SQLite / profile / keychain erase
 * seams are inert and only the localStorage stores are cleared. That is exactly
 * the "degrade gracefully outside Tauri" contract this surface must honor; the
 * on-Tauri backend erase (DELETE FROM, delete_profile, ai_clear_api_key) is
 * covered by the `wipeAllUserData` unit test.
 *
 * The erase resets the app with `window.location.reload()` (which Chromium won't
 * let a test stub). So the recorder writes SYNCHRONOUSLY into `sessionStorage` —
 * which survives the reload and is NOT one of the erased localStorage keys — and
 * the test reads it back after the reload's `load` event.
 */

/** SQLite + BYOK + profile IPC handlers (present so nothing rejects noisily). */
const HANDLERS = {
  "plugin:sql|load": "sqlite:omnilink.db",
  "plugin:sql|select": [],
  "plugin:sql|execute": [0, 0],
  "plugin:sql|close": true,
  load_profiles: [],
  delete_profile: null,
  ai_has_api_key: false,
  ai_clear_api_key: null,
};

/** sessionStorage bucket the removeItem recorder persists under. */
const REMOVE_LOG = "__omnilink_rmlog";

/** The 19 persisted localStorage stores the erase must clear (NFR-PRIV-02). */
const LOCAL_KEYS = [
  "omnilink-account",
  "omnilink-alerts",
  "omnilink-announcements",
  "omnilink-billing",
  "omnilink-byok",
  "omnilink-cloud-mock",
  "omnilink-dashboard-panels",
  "omnilink-dev-flags",
  "omnilink-diagnostics",
  "omnilink-diagnostics-history",
  "omnilink-knowledge",
  "omnilink-language",
  "omnilink-notes",
  "omnilink-notifications",
  "omnilink-preset-library",
  // M71: the chosen folder-sync path (a path the user picked = user data).
  "omnilink-profiles",
  "omnilink-retention",
  "omnilink-sync",
  "omnilink-theme",
];

/**
 * Install the mock plus a synchronous `localStorage.removeItem` recorder, and
 * seed every store so the erase has all 19 to remove. Must run before nav.
 */
async function setup(page: Page): Promise<void> {
  await installTauriMock(page, HANDLERS);
  await page.addInitScript(
    ({ removeLog, keys }) => {
      const origRemove = Storage.prototype.removeItem;
      // Prototype override (Storage is exotic; instance assignment is unreliable).
      Storage.prototype.removeItem = function (key: string) {
        try {
          const log = JSON.parse(sessionStorage.getItem(removeLog) ?? "[]");
          log.push(String(key));
          sessionStorage.setItem(removeLog, JSON.stringify(log));
        } catch {
          /* ignore */
        }
        return origRemove.call(this, key);
      };
      for (const k of keys) {
        localStorage.setItem(k, JSON.stringify({ state: {}, version: 0 }));
      }
    },
    { removeLog: REMOVE_LOG, keys: LOCAL_KEYS }
  );
}

test.describe("Privacy / Your data (NFR-PRIV-02)", () => {
  test.use({ reducedMotion: "reduce" });

  test("Export My Data downloads a single JSON bundle", async ({ page }) => {
    await setup(page);
    await gotoApp(page, "/settings");

    const card = page.getByTestId("privacy-data-card");
    await expect(card).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("privacy-export-btn").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^omnilink-data-export-.*\.json$/
    );
  });

  test("Delete All My Data requires a typed confirm, then clears every store", async ({
    page,
  }) => {
    await setup(page);
    await gotoApp(page, "/settings");

    // Open the destructive confirm dialog.
    await page.getByTestId("privacy-delete-btn").click();
    const confirmBtn = page.getByTestId("privacy-delete-confirm-btn");
    // Armed only once the confirm word is typed — never a single stray click.
    await expect(confirmBtn).toBeDisabled();
    await page.getByTestId("privacy-delete-confirm-input").fill("DELETE");
    await expect(confirmBtn).toBeEnabled();

    // Confirming erases everything, then reloads to reset state; wait for that
    // reload's load event so the sessionStorage record is complete.
    await Promise.all([page.waitForEvent("load"), confirmBtn.click()]);

    const removed: string[] = await page.evaluate(
      (k) => JSON.parse(sessionStorage.getItem(k) ?? "[]"),
      REMOVE_LOG
    );

    // Every one of the 19 persisted localStorage stores was removed.
    for (const key of LOCAL_KEYS) {
      expect(removed).toContain(key);
    }
  });
});
