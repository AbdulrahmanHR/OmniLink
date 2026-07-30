import { describe, expect, it } from "vitest";
import { diffProfiles } from "@/lib/profileDiff";
import { SETTING_FIELDS, type ProfileSettings } from "@/lib/profileSettings";

const base: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: false,
  modelId: 0,
  bindingPhrase: "omni-default",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

describe("diffProfiles", () => {
  it("reports identical when both sides match", () => {
    const result = diffProfiles(base, { ...base });
    expect(result.identical).toBe(true);
    expect(result.changeCount).toBe(0);
    expect(result.rows.every((r) => r.status === "unchanged")).toBe(true);
  });

  it("emits one row per known field in canonical order", () => {
    const result = diffProfiles(base, base);
    expect(result.rows.map((r) => r.key)).toEqual(
      SETTING_FIELDS.map((f) => f.key)
    );
  });

  it("counts changed fields and flips identical", () => {
    const result = diffProfiles(base, {
      ...base,
      packetRate: 500,
      txPower: 250,
    });
    expect(result.identical).toBe(false);
    expect(result.changeCount).toBe(2);
    const changed = result.rows.filter((r) => r.status === "changed");
    expect(changed.map((r) => r.key).sort()).toEqual(["packetRate", "txPower"]);
  });

  it("classifies added and removed for partial inputs", () => {
    const result = diffProfiles({ packetRate: 250 }, { packetRate: 250, txPower: 25 });
    const tx = result.rows.find((r) => r.key === "txPower");
    const rate = result.rows.find((r) => r.key === "packetRate");
    expect(tx?.status).toBe("added");
    expect(rate?.status).toBe("unchanged");
  });
});
