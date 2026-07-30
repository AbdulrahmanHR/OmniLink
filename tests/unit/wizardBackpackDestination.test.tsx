import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WifiDevice } from "@/lib/wifiDiscovery";

/**
 * The Backpack cross-family guard was structurally dead end to end.
 *
 * `check_backpack_compatibility` (and the real backend's fail-closed
 * `backpackFirmwareUnavailable` branch) are gated on the request's
 * `backpackKind` / `connectedBackpackKind`, but the only `FlashRequestPayload`
 * constructor omitted both — so a WiFi-discovered ExpressLRS Backpack could be
 * picked as the OTA destination for a plain main-ELRS flash and NOTHING
 * objected: over WiFi nothing handshakes, so `connectedDeviceType` is null and
 * the TX/RX guard abstains too.
 *
 * The backend half is pinned in Rust (`flash::backpack::check_backpack_family`
 * + its `run_flash` wiring). This is the UI half: the wizard catalogue holds
 * main-ELRS targets only, so a Backpack row can never be a valid destination
 * for the model chosen here and must be refused VISIBLY — disabled with a
 * stated reason — instead of the click being silently accepted and the flash
 * failing later.
 */

// The component only needs `t` to resolve keys; render the key itself so the
// assertions are about WHICH copy is shown, not about the translation.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

// The release list is fetched from an effect, which `renderToStaticMarkup`
// never runs; the seam only has to resolve at import time.
vi.mock("@/lib/tauri", () => ({
  fetchFirmwareReleases: vi.fn(() => Promise.resolve({ releases: [] })),
  pickLocalFirmwareFile: vi.fn(() => Promise.resolve(null)),
  releaseFetchReason: vi.fn(() => "unknown"),
}));

// Under `renderToStaticMarkup` zustand v5 serves its INITIAL state, so drive
// the component through selector-shaped fakes rather than the real stores.
const wizardState = vi.hoisted(() => ({
  brandId: "betafpv" as string | null,
  modelId: "betafpv-nano-tx-2400" as string | null,
  domain: "ISM2400" as string | null,
  firmwareVersion: "3.5.3" as string | null,
  flashMethod: "wifi" as string | null,
  deviceIp: "10.0.0.1",
  localFirmwarePath: null as string | null,
  localFirmwareName: null as string | null,
  selectDomain: () => {},
  selectFirmware: () => {},
  selectLocalFirmware: () => {},
  selectFlashMethod: () => {},
  setDeviceIp: () => {},
}));

// FR-FLASH-01: the release list + pre-release opt-in live in their own store now
// (the reconcile has to outlive this step). Only the loading state matters here.
const releasesState = vi.hoisted(() => ({
  state: { kind: "loading" } as { kind: string },
  showPrereleases: false,
  load: () => Promise.resolve(),
  setShowPrereleases: () => {},
}));

const wifiState = vi.hoisted(() => ({
  discovered: [] as unknown[],
  scanning: false,
  selectedId: null as string | null,
  error: null,
  startScan: () => {},
  stopScan: () => {},
  select: () => {},
}));

vi.mock("@/stores", () => ({
  isValidDeviceIp: () => true,
  useWizardStore: (selector: (s: typeof wizardState) => unknown) =>
    selector(wizardState),
  useFirmwareReleasesStore: (selector: (s: typeof releasesState) => unknown) =>
    selector(releasesState),
  useWifiStore: (selector: (s: typeof wifiState) => unknown) =>
    selector(wifiState),
}));

import { StepFrequency } from "@/components/wizard/StepFrequency";

const ITEM = 'data-testid="wifi-device-item"';
const REASON = 'data-testid="wifi-device-blocked-reason"';

const PLAIN: WifiDevice = {
  id: "mdns:elrs-tx",
  name: "ELRS TX",
  address: "192.168.1.50",
  source: "mdns",
  kind: "tx",
};
const TX_BACKPACK: WifiDevice = {
  id: "ap:ExpressLRS TX Backpack",
  name: "ExpressLRS TX Backpack",
  address: "10.0.0.1",
  source: "ap",
  kind: "tx-backpack",
};
const VRX_BACKPACK: WifiDevice = {
  ...TX_BACKPACK,
  id: "ap:ExpressLRS VRX Backpack",
  name: "ExpressLRS VRX Backpack",
  kind: "vrx-backpack",
};

/** Render the step with `devices` discovered, returning the markup. */
function render(devices: WifiDevice[]): string {
  wifiState.discovered = devices;
  return renderToStaticMarkup(<StepFrequency />);
}

/** The opening-tag attributes of the nth discovered-device button. */
function rowAttributes(html: string, index: number): string {
  const rows = html.split(ITEM).slice(1);
  expect(rows.length).toBeGreaterThan(index);
  return rows[index].slice(0, rows[index].indexOf(">"));
}

describe("StepFrequency WiFi destination rows", () => {
  it("leaves a plain ELRS device selectable", () => {
    const html = render([PLAIN]);

    expect(rowAttributes(html, 0)).not.toContain("disabled");
    expect(html).not.toContain(REASON);
  });

  it("disables both Backpack roles with a stated reason", () => {
    for (const backpack of [TX_BACKPACK, VRX_BACKPACK]) {
      const html = render([backpack]);

      expect(rowAttributes(html, 0)).toContain("disabled");
      expect(html).toContain(REASON);
      expect(html).toContain("wizard.frequency.backpackNotFlashable");
    }
  });

  it("blocks only the Backpack row in a mixed list", () => {
    const html = render([PLAIN, TX_BACKPACK]);

    expect(rowAttributes(html, 0)).not.toContain("disabled");
    expect(rowAttributes(html, 1)).toContain("disabled");
    // Exactly one reason line — the plain row is untouched.
    expect(html.split(REASON).length - 1).toBe(1);
  });
});
