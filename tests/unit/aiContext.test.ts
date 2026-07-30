import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_MODELS,
  aggregateTelemetry,
  buildAiContext,
} from "@/lib/aiContext";
import type { TelemetryFrame } from "@/stores/telemetry";
import type { DeviceInfo } from "@/stores/device";

function frame(over: Partial<TelemetryFrame>): TelemetryFrame {
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

describe("provider registry (FR-AI-08, Decision #6)", () => {
  it("exposes all BYOK providers with a default model + base URL", () => {
    expect(PROVIDER_IDS).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "openrouter",
      "ollama",
    ]);
    for (const id of PROVIDER_IDS) {
      const cfg = PROVIDERS[id];
      expect(cfg.models.length).toBeGreaterThan(0);
      expect(cfg.defaultBaseUrl).toMatch(/^https?:\/\//);
      expect(PROVIDER_MODELS[id]).toBe(cfg.models);
    }
  });

  it("marks Anthropic as its own adapter kind and Ollama as key-less", () => {
    expect(PROVIDERS.anthropic.kind).toBe("anthropic");
    expect(PROVIDERS.openai.kind).toBe("openai-compat");
    expect(PROVIDERS.ollama.requiresKey).toBe(false);
    expect(PROVIDERS.openai.requiresKey).toBe(true);
  });
});

describe("aggregateTelemetry (FR-AI-07)", () => {
  it("returns undefined for an empty buffer", () => {
    expect(aggregateTelemetry([])).toBeUndefined();
  });

  it("computes averages, minima, and failsafe count from frames", () => {
    const stats = aggregateTelemetry([
      frame({ linkQuality: 100, rssi1: -70, rssi2: -85, snr: 10 }),
      frame({ linkQuality: 80, rssi1: -90, rssi2: -88, snr: 6 }),
      frame({ linkQuality: 0, rssi1: -110, rssi2: -112, snr: -2 }),
    ]);
    expect(stats).toBeDefined();
    expect(stats!.sampleCount).toBe(3);
    expect(stats!.minLinkQuality).toBe(0);
    // Best-antenna RSSI is the least-negative of the pair: -70, -88, -110.
    expect(stats!.minRssi).toBe(-110);
    expect(stats!.failsafeCount).toBe(1); // the 0% LQ frame
  });
});

describe("buildAiContext (FR-AI-02)", () => {
  const device: DeviceInfo = {
    targetName: "Jumper AION Nano 2400 TX",
    firmwareVersion: "3.5.3",
    deviceType: "TX",
    port: "/dev/ttyUSB0",
  };

  it("gathers only target/version/type + aggregated telemetry", () => {
    const ctx = buildAiContext(device, [frame({})]);
    expect(ctx.targetName).toBe("Jumper AION Nano 2400 TX");
    expect(ctx.firmwareVersion).toBe("3.5.3");
    expect(ctx.deviceType).toBe("TX");
    expect(ctx.telemetry).toBeDefined();
    // The serial port path is device-local and must not be carried into context.
    expect(JSON.stringify(ctx)).not.toContain("/dev/ttyUSB0");
  });

  it("omits empty userDefines and handles a disconnected device", () => {
    const ctx = buildAiContext(null, []);
    expect(ctx.targetName).toBeUndefined();
    expect(ctx.userDefines).toBeUndefined();
    expect(ctx.telemetry).toBeUndefined();
  });
});

describe("buildAiContext retrievedDocs (M50)", () => {
  const device: DeviceInfo = {
    targetName: "Jumper AION Nano 2400 TX",
    firmwareVersion: "3.5.3",
    deviceType: "TX",
    port: "/dev/ttyUSB0",
  };
  const docs = [
    {
      sourceId: "elrs-binding",
      sourceTitle: "ExpressLRS — Binding",
      chunkId: "elrs-binding#2",
      excerpt: "A binding phrase is hashed into a unique link identity.",
    },
  ];

  it("threads retrieved docs into the gathered context when non-empty", () => {
    const ctx = buildAiContext(device, [frame({})], undefined, null, null, docs);
    expect(ctx.retrievedDocs).toHaveLength(1);
    expect(ctx.retrievedDocs?.[0].chunkId).toBe("elrs-binding#2");
    // The device serial path still never rides along.
    expect(JSON.stringify(ctx)).not.toContain("/dev/ttyUSB0");
  });

  it("omits retrievedDocs when absent or empty", () => {
    expect(buildAiContext(device, []).retrievedDocs).toBeUndefined();
    expect(
      buildAiContext(device, [], undefined, null, null, []).retrievedDocs,
    ).toBeUndefined();
  });
});
