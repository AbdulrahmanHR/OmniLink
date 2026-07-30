import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CONN-11 (wizard half): StepReview had no gate on a CRSF handshake in flight.
 *
 * A connect is a ~4.5s baud sweep that owns the serial port, and a WiFi OTA
 * disconnects nothing — so Start Flash was live throughout it. The flash then
 * captured "connecting" as the status to restore, the handshake's failure event
 * was swallowed as flash noise, and the completion put the bar back on a
 * spinner with no reader behind it and no pending event: permanently inert,
 * because `canClaimPort("connecting")` disables the picker, refresh, Connect and
 * the bridge probe.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const wizardState = vi.hoisted(() => ({
  brandId: "betafpv" as string | null,
  modelId: "betafpv-nano-tx-2400" as string | null,
  domain: "ISM2400" as string | null,
  firmwareVersion: "3.5.3" as string | null,
  localFirmwarePath: null as string | null,
  localFirmwareName: null as string | null,
  flashMethod: "wifi" as string | null,
  useTraditionalBinding: true,
  bindingPhrase: "",
  deviceIp: "10.0.0.1",
  flash: {
    status: "idle" as string,
    percent: 0,
    stage: null,
    etaSeconds: null,
    log: [] as unknown[],
    error: null,
    backupWarning: false,
  },
  // FR-FLASH-10: no identity guard has refused anything in these scenarios.
  identityRefusal: null,
  startFlash: vi.fn(),
  cancelFlash: vi.fn(),
  resetFlash: vi.fn(),
  reset: vi.fn(),
}));

const deviceState = vi.hoisted(() => ({
  status: "disconnected" as string,
  device: null as unknown,
  selectedPort: "/dev/ttyUSB0" as string | null,
}));

const wifiState = vi.hoisted(() => ({
  discovered: [] as unknown[],
  selectedId: null as string | null,
}));

vi.mock("@/stores", () => ({
  useWizardStore: (selector: (s: typeof wizardState) => unknown) =>
    selector(wizardState),
  useDeviceStore: (selector: (s: typeof deviceState) => unknown) =>
    selector(deviceState),
  useWifiStore: (selector: (s: typeof wifiState) => unknown) =>
    selector(wifiState),
}));
vi.mock("@/hooks", () => ({
  useDerivedUid: () => null,
  // No bridge operation running — the handshake is the only thing in the way.
  useSerialPortBusyReasonKey: () => null,
}));

import { StepReview } from "@/components/wizard/StepReview";

const START = "wizard.flash.start";
const REASON = 'data-testid="review-port-busy"';

function render(status: string): string {
  deviceState.status = status;
  return renderToStaticMarkup(<StepReview />);
}

function startButtonTag(html: string): string {
  const at = html.indexOf(START);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", open));
}

function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag);
}

describe("StepReview — handshake-in-flight gate", () => {
  it("refuses to start a flash while the device is connecting", () => {
    const html = render("connecting");

    expect(isDisabled(startButtonTag(html))).toBe(true);
  });

  it("says why, rather than leaving Start Flash looking broken", () => {
    const html = render("connecting");

    expect(html).toContain(REASON);
    expect(html).toContain("device.portBusy.connecting");
  });

  it("leaves Start Flash live in every settled state", () => {
    for (const status of ["disconnected", "connected", "error"]) {
      const html = render(status);
      expect(isDisabled(startButtonTag(html))).toBe(false);
      expect(html).not.toContain(REASON);
    }
  });
});
