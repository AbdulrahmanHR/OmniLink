import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildInsertLabelStatement,
  dbRowToSessionLabel,
  latestLabelBySession,
  nextRevision,
  SESSION_LABELS_TABLE,
  toCanonicalLabel,
  type SessionLabelRow,
} from "@/lib/session-labels";
import { buildDeleteSessionStatements } from "@/lib/sessions-db";
import { USER_DATA_SQLITE_TABLES } from "@/lib/userData";
import { ML_LABELS } from "@/lib/ml/dataset";
import { countLabels } from "@/lib/ml/readiness";

/**
 * The M56c label seam: the pure halves of `src/lib/session-labels.ts` (SQL shape,
 * row mapping, the append-only revision model), plus the two invariants that make
 * the persisted label safe — it carries **zero identifiers**, and the storage layer
 * itself cannot hold anything but a canonical label.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Build a label row for the pure suites. */
function row(
  sessionId: string,
  label: SessionLabelRow["label"],
  revision: number,
  labeledAt = 1000 * revision
): SessionLabelRow {
  return { sessionId, label, revision, labeledAt };
}

describe("migration v6 ↔ ML_LABELS (cross-language drift guard)", () => {
  const migrations = readFileSync(
    path.join(REPO_ROOT, "src-tauri/src/db/mod.rs"),
    "utf8"
  );
  const check = /CHECK \(label IN \(([\s\S]*?)\)\)/.exec(migrations);

  it("the table's CHECK constraint lists EXACTLY the six canonical labels", () => {
    expect(check).not.toBeNull();
    const listed = [...check![1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
    // The SQL column physically cannot store anything else — including a sentence.
    // If `ML_LABELS` ever gains/renames a label without a matching migration, this
    // goes red instead of a label silently failing to INSERT at runtime.
    expect(listed).toEqual([...ML_LABELS].sort());
  });

  it("migration v6 creates the table this seam writes to", () => {
    expect(migrations).toContain(
      `CREATE TABLE IF NOT EXISTS ${SESSION_LABELS_TABLE}`
    );
    expect(SESSION_LABELS_TABLE).toBe("session_labels");
  });
});

describe("buildInsertLabelStatement", () => {
  it("appends a revision with $n placeholders (the label is never concatenated)", () => {
    const { sql, params } = buildInsertLabelStatement("sess-1", "failsafe", 3, 1720000000000);
    expect(sql).toBe(
      "INSERT INTO session_labels (session_id, label, revision, labeled_at) " +
        "VALUES ($1, $2, $3, $4)"
    );
    expect(params).toEqual(["sess-1", "failsafe", 3, 1720000000000]);
    // Append-only: nothing in this seam issues an UPDATE against the table.
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it("stores no field beyond session id, label, revision and timestamp", () => {
    const { sql, params } = buildInsertLabelStatement("sess-1", "healthy", 1, 42);
    const columns = /\(([^)]*)\) VALUES/.exec(sql)![1].split(",").map((c) => c.trim());
    // ZERO identifiers, and NO free-text note column — a note box is exactly how a
    // pilot's name, a callsign, or a flying site gets into a dataset.
    expect(columns).toEqual(["session_id", "label", "revision", "labeled_at"]);
    expect(params).toHaveLength(columns.length);
    for (const forbidden of ["note", "comment", "lat", "lon", "gps", "uid", "mac", "email"]) {
      expect(sql.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("dbRowToSessionLabel / toCanonicalLabel", () => {
  it("maps a snake_case row, coercing SQLite's string numerics", () => {
    expect(
      dbRowToSessionLabel({
        session_id: "sess-1",
        label: "wiringSuspicion",
        revision: "2",
        labeled_at: "1720000000000",
      })
    ).toEqual({
      sessionId: "sess-1",
      label: "wiringSuspicion",
      revision: 2,
      labeledAt: 1720000000000,
    });
  });

  it("degrades an off-union label to `unknown` rather than passing a string through", () => {
    expect(toCanonicalLabel("healthy")).toBe("healthy");
    expect(toCanonicalLabel("Bob's quad, field behind the barn")).toBe("unknown");
    expect(toCanonicalLabel(null)).toBe("unknown");
    expect(
      dbRowToSessionLabel({ session_id: "s", label: "totally bogus", revision: 1, labeled_at: 0 })
        .label
    ).toBe("unknown");
  });
});

describe("the append-only revision model", () => {
  it("nextRevision starts at 1 and advances past the session's highest revision", () => {
    expect(nextRevision([], "sess-1")).toBe(1);
    const history = [row("sess-1", "warning", 1), row("sess-1", "failsafe", 2), row("sess-2", "healthy", 7)];
    expect(nextRevision(history, "sess-1")).toBe(3);
    // Revisions are per session, not global.
    expect(nextRevision(history, "sess-2")).toBe(8);
    expect(nextRevision(history, "sess-3")).toBe(1);
  });

  it("the CURRENT label of a session is its highest revision — history is preserved", () => {
    // The user first called it a warning, then decided it was an antenna null.
    const history = [
      row("sess-1", "warning", 1),
      row("sess-1", "antennaSuspicion", 2),
      row("sess-2", "healthy", 1),
    ];
    const latest = latestLabelBySession(history);
    expect(latest.get("sess-1")!.label).toBe("antennaSuspicion");
    expect(latest.get("sess-1")!.revision).toBe(2);
    expect(latest.get("sess-2")!.label).toBe("healthy");
    // The superseded assertion is still in the input — a relabel never destroys it,
    // so a model artifact can name the exact label set it trained on.
    expect(history.filter((r) => r.sessionId === "sess-1")).toHaveLength(2);
  });

  it("is order-independent (a DB read is not required to come back sorted)", () => {
    const shuffled = [row("s", "failsafe", 3), row("s", "healthy", 1), row("s", "warning", 2)];
    expect(latestLabelBySession(shuffled).get("s")!.label).toBe("failsafe");
  });

  it("feeds the readiness report exactly one label per session", () => {
    const history = [
      row("s1", "warning", 1),
      row("s1", "healthy", 2), // relabeled: only the latest counts
      row("s2", "failsafe", 1),
    ];
    const latest = [...latestLabelBySession(history).values()].map((r) => r.label);
    expect(countLabels(latest)).toEqual({
      healthy: 1,
      warning: 0,
      failsafe: 1,
      wiringSuspicion: 0,
      antennaSuspicion: 0,
      unknown: 0,
    });
  });
});

describe("labels are user data, and they die with their session", () => {
  it("deleting a session deletes its labels, children before the parent row", () => {
    const stmts = buildDeleteSessionStatements("sess-1");
    expect(stmts.map((s) => s.sql)).toEqual([
      "DELETE FROM telemetry WHERE session_id = $1",
      "DELETE FROM session_labels WHERE session_id = $1",
      "DELETE FROM telemetry_sessions WHERE session_id = $1",
    ]);
    // The parent row goes last, so an interrupted run can never orphan a label
    // behind a recording that no longer exists (which would also inflate the
    // readiness report's user-labeled count).
    expect(stmts[stmts.length - 1].sql).toContain("telemetry_sessions");
    for (const s of stmts) expect(s.params).toEqual(["sess-1"]);
  });

  it("`session_labels` is in the export/erase-all inventory (NFR-PRIV-02)", () => {
    expect([...USER_DATA_SQLITE_TABLES]).toContain(SESSION_LABELS_TABLE);
  });
});
