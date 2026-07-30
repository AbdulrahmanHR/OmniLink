import { describe, expect, it } from "vitest";
import {
  selectAiContext,
  type DiagnosticsAiContext,
  type WizardTargetSelection,
} from "@/lib/aiContext";
import type { TelemetryFrame } from "@/stores/telemetry";
import type { DeviceInfo } from "@/stores/device";
import type { BridgeContextDto } from "@/lib/tauri";

function frame(over: Partial<TelemetryFrame> = {}): TelemetryFrame {
  return {
    t: 0,
    rssi1: -70,
    rssi2: -80,
    linkQuality: 100,
    snr: 9,
    txPower: 100,
    packetRate: 500,
    antennas: [],
    ...over,
  };
}

const device: DeviceInfo = {
  targetName: "Jumper AION Nano 2400 TX",
  firmwareVersion: "3.5.3",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 12,
  serialNumber: 1,
  hardwareVersion: 1,
};

const wizard: WizardTargetSelection = {
  brandName: "RadioMaster",
  modelName: "Ranger",
  target: "RADIOMASTER_RANGER_2400",
  deviceType: "TX",
  firmwareVersion: "3.4.0",
  frequency: "2.4 GHz",
};

describe("selectAiContext (M23)", () => {
  it("auto: device identity wins but keeps wizard brand/model + telemetry", () => {
    const ctx = selectAiContext("auto", device, [frame()], wizard);
    expect(ctx.targetName).toBe(device.targetName);
    expect(ctx.firmwareVersion).toBe(device.firmwareVersion);
    expect(ctx.userDefines?.wizardBrand).toBe("RadioMaster");
    expect(ctx.telemetry).toBeDefined();
  });

  it("device: device + telemetry only, no wizard target data", () => {
    const ctx = selectAiContext("device", device, [frame()], wizard);
    expect(ctx.targetName).toBe(device.targetName);
    expect(ctx.userDefines).toBeUndefined();
    expect(ctx.telemetry).toBeDefined();
  });

  it("wizard: wizard target only, no device identity and no telemetry", () => {
    const ctx = selectAiContext("wizard", device, [frame()], wizard);
    expect(ctx.targetName).toBe(wizard.target);
    expect(ctx.deviceType).toBe(wizard.deviceType);
    expect(ctx.userDefines?.wizardModel).toBe("Ranger");
    // Telemetry is device-bound, so wizard mode sends none.
    expect(ctx.telemetry).toBeUndefined();
  });

  it("offline: sends no device, telemetry, or wizard context at all", () => {
    const ctx = selectAiContext("offline", device, [frame()], wizard);
    expect(ctx.targetName).toBeUndefined();
    expect(ctx.firmwareVersion).toBeUndefined();
    expect(ctx.deviceType).toBeUndefined();
    expect(ctx.userDefines).toBeUndefined();
    expect(ctx.telemetry).toBeUndefined();
    // Nothing device-local leaks regardless of inputs.
    expect(JSON.stringify(ctx)).not.toContain("Jumper");
    expect(JSON.stringify(ctx)).not.toContain("RadioMaster");
  });
});

// M65: the optional READ-ONLY controller-bridge context folds into the assembled
// AI payload when present (the actual redaction happens backend-side in Rust
// `sanitize_context()`; here we only verify the frontend attaches it).
const bridge: BridgeContextDto = {
  family: "betaflight",
  fcVariant: "BTFL",
  apiVersion: "1.46",
  fcVersion: "4.5.1",
  serialPorts: [
    { identifier: "UART1", function: "msp" },
    { identifier: "UART2", function: "serialRx" },
  ],
};

describe("selectAiContext bridge folding (M65)", () => {
  it("includes the bridge context in the payload when present (auto)", () => {
    const ctx = selectAiContext("auto", device, [frame()], wizard, bridge);
    expect(ctx.bridge).toEqual(bridge);
    expect(ctx.bridge?.serialPorts[1].function).toBe("serialRx");
  });

  it("includes the bridge context in device and wizard modes", () => {
    expect(selectAiContext("device", device, [frame()], wizard, bridge).bridge).toEqual(
      bridge
    );
    expect(selectAiContext("wizard", device, [frame()], wizard, bridge).bridge).toEqual(
      bridge
    );
  });

  it("omits the bridge context entirely in offline mode", () => {
    const ctx = selectAiContext("offline", device, [frame()], wizard, bridge);
    expect(ctx.bridge).toBeUndefined();
    expect(JSON.stringify(ctx)).not.toContain("BTFL");
  });

  it("omits the bridge key when no bridge context is provided", () => {
    const ctx = selectAiContext("auto", device, [frame()], wizard);
    expect(ctx.bridge).toBeUndefined();
  });
});

// M50: retrieved RAG docs are trusted-pack grounding, orthogonal to the device
// context mode — they thread through in EVERY mode (offline mode IS the offline
// knowledge-base path). The authoritative redaction is Rust `sanitize_context()`.
const retrievedDocs = [
  {
    sourceId: "elrs-packet-rates",
    sourceTitle: "ExpressLRS — Packet Rates",
    chunkId: "elrs-packet-rates#3",
    excerpt: "The telemetry ratio controls how often telemetry is sent.",
  },
];

describe("selectAiContext retrievedDocs threading (M50)", () => {
  it("includes retrieved docs in every mode, including offline", () => {
    for (const mode of ["auto", "device", "wizard", "offline"] as const) {
      const ctx = selectAiContext(mode, device, [frame()], wizard, null, retrievedDocs);
      expect(ctx.retrievedDocs, `mode=${mode}`).toHaveLength(1);
      expect(ctx.retrievedDocs?.[0].sourceId).toBe("elrs-packet-rates");
    }
  });

  it("offline sends the retrieved docs but still no device/telemetry/wizard data", () => {
    const ctx = selectAiContext("offline", device, [frame()], wizard, null, retrievedDocs);
    expect(ctx.retrievedDocs).toHaveLength(1);
    expect(ctx.targetName).toBeUndefined();
    expect(ctx.telemetry).toBeUndefined();
    expect(ctx.userDefines).toBeUndefined();
    // Device/wizard identity never leaks even while grounding docs are attached.
    expect(JSON.stringify(ctx)).not.toContain("Jumper");
    expect(JSON.stringify(ctx)).not.toContain("RadioMaster");
  });

  it("omits retrievedDocs entirely when none are supplied", () => {
    const ctx = selectAiContext("auto", device, [frame()], wizard);
    expect(ctx.retrievedDocs).toBeUndefined();
  });
});

// M39a: the diagnostics aggregate is explicit user-requested evidence (an "explain
// this finding"/"ask about this session" action), orthogonal to the device context
// mode — so, like the retrieved docs, it threads through in EVERY mode, INCLUDING
// offline. The authoritative redaction is Rust `sanitize_context()`.
const diagnostics: DiagnosticsAiContext = {
  scope: "finding",
  findings: [
    {
      ruleId: "lq-collapse",
      category: "link",
      severity: "critical",
      confidence: 0.9,
      startSec: 12.4,
      endSec: 15,
      detail: { from: 95, to: 8 },
    },
  ],
  patterns: [],
};

describe("selectAiContext diagnostics threading (M39a)", () => {
  it("includes the diagnostics aggregate in every mode, including offline", () => {
    for (const mode of ["auto", "device", "wizard", "offline"] as const) {
      const ctx = selectAiContext(mode, device, [frame()], wizard, null, null, diagnostics);
      expect(ctx.diagnostics, `mode=${mode}`).toBeDefined();
      expect(ctx.diagnostics?.scope, `mode=${mode}`).toBe("finding");
      expect(ctx.diagnostics?.findings[0].ruleId, `mode=${mode}`).toBe("lq-collapse");
    }
  });

  it("offline carries the diagnostics but still no device/telemetry/wizard data", () => {
    const ctx = selectAiContext("offline", device, [frame()], wizard, null, null, diagnostics);
    expect(ctx.diagnostics).toBeDefined();
    // The existing offline "no device data" contract is unchanged.
    expect(ctx.targetName).toBeUndefined();
    expect(ctx.firmwareVersion).toBeUndefined();
    expect(ctx.deviceType).toBeUndefined();
    expect(ctx.telemetry).toBeUndefined();
    expect(ctx.userDefines).toBeUndefined();
    // No device/wizard identity leaks even while the diagnostic evidence rides along.
    expect(JSON.stringify(ctx)).not.toContain("Jumper");
    expect(JSON.stringify(ctx)).not.toContain("RadioMaster");
  });

  it("omits the diagnostics key entirely when none is supplied", () => {
    const ctx = selectAiContext("auto", device, [frame()], wizard);
    expect(ctx.diagnostics).toBeUndefined();
  });
});
