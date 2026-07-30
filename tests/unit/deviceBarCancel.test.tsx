import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectionStatus } from "@/stores/device";

/**
 * CONN-7: an in-flight connect could not be cancelled.
 *
 * A full baud sweep is 5 candidate bauds × a 900ms probe window ≈ 4.5s. For all
 * of it the port picker and Connect button are disabled and Disconnect does not
 * render (it is gated on `isConnected`), so a wrong-port attempt could only be
 * waited out — even though the backend has always supported aborting one (the
 * probe loop checks the stop flag, and the silent-stop path suppresses the
 * resulting `device://error`). The bar must offer that abort as a Cancel.
 */

// The component only needs `t` to resolve keys; render the key itself so the
// assertions are about WHICH copy is shown, not about the translation.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Drive the bar through the `useDevice` seam rather than the real store: under
// `renderToStaticMarkup` zustand v5 serves its INITIAL state (the server
// snapshot), so a pre-render `setState` would not be visible.
const deviceState = vi.hoisted(() => ({
  status: "disconnected" as string,
  device: null,
  error: null as string | null,
  ports: [{ path: "/dev/ttyUSB0", product: "CP2102 USB UART" }],
  selectedPort: "/dev/ttyUSB0" as string | null,
  isConnected: false,
  isConnecting: false,
  setSelectedPort: () => {},
  refreshPorts: () => {},
  connect: () => {},
  disconnect: () => {},
}));

vi.mock("@/hooks", () => ({
  useDevice: () => deviceState,
  // No controller-bridge operation is holding the port in this spec — the
  // port-claim lockout has its own (see `deviceBarPortClaim.test.tsx`).
  useSerialPortBusyReasonKey: () => null,
}));
vi.mock("@/stores", () => ({
  useWifiStore: (selector: (s: { discovered: unknown[] }) => unknown) =>
    selector({ discovered: [] }),
}));
// Neighbours of the connection cluster, stubbed: this spec is about the
// connect/cancel controls only.
vi.mock("@/components/notifications", () => ({ NotificationBell: () => null }));
vi.mock("@/components/bridge/BridgeProbeControl", () => ({
  BridgeProbeControl: () => null,
}));
vi.mock("@/components/config/BackpackConfigForm", () => ({
  BackpackConfigForm: () => null,
}));

import { DeviceBar } from "@/components/layout/DeviceBar";

const CANCEL = 'data-testid="device-cancel-connect"';

function render(status: ConnectionStatus): string {
  Object.assign(deviceState, {
    status,
    isConnected: status === "connected",
    isConnecting: status === "connecting",
  });
  return renderToStaticMarkup(<DeviceBar />);
}

describe("DeviceBar connect cancellation", () => {
  it("offers a cancel control while a connect attempt is in flight", () => {
    const html = render("connecting");

    expect(html).toContain(CANCEL);
    expect(html).toContain("common.cancel");
    expect(html).toContain("device.cancelConnect");
    // The in-progress feedback stays — cancelling is offered alongside it.
    expect(html).toContain("device.connecting");
  });

  it("leaves the cancel control enabled (the whole point of CONN-7)", () => {
    const html = render("connecting");
    const attrs = html.slice(html.indexOf(CANCEL));

    expect(attrs.slice(0, attrs.indexOf(">"))).not.toContain("disabled");
  });

  it("shows no cancel control in any state without an attempt in flight", () => {
    for (const status of [
      "disconnected",
      "error",
      "connected",
      "flashing",
      "bootloader",
    ] as const) {
      expect(render(status)).not.toContain(CANCEL);
    }
  });

  it("still shows Disconnect (not Cancel) once connected", () => {
    const html = render("connected");

    expect(html).toContain("device.disconnect");
    expect(html).not.toContain("device.cancelConnect");
  });
});
