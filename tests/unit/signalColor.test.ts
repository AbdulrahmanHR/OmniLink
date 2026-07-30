import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNAL_RAMP,
  LQ_DOMAIN_PCT,
  RSSI_DOMAIN_DBM,
  interpolateHex,
  rampColor,
  signalColor,
  signalQualityFraction,
} from "@/components/map/signal-color";

describe("signalQualityFraction", () => {
  it("maps RSSI across its domain to [0,1]", () => {
    expect(signalQualityFraction(RSSI_DOMAIN_DBM.worst, "rssi")).toBe(0);
    expect(signalQualityFraction(RSSI_DOMAIN_DBM.best, "rssi")).toBe(1);
    const mid = (RSSI_DOMAIN_DBM.worst + RSSI_DOMAIN_DBM.best) / 2; // -80 dBm
    expect(signalQualityFraction(mid, "rssi")).toBeCloseTo(0.5, 5);
  });

  it("maps link quality (0–100 %) to [0,1]", () => {
    expect(signalQualityFraction(LQ_DOMAIN_PCT.worst, "lq")).toBe(0);
    expect(signalQualityFraction(LQ_DOMAIN_PCT.best, "lq")).toBe(1);
    expect(signalQualityFraction(50, "lq")).toBeCloseTo(0.5, 5);
  });

  it("clamps values outside the domain", () => {
    expect(signalQualityFraction(-200, "rssi")).toBe(0); // worse than floor
    expect(signalQualityFraction(0, "rssi")).toBe(1); // better than ceiling
    expect(signalQualityFraction(150, "lq")).toBe(1);
    expect(signalQualityFraction(-10, "lq")).toBe(0);
  });
});

describe("interpolateHex", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(interpolateHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(interpolateHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("interpolates linearly in sRGB", () => {
    expect(interpolateHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(interpolateHex("#ff0000", "#0000ff", 0.5)).toBe("#800080");
  });

  it("clamps t to [0,1]", () => {
    expect(interpolateHex("#000000", "#ffffff", -1)).toBe("#000000");
    expect(interpolateHex("#000000", "#ffffff", 2)).toBe("#ffffff");
  });
});

describe("rampColor", () => {
  it("hits the first and last ramp stops at the extremes", () => {
    expect(rampColor(0)).toBe(DEFAULT_SIGNAL_RAMP[0]);
    expect(rampColor(1)).toBe(DEFAULT_SIGNAL_RAMP[DEFAULT_SIGNAL_RAMP.length - 1]);
  });

  it("lands exactly on an interior stop at the matching fraction", () => {
    // 5 stops → stop index 2 sits at fraction 0.5.
    expect(rampColor(0.5)).toBe(DEFAULT_SIGNAL_RAMP[2]);
  });

  it("supports a custom ramp", () => {
    const ramp = ["#000000", "#ffffff"];
    expect(rampColor(0, ramp)).toBe("#000000");
    expect(rampColor(1, ramp)).toBe("#ffffff");
    expect(rampColor(0.5, ramp)).toBe("#808080");
  });

  it("returns the only stop for a single-stop ramp", () => {
    expect(rampColor(0.7, ["#123456"])).toBe("#123456");
  });
});

describe("signalColor", () => {
  it("colours a strong RSSI near the best stop and a weak one near the worst", () => {
    expect(signalColor(RSSI_DOMAIN_DBM.best, "rssi")).toBe(
      DEFAULT_SIGNAL_RAMP[DEFAULT_SIGNAL_RAMP.length - 1]
    );
    expect(signalColor(RSSI_DOMAIN_DBM.worst, "rssi")).toBe(
      DEFAULT_SIGNAL_RAMP[0]
    );
  });

  it("colours link quality independently of RSSI", () => {
    expect(signalColor(100, "lq")).toBe(
      DEFAULT_SIGNAL_RAMP[DEFAULT_SIGNAL_RAMP.length - 1]
    );
    expect(signalColor(0, "lq")).toBe(DEFAULT_SIGNAL_RAMP[0]);
  });
});
