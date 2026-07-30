import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * FIX 2A (frontend half): the controller-bridge commands open the serial port
 * directly and hold it — up to ~14s for a passthrough check — while the device
 * status stays "disconnected". `canClaimPort` is therefore blind to them, so the
 * bar kept Connect enabled straight into a busy port, and a status flip to
 * "connecting" UNMOUNTED `BridgeProbeControl` mid-probe, silently discarding the
 * in-flight result while the backend kept the port.
 *
 * The bar must instead: disable Connect with a VISIBLE reason while a bridge
 * operation runs, and keep the probe control mounted for its own operation.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

// The reason key the port-busy hook reports, driven per test.
const busy = vi.hoisted(() => ({ key: null as string | null }));

vi.mock("@/hooks", () => ({
  useDevice: () => deviceState,
  useSerialPortBusyReasonKey: () => busy.key,
}));
vi.mock("@/stores", () => ({
  useWifiStore: (selector: (s: { discovered: unknown[] }) => unknown) =>
    selector({ discovered: [] }),
}));
vi.mock("@/components/notifications", () => ({ NotificationBell: () => null }));
vi.mock("@/components/config/BackpackConfigForm", () => ({
  BackpackConfigForm: () => null,
}));
// Rendered as a marker so the mount/unmount assertions are unambiguous.
vi.mock("@/components/bridge/BridgeProbeControl", () => ({
  BridgeProbeControl: () => <div data-testid="bridge-probe-control" />,
}));

import { DeviceBar } from "@/components/layout/DeviceBar";

const CONNECT = 'aria-label="device.connect"';
const PROBE = 'data-testid="bridge-probe-control"';
const REASON = 'data-testid="device-port-busy"';

function render(status: string, reasonKey: string | null): string {
  Object.assign(deviceState, {
    status,
    isConnected: status === "connected",
    isConnecting: status === "connecting",
  });
  busy.key = reasonKey;
  return renderToStaticMarkup(<DeviceBar />);
}

/** The whole opening tag of the element carrying `marker`. */
function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<", at);
  return html.slice(open, html.indexOf(">", at));
}

/**
 * Whether the tag carries the boolean `disabled` attribute — matched as
 * `disabled=""` so the Tailwind `disabled:*` utility classes in `class` (which
 * are present either way) can never fake a pass.
 */
function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag);
}

describe("DeviceBar port-claim lockout", () => {
  it("disables Connect while a bridge operation holds the port", () => {
    const html = render("disconnected", "device.portBusy.passthrough");

    expect(isDisabled(tagOf(html, CONNECT))).toBe(true);
  });

  it("shows the reason on screen, not only as a tooltip", () => {
    const html = render("disconnected", "device.portBusy.passthrough");

    // Visible text, so a disabled Connect never reads as a broken button.
    expect(html).toContain(REASON);
    expect(html).toContain("device.portBusy.passthrough");
    // …and the same copy is repeated as the button's tooltip.
    expect(tagOf(html, CONNECT)).toContain(
      'title="device.portBusy.passthrough"'
    );
  });

  it("names the specific operation holding the port", () => {
    for (const key of [
      "device.portBusy.probe",
      "device.portBusy.context",
      "device.portBusy.passthrough",
    ]) {
      const html = render("disconnected", key);
      expect(html).toContain(key);
    }
  });

  it("leaves Connect enabled once no bridge operation is running", () => {
    const html = render("disconnected", null);

    expect(isDisabled(tagOf(html, CONNECT))).toBe(false);
    expect(html).not.toContain(REASON);
  });

  it("keeps the probe control mounted while its own operation runs", () => {
    // The regression: flipping to "connecting" (or any non-free status) used to
    // unmount the control mid-probe and throw the in-flight result away.
    for (const status of ["connecting", "connected", "flashing"]) {
      expect(render(status, "device.portBusy.probe")).toContain(PROBE);
    }
  });

  it("still hides the probe control when the port is genuinely ours", () => {
    // No bridge operation in flight + a status that owns the port ⇒ the probe
    // affordance stays gated exactly as CONN-2 requires.
    for (const status of ["connecting", "connected", "flashing", "bootloader"]) {
      expect(render(status, null)).not.toContain(PROBE);
    }
    expect(render("disconnected", null)).toContain(PROBE);
  });
});
