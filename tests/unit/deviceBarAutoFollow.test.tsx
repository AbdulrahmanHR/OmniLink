import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * CONN-10 (bar half, second pass): the picker had no control that releases a
 * pinned port, and Connect had no tooltip for the one reason it is most often
 * inert.
 *
 * `setSelectedPort(null)` is what hands the selection back to hotplug
 * auto-follow, and the only option that emitted it was the "Select a port"
 * placeholder — rendered ONLY while nothing is selected, so unreachable the
 * moment anything is. And Connect's `title` was set for `portBusyKey` alone: an
 * absent pinned path (or nothing selected at all) disabled the button with no
 * explanation beyond the "(not connected)" suffix inside the closed picker.
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
  portPinned: false,
  isConnected: false,
  isConnecting: false,
  setSelectedPort: () => {},
  refreshPorts: () => {},
  connect: () => {},
  disconnect: () => {},
}));

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
vi.mock("@/components/bridge/BridgeProbeControl", () => ({
  BridgeProbeControl: () => null,
}));

import { DeviceBar } from "@/components/layout/DeviceBar";

const ACM0 = { path: "/dev/ttyACM0", product: "Flight controller" };
const USB0 = { path: "/dev/ttyUSB0", product: "CP2102 USB UART" };
const CONNECT = 'aria-label="device.connect"';
const AUTO = "device.autoSelectPort";

function render(state: Partial<typeof deviceState>): string {
  Object.assign(deviceState, {
    ports: [],
    selectedPort: null,
    portPinned: false,
    ...state,
  });
  return renderToStaticMarkup(<DeviceBar />);
}

/** The opening tag of the element carrying `marker`. */
function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf("<", at);
  return html.slice(open, html.indexOf(">", at));
}

beforeEach(() => {
  busy.key = null;
});

describe("DeviceBar — releasing a pinned port", () => {
  it("offers the auto-follow option once a pin exists", () => {
    const html = render({
      ports: [ACM0, USB0],
      selectedPort: USB0.path,
      portPinned: true,
    });

    expect(html).toContain(AUTO);
    // It is the option that emits the empty value `setSelectedPort` reads as
    // null — the same channel the placeholder used, now reachable.
    expect(html).toContain(`<option value="">${AUTO}</option>`);
  });

  it("does not offer it while the selection is already the default", () => {
    const html = render({ ports: [ACM0], selectedPort: ACM0.path });

    expect(html).not.toContain(AUTO);
  });

  it("offers it even while the pinned path is absent", () => {
    // The just-flashed board is re-enumerating: this is exactly when the user
    // is most likely to want the picker to follow whatever is actually there.
    const html = render({
      ports: [ACM0],
      selectedPort: USB0.path,
      portPinned: true,
    });

    expect(html).toContain(AUTO);
    expect(html).toContain(`device.portMissing:${USB0.path}`);
  });
});

describe("DeviceBar — why Connect is inert", () => {
  it("names the absent port", () => {
    const html = render({
      ports: [ACM0],
      selectedPort: USB0.path,
      portPinned: true,
    });

    expect(tagOf(html, CONNECT)).toContain(
      `title="device.connectPortAbsent:${USB0.path}"`
    );
  });

  it("asks for a port when nothing is selected", () => {
    const html = render({ ports: [], selectedPort: null });

    expect(tagOf(html, CONNECT)).toContain('title="device.connectNoPort"');
  });

  it("still lets a busy-port reason win", () => {
    // A bridge operation holding the port is the more actionable explanation,
    // and the one already rendered next to the bridge chip.
    busy.key = "device.portBusy.probe";
    const html = render({ ports: [ACM0], selectedPort: ACM0.path });

    expect(tagOf(html, CONNECT)).toContain('title="device.portBusy.probe"');
  });

  it("carries no tooltip when Connect actually works", () => {
    const html = render({ ports: [ACM0], selectedPort: ACM0.path });

    expect(tagOf(html, CONNECT)).not.toContain("title=");
  });
});
