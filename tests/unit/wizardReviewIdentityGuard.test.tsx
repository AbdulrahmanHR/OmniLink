import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { DeviceInfo } from "@/stores/device";
import type { FlashRequestPayload } from "@/lib/tauri";

/**
 * FR-FLASH-10 (wizard half): the retry after an identity refusal was UNGUARDED.
 *
 * Both device-identity guards live in `run_flash`, which the wizard reaches only
 * after handing the serial port over (CONN-1) — so the store had already dropped
 * the connection by the time "Flash blocked: the device on this port isn't the
 * model selected" appeared. Start Flash is gated on `portBusy` alone, so it was
 * still live, and the second click re-built the request from an empty store:
 * `connectedDeviceType: null`, `connectedTargetName: null`, both guards
 * abstaining, `validate_local_firmware` happily comparing the image against the
 * SELECTED target — and the Ranger image written to the BetaFPV Nano TX.
 *
 * The step must therefore (a) keep sending the identity that WAS read from the
 * destination port, and (b) answer the second click itself rather than turning
 * it into another flash.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

// `renderToStaticMarkup` drops event handlers, so capture the Start Flash
// handler as it is rendered — that click is the whole subject of this file.
const captured = vi.hoisted(() => ({
  onClick: null as null | (() => void),
}));

vi.mock("@/components/ui/button", () => ({
  Button: (props: {
    onClick?: () => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => {
    captured.onClick = props.onClick ?? null;
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));

const wizardState = vi.hoisted(() => ({
  brandId: "radiomaster" as string | null,
  // The wrong model for the connected radio — a Ranger, on a Nano TX.
  modelId: "radiomaster-ranger-2400" as string | null,
  domain: "ISM2400" as string | null,
  firmwareVersion: "3.5.3" as string | null,
  localFirmwarePath: null as string | null,
  localFirmwareName: null as string | null,
  flashMethod: "uart" as string | null,
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
  identityRefusal: null as null | { port: string | null; target: string },
  startFlash: vi.fn(),
  cancelFlash: vi.fn(),
  resetFlash: vi.fn(),
  reset: vi.fn(),
}));

const deviceState = vi.hoisted(() => ({
  status: "disconnected" as string,
  device: null as unknown,
  lastIdentity: null as unknown,
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
  useSerialPortBusyReasonKey: () => null,
}));

import { StepReview } from "@/components/wizard/StepReview";

/** The radio actually on `/dev/ttyUSB0`, as the CRSF handshake read it. */
const NANO_TX: DeviceInfo = {
  targetName: "BETAFPV_2400_TX",
  firmwareVersion: "3.4.3",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 42,
  serialNumber: 1,
  hardwareVersion: 1,
};

const BLOCKED = 'data-testid="review-identity-blocked"';
const START = "wizard.flash.start";

interface Scenario {
  device?: DeviceInfo | null;
  lastIdentity?: DeviceInfo | null;
  selectedPort?: string | null;
  refusal?: { port: string | null; target: string } | null;
  method?: string;
  modelId?: string;
}

function render(scenario: Scenario = {}): string {
  captured.onClick = null;
  wizardState.startFlash.mockClear();
  deviceState.device = scenario.device ?? null;
  deviceState.lastIdentity = scenario.lastIdentity ?? null;
  deviceState.selectedPort =
    scenario.selectedPort === undefined ? "/dev/ttyUSB0" : scenario.selectedPort;
  wizardState.identityRefusal = scenario.refusal ?? null;
  wizardState.flashMethod = scenario.method ?? "uart";
  wizardState.modelId = scenario.modelId ?? "radiomaster-ranger-2400";
  return renderToStaticMarkup(<StepReview />);
}

/** The request the Start Flash click would send. */
function clickStartFlash(): FlashRequestPayload {
  expect(captured.onClick).not.toBeNull();
  captured.onClick?.();
  expect(wizardState.startFlash).toHaveBeenCalledTimes(1);
  return wizardState.startFlash.mock.calls[0][0] as FlashRequestPayload;
}

/** `disabled=""`, never the Tailwind `disabled:*` utilities in `class`. */
function startDisabled(html: string): boolean {
  const at = html.indexOf(START);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<button", at);
  return /\sdisabled=""/.test(html.slice(open, html.indexOf(">", open)));
}

describe("StepReview — evidence for the identity guards", () => {
  it("still carries the identity after the flash disconnected the device", () => {
    // Exactly the state the retry is clicked in: the flash released the port, so
    // `device` is null and the flashed port is still the selection.
    render({ lastIdentity: NANO_TX });

    const request = clickStartFlash();
    expect(request.port).toBe("/dev/ttyUSB0");
    expect(request.connectedDeviceType).toBe("TX");
    expect(request.connectedTargetName).toBe("BETAFPV_2400_TX");
  });

  it("prefers the live handshake when there is one", () => {
    const ranger: DeviceInfo = {
      ...NANO_TX,
      targetName: "RADIOMASTER_RANGER_2400",
    };
    render({ device: ranger, lastIdentity: NANO_TX });

    expect(clickStartFlash().connectedTargetName).toBe(
      "RADIOMASTER_RANGER_2400"
    );
  });

  it("does not carry it to a port it was not read from", () => {
    // The user re-pointed the picker at another port: the retained identity says
    // nothing about what is on THAT one, and "unknown" must abstain rather than
    // block (or approve) a flash on no evidence.
    render({ lastIdentity: NANO_TX, selectedPort: "/dev/ttyACM0" });

    const request = clickStartFlash();
    expect(request.port).toBe("/dev/ttyACM0");
    expect(request.connectedDeviceType).toBeNull();
    expect(request.connectedTargetName).toBeNull();
  });

  it("does not carry it to a WiFi OTA", () => {
    // An OTA writes to a device on the NETWORK; a radio that was once on the
    // serial port is not evidence about it, and pretending otherwise would
    // false-block every OTA to a different device.
    render({ lastIdentity: NANO_TX, method: "wifi" });

    const request = clickStartFlash();
    expect(request.connectedDeviceType).toBeNull();
    expect(request.connectedTargetName).toBeNull();
  });
});

describe("StepReview — a refused flash stays refused", () => {
  const REFUSAL = {
    port: "/dev/ttyUSB0",
    target: "RADIOMASTER_RANGER_2400",
  };

  it("refuses the second click instead of re-running the flash", () => {
    const html = render({ lastIdentity: NANO_TX, refusal: REFUSAL });

    expect(startDisabled(html)).toBe(true);
    expect(html).toContain(BLOCKED);
    expect(html).toContain("wizard.review.identityBlocked");
    // Belt and braces: the handler refuses even if the control is reached.
    captured.onClick?.();
    expect(wizardState.startFlash).not.toHaveBeenCalled();
  });

  it("lifts it once a device is connected again", () => {
    // A live handshake is better evidence than a remembered refusal — including
    // when the user really did swap the hardware on that port.
    const html = render({
      device: NANO_TX,
      lastIdentity: NANO_TX,
      refusal: REFUSAL,
    });

    expect(startDisabled(html)).toBe(false);
    expect(html).not.toContain(BLOCKED);
  });

  it("lifts it once another model is selected", () => {
    const html = render({
      lastIdentity: NANO_TX,
      refusal: REFUSAL,
      modelId: "radiomaster-ranger-nano-2400",
    });

    expect(startDisabled(html)).toBe(false);
    expect(html).not.toContain(BLOCKED);
  });

  it("lifts it once another port is selected", () => {
    const html = render({
      lastIdentity: NANO_TX,
      refusal: REFUSAL,
      selectedPort: "/dev/ttyACM0",
    });

    expect(startDisabled(html)).toBe(false);
    expect(html).not.toContain(BLOCKED);
  });
});
