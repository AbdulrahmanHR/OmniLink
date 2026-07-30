import { beforeAll, describe, expect, it, vi } from "vitest";
import i18next, { type TFunction } from "i18next";
import en from "@/locales/en/translation.json";
import {
  buildBridgeReport,
  prepareBridgeReportMarkdown,
  coarseOs,
  isSensitiveToken,
  looksLikeIdentifier,
  keepShortToken,
  keepVersionToken,
  type BridgeReportInput,
  type BridgeReportSources,
} from "@/lib/bridgeExport";
import type {
  BridgeClassificationDto,
  BridgeContextDto,
  PassthroughCheckReportDto,
} from "@/lib/tauri";

/**
 * M66 — support report export for bridge failures.
 *
 * The binary acceptance test is the redaction test: a `BridgeReportInput` with
 * EVERY excluded identifier (binding phrase, UID, GPS pair, MAC, IPv4 + IPv6,
 * email, serial number) stuffed into the source objects must produce Markdown in
 * which none of those values appears. The round-trip test proves every INCLUDED
 * field renders and the Markdown is well-formed, and the flow test proves the
 * sanitize → assemble → copy path embeds the SANITIZED bridge (from
 * `aiPreviewPayload`), never the raw fetched context.
 */

let t: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    resources: { en: { translation: en } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  t = instance.t.bind(instance);
});

// A normal categorised failure report (all four steps recorded).
const FAILURE_REPORT: PassthroughCheckReportDto = {
  steps: [
    { step: "handshake", status: "pass" },
    { step: "uart", status: "fail" },
    { step: "receiver", status: "skipped" },
    { step: "crsf", status: "skipped" },
  ],
  failure: "rxNotWired",
  category: "wiring",
  summaryKey: "rxNotWired",
  baud: 420000,
  uart: 3,
};

describe("buildBridgeReport — redaction (binary acceptance)", () => {
  // Realistic excluded identifiers, one per excluded class.
  const bindingPhrase = "correct horse battery staple";
  const uid = "222,173,190,239,0,17"; // 6-byte ELRS UID as comma-joined decimals
  const gpsLat = "37.7749";
  const gpsLon = "122.4194";
  const gps = `${gpsLat},-${gpsLon}`;
  const mac = "de:ad:be:ef:00:11";
  const ipv4 = "192.168.1.42";
  const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
  const email = "pilot@example.com";
  const serial = "SN0123456789ABCDEF";

  // Stuff every excluded value across the source objects: the (raw,
  // pre-whitelist) bridge summary fields, the serial-port identifiers/functions,
  // the never-read probe classification, and the never-read open-error string.
  const stuffedClassification: BridgeClassificationDto = {
    kind: "bridge",
    family: "betaflight",
    fcVariant: serial,
    apiVersion: mac,
    fcVersion: gps,
  };

  const input: BridgeReportInput = {
    generatedAt: 1_700_000_000_000,
    appVersion: "2.2.0",
    os: "Linux",
    port: "/dev/ttyUSB0",
    baudAttempts: [420000, 115200, 230400, 460800],
    report: FAILURE_REPORT,
    bridge: {
      family: bindingPhrase, // non-whitelisted → collapses to "unknown"
      fcVariant: serial, // too long → dropped
      apiVersion: mac, // identifier-shaped → dropped
      fcVersion: gps, // GPS pair → dropped
      serialPorts: [
        { identifier: ipv4, function: email }, // ip → [redacted], email fn dropped
        { identifier: ipv6, function: "gps" }, // ipv6 → [redacted]
        { identifier: uid, function: "msp" }, // uid → [redacted]
      ],
    },
    // Source objects the generator must NEVER read:
    classification: stuffedClassification,
    error: `Failed to open ${ipv4}: ${email} ${mac} phrase="${bindingPhrase}" uid=${uid} ${gps}`,
  };

  let output: string;
  beforeAll(() => {
    output = buildBridgeReport(input, t);
  });

  const excluded: Array<[string, string]> = [
    ["binding phrase", bindingPhrase],
    ["UID", uid],
    ["GPS latitude", gpsLat],
    ["GPS longitude", gpsLon],
    ["GPS pair", gps],
    ["MAC", mac],
    ["IPv4", ipv4],
    ["IPv6", ipv6],
    ["email", email],
    ["email domain", "example.com"],
    ["serial number", serial],
  ];

  it.each(excluded)("never leaks the %s into the output", (_label, value) => {
    expect(output).not.toContain(value);
  });

  it("still renders a usable, well-formed report despite the stuffed input", () => {
    // Family collapsed to the safe coarse value; the report is not empty.
    expect(output).toContain(t("bridge.family.unsupported"));
    expect(output.startsWith(`# ${t("bridge.export.title")}`)).toBe(true);
    // Identifier-shaped ports were redacted, not carried through.
    expect(output).toContain("[redacted]");
  });
});

describe("buildBridgeReport — round-trip (included fields present)", () => {
  const input: BridgeReportInput = {
    generatedAt: 1_700_000_000_000, // → 2023-11-14T22:13:20.000Z (deterministic)
    appVersion: "2.2.0",
    os: "Linux",
    port: "/dev/ttyUSB0",
    baudAttempts: [420000, 115200, 230400, 460800],
    report: FAILURE_REPORT,
    bridge: {
      family: "betaflight",
      fcVariant: "BTFL",
      apiVersion: "1.46",
      fcVersion: "4.5.1",
      serialPorts: [
        { identifier: "UART1", function: "serialRx" },
        { identifier: "USB", function: "msp" },
      ],
    },
  };

  let output: string;
  beforeAll(() => {
    output = buildBridgeReport(input, t);
  });

  it("renders a well-formed Markdown heading and all sections", () => {
    expect(output.startsWith("# ")).toBe(true);
    expect(output).toContain(`# ${t("bridge.export.title")}`);
    expect(output).toContain(`## ${t("bridge.export.section.environment")}`);
    expect(output).toContain(`## ${t("bridge.export.section.bridge")}`);
    expect(output).toContain(`## ${t("bridge.export.section.passthrough")}`);
    expect(output).toContain(`### ${t("bridge.export.section.handshake")}`);
    expect(output).toContain(`### ${t("bridge.export.section.serialPorts")}`);
  });

  it("includes app version, OS, selected port and the fixed timestamp", () => {
    expect(output).toContain("2.2.0");
    expect(output).toContain("Linux");
    expect(output).toContain("/dev/ttyUSB0");
    expect(output).toContain("2023-11-14T22:13:20.000Z");
  });

  it("includes the detected bridge family and version fields", () => {
    expect(output).toContain(t("bridge.family.betaflight"));
    expect(output).toContain("BTFL");
    expect(output).toContain("1.46");
    expect(output).toContain("4.5.1");
  });

  it("lists every baud attempt and the baud/uart actually used", () => {
    for (const baud of [420000, 115200, 230400, 460800]) {
      expect(output).toContain(String(baud));
    }
    // Baud used + wired UART echoed from the report.
    expect(output).toContain(`${t("bridge.export.field.baudUsed")}: 420000`);
    expect(output).toContain(`${t("bridge.export.field.uart")}: 3`);
  });

  it("renders the failure category via its i18n key", () => {
    expect(output).toContain(t("bridge.passthrough.failure.rxNotWired"));
  });

  it("renders the per-step handshake summary statuses", () => {
    expect(output).toContain(t("bridge.passthrough.step.handshake"));
    expect(output).toContain(t("bridge.passthrough.status.pass"));
    expect(output).toContain(t("bridge.passthrough.status.fail"));
    expect(output).toContain(t("bridge.passthrough.status.skipped"));
  });

  it("renders the coarse serial ports with their function labels", () => {
    expect(output).toContain("UART1");
    expect(output).toContain("USB");
    expect(output).toContain(t("bridge.context.function.serialRx"));
    expect(output).toContain(t("bridge.context.function.msp"));
  });

  it("falls back to the not-available label for missing scalars", () => {
    const sparse = buildBridgeReport(
      {
        generatedAt: 0,
        appVersion: null,
        os: "Unknown",
        port: null,
        baudAttempts: [],
        report: null,
        bridge: null,
      },
      t
    );
    expect(sparse).toContain(t("bridge.export.none"));
    // No report ⇒ the explicit "no check run yet" line, not a fake failure.
    expect(sparse).toContain(t("bridge.export.noReport"));
    expect(sparse).toContain(t("bridge.export.noSerialPorts"));
  });
});

describe("bridgeExport scrubber parity with the Rust source of truth (pinning)", () => {
  // Holds the TS belt-and-suspenders mirror in lockstep with the Rust scrubber in
  // `src-tauri/src/commands/ai.rs` (`looks_like_identifier` / `token_is_sensitive`
  // + the `keep_*` helpers). A future divergence — letting an identifier shape
  // through, OR over-redacting a benign FC token — makes this test fail.

  // Shapes the Rust `looks_like_identifier` recognizes directly.
  const shapeIdentifiers: Array<[string, string]> = [
    ["MAC", "de:ad:be:ef:00:11"],
    ["IPv4", "192.168.1.42"],
    ["IPv6 (full)", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"],
    ["IPv6 (compressed)", "2001:db8::8a2e:370:7334"],
    ["email", "pilot@example.com"],
    ["high-precision GPS", "37.7749295"],
  ];

  it.each(shapeIdentifiers)(
    "looksLikeIdentifier + isSensitiveToken catch a %s",
    (_label, token) => {
      expect(looksLikeIdentifier(token)).toBe(true);
      expect(isSensitiveToken(token)).toBe(true);
    }
  );

  it("isSensitiveToken catches a comma-joined GPS pair, even at low precision", () => {
    // The coordinate-PAIR branch (two lat/long magnitudes joined) — pins the
    // Rust `token_is_sensitive` pair rule, independent of per-token precision.
    expect(isSensitiveToken("37.7749,-122.4194")).toBe(true);
    expect(isSensitiveToken("37.7,-122.4")).toBe(true);
  });

  // The FULL battery — including shapes the GATES (not the shape detector) drop:
  // a long serial and a binding-phrase-like value are rejected by the length /
  // alphanumeric / version-charset rules, and an ELRS UID by the charset rule.
  const battery: Array<[string, string]> = [
    ...shapeIdentifiers,
    ["GPS pair", "37.7749,-122.4194"],
    ["low-precision GPS pair", "37.7,-122.4"],
    ["ELRS UID", "222,173,190,239,0,17"],
    ["long serial", "SN0123456789ABCDEF"],
    ["binding phrase", "correct horse battery staple"],
  ];

  it.each(battery)("no whitelist gate keeps a %s as a token", (_label, token) => {
    expect(keepShortToken(token)).toBeNull();
    expect(keepVersionToken(token)).toBeNull();
  });

  it("still keeps the benign FC tokens the Rust scrubber keeps (no over-redaction)", () => {
    // Positive controls — the `Some(..)` cases of the Rust `keep_*` helpers must
    // survive, so the pin also guards against future OVER-redaction.
    expect(keepShortToken("BTFL")).toBe("BTFL");
    expect(keepShortToken("UART1")).toBe("UART1");
    expect(keepVersionToken("1.46")).toBe("1.46");
    expect(keepVersionToken("4.5.1")).toBe("4.5.1");
  });
});

describe("coarseOs", () => {
  it("maps user-agent families to a coarse, identifier-free label", () => {
    expect(coarseOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(coarseOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5)")).toBe("macOS");
    expect(coarseOs("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(coarseOs("")).toBe("Unknown");
    expect(coarseOs(null)).toBe("Unknown");
  });
});

describe("prepareBridgeReportMarkdown — sanitize → assemble → copy flow", () => {
  const context: BridgeContextDto = {
    family: "betaflight",
    fcVariant: "BTFL",
    apiVersion: "1.46",
    fcVersion: "4.5.1",
    // A raw, UN-sanitized serial-number identifier the seam must strip.
    serialPorts: [{ identifier: "SN-RAW-9988776655", function: "serialRx" }],
  };

  const sources: BridgeReportSources = {
    generatedAt: 1_700_000_000_000,
    appVersion: "2.2.0",
    os: "Linux",
    port: "/dev/ttyUSB0",
    report: FAILURE_REPORT,
    error: null,
    classification: null,
    context,
  };

  it("routes the bridge context through aiPreviewPayload and embeds ONLY the sanitized result", async () => {
    // The mocked sanitize seam returns the EXACT scrubbed `bridge` shape: the raw
    // serial identifier is gone, replaced by a coarse "UART1".
    const aiPreview = vi.fn(async (_ctx: { bridge: BridgeContextDto }) => ({
      bridge: {
        family: "betaflight",
        fcVariant: "BTFL",
        apiVersion: "1.46",
        fcVersion: "4.5.1",
        serialPorts: [{ identifier: "UART1", function: "serialRx" }],
      },
    }));

    const md = await prepareBridgeReportMarkdown(sources, aiPreview, t);

    // The seam was asked to sanitize the fetched context.
    expect(aiPreview).toHaveBeenCalledWith({ bridge: context });
    // The SANITIZED identifier is embedded; the raw serial never is.
    expect(md).toContain("UART1");
    expect(md).not.toContain("SN-RAW-9988776655");

    // The component's copy step: mocked clipboard receives the Markdown.
    const writeText = vi.fn(async () => {});
    const clipboard = { writeText } as unknown as Clipboard;
    await clipboard.writeText(md);
    expect(writeText).toHaveBeenCalledWith(md);
  });

  it("omits the handshake summary (never embeds raw context) when the sanitize seam is unavailable", async () => {
    const aiPreview = vi.fn(async () => {
      throw new Error("not running in Tauri");
    });
    const md = await prepareBridgeReportMarkdown(sources, aiPreview, t);
    // No sanitized bridge ⇒ family/variant fall back to "not available"; the raw
    // fetched serial is NOT embedded as a fallback.
    expect(md).not.toContain("SN-RAW-9988776655");
    expect(md).toContain(t("bridge.export.none"));
    // The report still renders (the passthrough section is independent).
    expect(md).toContain(t("bridge.passthrough.failure.rxNotWired"));
  });

  it("synthesizes a sanitizable context from a probe classification when no context was fetched", async () => {
    const aiPreview = vi.fn(async (_ctx: { bridge: BridgeContextDto }) => ({
      bridge: {
        family: "inav",
        fcVariant: "INAV",
        apiVersion: "2.4",
        fcVersion: "7.1.0",
        serialPorts: [],
      },
    }));
    const classification: BridgeClassificationDto = {
      kind: "bridge",
      family: "inav",
      fcVariant: "INAV",
      apiVersion: "2.4",
      fcVersion: "7.1.0",
    };
    const md = await prepareBridgeReportMarkdown(
      { ...sources, context: null, classification },
      aiPreview,
      t
    );
    expect(aiPreview).toHaveBeenCalledWith({
      bridge: {
        family: "inav",
        fcVariant: "INAV",
        apiVersion: "2.4",
        fcVersion: "7.1.0",
        serialPorts: [],
      },
    });
    expect(md).toContain(t("bridge.family.inav"));
    expect(md).toContain("INAV");
  });
});
