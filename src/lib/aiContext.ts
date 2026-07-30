/**
 * AI context model + provider registry (M9-API, FR-AI-02/07/08).
 *
 * Pure, dependency-free helpers so they are trivially unit-testable and never
 * pull the Tauri bridge into the test runner. The actual `invoke` wrappers live
 * in `src/lib/ai.ts`; the privacy-critical sanitization runs in Rust
 * (`src-tauri/src/commands/ai.rs`) — this module only assembles the *aggregated*
 * shape and mirrors the Rust DTO field names.
 */

import type { DeviceInfo, DeviceType } from "@/stores/device";
import type { TelemetryFrame } from "@/stores/telemetry";
import type { BridgeContextDto } from "@/lib/tauri";
import type { RetrievedDoc } from "@/lib/knowledge/retrieve";
import type { ParsedLog } from "@/lib/blackbox";
import type { DiagnosticExport, DiagnosticFinding } from "@/lib/diagnostics";

/** BYOK provider ids supported in v1.0 (Decision #6 — BYOK only). */
export type AIProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openrouter"
  | "ollama";

/** How a provider's HTTP API is shaped, used by the Rust adapter seam. */
export type ProviderKind = "anthropic" | "openai-compat";

/** Static metadata for each provider (FR-AI-08 seam, mirrors the Rust side). */
export interface ProviderConfig {
  /** OpenAI-compat covers OpenAI/Gemini/OpenRouter/Ollama via one adapter. */
  kind: ProviderKind;
  /** Default base URL; user-overridable for OpenAI-compat (esp. Ollama). */
  defaultBaseUrl: string;
  /** Whether an API key is required (Ollama runs locally without one). */
  requiresKey: boolean;
  /** Selectable models; first entry is the default. */
  models: readonly string[];
}

/**
 * Provider registry. Default models are sensible current picks; the user can
 * still type/select others. Base URLs match `default_base_url` in the Rust
 * adapter so an un-overridden request resolves identically on both sides.
 */
export const PROVIDERS: Record<AIProvider, ProviderConfig> = {
  anthropic: {
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresKey: true,
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  openai: {
    kind: "openai-compat",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  },
  gemini: {
    kind: "openai-compat",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  openrouter: {
    kind: "openai-compat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5", "google/gemini-2.5-pro"],
  },
  ollama: {
    kind: "openai-compat",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    models: ["llama3.1", "qwen2.5", "mistral"],
  },
};

/** Ordered provider ids for menus. */
export const PROVIDER_IDS = Object.keys(PROVIDERS) as AIProvider[];

/** Per-provider list of selectable models (kept for the Settings/store API). */
export const PROVIDER_MODELS = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, PROVIDERS[id].models])
) as Record<AIProvider, readonly string[]>;

/** Aggregated telemetry summary (FR-AI-07) — mirrors Rust `TelemetryStatsDto`. */
export interface TelemetryStats {
  sampleCount: number;
  avgLinkQuality: number;
  minLinkQuality: number;
  avgRssi: number;
  minRssi: number;
  avgSnr: number;
  failsafeCount: number;
}

/**
 * The flashing wizard's chosen (or auto-detected) ELRS target. Fed into the AI
 * context so Omnia knows which model the user is discussing even before/without
 * a live device connection. Sourced from the real target catalogue.
 */
export interface WizardTargetSelection {
  brandName: string;
  modelName: string;
  /** ELRS build target id (e.g. `RADIOMASTER_RANGER_2400`). */
  target: string;
  deviceType: DeviceType;
  /** Selected firmware version, when chosen. */
  firmwareVersion?: string | null;
  /** Human RF-band label (e.g. `2.4 GHz`), when a band is chosen. */
  frequency?: string | null;
}

/** Raw context sent to the Rust command — mirrors `AiContextInput`. */
export interface AiContextInput {
  targetName?: string;
  firmwareVersion?: string;
  deviceType?: string;
  userDefines?: Record<string, string>;
  telemetry?: TelemetryStats;
  /**
   * Optional READ-ONLY controller-bridge context (M65). Folded in when a bridge
   * context exists. The privacy-critical redaction runs backend-side in Rust
   * `sanitize_context()` (only fw family/version + coarse port metadata survive),
   * so this just carries the raw DTO — never include it in `offline` mode.
   */
  bridge?: BridgeContextDto;
  /**
   * Optional retrieved RAG docs (M50, D15/D19). A bounded list of trusted-pack
   * excerpts to ground an answer, mirroring the Rust `retrieved_docs` field
   * (serde `retrievedDocs`). "Gather, don't redact" holds here too: excerpts are
   * already bounded snippets, and the authoritative scrub runs Rust-side in
   * `sanitize_context()` (a TS mirror lives in `knowledge/retrievalSanitize.ts`).
   * M50 lands the field + sanitizer; M51 wires it into the actual prompt.
   */
  retrievedDocs?: RetrievedDoc[];
  /**
   * Optional aggregate diagnostic context (M39a). The user-requested "explain this
   * finding / ask about this session" evidence, built from the M38 export / an M36
   * finding by the pure builders below. Aggregate + non-identifying by construction
   * ("gather, don't redact"): the authoritative scrub runs Rust-side in
   * `sanitize_context()`, which whitelists the enums, clamps the numbers, and scrubs
   * each `detail` bag. Threaded through in EVERY context mode (like `retrievedDocs`)
   * because it is explicit user-requested evidence, independent of device scoping.
   */
  diagnostics?: DiagnosticsAiContext;
}

/** One per-window finding in the diagnostics aggregate (M39a). */
export interface DiagnosticsAiFinding {
  ruleId: string;
  category: string;
  severity: string;
  confidence: number;
  startSec: number;
  endSec: number;
  detail: Record<string, number | string>;
}

/** One session-level pattern in the diagnostics aggregate (M39a). */
export interface DiagnosticsAiPattern {
  patternId: string;
  category: string;
  severity: string;
  confidence: number;
  detail: Record<string, number | string>;
}

/**
 * The aggregate diagnostic evidence attached to an "explain this finding / ask
 * about this session" request (M39a). Carries only aggregate, non-identifying
 * numbers/strings — rule/pattern ids, category/severity enums, confidence, relative
 * seconds, and the already-safe `detail` bags. Never a coordinate/UID/MAC/IP/serial.
 */
export interface DiagnosticsAiContext {
  /** `"finding"` (one explained finding) or `"session"` (the whole session). */
  scope: "finding" | "session";
  /** Overall session health 0–100 (session scope). */
  healthScore?: number;
  /** Finding counts per severity (session scope). */
  countsBySeverity?: { info: number; warning: number; critical: number };
  /** Whether the session had enough evidence for session-level patterns. */
  hasEnoughEvidence?: boolean;
  /** Per-window findings (≤ {@link MAX_DIAGNOSTICS_ROWS}). */
  findings: DiagnosticsAiFinding[];
  /** Session-level patterns (≤ {@link MAX_DIAGNOSTICS_ROWS}). */
  patterns: DiagnosticsAiPattern[];
}

/**
 * Max findings/patterns carried in a diagnostics aggregate (mirrors the Rust
 * `MAX_DIAGNOSTIC_ROWS`; the Rust sanitizer re-caps defensively).
 */
export const MAX_DIAGNOSTICS_ROWS = 32;

/** Round to one decimal place — matches the M38 export's relative-seconds resolution. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the SESSION-scope diagnostics aggregate from the deterministic M38 export
 * (M39a). Pure + deterministic + identifier-free by construction (the export is a
 * versioned, non-identifying contract; see `src/lib/diagnostics/export.ts`). Rows
 * are capped at {@link MAX_DIAGNOSTICS_ROWS}.
 */
export function diagnosticsContextFromExport(
  exp: DiagnosticExport
): DiagnosticsAiContext {
  return {
    scope: "session",
    healthScore: exp.healthScore,
    countsBySeverity: {
      info: exp.countsBySeverity.info,
      warning: exp.countsBySeverity.warning,
      critical: exp.countsBySeverity.critical,
    },
    hasEnoughEvidence: exp.hasEnoughEvidence,
    findings: exp.findings.slice(0, MAX_DIAGNOSTICS_ROWS).map((f) => ({
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
      startSec: f.window.startSec,
      endSec: f.window.endSec,
      detail: { ...f.detail },
    })),
    patterns: exp.patterns.slice(0, MAX_DIAGNOSTICS_ROWS).map((p) => ({
      patternId: p.patternId,
      category: p.category,
      severity: p.severity,
      confidence: p.confidence,
      detail: { ...p.detail },
    })),
  };
}

/**
 * Build the FINDING-scope diagnostics aggregate from a single M36
 * {@link DiagnosticFinding} (M39a). `startSec`/`endSec` are derived from `log.time`
 * exactly like the M38 export's `toWindow` (`round1((time[i] − time[0]) / 1000)`),
 * so it is pure + deterministic. `detail` is non-identifying by the finding's
 * contract; `patterns` is empty (a single finding carries no session patterns).
 */
export function diagnosticsContextFromFinding(
  finding: DiagnosticFinding,
  log: ParsedLog
): DiagnosticsAiContext {
  const t0 = log.time[0] ?? 0;
  const sec = (i: number): number => round1(((log.time[i] ?? t0) - t0) / 1000);
  return {
    scope: "finding",
    findings: [
      {
        ruleId: finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        startSec: sec(finding.evidenceWindow.startIndex),
        endSec: sec(finding.evidenceWindow.endIndex),
        detail: { ...finding.detail },
      },
    ],
    patterns: [],
  };
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Aggregate a rolling telemetry buffer into the safe summary stats. Returns
 * `undefined` for an empty buffer so no telemetry section is sent. Pure.
 */
export function aggregateTelemetry(
  frames: readonly TelemetryFrame[]
): TelemetryStats | undefined {
  if (frames.length === 0) return undefined;

  let sumLq = 0;
  let minLq = Infinity;
  let sumRssi = 0;
  let minRssi = Infinity;
  let sumSnr = 0;
  let failsafeCount = 0;

  for (const f of frames) {
    sumLq += f.linkQuality;
    minLq = Math.min(minLq, f.linkQuality);
    // Best (least-negative) of the two antennas approximates effective RSSI.
    const rssi = Math.max(f.rssi1, f.rssi2);
    sumRssi += rssi;
    minRssi = Math.min(minRssi, rssi);
    sumSnr += f.snr;
    // A 0% LQ frame is treated as a failsafe-class event for the summary.
    if (f.linkQuality <= 0) failsafeCount += 1;
  }

  const n = frames.length;
  return {
    sampleCount: n,
    avgLinkQuality: round(sumLq / n),
    minLinkQuality: round(minLq),
    avgRssi: round(sumRssi / n),
    minRssi: round(minRssi),
    avgSnr: round(sumSnr / n),
    failsafeCount,
  };
}

/**
 * Assemble the (pre-sanitization) context object from device + telemetry
 * inputs. Rust sanitizes again before anything is sent (defense in depth), so
 * this only needs to gather, not redact. `userDefines` is wired here for when a
 * live config store lands; today it is typically empty.
 */
export function buildAiContext(
  device: DeviceInfo | null,
  frames: readonly TelemetryFrame[],
  userDefines?: Record<string, string>,
  wizardTarget?: WizardTargetSelection | null,
  bridge?: BridgeContextDto | null,
  retrievedDocs?: readonly RetrievedDoc[] | null,
  diagnostics?: DiagnosticsAiContext | null
): AiContextInput {
  // A connected device's own identity always takes precedence; the wizard's
  // chosen/detected target fills the gap (and adds the human brand/model/band
  // names) so Omnia is grounded in the hardware being discussed.
  const defines: Record<string, string> = { ...(userDefines ?? {}) };
  if (wizardTarget) {
    defines.wizardBrand = wizardTarget.brandName;
    defines.wizardModel = wizardTarget.modelName;
    if (wizardTarget.frequency) defines.wizardFrequency = wizardTarget.frequency;
  }

  return {
    targetName: device?.targetName ?? wizardTarget?.target,
    firmwareVersion:
      device?.firmwareVersion ?? wizardTarget?.firmwareVersion ?? undefined,
    deviceType: device?.deviceType ?? wizardTarget?.deviceType,
    userDefines: Object.keys(defines).length > 0 ? defines : undefined,
    telemetry: aggregateTelemetry(frames),
    // M65: optional READ-ONLY bridge context. Rust `sanitize_context()` scrubs it
    // before anything leaves; here we only attach it when one exists.
    bridge: bridge ?? undefined,
    // M50: optional retrieved RAG docs. Attached only when non-empty; the Rust
    // sanitizer scrubs each excerpt/title before anything leaves.
    retrievedDocs:
      retrievedDocs && retrievedDocs.length > 0
        ? retrievedDocs.slice()
        : undefined,
    // M39a: optional aggregate diagnostic context. Attached only when provided
    // (default undefined ⇒ zero payload change); the Rust sanitizer scrubs it.
    diagnostics: diagnostics ?? undefined,
  };
}

/**
 * What hardware context Omnia is grounded in (M23). Chosen from the chat panel
 * so a user can scope (or fully suppress) what device data accompanies a turn:
 *   - `auto`    — connected device takes precedence, else the wizard target,
 *   - `device`  — the connected device only (no wizard target),
 *   - `wizard`  — the wizard target only (no device/telemetry),
 *   - `offline` — no device/telemetry/wizard data at all (offline KB).
 */
export type AiContextMode = "auto" | "device" | "wizard" | "offline";

/**
 * Assemble the AI context for a given context mode. Pure wrapper over
 * `buildAiContext` so the chat panel's privacy preview and the actual send path
 * stay in lockstep, and so the mode→inputs mapping is unit-testable.
 *
 * `device`/`wizard` deliberately drop the other source; `offline` passes no
 * device, telemetry, or wizard data, yielding an empty context object.
 */
export function selectAiContext(
  mode: AiContextMode,
  device: DeviceInfo | null,
  frames: readonly TelemetryFrame[],
  wizardTarget: WizardTargetSelection | null,
  bridge: BridgeContextDto | null = null,
  retrievedDocs: readonly RetrievedDoc[] | null = null,
  diagnostics: DiagnosticsAiContext | null = null
): AiContextInput {
  // Retrieved RAG docs are trusted-pack grounding, orthogonal to the device
  // context mode — they thread through in EVERY mode when present (offline mode
  // IS the offline knowledge-base path). Device/telemetry/wizard scoping is
  // unchanged; the bridge context stays hardware-only (omitted offline). The M39a
  // diagnostics aggregate is explicit user-requested evidence, so — like the
  // retrieved docs — it threads through in EVERY mode too (including offline).
  switch (mode) {
    case "device":
      // Connected device + its telemetry only; ignore any wizard target. The
      // read-only bridge context is hardware troubleshooting data, so include it.
      return buildAiContext(device, frames, undefined, null, bridge, retrievedDocs, diagnostics);
    case "wizard":
      // Wizard target only; no device identity and no live telemetry.
      return buildAiContext(null, [], undefined, wizardTarget, bridge, retrievedDocs, diagnostics);
    case "offline":
      // Send nothing device-specific — Omnia answers from its offline knowledge
      // (which is exactly the retrieved docs). The bridge context is hardware
      // data, so offline omits it.
      return buildAiContext(null, [], undefined, null, null, retrievedDocs, diagnostics);
    case "auto":
    default:
      return buildAiContext(device, frames, undefined, wizardTarget, bridge, retrievedDocs, diagnostics);
  }
}
