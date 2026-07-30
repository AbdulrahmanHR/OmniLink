import { describe, expect, it } from "vitest";
import {
  classifyElrsSsid,
  ssidToDevice,
  mdnsRecordToDevice,
  isElrsMdnsRecord,
  wifiSourceLabelKey,
  type WifiDevice,
  type MdnsRecord,
} from "@/lib/wifiDiscovery";

describe("classifyElrsSsid", () => {
  it("accepts ExpressLRS TX/RX self-AP SSIDs with the correct role", () => {
    expect(classifyElrsSsid("ExpressLRS TX")).toEqual({ isElrs: true, kind: "tx" });
    expect(classifyElrsSsid("ExpressLRS RX")).toEqual({ isElrs: true, kind: "rx" });
    expect(classifyElrsSsid("ExpressLRS RX 01")).toEqual({ isElrs: true, kind: "rx" });
  });

  it("is case-insensitive", () => {
    expect(classifyElrsSsid("expresslrs tx")).toEqual({ isElrs: true, kind: "tx" });
  });

  it("is whitespace-tolerant (collapses runs of whitespace)", () => {
    expect(classifyElrsSsid("ExpressLRS  TX")).toEqual({ isElrs: true, kind: "tx" });
  });

  // M19 BOUNDARY: Backpack/VRX SSIDs must be hard-rejected here — they belong
  // to the M19 Backpack scanner, not the M18 self-AP scanner.
  it("rejects all Backpack/VRX SSIDs (M19 boundary), even with a TX/RX token", () => {
    expect(classifyElrsSsid("ExpressLRS TX Backpack")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("ExpressLRS VRX Backpack")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("ExpressLRS VRX")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("ExpressLRS RX Backpack")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("expresslrs vrx backpack")).toEqual({ isElrs: false, kind: "unknown" });
  });

  it("rejects unrelated, empty, and role-less SSIDs", () => {
    expect(classifyElrsSsid("MyHomeWiFi")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("ExpressLRS")).toEqual({ isElrs: false, kind: "unknown" });
  });

  // M29 hardening: the role match is whole-word, so noise tokens that merely
  // CONTAIN "tx"/"rx" ("TXT", "RXD") are NOT a role and the SSID is not claimed.
  // A substring match would mis-classify these as a real ELRS self-AP.
  it("does not treat 'TXT'/'RXD' noise as a TX/RX role (whole-word only)", () => {
    expect(classifyElrsSsid("ExpressLRS TXT")).toEqual({ isElrs: false, kind: "unknown" });
    expect(classifyElrsSsid("ExpressLRS RXD")).toEqual({ isElrs: false, kind: "unknown" });
    // A trailing-glued token ("TX1", no separator) is likewise not a role.
    expect(classifyElrsSsid("ExpressLRS TX1")).toEqual({ isElrs: false, kind: "unknown" });
  });
});

describe("ssidToDevice", () => {
  it("maps an ELRS self-AP SSID to a source:'ap' device at 10.0.0.1", () => {
    const device = ssidToDevice("ExpressLRS TX");
    expect(device).toEqual<WifiDevice>({
      id: "ap:ExpressLRS TX",
      name: "ExpressLRS TX",
      address: "10.0.0.1",
      source: "ap",
      kind: "tx",
    });
  });

  it("keys the id on the raw SSID and infers the RX role", () => {
    const device = ssidToDevice("ExpressLRS RX 01");
    expect(device).toEqual<WifiDevice>({
      id: "ap:ExpressLRS RX 01",
      name: "ExpressLRS RX 01",
      address: "10.0.0.1",
      source: "ap",
      kind: "rx",
    });
  });

  it("returns null for a Backpack/VRX SSID (M19 boundary)", () => {
    expect(ssidToDevice("ExpressLRS TX Backpack")).toBeNull();
    expect(ssidToDevice("ExpressLRS VRX")).toBeNull();
  });

  it("returns null for a non-ELRS SSID", () => {
    expect(ssidToDevice("MyHomeWiFi")).toBeNull();
  });
});

describe("mdnsRecordToDevice", () => {
  it("picks the first IPv4 over IPv6 and keys the id on it", () => {
    const rec: MdnsRecord = {
      instanceName: "ExpressLRS TX",
      host: "elrs.local",
      addresses: ["fe80::1", "192.168.1.50"],
      port: 80,
    };
    expect(mdnsRecordToDevice(rec)).toEqual<WifiDevice>({
      id: "mdns:192.168.1.50",
      name: "ExpressLRS TX",
      address: "192.168.1.50",
      source: "mdns",
      kind: "tx",
    });
  });

  it("falls back to host when the record carries no IPv4", () => {
    const rec: MdnsRecord = {
      instanceName: "ExpressLRS RX",
      host: "elrs-rx.local",
      addresses: ["fe80::1", "::1"],
      port: 80,
    };
    expect(mdnsRecordToDevice(rec)).toEqual<WifiDevice>({
      id: "mdns:elrs-rx.local",
      name: "ExpressLRS RX",
      address: "elrs-rx.local",
      source: "mdns",
      kind: "rx",
    });
  });

  it("strips a single trailing dot from the host fallback", () => {
    const rec: MdnsRecord = {
      instanceName: "ExpressLRS RX",
      host: "elrs-rx.local.",
      addresses: ["fe80::1"],
      port: 80,
    };
    // The mDNS host's trailing dot is stripped so the address is a clean host.
    expect(mdnsRecordToDevice(rec)).toEqual<WifiDevice>({
      id: "mdns:elrs-rx.local",
      name: "ExpressLRS RX",
      address: "elrs-rx.local",
      source: "mdns",
      kind: "rx",
    });
  });

  it("falls back to host when the address set is empty", () => {
    const rec: MdnsRecord = {
      instanceName: "ExpressLRS RX",
      host: "elrs-rx.local",
      addresses: [],
      port: 80,
    };
    expect(mdnsRecordToDevice(rec).address).toBe("elrs-rx.local");
  });

  it("infers kind 'unknown' for an ambiguous instance name", () => {
    const rec: MdnsRecord = {
      instanceName: "ExpressLRS Device",
      host: "elrs.local",
      addresses: ["10.1.2.3"],
      port: 80,
    };
    expect(mdnsRecordToDevice(rec)).toEqual<WifiDevice>({
      id: "mdns:10.1.2.3",
      name: "ExpressLRS Device",
      address: "10.1.2.3",
      source: "mdns",
      kind: "unknown",
    });
  });
});

describe("isElrsMdnsRecord", () => {
  const rec = (instanceName: string, host = "host.local"): MdnsRecord => ({
    instanceName,
    host,
    addresses: ["192.168.1.50"],
    port: 80,
  });

  it("accepts records whose instance name marks an ELRS device", () => {
    // "ExpressLRS …" style instance name.
    expect(isElrsMdnsRecord(rec("ExpressLRS RX._http._tcp.local"))).toBe(true);
    // bare "elrs" token (NOT a substring of "expresslrs" — both are tested).
    expect(isElrsMdnsRecord(rec("elrs_rx"))).toBe(true);
  });

  it("accepts when only the host carries the ELRS marker", () => {
    expect(isElrsMdnsRecord(rec("node", "elrs-tx.local."))).toBe(true);
  });

  it("rejects generic LAN services (printers/Chromecasts/NAS) and empty", () => {
    expect(isElrsMdnsRecord(rec("Brother HL-2270DW"))).toBe(false);
    expect(isElrsMdnsRecord(rec("Chromecast"))).toBe(false);
    expect(isElrsMdnsRecord(rec("My NAS"))).toBe(false);
    expect(isElrsMdnsRecord(rec("", ""))).toBe(false);
  });
});

describe("wifiSourceLabelKey", () => {
  it("maps each source to its i18n key", () => {
    expect(wifiSourceLabelKey("ap")).toBe("wifi.source.ap");
    expect(wifiSourceLabelKey("mdns")).toBe("wifi.source.mdns");
  });
});
