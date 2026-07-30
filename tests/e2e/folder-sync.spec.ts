import { expect, test } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installFolderSyncMock,
  installTauriMock,
  readFolderSyncMock,
} from "./_helpers";

/**
 * M71 — user-owned folder sync (decision D37), end to end through the real
 * store and the real seam: pick a folder → PUSH a saved profile into it → PULL
 * a file that is only in the folder.
 *
 * The filesystem is stood in for by {@link installFolderSyncMock}, a stateful
 * in-page fake of the six `plugin:folder-sync|*` commands, so the flow exercises
 * `stores/profiles.ts` + `components/config/FolderSync.tsx` exactly as shipped.
 *
 * Localized labels come from the contract (`folderSync.*`, en):
 *   status.local-only  = "Only on this machine"
 *   status.folder-only = "Only in the folder"
 *   status.same        = "In sync"
 *   status.conflict    = "Differs"
 */

const FOLDER = "/home/pilot/Dropbox/OmniLink";

/** A hand-written `.elrsp` file already sitting in the folder (another machine). */
const FROM_OTHER_MACHINE = JSON.stringify(
  {
    schemaVersion: 1,
    name: "Long Range",
    description: "50 Hz, low telemetry",
    settings: {
      packetRate: 50,
      telemetryRatio: "1:128",
      switchMode: "Wide",
      txPower: 500,
      dynamicPower: false,
      modelMatch: false,
      modelId: 0,
      bindingPhrase: "",
      antennaMode: "Diversity",
      fanThreshold: 250,
    },
    updatedAt: 1_700_000_900_000,
  },
  null,
  2
);

test.describe("folder sync", () => {
  test("pick a folder, push a local profile, pull a folder-only one", async ({
    page,
  }) => {
    await installTauriMock(page, {
      load_profiles: [],
      save_profile: null,
      delete_profile: null,
    });
    await installFolderSyncMock(page, FOLDER, [
      { name: "Long Range.elrsp", contents: FROM_OTHER_MACHINE },
    ]);

    await gotoApp(page, "/profiles");

    // A saved profile to push (the local library starts with presets only).
    await page.getByRole("button", { name: "Save As" }).click();
    await page.getByPlaceholder("e.g. Racing 500Hz").fill("Race 250");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Opt-in: the surface only exists once you open it, and does nothing until
    // a folder is chosen.
    await page.getByTestId("profiles-tab-folder").click();
    await expect(page.getByTestId("folder-sync")).toBeVisible();
    await expect(page.getByTestId("folder-sync-path")).toHaveCount(0);
    await expect(page.getByTestId("folder-sync-entry")).toHaveCount(0);
    expect(await readFolderSyncMock(page)).toEqual({
      "Long Range.elrsp": FROM_OTHER_MACHINE,
    });

    // 1. Pick the folder (native dialog stood in for by the mock).
    await page.getByTestId("folder-sync-pick").click();
    await expect(page.getByTestId("folder-sync-path")).toHaveText(FOLDER);

    // Both sides show up, correctly classified.
    const rows = page.getByTestId("folder-sync-entry");
    await expect(rows).toHaveCount(2);
    const localOnly = rows.filter({ has: page.getByText("Only on this machine") });
    const folderOnly = rows.filter({ has: page.getByText("Only in the folder") });
    await expect(localOnly).toHaveCount(1);
    await expect(folderOnly).toHaveCount(1);
    await expect(localOnly.getByTestId("folder-sync-entry-name")).toHaveText(
      "Race 250.elrsp"
    );

    // 2. PUSH the local profile. The row settles to "In sync" and the file
    //    appears in the folder as a pretty `.elrsp` document.
    await localOnly.getByTestId("folder-sync-push").click();
    await expect(
      page
        .getByTestId("folder-sync-entry")
        .filter({ hasText: "Race 250.elrsp" })
        .getByTestId("folder-sync-entry-status")
    ).toHaveText("In sync");

    const afterPush = await readFolderSyncMock(page);
    expect(Object.keys(afterPush).sort()).toEqual([
      "Long Range.elrsp",
      "Race 250.elrsp",
    ]);
    const pushed = JSON.parse(afterPush["Race 250.elrsp"] ?? "{}");
    expect(pushed.name).toBe("Race 250");
    expect(pushed.schemaVersion).toBe(1);
    expect(pushed.settings.packetRate).toBeGreaterThan(0);
    // Human-readable: pretty-printed, no wrapper around the document.
    expect(afterPush["Race 250.elrsp"]).toContain('\n  "settings"');

    // 3. PULL the folder-only profile into the local library.
    await folderOnly.getByTestId("folder-sync-pull").click();
    await expect(
      page
        .getByTestId("folder-sync-entry")
        .filter({ hasText: "Long Range.elrsp" })
        .getByTestId("folder-sync-entry-status")
    ).toHaveText("In sync");

    // It is a real local profile now: the saved list shows it, with the values
    // that were in the file.
    await page.getByRole("tab", { name: "Saved" }).click();
    // Scoped + exact: a bundled preset is called "Long Range 50Hz".
    await expect(
      page.getByLabel("Saved Profiles").getByText("Long Range", { exact: true })
    ).toBeVisible();
    // The description came from the file, not from anything local.
    await expect(
      page.getByLabel("Saved Profiles").getByText("50 Hz, low telemetry")
    ).toBeVisible();

    // Pulling wrote nothing back to the folder.
    expect(await readFolderSyncMock(page)).toEqual(afterPush);
  });

  test("a conflict offers a choice and never overwrites on its own", async ({
    page,
  }) => {
    await installTauriMock(page, {
      load_profiles: [],
      save_profile: null,
      delete_profile: null,
    });
    // Same NAME as the profile saved below, different content.
    await installFolderSyncMock(page, FOLDER, [
      {
        name: "Race 250.elrsp",
        contents: JSON.stringify(
          {
            schemaVersion: 1,
            name: "Race 250",
            settings: {
              packetRate: 50,
              telemetryRatio: "1:128",
              switchMode: "Wide",
              txPower: 25,
              dynamicPower: false,
              modelMatch: false,
              modelId: 0,
              bindingPhrase: "",
              antennaMode: "Diversity",
              fanThreshold: 250,
            },
            updatedAt: 1_700_000_900_000,
          },
          null,
          2
        ),
      },
    ]);

    await gotoApp(page, "/profiles");
    await page.getByRole("button", { name: "Save As" }).click();
    await page.getByPlaceholder("e.g. Racing 500Hz").fill("Race 250");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await page.getByTestId("profiles-tab-folder").click();
    const before = await readFolderSyncMock(page);
    await page.getByTestId("folder-sync-pick").click();

    // One conflict row, and the folder is untouched by merely detecting it.
    const row = page.getByTestId("folder-sync-entry");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("folder-sync-entry-status")).toHaveText("Differs");
    expect(await readFolderSyncMock(page)).toEqual(before);

    // Both sides are shown before anything is decided.
    await row.getByTestId("folder-sync-compare").click();
    await expect(page.getByTestId("folder-sync-conflict-diff")).toBeVisible();

    // Three named choices, no default action.
    await expect(row.getByTestId("folder-sync-push")).toBeVisible();
    await expect(row.getByTestId("folder-sync-pull")).toBeVisible();
    await expect(row.getByTestId("folder-sync-keep-both")).toBeVisible();

    // Keep both: nothing is lost — two files, two profiles, no conflict left.
    await row.getByTestId("folder-sync-keep-both").click();
    await expect
      .poll(async () => Object.keys(await readFolderSyncMock(page)).sort())
      .toEqual(["Race 250 (2).elrsp", "Race 250.elrsp"]);
    // The folder's original file still holds the folder's version.
    expect((await readFolderSyncMock(page))["Race 250.elrsp"]).toBe(
      before["Race 250.elrsp"]
    );
    await expect(page.getByTestId("folder-sync-entry")).toHaveCount(2);
    await expect(
      page
        .getByTestId("folder-sync-entry")
        .filter({ has: page.getByText("Differs") })
    ).toHaveCount(0);

    await expectNoSeriousA11y(page);
  });

  test("with no folder configured the surface is inert", async ({ page }) => {
    await installTauriMock(page, { load_profiles: [], save_profile: null });
    await installFolderSyncMock(page, FOLDER, [
      { name: "Long Range.elrsp", contents: FROM_OTHER_MACHINE },
    ]);
    await gotoApp(page, "/profiles");

    // The saved-profiles surface behaves exactly as it did before M71.
    await expect(page.getByRole("button", { name: "Save As" })).toBeVisible();
    await expect(page.getByTestId("folder-sync")).toHaveCount(0);

    // Opening the tab reads nothing: no path, no rows, and the folder is
    // untouched (the file that was there is still exactly as it was).
    await page.getByTestId("profiles-tab-folder").click();
    await expect(page.getByTestId("folder-sync-path")).toHaveCount(0);
    await expect(page.getByTestId("folder-sync-entry")).toHaveCount(0);
    await expect(page.getByTestId("folder-sync-error")).toHaveCount(0);
    expect(await readFolderSyncMock(page)).toEqual({
      "Long Range.elrsp": FROM_OTHER_MACHINE,
    });

    await expectNoSeriousA11y(page);
  });
});
