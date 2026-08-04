import { expect, test, type Page } from "@playwright/test";
import { gotoApp, installTauriMock } from "./_helpers";

/**
 * v3.0.3 defect 1 — "Export my data" must reach a file the **user** chose, and
 * must say so.
 *
 * Shipped, the three export actions built a `Blob`, minted an object URL and
 * clicked a synthetic `<a download>`. Chromium runs that through its download
 * manager; WebKitGTK 2.52.3 (the engine in the AppImage) wrote the bundle into
 * the process's current working directory instead — no dialog, no toast, no
 * reveal-in-folder. On an installed app that cwd is `/` or `$HOME`, so the file
 * was gone as far as the user was concerned.
 *
 * The fix routes the desktop path through the native save dialog (Rust command
 * `save_export_file`) and then states the outcome. This spec drives the three
 * outcomes that must be distinguishable:
 *
 *  - **saved** — the dialog returned a path; the card shows that path;
 *  - **cancelled** — the user dismissed the dialog; the card stays clean, with
 *    no error and no phantom "saved";
 *  - **failed** — the write itself failed; the card says so, with the detail.
 *
 * `tests/e2e/privacy-data.spec.ts` covers the same button on the *browser*
 * path (no `isTauri`), where the anchor download is still the right answer and
 * a real `download` event fires. Between them, both halves of the seam are
 * pinned.
 */

/** SQLite + BYOK + profile IPC handlers (present so nothing rejects noisily). */
const HANDLERS = {
  "plugin:sql|load": "sqlite:omnilink.db",
  "plugin:sql|select": [],
  "plugin:sql|execute": [0, 0],
  "plugin:sql|close": true,
  load_profiles: [],
  ai_has_api_key: false,
};

/** What the fake `save_export_file` command should do when the UI calls it. */
type SaveOutcome =
  | { readonly path: string | null }
  | { readonly error: string };

/**
 * Turn the page into a Tauri host (`isTauri()` reads `globalThis.isTauri`, as
 * `installFolderSyncMock` already relies on) and serve `save_export_file` from
 * the test side, recording every request so the spec can assert what the UI
 * actually asked the backend to write.
 *
 * Call AFTER {@link installTauriMock} and BEFORE navigation.
 */
async function installSaveDialogMock(
  page: Page,
  outcome: SaveOutcome
): Promise<void> {
  await page.addInitScript((result: SaveOutcome) => {
    (globalThis as unknown as { isTauri: boolean }).isTauri = true;

    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const base = internals.invoke.bind(internals);

    const requests: unknown[] = [];
    (window as unknown as { __omnilinkSaveRequests: unknown[] })
      .__omnilinkSaveRequests = requests;

    internals.invoke = async (cmd, args = {}) => {
      if (cmd === "save_export_file") {
        requests.push(args.request);
        if ("error" in result) throw result.error;
        return result.path;
      }
      return base(cmd, args);
    };
  }, outcome);
}

/** Every `save_export_file` request the page has made so far. */
async function saveRequests(
  page: Page
): Promise<{ title: string; defaultName: string; contents: string }[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __omnilinkSaveRequests: {
            title: string;
            defaultName: string;
            contents: string;
          }[];
        }
      ).__omnilinkSaveRequests
  );
}

const SAVED_PATH = "/home/pilot/Documents/omnilink-data-export.json";

test.describe("Export my data — native save dialog (defect 1)", () => {
  test.use({ reducedMotion: "reduce" });

  test("saves where the user chose and shows the resolved path", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await installSaveDialogMock(page, { path: SAVED_PATH });
    await gotoApp(page, "/settings");

    await expect(page.getByTestId("privacy-data-card")).toBeVisible();
    await page.getByTestId("privacy-export-btn").click();

    // The outcome is stated, with the path — not left to the user to hunt for.
    const status = page.getByTestId("privacy-export-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText(SAVED_PATH);
    await expect(page.getByTestId("privacy-export-error")).toHaveCount(0);

    // And the request really carried the bundle through the native dialog.
    const requests = await saveRequests(page);
    expect(requests).toHaveLength(1);
    expect(requests[0].defaultName).toMatch(/^omnilink-data-export-.*\.json$/);
    expect(requests[0].title.length).toBeGreaterThan(0);
    expect(JSON.parse(requests[0].contents)).toMatchObject({
      localStorage: expect.anything(),
    });
  });

  test("a dismissed dialog is silent but clean", async ({ page }) => {
    await installTauriMock(page, HANDLERS);
    await installSaveDialogMock(page, { path: null });
    await gotoApp(page, "/settings");

    await page.getByTestId("privacy-export-btn").click();

    // Cancel is a normal outcome: nothing claimed, nothing blamed. Wait for the
    // request to land so this is not just "the UI has not caught up yet".
    await expect
      .poll(async () => (await saveRequests(page)).length)
      .toBe(1);
    await expect(page.getByTestId("privacy-export-status")).toHaveCount(0);
    await expect(page.getByTestId("privacy-export-error")).toHaveCount(0);
    // The button is usable again rather than stuck in its busy state.
    await expect(page.getByTestId("privacy-export-btn")).toBeEnabled();
  });

  test("a failed write says what failed", async ({ page }) => {
    await installTauriMock(page, HANDLERS);
    await installSaveDialogMock(page, {
      error: "Permission denied (os error 13)",
    });
    await gotoApp(page, "/settings");

    await page.getByTestId("privacy-export-btn").click();

    const error = page.getByTestId("privacy-export-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("Permission denied (os error 13)");
    await expect(page.getByTestId("privacy-export-status")).toHaveCount(0);
  });
});
