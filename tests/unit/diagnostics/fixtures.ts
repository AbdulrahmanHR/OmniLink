/**
 * Shared loader for the M36 DL2 diagnostic fixture corpus.
 *
 * Reads `data/fixtures/diagnostics/fixtures-manifest.json` and each labelled CSV
 * from disk (this runs under the Node vitest environment) and parses every CSV
 * into a {@link ParsedLog} via the canonical {@link parseOmniLogCsv}. Paths are
 * resolved relative to this file so the suite is cwd-independent.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ParsedLog } from "@/lib/blackbox";
import { parseOmniLogCsv } from "@/lib/omnilog";
import type { DiagnosticSeverity } from "@/lib/diagnostics";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the diagnostic fixture corpus directory. */
export const FIXTURES_DIR = path.resolve(here, "../../../data/fixtures/diagnostics");

/** One expected finding entry from the manifest. */
export interface ExpectedFinding {
  ruleId: string;
  severity: DiagnosticSeverity;
  approxWindow: { startIndex: number; endIndex: number };
  note?: string;
}

/** One fixture entry from the manifest. */
export interface FixtureEntry {
  file: string;
  label: "healthy" | "warning" | "failsafe" | "wiring" | "antenna";
  description: string;
  sampleCount: number;
  expectClean: boolean;
  expectedFindings: ExpectedFinding[];
}

/** The full fixtures manifest. */
export interface Manifest {
  version: string;
  description: string;
  fixtures: FixtureEntry[];
}

/** Read + parse the fixtures manifest. */
export function loadManifest(): Manifest {
  const raw = readFileSync(path.join(FIXTURES_DIR, "fixtures-manifest.json"), "utf8");
  return JSON.parse(raw) as Manifest;
}

/** Read + parse one fixture CSV (relative `file` from the manifest) to a ParsedLog. */
export function loadFixtureLog(file: string): ParsedLog {
  return parseOmniLogCsv(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
}

/** A fixture entry paired with its parsed log. */
export type LoadedFixture = FixtureEntry & { log: ParsedLog };

/** Load every fixture in the manifest, each paired with its parsed log. */
export function loadAllFixtures(): LoadedFixture[] {
  return loadManifest().fixtures.map((f) => ({ ...f, log: loadFixtureLog(f.file) }));
}

/** Inclusive 1-D window overlap test. */
export function windowsOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

/**
 * Build a minimal {@link ParsedLog} from a `{ key: values[] }` channel map, with
 * a synthetic 40 ms time axis. Mirrors the inline-fixture style of
 * `tests/unit/anomaly.test.ts`.
 */
export function buildLog(channels: Record<string, number[]>): ParsedLog {
  const keys = Object.keys(channels);
  const sampleCount = keys.length ? channels[keys[0]].length : 0;
  const time = Array.from({ length: sampleCount }, (_, i) => i * 40);
  const logChannels = keys.map((key) => ({ key, label: key, values: channels[key] }));
  const durationMs = sampleCount >= 2 ? time[sampleCount - 1] - time[0] : 0;
  return { source: "omnilog", time, channels: logChannels, sampleCount, durationMs };
}

/** ± sample tolerance used when matching a finding's window to an `approxWindow`. */
export const WINDOW_TOLERANCE = 8;
