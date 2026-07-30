import { expect, test, type Page } from "@playwright/test";
import {
  emitTauri,
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
} from "./_helpers";

/**
 * M20 Backpack discovery + config (M19): a Backpack device is surfaced
 * UNMISTAKABLY (distinct Backpack badge), never in the plain TX/RX list; clicking
 * its DeviceBar row toggles the schema-driven config form, which is a fully
 * controlled read/write component.
 *
 * Contract label: backpack.kind.tx="Backpack (TX)".
 */

const PLAIN_TX = {
  id: "ap:ExpressLRS TX",
  name: "ExpressLRS TX",
  address: "10.0.0.2",
  source: "ap",
  kind: "tx",
} as const;

const BACKPACK_TX = {
  id: "ap:ExpressLRS TX Backpack",
  name: "ExpressLRS TX Backpack",
  address: "10.0.0.1",
  source: "ap",
  kind: "tx-backpack",
} as const;

/** Re-emit until the discovered list reflects the devices (closes the listener race). */
async function emitUntilCount(
  page: Page,
  devices: readonly unknown[],
  expected: number
): Promise<void> {
  await expect
    .poll(async () => {
      for (const d of devices) await emitTauri(page, "wifi://discovered", d);
      return page.getByTestId("wifi-device-item").count();
    })
    .toBe(expected);
}

test.describe("Backpack discovery & config", () => {
  test("distinct Backpack label + schema-driven form read/write", async ({
    page,
  }) => {
    await installTauriMock(page, {
      start_wifi_scan: null,
      stop_wifi_scan: null,
    });
    await gotoApp(page, "/");

    // Before/after (real-flow) guard.
    await expect(page.getByTestId("wifi-discovered-list")).toHaveCount(0);

    await emitUntilCount(page, [BACKPACK_TX, PLAIN_TX], 2);

    // Exactly one item carries the Backpack badge; the plain TX must NOT.
    const backpackLabel = page.getByTestId("backpack-device-label");
    await expect(backpackLabel).toHaveCount(1);
    await expect(backpackLabel).toHaveText("Backpack (TX)");

    const items = page.getByTestId("wifi-device-item");
    const plainItem = items.filter({ hasText: "ExpressLRS TX" }).filter({
      hasNot: page.getByTestId("backpack-device-label"),
    });
    await expect(plainItem).toHaveCount(1);

    // The form is not mounted until the Backpack row is clicked (it toggles open).
    await expect(page.getByTestId("backpack-config-form")).toHaveCount(0);
    const backpackItem = items.filter({
      has: page.getByTestId("backpack-device-label"),
    });
    await backpackItem.click();

    const form = page.getByTestId("backpack-config-form");
    await expect(form).toBeVisible();
    const vtx = page.getByTestId("backpack-field-vtxChannel");
    const dvr = page.getByTestId("backpack-field-dvrControl");
    const head = page.getByTestId("backpack-field-headTracker");
    await expect(vtx).toBeVisible();
    await expect(dvr).toBeVisible();
    await expect(head).toBeVisible();

    // Read/write: the schema default for vtxChannel is "R1"; change it + flip the
    // head-tracker checkbox, and assert both controls reflect the new values.
    await expect(vtx).toHaveValue("R1");
    await vtx.selectOption("A1");
    await expect(vtx).toHaveValue("A1");

    await expect(head).not.toBeChecked();
    await head.check();
    await expect(head).toBeChecked();

    // Full-page a11y with the schema-driven form popover open over the DeviceBar.
    await expectNoSeriousA11y(page);
  });
});
