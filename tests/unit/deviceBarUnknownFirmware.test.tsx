import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceInfo } from "@/stores/device";

/**
 * FWCHK: an absent firmware version must not be rendered as a concrete one.
 *
 * Betaflight's `crsfFrameDeviceInfo` answers a CRSF Device Ping — on exactly the
 * RX↔FC UART this app's own probe-failure text tells the user to wire up — with
 * an all-zero serial/hardware/firmware triple. The backend used to format that
 * word unconditionally, so the bar announced a fabricated `v0.0.0` as fact. The
 * DTO now carries `null`, and the bar labels it the same way it already labels
 * an unclassifiable `deviceType`.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const deviceState = vi.hoisted(() => ({
  status: "connected" as string,
  device: null as DeviceInfo | null,
  error: null as string | null,
  ports: [{ path: "/dev/ttyUSB0", product: "CP2102 USB UART" }],
  selectedPort: "/dev/ttyUSB0" as string | null,
  isConnected: true,
  isConnecting: false,
  setSelectedPort: () => {},
  refreshPorts: () => {},
  connect: () => {},
  disconnect: () => {},
}));

vi.mock("@/hooks", () => ({
  useDevice: () => deviceState,
  useSerialPortBusyReasonKey: () => null,
}));
vi.mock("@/stores", () => ({
  useWifiStore: (selector: (s: { discovered: unknown[] }) => unknown) =>
    selector({ discovered: [] }),
}));
vi.mock("@/components/notifications", () => ({ NotificationBell: () => null }));
vi.mock("@/components/bridge/BridgeProbeControl", () => ({
  BridgeProbeControl: () => null,
}));
vi.mock("@/components/config/BackpackConfigForm", () => ({
  BackpackConfigForm: () => null,
}));

import { DeviceBar } from "@/components/layout/DeviceBar";

function render(firmwareVersion: string | null): string {
  deviceState.device = {
    targetName: "ELRS Device",
    firmwareVersion,
    deviceType: null,
    port: "/dev/ttyUSB0",
    baud: 420_000,
    paramCount: 12,
    serialNumber: 0,
    hardwareVersion: 0,
  };
  return renderToStaticMarkup(<DeviceBar />);
}

describe("DeviceBar firmware version", () => {
  it("labels an unreported firmware version instead of inventing one", () => {
    const html = render(null);

    expect(html).toContain("device.firmwareUnknown");
    // Nothing that reads as a version — not a bare "v", not a zero version.
    expect(html).not.toContain("0.0.0");
    expect(html).not.toMatch(/>v</);
  });

  it("still renders a reported version verbatim", () => {
    const html = render("3.5.3");

    expect(html).toContain("v3.5.3");
    expect(html).not.toContain("device.firmwareUnknown");
  });

  it("keeps a genuine 0.x.y version, which is not the absent case", () => {
    expect(render("0.5.1")).toContain("v0.5.1");
  });
});
