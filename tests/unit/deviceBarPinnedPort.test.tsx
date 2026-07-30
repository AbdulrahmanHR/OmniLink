import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CONN-10 (bar half): a pinned port selection SURVIVES its path disappearing —
 * the store no longer re-points it at `ports[0]` when a just-flashed board drops
 * off the bus while it re-enumerates. The bar therefore has to render a path
 * that is not in the enumeration, and must not offer to Connect to it: the
 * picker showing a blank row (with Connect live) would be worse than the
 * substitution it replaces.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.port ? `${key}:${String(opts.port)}` : key,
  }),
}));

const deviceState = vi.hoisted(() => ({
  status: "disconnected" as string,
  device: null,
  error: null as string | null,
  ports: [] as { path: string; product?: string | null }[],
  selectedPort: null as string | null,
  isConnected: false,
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
vi.mock("@/components/config/BackpackConfigForm", () => ({
  BackpackConfigForm: () => null,
}));
vi.mock("@/components/bridge/BridgeProbeControl", () => ({
  BridgeProbeControl: () => null,
}));

import { DeviceBar } from "@/components/layout/DeviceBar";

const ACM0 = { path: "/dev/ttyACM0", product: "Flight controller" };
const USB0 = { path: "/dev/ttyUSB0", product: "CP2102 USB UART" };
const CONNECT = 'aria-label="device.connect"';

function render(
  ports: { path: string; product?: string | null }[],
  selectedPort: string | null
): string {
  Object.assign(deviceState, { ports, selectedPort });
  return renderToStaticMarkup(<DeviceBar />);
}

/** The opening tag of the element carrying `marker`. */
function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<", at);
  return html.slice(open, html.indexOf(">", at));
}

function isDisabled(tag: string): boolean {
  return /\sdisabled=""/.test(tag);
}

describe("DeviceBar — a pinned port that is not present", () => {
  it("names the absent path in the picker instead of leaving it blank", () => {
    // The ELRS RX on /dev/ttyUSB0 was just flashed and is re-enumerating; the
    // FC on /dev/ttyACM0 is the only port the OS reports.
    const html = render([ACM0], USB0.path);

    expect(html).toContain(`device.portMissing:${USB0.path}`);
    // …and the other device is NOT presented as the selection.
    expect(html).toContain(`value="${USB0.path}"`);
  });

  it("refuses to Connect to a port that is not there", () => {
    const html = render([ACM0], USB0.path);

    expect(isDisabled(tagOf(html, CONNECT))).toBe(true);
  });

  it("re-enables Connect the moment the board comes back", () => {
    const html = render([ACM0, USB0], USB0.path);

    expect(isDisabled(tagOf(html, CONNECT))).toBe(false);
    expect(html).not.toContain("device.portMissing");
  });

  it("still shows the empty state when nothing is plugged in or selected", () => {
    const html = render([], null);

    expect(html).toContain("device.noPorts");
    expect(isDisabled(tagOf(html, CONNECT))).toBe(true);
  });

  it("keeps the pinned path visible even when no ports are enumerated", () => {
    const html = render([], USB0.path);

    expect(html).toContain(`device.portMissing:${USB0.path}`);
    expect(isDisabled(tagOf(html, CONNECT))).toBe(true);
  });
});
