/**
 * M66 — Support report export for bridge failures (v2.2 "Controller Bridge Mode").
 *
 * A PURE, deterministic, paste-friendly **Markdown** generator that mirrors the
 * v2.0 diagnostic-summary export shape ({@link import("@/components/diagnostics/util").buildDiagnosticSummary}):
 * an identifier-free text builder that takes a `t` and joins `\n`-separated
 * lines. No clock and no randomness live here — the caller injects the
 * timestamp, so the same input always produces byte-identical output.
 *
 * PRIVACY MODEL (two independent layers, defense-in-depth):
 *  1. The bridge/CRSF/MSP handshake summary is routed through the Rust
 *     `sanitize_context()` baseline by the caller (via `aiPreviewPayload`), so a
 *     serial number / UID / MAC / IP / email / GPS pair is already scrubbed
 *     before it reaches {@link buildBridgeReport}.
 *  2. This module is **whitelist-only**: it reads ONLY the allowed fields and
 *     re-validates every value it emits through the SAME shape discipline the
 *     Rust sanitizer uses ({@link keepShortToken} / {@link keepVersionToken} /
 *     {@link keepPortFunction} / {@link keepFamily}, all gated by
 *     {@link looksLikeIdentifier}). Raw diagnostic source objects it carries but
 *     never reads — the probe {@link BridgeClassificationDto} and the raw open
 *     error string — can hold anything and still never leak.
 *
 * Excluded fields (binding phrase, UID, GPS, MAC/IP/email, serial numbers) are
 * therefore absent from the output by construction; the redaction test is the
 * binary acceptance gate.
 */

import {
  PASSTHROUGH_BAUDS,
  PASSTHROUGH_STEPS,
  bridgeFamilyLabelKey,
  bridgePortFunctionLabelKey,
  passthroughFailureLabelKey,
  passthroughStepLabelKey,
  passthroughStepStatus,
} from "@/lib/bridge";
import type {
  BridgeClassificationDto,
  BridgeContextDto,
  BridgeFamilyDto,
  PassthroughCheckReportDto,
} from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Whitelist constants (mirror the Rust `sanitize_context()` baseline in
// `commands/ai.rs`, so the TS defense layer drops exactly what Rust drops).
// ---------------------------------------------------------------------------

/** Coarse FC-bridge families; anything else collapses to `"unknown"`. */
const KNOWN_BRIDGE_FAMILIES: readonly string[] = ["betaflight", "inav", "unknown"];
/** Coarse serial-port function labels; anything else ⇒ `null`. */
const KNOWN_PORT_FUNCTIONS: readonly string[] = [
  "serialRx",
  "msp",
  "gps",
  "telemetry",
  "blackbox",
];
/** Max FC variant / serial-port identifier token length. */
const BRIDGE_ID_MAX_LEN = 12;
/** Max version token length. */
const BRIDGE_VERSION_MAX_LEN = 16;
/** Max serial ports rendered (a real FC has far fewer). */
const MAX_BRIDGE_SERIAL_PORTS = 16;
/** Placeholder substituted for an identifier-shaped value. */
const REDACTED = "[redacted]";

// ---------------------------------------------------------------------------
// SOURCE OF TRUTH — Rust `src-tauri/src/commands/ai.rs`:
//   `looks_like_identifier` + `is_ipv6` + `is_coordinate` + `token_is_sensitive`,
//   and the field-level `keep_short_token` / `keep_version_token` /
//   `keep_port_function` helpers (mirrored below as `keepShortToken` etc.).
//
// The functions below are an INTENTIONAL belt-and-suspenders MIRROR of those Rust
// heuristics — NOT a substitute. Data reaching `buildBridgeReport` is ALREADY
// scrubbed by the Rust `sanitize_context()` (via `aiPreviewPayload`); this second,
// independent layer re-validates every emitted value so the pure builder is safe
// on its own. The two layers MUST stay in lockstep: the parity/pinning test in
// `tests/unit/bridgeExport.test.ts` feeds a battery of identifier shapes through
// these helpers so a future divergence from the Rust source of truth fails CI.
//
// Identifier-shape detection (a focused TS port of the Rust `looks_like_*`
// helpers), so the whitelist drops a stuffed MAC / IPv4 / IPv6 / email / GPS
// pair BEFORE the coarse short-token / version-token checks see it. Without
// this, an IPv4 ("192.168.1.42") would pass the version-token char set.
// ---------------------------------------------------------------------------

/** Strip leading/trailing non-alphanumerics so shape checks see the bare value. */
function stripPunctuation(s: string): string {
  return s.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}

/** A dotted decimal in lat/long magnitude range (for coordinate-pair detection). */
function isCoordinate(token: string): boolean {
  const cleaned = stripPunctuation(token);
  if (!cleaned.includes(".")) return false;
  const n = Number(cleaned);
  return Number.isFinite(n) && Math.abs(n) <= 180;
}

/**
 * Shape-based detector for MAC / IPv4 / IPv6 / email / high-precision GPS tokens.
 * Exported for the parity/pinning test that holds it in lockstep with the Rust
 * `looks_like_identifier` in `commands/ai.rs`.
 */
export function looksLikeIdentifier(token: string): boolean {
  if (!token) return false;
  // Email: '@' with a '.' after it.
  const at = token.indexOf("@");
  if (at >= 0 && token.slice(at + 1).includes(".")) return true;
  // MAC: six colon/dash-separated hex pairs.
  const macParts = token.split(/[:-]/);
  if (
    macParts.length === 6 &&
    macParts.every((p) => p.length === 2 && /^[0-9a-fA-F]{2}$/.test(p))
  ) {
    return true;
  }
  // IPv4: four dot-separated 0..=255 octets.
  const octets = token.split(".");
  if (
    octets.length === 4 &&
    octets.every((o) => o.length > 0 && /^\d+$/.test(o) && Number(o) <= 255)
  ) {
    return true;
  }
  // IPv6: hex groups joined by ':' with "::" compression or ≥3 colons.
  if (isIpv6(token)) return true;
  // GPS-ish: a long signed decimal with ≥4 fractional digits in lat/long range.
  if (token.includes(".")) {
    const n = Number(token);
    if (Number.isFinite(n)) {
      const frac = token.split(".")[1] ?? "";
      if (frac.length >= 4 && Math.abs(n) <= 180) return true;
    }
  }
  return false;
}

/** IPv6 shape: colon-separated 1–4 hex groups, with "::" or ≥3 colons. */
function isIpv6(token: string): boolean {
  if (!token.includes(":")) return false;
  const colons = (token.match(/:/g) ?? []).length;
  if (!token.includes("::") && colons < 3) return false;
  const groups = token.split(":").filter((g) => g.length > 0);
  return (
    groups.length > 0 && groups.every((g) => g.length <= 4 && /^[0-9a-fA-F]+$/.test(g))
  );
}

/**
 * True when a token packs an identifier, or is a comma/semicolon-joined GPS pair.
 * Exported for the parity/pinning test (mirror of the Rust `token_is_sensitive`).
 */
export function isSensitiveToken(token: string): boolean {
  const parts = token
    .split(/[,;]/)
    .map(stripPunctuation)
    .filter((p) => p.length > 0);
  if (parts.some(looksLikeIdentifier)) return true;
  return parts.length >= 2 && parts.filter(isCoordinate).length >= 2;
}

// ---------------------------------------------------------------------------
// Field-level whitelist validators (mirror the Rust `keep_*` helpers).
// ---------------------------------------------------------------------------

/**
 * Keep a value ONLY if it is a short, benign alphanumeric token (`"BTFL"`/`"UART1"`).
 * Exported for the parity/pinning test (mirror of the Rust `keep_short_token`).
 */
export function keepShortToken(
  value: string | null | undefined,
  max = BRIDGE_ID_MAX_LEN
): string | null {
  if (value == null) return null;
  const token = value.trim();
  if (token.length === 0 || [...token].length > max) return null;
  if (isSensitiveToken(token)) return null;
  return /^[A-Za-z0-9]+$/.test(token) ? token : null;
}

/**
 * Keep a value ONLY if it looks like a dotted version number (`"1.46"`/`"4.5.1"`).
 * Exported for the parity/pinning test (mirror of the Rust `keep_version_token`).
 */
export function keepVersionToken(
  value: string | null | undefined,
  max = BRIDGE_VERSION_MAX_LEN
): string | null {
  if (value == null) return null;
  const token = value.trim();
  if (token.length === 0 || [...token].length > max) return null;
  if (isSensitiveToken(token)) return null;
  return /^[0-9][0-9._-]*$/.test(token) ? token : null;
}

/** Whitelist a coarse serial-port function to the known set; anything else ⇒ null. */
function keepPortFunction(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = value.trim();
  return KNOWN_PORT_FUNCTIONS.find((k) => k.toLowerCase() === v.toLowerCase()) ?? null;
}

/** Whitelist a coarse family; anything outside the known set collapses to "unknown". */
function keepFamily(value: string | null | undefined): BridgeFamilyDto {
  const v = (value ?? "").trim().toLowerCase();
  return (KNOWN_BRIDGE_FAMILIES.includes(v) ? v : "unknown") as BridgeFamilyDto;
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/** One coarse serial port in the sanitized handshake summary. */
export interface SanitizedSerialPort {
  identifier: string;
  function: string | null;
}

/**
 * The sanitized CRSF/MSP handshake summary — the EXACT `bridge` shape returned
 * by `aiPreviewPayload` (already scrubbed by Rust `sanitize_context()`). The
 * generator re-validates every field through the whitelist before emitting it.
 */
export interface SanitizedBridgeSummary {
  family: string;
  fcVariant: string | null;
  apiVersion: string | null;
  fcVersion: string | null;
  serialPorts: SanitizedSerialPort[];
}

/**
 * The complete, deterministic input to {@link buildBridgeReport}. WHITELIST-ONLY:
 * the generator emits the included fields and re-validates the {@link bridge}
 * summary; the `classification` and `error` source objects are carried for an
 * honest record but are deliberately NEVER read (so a stuffed identifier in them
 * cannot leak — proven by the redaction test).
 */
export interface BridgeReportInput {
  /** Injected wall-clock time (ms) — the generator never reads a clock. */
  generatedAt: number;
  /** App version (`getVersion()`), or null off-Tauri. */
  appVersion: string | null;
  /** Coarse OS label ("Windows"/"macOS"/"Linux"/"Unknown") — no machine ids. */
  os: string;
  /** The selected serial port the check targeted. */
  port: string | null;
  /** Candidate baud rates attempted (the FC fallback set). */
  baudAttempts: readonly number[];
  /** The categorised passthrough check report (steps + failure), or null. */
  report: PassthroughCheckReportDto | null;
  /** SANITIZED handshake summary (from `aiPreviewPayload`); re-validated here. */
  bridge: SanitizedBridgeSummary | null;
  /** Raw probe classification — a SOURCE object the generator never reads. */
  classification?: BridgeClassificationDto | null;
  /** Raw open/invoke error — a SOURCE object the generator never reads. */
  error?: string | null;
}

/** Localizer signature (mirrors {@link buildDiagnosticSummary}). */
export type ReportTFn = (key: string, opts?: Record<string, unknown>) => string;

// ---------------------------------------------------------------------------
// The pure Markdown builder (deliverable 1).
// ---------------------------------------------------------------------------

/** Deterministic UTC ISO timestamp from injected ms (no clock read). */
function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Build the paste-friendly Markdown bridge-failure support report. PURE and
 * deterministic. Emits a heading, an intro, then key-value sections:
 * Environment, Detected controller bridge, Passthrough check (with the
 * handshake step summary and coarse serial ports). Every emitted value is
 * whitelist-validated; excluded identifiers are absent by construction.
 */
export function buildBridgeReport(input: BridgeReportInput, t: ReportTFn): string {
  const NA = t("bridge.export.none");
  const lines: string[] = [];

  // Heading + intro.
  lines.push(`# ${t("bridge.export.title")}`);
  lines.push("");
  lines.push(t("bridge.export.intro"));
  lines.push("");

  // Environment.
  lines.push(`## ${t("bridge.export.section.environment")}`);
  lines.push("");
  lines.push(`- ${t("bridge.export.field.generatedAt")}: ${formatTimestamp(input.generatedAt)}`);
  lines.push(`- ${t("bridge.export.field.appVersion")}: ${input.appVersion ?? NA}`);
  lines.push(`- ${t("bridge.export.field.os")}: ${input.os || NA}`);
  lines.push(`- ${t("bridge.export.field.port")}: ${input.port ?? NA}`);
  lines.push("");

  // Detected controller bridge — whitelist-validated from the sanitized summary.
  lines.push(`## ${t("bridge.export.section.bridge")}`);
  lines.push("");
  const summary = input.bridge;
  const family = summary ? keepFamily(summary.family) : null;
  const fcVariant = summary ? keepShortToken(summary.fcVariant) : null;
  const apiVersion = summary ? keepVersionToken(summary.apiVersion) : null;
  const fcVersion = summary ? keepVersionToken(summary.fcVersion) : null;
  lines.push(
    `- ${t("bridge.export.field.family")}: ${family ? t(bridgeFamilyLabelKey(family)) : NA}`
  );
  lines.push(`- ${t("bridge.export.field.fcVariant")}: ${fcVariant ?? NA}`);
  lines.push(`- ${t("bridge.export.field.apiVersion")}: ${apiVersion ?? NA}`);
  lines.push(`- ${t("bridge.export.field.fcVersion")}: ${fcVersion ?? NA}`);
  lines.push("");

  // Passthrough check.
  const report = input.report;
  lines.push(`## ${t("bridge.export.section.passthrough")}`);
  lines.push("");
  lines.push(
    `- ${t("bridge.export.field.baudAttempts")}: ${
      input.baudAttempts.length > 0 ? input.baudAttempts.join(", ") : NA
    }`
  );
  lines.push(`- ${t("bridge.export.field.baudUsed")}: ${report?.baud ?? NA}`);
  lines.push(`- ${t("bridge.export.field.uart")}: ${report?.uart ?? NA}`);
  let failure: string;
  if (!report) failure = t("bridge.export.noReport");
  else if (report.failure === null) failure = t("bridge.export.noFailure");
  else failure = t(passthroughFailureLabelKey(report.failure));
  lines.push(`- ${t("bridge.export.field.failure")}: ${failure}`);
  lines.push("");

  // Handshake summary — the per-step outcomes (enums → localized copy).
  lines.push(`### ${t("bridge.export.section.handshake")}`);
  lines.push("");
  for (const step of PASSTHROUGH_STEPS) {
    const status = passthroughStepStatus(report, step);
    lines.push(
      `- ${t(passthroughStepLabelKey(step))}: ${t(`bridge.passthrough.status.${status}`)}`
    );
  }
  lines.push("");

  // Coarse serial ports — identifiers re-validated, functions whitelisted.
  lines.push(`### ${t("bridge.export.section.serialPorts")}`);
  lines.push("");
  const rendered = (summary?.serialPorts ?? [])
    .slice(0, MAX_BRIDGE_SERIAL_PORTS)
    .map((p) => {
      const id = keepShortToken(p.identifier) ?? REDACTED;
      const fnKey = bridgePortFunctionLabelKey(keepPortFunction(p.function));
      return fnKey ? `- ${id} — ${t(fnKey)}` : `- ${id}`;
    });
  if (rendered.length === 0) {
    lines.push(`- ${t("bridge.export.noSerialPorts")}`);
  } else {
    lines.push(...rendered);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration helpers (pure / dependency-injected, so the click flow is
// testable headlessly with a mocked `aiPreviewPayload`). The component injects
// the real seam; bridgeExport stays free of any Tauri import.
// ---------------------------------------------------------------------------

/** Coarse OS label from a user-agent string — NO hostnames, NO machine ids. */
export function coarseOs(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("win")) return "Windows";
  if (ua.includes("mac")) return "macOS";
  if (ua.includes("linux") || ua.includes("x11")) return "Linux";
  return "Unknown";
}

/**
 * Pick the bridge context to sanitize: the fetched read-only context if present,
 * else a minimal context synthesized from a recognized probe classification (so
 * the detected family/version still rides the sanitize path). `null` when there
 * is no bridge data to summarize.
 */
export function bridgeContextFromState(
  context: BridgeContextDto | null,
  classification: BridgeClassificationDto | null
): BridgeContextDto | null {
  if (context) return context;
  if (classification?.kind === "bridge") {
    return {
      family: classification.family,
      fcVariant: classification.fcVariant,
      apiVersion: classification.apiVersion ?? null,
      fcVersion: classification.fcVersion ?? null,
      serialPorts: [],
    };
  }
  return null;
}

/**
 * Extract the sanitized `bridge` summary from an `aiPreviewPayload` result. The
 * payload is the EXACT JSON the Rust `sanitize_context()` emits; we read only its
 * `bridge` key. Returns null when no bridge data is present.
 */
export function extractSanitizedBridge(payload: unknown): SanitizedBridgeSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const bridge = (payload as { bridge?: unknown }).bridge;
  if (!bridge || typeof bridge !== "object") return null;
  const o = bridge as Record<string, unknown>;
  const serialPorts: SanitizedSerialPort[] = Array.isArray(o.serialPorts)
    ? o.serialPorts.map((p) => {
        const pr = (p ?? {}) as Record<string, unknown>;
        return {
          identifier: typeof pr.identifier === "string" ? pr.identifier : "",
          function: typeof pr.function === "string" ? pr.function : null,
        };
      })
    : [];
  return {
    family: typeof o.family === "string" ? o.family : "unknown",
    fcVariant: typeof o.fcVariant === "string" ? o.fcVariant : null,
    apiVersion: typeof o.apiVersion === "string" ? o.apiVersion : null,
    fcVersion: typeof o.fcVersion === "string" ? o.fcVersion : null,
    serialPorts,
  };
}

/** The state snapshot the click handler assembles a report from. */
export interface BridgeReportSources {
  generatedAt: number;
  appVersion: string | null;
  os: string;
  port: string | null;
  report: PassthroughCheckReportDto | null;
  error: string | null;
  classification: BridgeClassificationDto | null;
  context: BridgeContextDto | null;
}

/** The `aiPreviewPayload` seam, injected so the flow is testable off-Tauri. */
export type AiPreviewFn = (context: { bridge: BridgeContextDto }) => Promise<unknown>;

/**
 * Assemble + render the bridge-failure report Markdown: route any bridge/CRSF/MSP
 * context through `sanitize_context()` (via the injected {@link AiPreviewFn}) so
 * identifiers are stripped, then build the whitelist-only report. If the sanitize
 * seam is unavailable (off-Tauri, invoke rejects), the handshake summary is
 * simply omitted — raw fetched context is NEVER embedded.
 */
export async function prepareBridgeReportMarkdown(
  sources: BridgeReportSources,
  aiPreview: AiPreviewFn,
  t: ReportTFn
): Promise<string> {
  const ctxBridge = bridgeContextFromState(sources.context, sources.classification);
  let bridge: SanitizedBridgeSummary | null = null;
  if (ctxBridge) {
    try {
      bridge = extractSanitizedBridge(await aiPreview({ bridge: ctxBridge }));
    } catch {
      // Sanitize seam unavailable — omit the summary rather than embed raw context.
      bridge = null;
    }
  }
  const input: BridgeReportInput = {
    generatedAt: sources.generatedAt,
    appVersion: sources.appVersion,
    os: sources.os,
    port: sources.port,
    baudAttempts: PASSTHROUGH_BAUDS,
    report: sources.report,
    bridge,
    classification: sources.classification,
    error: sources.error,
  };
  return buildBridgeReport(input, t);
}
