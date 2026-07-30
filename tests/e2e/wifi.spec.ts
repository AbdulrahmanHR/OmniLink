import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  emitTauri,
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
} from "./_helpers";

/**
 * M20 WiFi discovery (M18): streaming `wifi://discovered` devices surface in the
 * layout DeviceBar with an UNMISTAKABLE AP-mode vs on-network (mDNS) label; the
 * empty/no-device state is graceful; and (best-effort) picking a device in the
 * flash wizard's WiFi step populates the device IP.
 *
 * Localized labels are read from the contract: wifi.source.ap="AP mode",
 * wifi.source.mdns="On network".
 */

const AP_TX = {
  id: "ap:ExpressLRS TX",
  name: "ExpressLRS TX",
  address: "10.0.0.1",
  source: "ap",
  kind: "tx",
} as const;

const MDNS_RX = {
  id: "mdns:192.168.1.50",
  name: "ExpressLRS RX",
  address: "192.168.1.50",
  source: "mdns",
  kind: "rx",
} as const;

/**
 * Emit the discovered devices repeatedly until `root` reflects them. The store
 * registers its `wifi://discovered` listener asynchronously on mount, so the very
 * first emit can race ahead of it; re-emitting is safe (upsert is last-write-wins
 * by id), so this poll closes the race deterministically without arbitrary waits.
 */
async function emitUntilCount(
  page: Page,
  root: Locator,
  devices: readonly unknown[],
  expected: number
): Promise<void> {
  await expect
    .poll(async () => {
      for (const d of devices) await emitTauri(page, "wifi://discovered", d);
      return root.getByTestId("wifi-device-item").count();
    })
    .toBe(expected);
}

test.describe("WiFi discovery", () => {
  test("discovered list shows AP + mDNS devices with source labels", async ({
    page,
  }) => {
    await installTauriMock(page, {
      start_wifi_scan: null,
      stop_wifi_scan: null,
      probe_wifi_device: { name: "ELRS", deviceType: "TX", reachable: true },
    });
    await gotoApp(page, "/");

    // Before/after (real-flow) guard: no list until devices stream in.
    await expect(page.getByTestId("wifi-discovered-list")).toHaveCount(0);

    await emitUntilCount(page, page.locator("body"), [AP_TX, MDNS_RX], 2);

    await expect(page.getByTestId("wifi-discovered-list")).toBeVisible();
    const sources = page.getByTestId("wifi-device-source");
    await expect(sources).toHaveCount(2);
    // One device reads the AP label, the other the on-network (mDNS) label.
    await expect(sources.filter({ hasText: "AP mode" })).toHaveCount(1);
    await expect(sources.filter({ hasText: "On network" })).toHaveCount(1);

    await expectNoSeriousA11y(page);
  });

  test("graceful empty state when no devices are discovered", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await installTauriMock(page, {
      start_wifi_scan: null,
      stop_wifi_scan: null,
    });
    await gotoApp(page, "/");

    // Positive anchor: the DeviceBar (host of the WiFi list) actually mounted,
    // so the empty assertions below prove "no devices" rather than "no surface".
    await expect(
      page.getByRole("button", { name: "Notifications" })
    ).toBeVisible();
    // No devices emitted: the discovered list never appears and nothing crashes.
    await expect(page.getByTestId("wifi-discovered-list")).toHaveCount(0);
    await expect(page.getByTestId("wifi-device-item")).toHaveCount(0);
    await expect(page.locator("main")).toBeVisible();
    expect(pageErrors).toEqual([]);

    await expectNoSeriousA11y(page);
  });

  test("wizard WiFi step: picking a device populates the device IP", async ({
    page,
  }) => {
    await installTauriMock(page, {
      start_wifi_scan: null,
      stop_wifi_scan: null,
      probe_wifi_device: { name: "ELRS", deviceType: "TX", reachable: true },
      // StepFrequency fetches the live release list on mount; return an empty
      // array so it falls back to the bundled catalogue instead of crashing on
      // an undefined response.
      fetch_firmware_releases: [],
    });
    await gotoApp(page, "/flash");

    // Drive the wizard to the frequency step: pick a brand + model that support
    // the WiFi flash method, advancing with Next each time.
    await page.getByRole("button", { name: /BetaFPV/ }).first().click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: /Nano TX/ }).first().click();
    await page.getByRole("button", { name: "Next" }).click();

    // On the frequency step, choose the WiFi method to reveal the picker.
    await page.getByRole("button", { name: /WiFi/ }).first().click();
    await expect(page.getByTestId("wifi-scan-button")).toBeVisible();

    // The wizard's discovered list lives in <main>; the layout DeviceBar renders
    // its OWN copy in <header>, so scope all wizard-list assertions to <main>.
    const main = page.locator("main");
    // No devices yet → the empty state is shown (graceful), not a crash.
    await expect(main.getByTestId("wifi-empty")).toBeVisible();

    // Stream a device and pick it; selecting it must populate the manual IP.
    await emitUntilCount(page, main, [MDNS_RX], 1);
    const ipInput = page.getByLabel("Enter IP manually");
    await expect(ipInput).not.toHaveValue(MDNS_RX.address);
    await main.getByTestId("wifi-device-item").first().click();
    await expect(ipInput).toHaveValue(MDNS_RX.address);

    await expectNoSeriousA11y(page);
  });
});
