import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRecoveryProfile,
  fileNameFromPath,
  isWizardStepValid,
  useWizardStore,
} from "@/stores/wizard";
import type { DeviceInfo } from "@/stores/device";

/** Base frequency-step selections with no firmware source chosen. */
const freqBase = {
  brandId: "b",
  modelId: "m",
  domain: "ISM2400",
  firmwareVersion: null,
  flashMethod: "uart",
  useTraditionalBinding: false,
  bindingPhrase: "",
  deviceIp: "10.0.0.1",
  localFirmwarePath: null,
  localFirmwareName: null,
} as const;

const device: DeviceInfo = {
  targetName: "BETAFPV_2400_TX",
  firmwareVersion: "3.5.3",
  deviceType: "TX",
  port: "/dev/ttyUSB0",
  baud: 420000,
  paramCount: 0,
  serialNumber: 0,
  hardwareVersion: 0,
};

describe("fileNameFromPath", () => {
  it("extracts the basename from POSIX and Windows paths", () => {
    expect(fileNameFromPath("/home/user/fw/firmware.bin")).toBe("firmware.bin");
    expect(fileNameFromPath("C:\\Users\\me\\fw.bin")).toBe("fw.bin");
    expect(fileNameFromPath("firmware.bin")).toBe("firmware.bin");
    // Degenerate input falls back to the original string.
    expect(fileNameFromPath("")).toBe("");
  });
});

describe("buildRecoveryProfile", () => {
  it("builds a recovery DTO from the device identity + supplied name", () => {
    const dto = buildRecoveryProfile(device, 1_700_000_000_000, "backup name");
    expect(dto.id).toBe("preflash-backup-BETAFPV_2400_TX-1700000000000");
    expect(dto.name).toBe("backup name");
    expect(dto.updatedAt).toBe(1_700_000_000_000);
    // A sane neutral settings baseline is recorded.
    expect(dto.settings.packetRate).toBe(250);
    expect(dto.settings.switchMode).toBe("Hybrid");
  });

  it("sanitizes the target name so the id is filesystem-safe", () => {
    const evil = { ...device, targetName: "BAD/NAME ..x" };
    const dto = buildRecoveryProfile(evil, 1, "n");
    expect(dto.id).not.toContain("/");
    expect(dto.id).not.toContain(" ");
    expect(dto.id.startsWith("preflash-backup-")).toBe(true);
  });
});

describe("isWizardStepValid — local-file firmware source (M25)", () => {
  it("requires a firmware source: a release version OR a local file", () => {
    // Neither chosen -> invalid.
    expect(isWizardStepValid(freqBase, "frequency")).toBe(false);
    // Release version chosen -> valid.
    expect(
      isWizardStepValid({ ...freqBase, firmwareVersion: "3.5.3" }, "frequency")
    ).toBe(true);
    // Local file chosen (no version) -> valid.
    expect(
      isWizardStepValid(
        {
          ...freqBase,
          localFirmwarePath: "/tmp/fw.bin",
          localFirmwareName: "fw.bin",
        },
        "frequency"
      )
    ).toBe(true);
  });

  it("still enforces the WiFi device IP alongside a local file", () => {
    expect(
      isWizardStepValid(
        {
          ...freqBase,
          flashMethod: "wifi",
          deviceIp: "",
          localFirmwarePath: "/tmp/fw.bin",
          localFirmwareName: "fw.bin",
        },
        "frequency"
      )
    ).toBe(false);
  });
});

describe("wizard store — local-file selection state (M25)", () => {
  beforeEach(() => {
    useWizardStore.getState().reset();
  });

  it("picking a local file sets the path + name and clears the release version", () => {
    const store = useWizardStore.getState();
    store.selectFirmware("3.5.3");
    expect(useWizardStore.getState().firmwareVersion).toBe("3.5.3");

    store.selectLocalFirmware("/a/b/local-firmware.bin");
    const s = useWizardStore.getState();
    expect(s.localFirmwarePath).toBe("/a/b/local-firmware.bin");
    expect(s.localFirmwareName).toBe("local-firmware.bin");
    // Mutually exclusive: the release version is cleared.
    expect(s.firmwareVersion).toBeNull();
  });

  it("picking a release version clears a previously selected local file", () => {
    const store = useWizardStore.getState();
    store.selectLocalFirmware("/a/b/fw.bin");
    store.selectFirmware("3.4.3");
    const s = useWizardStore.getState();
    expect(s.firmwareVersion).toBe("3.4.3");
    expect(s.localFirmwarePath).toBeNull();
    expect(s.localFirmwareName).toBeNull();
  });

  it("clearing the local file (null) resets both fields", () => {
    const store = useWizardStore.getState();
    store.selectLocalFirmware("/a/b/fw.bin");
    store.selectLocalFirmware(null);
    const s = useWizardStore.getState();
    expect(s.localFirmwarePath).toBeNull();
    expect(s.localFirmwareName).toBeNull();
  });

  it("changing model clears the local-file source", () => {
    const store = useWizardStore.getState();
    store.selectBrand("betafpv");
    store.selectModel("betafpv-nano-tx-2400");
    store.selectLocalFirmware("/a/b/fw.bin");
    store.selectModel("betafpv-micro-tx-1w-2400");
    const s = useWizardStore.getState();
    expect(s.localFirmwarePath).toBeNull();
    expect(s.localFirmwareName).toBeNull();
  });
});
