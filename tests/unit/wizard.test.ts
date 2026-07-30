import { describe, expect, it } from "vitest";
import {
  furthestReachableIndex,
  isValidDeviceIp,
  isWizardStepValid,
  WIZARD_STEPS,
} from "@/stores/wizard";

const empty = {
  brandId: null,
  modelId: null,
  domain: null,
  firmwareVersion: null,
  flashMethod: null,
  useTraditionalBinding: false,
  bindingPhrase: "",
  deviceIp: "10.0.0.1",
  localFirmwarePath: null,
  localFirmwareName: null,
} as const;

describe("isWizardStepValid", () => {
  it("gates each step on its required selections", () => {
    expect(isWizardStepValid(empty, "brand")).toBe(false);
    expect(isWizardStepValid({ ...empty, brandId: "b" }, "brand")).toBe(true);
    expect(isWizardStepValid({ ...empty, modelId: "m" }, "model")).toBe(true);
    expect(
      isWizardStepValid(
        { ...empty, domain: "ISM2400", firmwareVersion: "3.5.3", flashMethod: "wifi" },
        "frequency"
      )
    ).toBe(true);
  });

  it("accepts binding via phrase or traditional", () => {
    expect(isWizardStepValid(empty, "binding")).toBe(false);
    expect(isWizardStepValid({ ...empty, bindingPhrase: "  " }, "binding")).toBe(false);
    expect(isWizardStepValid({ ...empty, bindingPhrase: "hi" }, "binding")).toBe(true);
    expect(isWizardStepValid({ ...empty, useTraditionalBinding: true }, "binding")).toBe(true);
  });

  it("review is always valid", () => {
    expect(isWizardStepValid(empty, "review")).toBe(true);
  });

  it("requires a valid device IP for the WiFi method (FR-FLASH-09)", () => {
    const base = {
      ...empty,
      domain: "ISM2400" as const,
      firmwareVersion: "3.5.3",
    };
    // Non-WiFi methods don't need an IP.
    expect(
      isWizardStepValid({ ...base, flashMethod: "uart" }, "frequency")
    ).toBe(true);
    // WiFi with a valid IP is fine.
    expect(
      isWizardStepValid(
        { ...base, flashMethod: "wifi", deviceIp: "10.0.0.1" },
        "frequency"
      )
    ).toBe(true);
    // WiFi with an empty/invalid IP is gated.
    expect(
      isWizardStepValid(
        { ...base, flashMethod: "wifi", deviceIp: "" },
        "frequency"
      )
    ).toBe(false);
    expect(
      isWizardStepValid(
        { ...base, flashMethod: "wifi", deviceIp: "999.1.1.1" },
        "frequency"
      )
    ).toBe(false);
  });
});

describe("isValidDeviceIp", () => {
  it("accepts dotted-quad IPv4 and hostnames, rejects junk", () => {
    expect(isValidDeviceIp("10.0.0.1")).toBe(true);
    expect(isValidDeviceIp("192.168.1.255")).toBe(true);
    expect(isValidDeviceIp("elrs_tx.local")).toBe(false); // underscore not allowed
    expect(isValidDeviceIp("elrs-tx.local")).toBe(true);
    expect(isValidDeviceIp("")).toBe(false);
    expect(isValidDeviceIp("256.0.0.1")).toBe(false);
    expect(isValidDeviceIp("10.0.0")).toBe(false);
    expect(isValidDeviceIp("not a host!")).toBe(false);
  });
});

describe("furthestReachableIndex", () => {
  it("returns the first incomplete step index", () => {
    expect(furthestReachableIndex(empty)).toBe(0);
    expect(furthestReachableIndex({ ...empty, brandId: "b" })).toBe(1);
  });

  it("returns the last step when all selections are complete", () => {
    expect(
      furthestReachableIndex({
        brandId: "b",
        modelId: "m",
        domain: "ISM2400",
        firmwareVersion: "3.5.3",
        flashMethod: "wifi",
        useTraditionalBinding: true,
        bindingPhrase: "",
        deviceIp: "10.0.0.1",
        localFirmwarePath: null,
        localFirmwareName: null,
      })
    ).toBe(WIZARD_STEPS.length - 1);
  });
});
