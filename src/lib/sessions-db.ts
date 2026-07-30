/**
 * SQLite *read* seam for recorded telemetry sessions (M11).
 *
 * The companion writer in `telemetry-db.ts` opens a `telemetry_sessions` parent
 * row and streams frames into `telemetry`. This module is the inverse: it
 * enumerates the stored sessions and reads one session's frames back out as
 * canonical {@link TelemetrySessionCsvRow}s, ready for
 * {@link telemetrySessionToCsv} export.
 *
 * Like the writer, most DB operations here are **best-effort**: a genuine failed
 * `select`/`close` under Tauri is `console.error`-logged and swallowed. The one
 * exception is {@link loadSessionRows}, which additionally *re-throws* after
 * logging so a failed frame read can't be mistaken for a legitimately-empty
 * recording (which would otherwise silently load a blank analysis surface or
 * export a header-only CSV). Outside Tauri there is no backend, so both reads
 * short-circuit on `isTauri()` and return empty *silently* — a non-Tauri host is
 * the expected browser/dev case, not an error, and must not log (the offline e2e
 * asserts a clean console, mirroring `stores/device.ts` / `stores/profiles.ts`).
 *
 * The connection URL is shared with the writer via {@link TELEMETRY_DB_URL} so
 * both halves talk to the same migrated database file.
 */

import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { TELEMETRY_DB_URL } from "@/lib/telemetry-db";
import type { TelemetrySessionCsvRow } from "@/lib/telemetry-session-csv";

/**
 * One row of the `telemetry_sessions` table, in camelCase. Mirrors the parent
 * row written by `buildSessionStartInsert`/`buildSessionEndUpdate`.
 *
 * `endedAt` is `null` for a session that was never closed (e.g. a crash mid
 * recording); `targetName`/`firmware` are `null` when the device did not report
 * them. `name` is the optional user-set label (M24): `null` = unnamed, which
 * the UI renders by falling back to the device target/firmware line.
 */
export interface StoredSessionMeta {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  targetName: string | null;
  firmware: string | null;
  name: string | null;
  frameCount: number;
}

/**
 * Loosely-typed row as returned by `db.select`. SQLite values come back as
 * `number | string | null` and column presence is not statically known, so the
 * mappers below coerce defensively.
 */
type DbRow = Record<string, number | string | null | undefined>;

/** Coerce a possibly-string SQLite numeric to a `number`. */
function num(value: number | string | null | undefined): number {
  return Number(value);
}

/**
 * Coerce a nullable SQLite numeric: `null`/`undefined` (an absent or NULL
 * column) stays `null`, anything else becomes a `number`.
 */
function nullableNum(
  value: number | string | null | undefined
): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Coerce a nullable SQLite text column: `null`/`undefined` stays `null`,
 * otherwise stringified.
 */
function nullableStr(
  value: number | string | null | undefined
): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Map a `telemetry_sessions` row (snake_case columns) to the camelCase
 * {@link StoredSessionMeta} DTO. Pure and DB-free so it is unit-testable with
 * plain row objects. Numerics are coerced with `Number(...)`; `ended_at`,
 * `target_name`, `firmware` and the user-set `name` (M24) preserve their
 * `null`s.
 */
export function dbRowToSessionMeta(row: DbRow): StoredSessionMeta {
  return {
    sessionId: String(row.session_id),
    startedAt: num(row.started_at),
    endedAt: nullableNum(row.ended_at),
    targetName: nullableStr(row.target_name),
    firmware: nullableStr(row.firmware),
    name: nullableStr(row.name),
    frameCount: num(row.frame_count),
  };
}

/**
 * Map a `telemetry` row (snake_case columns) to a camelCase
 * {@link TelemetrySessionCsvRow}. Pure and DB-free so it is unit-testable with
 * plain row objects. The required link-stat fields are coerced with
 * `Number(...)`; the GPS fields stay `null` when their column is `null`.
 */
export function dbRowToCsvRow(row: DbRow): TelemetrySessionCsvRow {
  return {
    ts: num(row.ts),
    rssi1: num(row.rssi1),
    rssi2: num(row.rssi2),
    linkQuality: num(row.link_quality),
    snr: num(row.snr),
    txPower: num(row.tx_power),
    packetRate: num(row.packet_rate),
    lat: nullableNum(row.lat),
    lon: nullableNum(row.lon),
    alt: nullableNum(row.alt),
    sats: nullableNum(row.sats),
    groundSpeed: nullableNum(row.ground_speed),
    heading: nullableNum(row.heading),
  };
}

/**
 * Format a recorded session's wall-clock duration for display, or `null` when
 * it cannot be computed: an unclosed session (`endedAt === null`, e.g. a crash
 * mid-recording) or a non-finite/negative span. Pure and DB-free so it is
 * unit-testable with plain numbers.
 *
 * Unit suffixes are hardcoded like the log scrubber's `relSeconds`: `42s`,
 * `1m 23s`, `1h 02m 03s` (minutes/seconds zero-padded once an hour is shown).
 */
export function formatSessionDuration(
  startedAt: number,
  endedAt: number | null
): string | null {
  if (endedAt === null) return null;
  const ms = endedAt - startedAt;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * Enumerate the stored telemetry sessions, newest first.
 *
 * Best-effort: outside Tauri it returns `[]` silently (no backend); a genuine
 * in-Tauri failure is logged and also yields `[]`, so callers can render an
 * empty browser without special-casing the environment.
 */
export async function listStoredSessions(): Promise<StoredSessionMeta[]> {
  // No Tauri backend (browser/dev host): nothing is persisted, so skip the
  // query and degrade to empty *silently* — this is expected, not an error.
  if (!isTauri()) return [];
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    const rows = await db.select<DbRow[]>(
      "SELECT session_id, started_at, ended_at, target_name, firmware, name, frame_count " +
        "FROM telemetry_sessions ORDER BY started_at DESC"
    );
    return rows.map(dbRowToSessionMeta);
  } catch (e) {
    console.error("[sessions] failed to list stored sessions", e);
    return [];
  }
}

/**
 * Load every telemetry frame for one session as canonical CSV rows, oldest
 * first (`ts ASC`), ready for {@link telemetrySessionToCsv}.
 *
 * Outside Tauri it returns `[]` silently (no backend). A genuine in-Tauri
 * failure is logged and **re-thrown** — unlike the other seams here it is not
 * swallowed, so callers can tell a failed read apart from a legitimately-empty
 * recording (`frame_count` seeds to 0 and a crash mid-recording leaves zero
 * frames), rather than silently loading a blank session / exporting an empty CSV.
 */
export async function loadSessionRows(
  sessionId: string
): Promise<TelemetrySessionCsvRow[]> {
  if (!isTauri()) return [];
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    const rows = await db.select<DbRow[]>(
      "SELECT ts, rssi1, rssi2, link_quality, snr, tx_power, packet_rate, " +
        "lat, lon, alt, sats, ground_speed, heading " +
        "FROM telemetry WHERE session_id = $1 ORDER BY ts ASC",
      [sessionId]
    );
    return rows.map(dbRowToCsvRow);
  } catch (e) {
    console.error("[sessions] failed to load session rows", e);
    throw e;
  }
}

/** One bound SQL statement: a `$n`-parameterised string plus its params. */
type SqlStatement = { sql: string; params: (string | number | null)[] };

/**
 * Build the ordered statements that delete one stored session, children first.
 *
 * Pure and DB-free so the SQL shape/ordering is unit-testable without a
 * database. The `telemetry` frames **and** the M56c `session_labels` assertions
 * are deleted *before* the parent `telemetry_sessions` row so an interrupted run
 * can never orphan a child behind a missing parent. (v6 declares the label FK
 * `ON DELETE CASCADE`, but SQLite only honours that with `PRAGMA foreign_keys`
 * on — deleting explicitly means the labels of a deleted recording are gone
 * whatever the connection's pragma state, and it keeps the readiness report's
 * denominator from counting labels of sessions that no longer exist.) Uses `$n`
 * positional placeholders (tauri-plugin-sql convention); {@link deleteSession}
 * runs them inside a single transaction.
 */
export function buildDeleteSessionStatements(
  sessionId: string
): SqlStatement[] {
  return [
    {
      sql: "DELETE FROM telemetry WHERE session_id = $1",
      params: [sessionId],
    },
    {
      sql: "DELETE FROM session_labels WHERE session_id = $1",
      params: [sessionId],
    },
    {
      sql: "DELETE FROM telemetry_sessions WHERE session_id = $1",
      params: [sessionId],
    },
  ];
}

/**
 * Build the parameterised UPDATE that sets (or clears) a session's user label.
 *
 * Pure and DB-free so the SQL shape is unit-testable without a database. An
 * empty/whitespace `name` is treated as *clearing* the label and stores `NULL`
 * (an unnamed session), so the UI falls back to the device target/firmware
 * line. A non-empty name is trimmed before storing. Uses `$n` positional
 * placeholders (tauri-plugin-sql convention).
 */
export function buildRenameSessionUpdate(
  sessionId: string,
  name: string
): SqlStatement {
  const trimmed = name.trim();
  return {
    sql: "UPDATE telemetry_sessions SET name = $1 WHERE session_id = $2",
    params: [trimmed.length === 0 ? null : trimmed, sessionId],
  };
}

/**
 * Retention bounds for {@link selectSessionsToPrune}/{@link pruneSessions}.
 *
 * Each dimension is independent and optional: a `null`/`undefined`/`<= 0` value
 * disables that dimension. With both set the rules combine as a *union* (a
 * session pruned by either rule is pruned).
 */
export interface RetentionPolicy {
  /** Keep only the newest this-many sessions; prune the older surplus. */
  maxCount?: number | null;
  /** Prune sessions whose `startedAt` is older than this many days. */
  maxAgeDays?: number | null;
}

/** Milliseconds in one day, for the `maxAgeDays` cutoff. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Select which sessions to prune under a {@link RetentionPolicy}, returning
 * their `sessionId`s (in input order) — the rest are kept.
 *
 * Pure and DB-free so the policy is fully unit-testable without a database:
 *  - **count** keeps the newest `maxCount` sessions (by `startedAt`) and prunes
 *    the older surplus;
 *  - **age** prunes any session that started more than `maxAgeDays` before
 *    `now`;
 *  - **combined** prunes the union of both rules;
 *  - a disabled dimension (`null`/`undefined`/`<= 0`) contributes nothing, so
 *    an all-disabled policy returns `[]` (prune nothing).
 *
 * Input order is not assumed: the count rule sorts a copy newest-first, so the
 * result is correct regardless of how the list was supplied.
 */
export function selectSessionsToPrune(
  sessions: StoredSessionMeta[],
  policy: RetentionPolicy,
  now: number
): string[] {
  const doomed = new Set<string>();

  const maxCount = policy.maxCount;
  if (maxCount != null && maxCount > 0) {
    // Keep the newest `maxCount`; everything past that slice is surplus.
    const byNewest = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
    for (const s of byNewest.slice(maxCount)) doomed.add(s.sessionId);
  }

  const maxAgeDays = policy.maxAgeDays;
  if (maxAgeDays != null && maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * MS_PER_DAY;
    for (const s of sessions) {
      if (s.startedAt < cutoff) doomed.add(s.sessionId);
    }
  }

  // Preserve the caller's input order for a stable, deterministic result.
  return sessions.filter((s) => doomed.has(s.sessionId)).map((s) => s.sessionId);
}

/**
 * Summarize a stored-session list for the storage/usage readout.
 *
 * Pure and DB-free so the totals are unit-testable with plain DTOs.
 */
export function summarizeSessions(sessions: StoredSessionMeta[]): {
  sessionCount: number;
  totalFrames: number;
} {
  return {
    sessionCount: sessions.length,
    totalFrames: sessions.reduce((sum, s) => sum + s.frameCount, 0),
  };
}

/**
 * Delete one stored session: its `telemetry_sessions` row **and** all of its
 * `telemetry` frames, transactionally.
 *
 * Best-effort, mirroring the read seam: outside Tauri it is a silent no-op (no
 * backend); a genuine in-Tauri failure is `console.error`-logged and swallowed,
 * never thrown to the UI. The two deletes run inside a `BEGIN`/`COMMIT`
 * transaction with `ROLLBACK` on error so a partial failure can't leave frames
 * orphaned behind a deleted parent (or vice-versa).
 */
export async function deleteSession(sessionId: string): Promise<void> {
  // No Tauri backend (browser/dev host): nothing is persisted — silent no-op.
  if (!isTauri()) return;
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    const statements = buildDeleteSessionStatements(sessionId);
    await db.execute("BEGIN");
    try {
      for (const { sql, params } of statements) {
        await db.execute(sql, params);
      }
      await db.execute("COMMIT");
    } catch (e) {
      // Undo any partial delete so the row + frames stay consistent.
      await db.execute("ROLLBACK");
      throw e;
    }
  } catch (e) {
    console.error("[sessions] failed to delete stored session", e);
  }
}

/**
 * Set (or clear) a stored session's user label.
 *
 * Best-effort, mirroring the read seam: outside Tauri it is a silent no-op; a
 * genuine in-Tauri failure is logged and swallowed. An empty/whitespace `name`
 * clears the label (stores `NULL`) — see {@link buildRenameSessionUpdate}.
 */
export async function renameSession(
  sessionId: string,
  name: string
): Promise<void> {
  if (!isTauri()) return;
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    const { sql, params } = buildRenameSessionUpdate(sessionId, name);
    await db.execute(sql, params);
  } catch (e) {
    console.error("[sessions] failed to rename stored session", e);
  }
}

/**
 * Apply a {@link RetentionPolicy} to the stored sessions: list → select →
 * delete each doomed session.
 *
 * Best-effort and `isTauri()`-guarded throughout (the listing and each delete
 * are themselves best-effort), so it is a silent no-op outside Tauri and never
 * throws to the caller. `now` is injected so callers/tests control the age
 * cutoff. Each session is deleted in its own transaction via
 * {@link deleteSession}.
 */
export async function pruneSessions(
  policy: RetentionPolicy,
  now: number
): Promise<void> {
  if (!isTauri()) return;
  const sessions = await listStoredSessions();
  for (const sessionId of selectSessionsToPrune(sessions, policy, now)) {
    await deleteSession(sessionId);
  }
}
