import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * FIX 2A (wizard half): StepReview had NO port-ownership gate at all.
 *
 * A controller-bridge probe / context fetch / passthrough check opens the serial
 * port directly and holds it (up to ~14s), without ever touching the device
 * status. Start Flash therefore stayed live: `start_flash`'s reader teardown is
 * a no-op against a bridge command, `upload_uart` took the point of no return
 * BEFORE spawning esptool, and esptool's "could not open port … busy" was
 * categorised as `Wiring` — telling the user to re-cable and bootloader a device
 * nothing had touched, after the UI had already dropped the cancel control.
 *
 * The step must refuse to start while the port is held, and say why.
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
  flashMethod: "uart" as string | null,
  useTraditionalBinding: true,
  bindingPhrase: "",
  deviceIp: "",
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
  device: null as unknown,
  selectedPort: "/dev/ttyUSB0" as string | null,
}));

const wifiState = vi.hoisted(() => ({
  discovered: [] as unknown[],
  selectedId: null as string | null,
}));

const busy = vi.hoisted(() => ({ key: null as string | null }));

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
  useSerialPortBusyReasonKey: () => busy.key,
}));

import { StepReview } from "@/components/wizard/StepReview";

const START = "wizard.flash.start";
const REASON = 'data-testid="review-port-busy"';

function render(reasonKey: string | null): string {
  busy.key = reasonKey;
  return renderToStaticMarkup(<StepReview />);
}

/** The opening tag of the Start Flash button. */
function startButtonTag(html: string): string {
  const at = html.indexOf(START);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", open));
}

/** `disabled=""`, never the Tailwind `disabled:*` utilities in `class`. */
function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag);
}

describe("StepReview serial-port gate", () => {
  it("disables Start Flash while a bridge operation holds the port", () => {
    const html = render("device.portBusy.passthrough");

    expect(isDisabled(startButtonTag(html))).toBe(true);
  });

  it("states the reason on screen rather than failing later as a wiring fault", () => {
    const html = render("device.portBusy.passthrough");

    expect(html).toContain(REASON);
    expect(html).toContain("device.portBusy.passthrough");
  });

  it("gates on every bridge operation, not just the long one", () => {
    for (const key of [
      "device.portBusy.probe",
      "device.portBusy.context",
      "device.portBusy.passthrough",
    ]) {
      const html = render(key);
      expect(isDisabled(startButtonTag(html))).toBe(true);
      expect(html).toContain(key);
    }
  });

  it("leaves Start Flash live when nothing is holding the port", () => {
    const html = render(null);

    expect(isDisabled(startButtonTag(html))).toBe(false);
    expect(html).not.toContain(REASON);
  });
});
