/**
 * Deterministic diagnostic-findings export schema (M38, v2.0.1 backfill).
 *
 * This is the **stable, versioned cross-line artifact** that later diagnostics
 * work consumes: **M39a** (BYOK AI explanations) builds its sanitized prompt from
 * it, and the **v2.5 ML line** trains/serves from it. Because those consumers must
 * not break when the UI changes, the shape here is a *contract*, not a convenience
 * dump — it is versioned ({@link DIAGNOSTIC_EXPORT_SCHEMA_VERSION}) and carries
 * ONLY aggregate, non-identifying evidence.
 *
 * ## Purity
 * {@link buildDiagnosticExport} is pure & deterministic: seconds are derived from
 * `log.time` (no `Date.now`), there is no `Math.random`, no I/O. `JSON.parse(
 * JSON.stringify(export))` deep-equals the export.
 *
 * ## Safety
 * The export is assembled from the already-safe {@link DiagnosticFinding} /
 * {@link SessionPattern} `detail` bags plus counts and relative seconds — it
 * NEVER includes a coordinate, cell key, UID, MAC, IP, email, or serial. Only the
 * `source` enum, sample/duration counts, the health score, severity counts, sample
 * windows, relative seconds, and the non-identifying `detail` numbers/strings
 * cross this boundary.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type {
  DiagnosticCategory,
  DiagnosticReport,
  DiagnosticSeverity,
  SessionPatternId,
  SessionPatternReport,
} from "./types";

/** Semantic version of the export schema (bump on any breaking shape change). */
export const DIAGNOSTIC_EXPORT_SCHEMA_VERSION = "1.0.0";

/** One evidence window: sample indices plus relative seconds (both stable). */
export interface DiagnosticExportWindow {
  /** Inclusive first sample index. */
  startIndex: number;
  /** Inclusive last sample index. */
  endIndex: number;
  /** Seconds since the session start at `startIndex` (1 dp). */
  startSec: number;
  /** Seconds since the session start at `endIndex` (1 dp). */
  endSec: number;
}

/** One per-window finding in the export. */
export interface DiagnosticExportFinding {
  ruleId: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  confidence: number;
  window: DiagnosticExportWindow;
  detail: Record<string, number | string>;
}

/** One session-level pattern in the export. */
export interface DiagnosticExportPattern {
  patternId: SessionPatternId;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  confidence: number;
  windows: DiagnosticExportWindow[];
  detail: Record<string, number | string>;
}

/**
 * The full, versioned, deterministic diagnostic export. Consumed by M39a (AI
 * explanations) and the v2.5 ML line — treat its shape as a contract.
 */
export interface DiagnosticExport {
  schemaVersion: typeof DIAGNOSTIC_EXPORT_SCHEMA_VERSION;
  session: {
    source: ParsedLog["source"];
    sampleCount: number;
    durationMs: number;
  };
  healthScore: number;
  countsBySeverity: Record<DiagnosticSeverity, number>;
  hasEnoughEvidence: boolean;
  findings: DiagnosticExportFinding[];
  patterns: DiagnosticExportPattern[];
}

/** Round to one decimal place (stable for the export's relative seconds). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the deterministic diagnostic export from an M36 {@link DiagnosticReport}
 * and an M38 {@link SessionPatternReport} over the same `log`.
 *
 * Pure: relative seconds come from `log.time` (`startSec = round1((time[i] −
 * time[0]) / 1000)`), so the same inputs always yield a deeply-equal export that
 * JSON-round-trips exactly. Emits no identifiers (see module docs).
 */
export function buildDiagnosticExport(
  report: DiagnosticReport,
  patternReport: SessionPatternReport,
  log: ParsedLog
): DiagnosticExport {
  const t0 = log.time[0] ?? 0;
  const sec = (i: number): number => round1(((log.time[i] ?? t0) - t0) / 1000);
  const toWindow = (w: { startIndex: number; endIndex: number }): DiagnosticExportWindow => ({
    startIndex: w.startIndex,
    endIndex: w.endIndex,
    startSec: sec(w.startIndex),
    endSec: sec(w.endIndex),
  });

  return {
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    session: {
      source: log.source,
      sampleCount: log.sampleCount,
      durationMs: log.durationMs,
    },
    healthScore: report.healthScore,
    countsBySeverity: { ...report.sessionSummary.countsBySeverity },
    hasEnoughEvidence: patternReport.hasEnoughEvidence,
    findings: report.findings.map((f) => ({
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      confidence: f.confidence,
      window: toWindow(f.evidenceWindow),
      detail: { ...f.detail },
    })),
    patterns: patternReport.patterns.map((p) => ({
      patternId: p.patternId,
      category: p.category,
      severity: p.severity,
      confidence: p.confidence,
      windows: p.evidenceWindows.map(toWindow),
      detail: { ...p.detail },
    })),
  };
}
