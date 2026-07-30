/**
 * SQLite seam for **ML session labels** (v2.5 / M56c) — the `session_labels` table
 * created by migration v6 (`src-tauri/src/db/mod.rs`).
 *
 * It is the direct sibling of `sessions-db.ts` and follows exactly the same
 * precedent: the frontend talks to SQLite through `tauri-plugin-sql` (`db.execute` /
 * `db.select`) over the shared {@link TELEMETRY_DB_URL}. There is no Rust
 * persistence layer for telemetry, and this milestone does not add one.
 *
 * ## The shape, and why
 * Rows are **append-only**. Labeling a session inserts `(session_id, label,
 * revision = max(revision) + 1, labeled_at)`; nothing ever UPDATEs. "The label" of a
 * session is its **highest revision** ({@link latestLabelBySession}). A relabel is
 * therefore a new assertion layered over an old one, and the history is intact — so
 * a model artifact can name the label set it trained on, and a corpus stays
 * reproducible after someone changes their mind. See the migration comment for the
 * full defense of a separate table over a column on `telemetry_sessions`.
 *
 * ## Zero identifiers
 * A row is a session id, one of six canonical {@link MlLabel}s (enforced by a SQL
 * `CHECK`, so the column *cannot* hold prose), a revision, and a local timestamp.
 * **There is no note field, by design** — a free-text box is how a pilot's name or a
 * flying site ends up in a dataset. `labeled_at` is injected by the caller (never
 * read from a clock in here), it orders history, and it never enters a feature
 * vector or any eval computation.
 *
 * ## Local only
 * Nothing here leaves the device. No network call exists in this module, and
 * `session_labels` is registered in `USER_DATA_SQLITE_TABLES` so the existing
 * export-my-data / erase-all-data flows cover labels like every other local table.
 *
 * Best-effort, exactly like the sibling read seam: outside Tauri every operation is
 * a silent no-op / empty read (a browser dev host is the expected case, not an
 * error); a genuine in-Tauri failure is `console.error`-logged and swallowed so a
 * lab tool can never take down the app.
 */

import { isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { ML_LABELS, type MlLabel } from "@/lib/ml/dataset";
import { TELEMETRY_DB_URL } from "@/lib/telemetry-db";

/** The table migration v6 creates. */
export const SESSION_LABELS_TABLE = "session_labels";

/** One stored label assertion: a session, a canonical label, and its revision. */
export interface SessionLabelRow {
  /** The `telemetry_sessions.session_id` this assertion is about. */
  sessionId: string;
  /** One of the six canonical {@link MlLabel}s. */
  label: MlLabel;
  /** 1-based, monotonic per session. The highest revision is the current label. */
  revision: number;
  /** Local epoch-ms the assertion was made. Ordering/audit only — never a model input. */
  labeledAt: number;
}

/** Loosely-typed row as returned by `db.select` (SQLite gives back `number | string | null`). */
type DbRow = Record<string, number | string | null | undefined>;

/** One bound SQL statement: a `$n`-parameterised string plus its params. */
type SqlStatement = { sql: string; params: (string | number | null)[] };

/** Narrow an arbitrary string to a canonical {@link MlLabel} (unrecognised ⇒ `unknown`). */
export function toCanonicalLabel(value: unknown): MlLabel {
  const s = String(value);
  return (ML_LABELS as readonly string[]).includes(s) ? (s as MlLabel) : "unknown";
}

/**
 * Map a `session_labels` row (snake_case) to a camelCase {@link SessionLabelRow}.
 *
 * Pure and DB-free so it is unit-testable with plain row objects. A label the DB
 * somehow holds outside the canonical six (it cannot — there is a `CHECK` — but a
 * reader must not *assume* its writer) degrades to `unknown` rather than being
 * passed through as an arbitrary string.
 */
export function dbRowToSessionLabel(row: DbRow): SessionLabelRow {
  return {
    sessionId: String(row.session_id),
    label: toCanonicalLabel(row.label),
    revision: Number(row.revision),
    labeledAt: Number(row.labeled_at),
  };
}

/**
 * Build the INSERT for one label assertion. Pure and DB-free so the SQL shape is
 * unit-testable without a database.
 *
 * `revision` is computed by the caller from the session's existing history
 * ({@link nextRevision}); the table's `UNIQUE (session_id, revision)` is the
 * backstop that makes a duplicate a hard failure rather than a silent second
 * "current" label. Uses `$n` positional placeholders (tauri-plugin-sql convention),
 * so the label can never be string-concatenated into SQL.
 */
export function buildInsertLabelStatement(
  sessionId: string,
  label: MlLabel,
  revision: number,
  labeledAt: number
): SqlStatement {
  return {
    sql:
      "INSERT INTO session_labels (session_id, label, revision, labeled_at) " +
      "VALUES ($1, $2, $3, $4)",
    params: [sessionId, label, revision, labeledAt],
  };
}

/**
 * Reduce a label's full revision history to the **current** label of each session:
 * the assertion with the highest `revision`.
 *
 * Pure. Ties (which the `UNIQUE (session_id, revision)` constraint makes
 * unreachable) resolve to the later `labeledAt`, then to the row seen last, so the
 * function is total and deterministic for any input a test can construct.
 */
export function latestLabelBySession(
  rows: readonly SessionLabelRow[]
): Map<string, SessionLabelRow> {
  const latest = new Map<string, SessionLabelRow>();
  for (const row of rows) {
    const current = latest.get(row.sessionId);
    if (
      !current ||
      row.revision > current.revision ||
      (row.revision === current.revision && row.labeledAt >= current.labeledAt)
    ) {
      latest.set(row.sessionId, row);
    }
  }
  return latest;
}

/**
 * The revision a new assertion about `sessionId` should carry: one past the highest
 * revision already stored for it (1 when it has never been labeled). Pure.
 */
export function nextRevision(
  rows: readonly SessionLabelRow[],
  sessionId: string
): number {
  let highest = 0;
  for (const row of rows) {
    if (row.sessionId === sessionId && row.revision > highest) highest = row.revision;
  }
  return highest + 1;
}

/**
 * Read every stored label assertion (full history), oldest first.
 *
 * Best-effort: outside Tauri it returns `[]` **silently** (no backend — the expected
 * browser/dev case, and the offline e2e asserts a clean console); a genuine in-Tauri
 * failure is logged and also yields `[]`, so the lab surface renders an empty,
 * honest report instead of an error boundary.
 */
export async function listSessionLabels(): Promise<SessionLabelRow[]> {
  if (!isTauri()) return [];
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    const rows = await db.select<DbRow[]>(
      "SELECT session_id, label, revision, labeled_at FROM session_labels " +
        "ORDER BY session_id ASC, revision ASC"
    );
    return rows.map(dbRowToSessionLabel);
  } catch (e) {
    console.error("[labels] failed to list session labels", e);
    return [];
  }
}

/**
 * Assert a label for one stored session: append a new revision.
 *
 * `now` is **injected** (epoch ms) rather than read from a clock here, mirroring
 * `pruneSessions(policy, now)` — the module stays deterministic and testable, and no
 * `Date.now()` can leak into a path anything reproducible depends on.
 *
 * The read-then-insert runs inside one `BEGIN`/`COMMIT` transaction so two
 * concurrent labels of the same session cannot both compute the same next revision
 * and land two "current" labels (the `UNIQUE (session_id, revision)` constraint
 * would reject the second anyway — the transaction is what makes it a clean
 * rollback rather than a torn write).
 *
 * Best-effort: a silent no-op outside Tauri; a genuine failure is logged, rolled
 * back, and swallowed.
 */
export async function setSessionLabel(
  sessionId: string,
  label: MlLabel,
  now: number
): Promise<void> {
  if (!isTauri()) return;
  try {
    const db = await Database.load(TELEMETRY_DB_URL);
    await db.execute("BEGIN");
    try {
      const rows = await db.select<DbRow[]>(
        "SELECT session_id, label, revision, labeled_at FROM session_labels " +
          "WHERE session_id = $1",
        [sessionId]
      );
      const revision = nextRevision(rows.map(dbRowToSessionLabel), sessionId);
      const { sql, params } = buildInsertLabelStatement(sessionId, label, revision, now);
      await db.execute(sql, params);
      await db.execute("COMMIT");
    } catch (e) {
      await db.execute("ROLLBACK");
      throw e;
    }
  } catch (e) {
    console.error("[labels] failed to set session label", e);
  }
}
