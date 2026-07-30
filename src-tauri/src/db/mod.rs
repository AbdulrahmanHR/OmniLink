//! Database layer + migrations (SQLite via `tauri-plugin-sql`).
//!
//! M7-API: persists real telemetry frames decoded from the serial port. The
//! schema is created by the migrations registered here at plugin-build time, so
//! the `telemetry` table exists before the frontend's batching writer
//! (`src/lib/telemetry-db.ts`) issues its first INSERT.
//!
//! The connection URL **must** match `TELEMETRY_DB_URL` in
//! `src/lib/telemetry-db.ts` (`sqlite:omnilink.db`) so the JS `Database.load`
//! call targets the same, already-migrated database file.

use tauri_plugin_sql::{Migration, MigrationKind};

/// SQLite connection URL shared with the frontend writer.
pub const TELEMETRY_DB_URL: &str = "sqlite:omnilink.db";

/// Ordered schema migrations for the telemetry database.
///
/// Version 1 creates the `telemetry` table plus a `(session_id, ts)` index for
/// efficient per-session, time-ordered reads. RSSI/SNR are stored signed
/// (dBm / dB) exactly as the UI consumes them; `tx_power` is mW and
/// `packet_rate` is Hz (decoded from the CRSF enum indices in
/// `src/lib/telemetry-crsf.ts`). `session_id` groups all frames from one
/// connection session.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create telemetry table",
            sql: "CREATE TABLE IF NOT EXISTS telemetry (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT    NOT NULL,
                ts           INTEGER NOT NULL,
                rssi1        INTEGER NOT NULL,
                rssi2        INTEGER NOT NULL,
                link_quality INTEGER NOT NULL,
                snr          REAL    NOT NULL,
                tx_power     INTEGER NOT NULL,
                packet_rate  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_telemetry_session_ts
                ON telemetry (session_id, ts);",
            kind: MigrationKind::Up,
        },
        // Version 2 (M9-API): persist Omnia chat history so conversations
        // survive an app restart. A `conversations` row groups an ordered set of
        // `messages`; the frontend writer is `src/lib/chat-db.ts`. `suggestion`
        // holds the optional validated config-suggestion JSON for an assistant
        // turn (FR-AI-04). `ON DELETE CASCADE` lets clearing a conversation drop
        // its messages in one statement.
        Migration {
            version: 2,
            description: "create chat history tables",
            sql: "CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT    PRIMARY KEY,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                title      TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT    PRIMARY KEY,
                conversation_id TEXT    NOT NULL
                                  REFERENCES conversations (id) ON DELETE CASCADE,
                role            TEXT    NOT NULL,
                content         TEXT    NOT NULL,
                ts              INTEGER NOT NULL,
                is_error        INTEGER NOT NULL DEFAULT 0,
                suggestion      TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts
                ON messages (conversation_id, ts);",
            kind: MigrationKind::Up,
        },
        // Version 3 (M11): GPS telemetry + session scaffolding. Adds nullable
        // GPS columns to `telemetry` (NULL on non-GPS devices / before a fix —
        // see `src/lib/telemetry-db.ts`): lat/lon in decimal degrees, `alt` in
        // metres, `ground_speed` in km/h and `heading` in degrees (already
        // scaled from the raw CRSF wire integers in `src/lib/telemetry-crsf.ts`).
        // `telemetry_sessions` is forward-looking scaffolding for per-recording
        // metadata (target/firmware/frame count); nothing writes or reads it yet
        // — the live writer only INSERTs frames into `telemetry`. Wiring a
        // session-metadata writer (INSERT on connect / UPDATE on disconnect) plus
        // a DB->CSV session export is a pending follow-up; until then no code
        // path consumes the table.
        Migration {
            version: 3,
            description: "add gps columns and telemetry_sessions table",
            sql: "ALTER TABLE telemetry ADD COLUMN lat          REAL;
            ALTER TABLE telemetry ADD COLUMN lon          REAL;
            ALTER TABLE telemetry ADD COLUMN alt          REAL;
            ALTER TABLE telemetry ADD COLUMN sats         INTEGER;
            ALTER TABLE telemetry ADD COLUMN ground_speed REAL;
            ALTER TABLE telemetry ADD COLUMN heading      REAL;
            CREATE TABLE IF NOT EXISTS telemetry_sessions (
                session_id  TEXT    PRIMARY KEY,
                started_at  INTEGER NOT NULL,
                ended_at    INTEGER,
                target_name TEXT,
                firmware    TEXT,
                frame_count INTEGER NOT NULL DEFAULT 0
            );",
            kind: MigrationKind::Up,
        },
        // Version 4 (M24): session management. Adds a nullable, user-set `name`
        // label to `telemetry_sessions` so a recorded session can be renamed
        // in-app (NULL = unnamed; falls back to the device target/firmware line
        // in the UI). This is semantically distinct from `target_name` (the
        // device's CRSF target), so it gets its own column rather than reusing
        // it. Delete/rename/retention all run from the JS seam
        // (`src/lib/sessions-db.ts`) via `db.execute`, so this column is the
        // only schema change M24 needs.
        Migration {
            version: 4,
            description: "add session name column",
            sql: "ALTER TABLE telemetry_sessions ADD COLUMN name TEXT;",
            kind: MigrationKind::Up,
        },
        // Version 5 (M51): RAG citations. Persist the retrieved-source citation
        // cards (+ the D19 "no source found" flag) alongside each assistant turn
        // so a restored conversation still shows which trusted excerpts backed an
        // answer. `citations` holds the optional citation-array JSON (mirrors how
        // `suggestion` stores its JSON in version 2); `no_source_found` is the
        // D19 flag. Both are nullable — pre-M51 rows and non-RAG turns carry NULL.
        // The frontend writer/reader is `src/lib/chat-db.ts`.
        Migration {
            version: 5,
            description: "add rag citations columns to messages",
            sql: "ALTER TABLE messages ADD COLUMN citations TEXT;
            ALTER TABLE messages ADD COLUMN no_source_found INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        // Version 6 (v2.5 / M56c): ML session labels — the local labeling tool.
        //
        // ## Why a SEPARATE TABLE and not a `label` column on `telemetry_sessions`
        //
        // 1. **`unknown` is a real label, and NULL is not it.** The canonical union
        //    (`src/lib/ml/dataset.ts::ML_LABELS`) contains `unknown` — a human
        //    asserting "I looked and I cannot tell". A nullable column would have
        //    to represent BOTH that and "nobody has looked yet" with the same NULL,
        //    and those are different facts: the first is a data point, the second is
        //    an empty seat. Conflating them corrupts the denominator of the very
        //    readiness report this milestone exists to produce.
        //
        // 2. **A label is an ASSERTION ABOUT a recording, not a property OF it.**
        //    `telemetry_sessions` is a factual record of what the radio did. A label
        //    is what a person later claimed about it — a different author, a
        //    different provenance, and (below) a different lifetime. Keeping the
        //    recording pure means a labeling mistake can never damage the recording.
        //
        // 3. **Relabeling needs history, and a column cannot carry it.** A label is
        //    revised (a session first read as `warning` turns out to be an antenna
        //    null). An UPDATE-in-place destroys the prior claim, so a model artifact
        //    can no longer name the label set it trained on and the corpus stops
        //    being reproducible. Rows here are therefore **append-only**: each
        //    (session_id, revision) is one immutable assertion, and "the label" is
        //    the highest revision for that session (`latestLabelBySession` in
        //    `src/lib/session-labels.ts`). Nothing UPDATEs this table.
        //
        // ## Identifier-free by construction
        // `session_id` + a canonical label + a monotonic revision + a local
        // timestamp. There is deliberately **NO free-text note column**: a free-text
        // box is exactly how a pilot's name, a field location, or a callsign gets
        // into a dataset. The `CHECK` pins `label` to the six canonical values, so
        // the column *physically cannot store a sentence* — the privacy invariant is
        // enforced by the schema, not by a code review. The label list is mirrored
        // by `ML_LABELS`; `tests/unit/ml/sessionLabels.test.ts` reads THIS file and
        // fails if the two ever drift.
        //
        // Labels are local-only (nothing is uploaded), the writer/reader is the JS
        // seam `src/lib/session-labels.ts` (`tauri-plugin-sql`, the established
        // pattern — there are no telemetry Rust commands), and `session_labels` is
        // registered in `USER_DATA_SQLITE_TABLES` so export/erase-all cover it.
        Migration {
            version: 6,
            description: "create session_labels table",
            sql: "CREATE TABLE IF NOT EXISTS session_labels (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT    NOT NULL
                             REFERENCES telemetry_sessions (session_id) ON DELETE CASCADE,
                label      TEXT    NOT NULL
                             CHECK (label IN ('healthy','warning','failsafe',
                                              'wiringSuspicion','antennaSuspicion','unknown')),
                revision   INTEGER NOT NULL,
                labeled_at INTEGER NOT NULL,
                UNIQUE (session_id, revision)
            );",
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The db URL is the one the JS seams (`telemetry-db.ts` / `sessions-db.ts` /
    /// `session-labels.ts`) load; a drift here silently splits the app across two
    /// database files, one of which is never migrated.
    #[test]
    fn telemetry_db_url_matches_the_js_seam() {
        assert_eq!(TELEMETRY_DB_URL, "sqlite:omnilink.db");
    }

    /// Migrations must be contiguous from 1, strictly ascending, and all `Up`.
    /// `tauri-plugin-sql` applies them by version, so a duplicate or out-of-order
    /// version is a corrupted upgrade path on an existing user's database.
    #[test]
    fn migrations_are_contiguous_ascending_and_up() {
        let migrations = migrations();
        assert_eq!(migrations.len(), 6, "v6 is the newest migration");
        for (i, m) in migrations.iter().enumerate() {
            assert_eq!(m.version, (i + 1) as i64, "version {} out of order", i + 1);
            assert!(
                matches!(m.kind, MigrationKind::Up),
                "migration {} must be an Up migration",
                m.version
            );
            assert!(!m.description.is_empty());
        }
    }

    /// v6 creates `session_labels` with the shape M56c defends: append-only
    /// (session_id, revision) assertions, a canonical-label CHECK, and **no
    /// free-text column**.
    #[test]
    fn v6_creates_session_labels_with_a_canonical_label_check() {
        let m = migrations()
            .into_iter()
            .find(|m| m.version == 6)
            .expect("migration v6 exists");
        assert_eq!(m.description, "create session_labels table");

        let sql = m.sql;
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS session_labels"));
        // Append-only history: one immutable assertion per (session, revision).
        assert!(sql.contains("UNIQUE (session_id, revision)"));
        assert!(sql.contains("revision   INTEGER NOT NULL"));
        // Deleting a recording takes its labels with it.
        assert!(sql.contains("ON DELETE CASCADE"));
        // The six canonical labels, and nothing else, can be stored.
        for label in [
            "healthy",
            "warning",
            "failsafe",
            "wiringSuspicion",
            "antennaSuspicion",
            "unknown",
        ] {
            assert!(
                sql.contains(&format!("'{label}'")),
                "canonical label {label} missing from the CHECK"
            );
        }
        assert!(sql.contains("CHECK (label IN ("));
    }

    /// The privacy invariant, asserted rather than trusted: nothing in the label
    /// schema can hold prose, coordinates, or a device/user identifier.
    #[test]
    fn v6_has_no_free_text_or_identifier_columns() {
        let raw = migrations()
            .into_iter()
            .find(|m| m.version == 6)
            .expect("migration v6 exists")
            .sql
            .to_lowercase();
        // Collapse runs of whitespace so `note       TEXT` cannot slip past a
        // single-space match.
        let sql: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        for forbidden in [
            "note",
            "comment",
            "text_note",
            "name",
            "pilot",
            "lat",
            "lon",
            "gps",
            "uid",
            "mac",
            "ip",
            "email",
            "serial",
            "binding",
        ] {
            assert!(
                !sql.contains(&format!("{forbidden} text")),
                "session_labels must not carry a `{forbidden}` free-text/identifier column"
            );
        }
    }
}
