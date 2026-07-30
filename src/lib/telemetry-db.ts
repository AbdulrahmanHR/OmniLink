/**
 * SQLite persistence for telemetry frames (M7-API), via `tauri-plugin-sql`.
 *
 * ## Why the write path lives here (JS) rather than in the Rust reader thread
 *
 * `tauri-plugin-sql` is a JS-first plugin: it owns the connection pool and
 * exposes it through the `@tauri-apps/plugin-sql` `Database` API. Reaching that
 * pool from the standalone `crsf-reader` OS thread would mean depending on the
 * plugin's private `DbInstances` state and driving `sqlx` by hand — a lot of
 * surface for little gain. The frontend already receives *every* frame over the
 * existing `device://link-stats` event, so we persist from there. The cost of
 * "going through JS" is eliminated by **batching**: frames are buffered and
 * written as a single multi-row INSERT, never one IPC round-trip per 25 Hz
 * frame and never on a render path.
 *
 * The schema/migration is registered in Rust (`src-tauri/src/db/mod.rs` +
 * `lib.rs`) so the table exists before the first write regardless of who opens
 * the DB first.
 */

import Database from "@tauri-apps/plugin-sql";
import { gpsHasFix } from "@/lib/telemetry-crsf";
import type { TelemetryFrame } from "@/stores/telemetry";

/**
 * SQLite connection URL. MUST match the string passed to
 * `Builder::add_migrations` in `src-tauri/src/db/mod.rs` so migrations apply to
 * the same database file.
 */
export const TELEMETRY_DB_URL = "sqlite:omnilink.db";

/** Flush the buffer once it reaches this many frames (a single INSERT). */
export const BATCH_SIZE = 50;

/** Also flush at least this often so a quiet/low-rate link still persists. */
export const FLUSH_INTERVAL_MS = 2_000;

/** Number of columns written per row (keep in sync with {@link buildTelemetryInsert}). */
const COLUMNS_PER_ROW = 14;

/**
 * Largest batch we may build in a single INSERT. SQLite's default
 * `SQLITE_MAX_VARIABLE_NUMBER` is 999 positional parameters; at
 * {@link COLUMNS_PER_ROW} params per row that caps a batch at
 * `floor(999 / 14) = 71` rows. Exceeding it makes the bound INSERT fail at
 * runtime, so {@link TelemetryBatchBuffer} rejects an over-large `maxBatch`
 * instead of silently losing batches.
 */
export const MAX_BATCH_ROWS = Math.floor(999 / COLUMNS_PER_ROW);

/** A frame paired with the session it belongs to, queued for insertion. */
export interface TelemetryRow {
  sessionId: string;
  frame: TelemetryFrame;
}

/**
 * Build a parameterised multi-row INSERT for a batch of telemetry rows.
 *
 * Pure and dependency-free so the batching/SQL shape is unit-testable without a
 * database. Uses `$n` positional placeholders (tauri-plugin-sql convention).
 * Returns `null` for an empty batch.
 */
export function buildTelemetryInsert(
  rows: TelemetryRow[]
): { sql: string; params: (number | string | null)[] } | null {
  if (rows.length === 0) return null;

  const placeholders: string[] = [];
  const params: (number | string | null)[] = [];

  rows.forEach((row, i) => {
    const base = i * COLUMNS_PER_ROW;
    const slots = Array.from(
      { length: COLUMNS_PER_ROW },
      (_, c) => `$${base + c + 1}`
    );
    placeholders.push(`(${slots.join(", ")})`);
    const { frame, sessionId } = row;
    // GPS columns (M11) are nullable: NULL on non-GPS devices / before a fix.
    // A powered-but-unlocked module reports (0,0) and `gpsFromTelemetry`
    // preserves it for the live "acquiring" readout — but the stored/exported
    // contract is NULL before a fix (see the migration-v3 comment and
    // `telemetry-session-csv.ts`). Gate on `gpsHasFix` so a pre-lock frame
    // persists NULL coords, never a bogus null-island `0,0` that would corrupt
    // an exported session CSV.
    const gps = frame.gps && gpsHasFix(frame.gps) ? frame.gps : null;
    params.push(
      sessionId,
      frame.t,
      frame.rssi1,
      frame.rssi2,
      frame.linkQuality,
      frame.snr,
      frame.txPower,
      frame.packetRate,
      gps ? gps.latitude : null,
      gps ? gps.longitude : null,
      gps ? gps.altitude : null,
      gps ? gps.satellites : null,
      gps ? gps.groundSpeed : null,
      gps ? gps.heading : null
    );
  });

  const sql =
    "INSERT INTO telemetry " +
    "(session_id, ts, rssi1, rssi2, link_quality, snr, tx_power, packet_rate, " +
    "lat, lon, alt, sats, ground_speed, heading) " +
    `VALUES ${placeholders.join(", ")}`;

  return { sql, params };
}

/**
 * Identifying metadata for one recording session, written to the
 * `telemetry_sessions` parent row that groups the frames in `telemetry`.
 */
export interface SessionMeta {
  /** Stable session id (also the `session_id` foreign key on each frame). */
  id: string;
  /** Connected device's CRSF target name, or "" when unknown. */
  targetName: string;
  /** Connected device's firmware version, or "" when unknown. */
  firmware: string;
}

/**
 * Build the parameterised INSERT that opens a `telemetry_sessions` row.
 *
 * Pure and dependency-free so the SQL shape is unit-testable without a
 * database. Uses `$n` positional placeholders (tauri-plugin-sql convention).
 * `INSERT OR REPLACE` keeps it idempotent: re-opening the same `sessionId`
 * overwrites the prior row (and re-seeds `frame_count` to 0) instead of
 * failing the primary-key constraint.
 */
export function buildSessionStartInsert(meta: {
  sessionId: string;
  startedAt: number;
  targetName: string;
  firmware: string;
}): { sql: string; params: (number | string | null)[] } {
  const sql =
    "INSERT OR REPLACE INTO telemetry_sessions " +
    "(session_id, started_at, target_name, firmware, frame_count) " +
    "VALUES ($1, $2, $3, $4, 0)";
  return {
    sql,
    params: [meta.sessionId, meta.startedAt, meta.targetName, meta.firmware],
  };
}

/**
 * Build the parameterised UPDATE that closes a `telemetry_sessions` row,
 * stamping its end time and final frame count.
 *
 * Pure and dependency-free. Uses `$n` positional placeholders.
 */
export function buildSessionEndUpdate(meta: {
  sessionId: string;
  endedAt: number;
  frameCount: number;
}): { sql: string; params: (number | string | null)[] } {
  const sql =
    "UPDATE telemetry_sessions SET ended_at = $1, frame_count = $2 " +
    "WHERE session_id = $3";
  return { sql, params: [meta.endedAt, meta.frameCount, meta.sessionId] };
}

/**
 * Sink invoked with each drained batch. Returns a promise so failures can be
 * awaited/swallowed by the caller. Injectable for tests.
 */
export type BatchSink = (rows: TelemetryRow[]) => Promise<void> | void;

/**
 * Size-triggered batch buffer with an explicit flush.
 *
 * Pure (no timers, no DB) so the threshold/drain behaviour is unit-testable.
 * `add` flushes automatically once {@link maxBatch} is reached; `flush` drains
 * whatever remains. Draining swaps the internal array so a slow sink never sees
 * frames added after it was invoked.
 */
export class TelemetryBatchBuffer {
  private buf: TelemetryRow[] = [];
  /** The most recent sink invocation, so {@link drain} can await it. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: BatchSink,
    private readonly maxBatch: number = BATCH_SIZE
  ) {
    if (
      !Number.isInteger(maxBatch) ||
      maxBatch < 1 ||
      maxBatch > MAX_BATCH_ROWS
    ) {
      throw new RangeError(
        `maxBatch must be an integer in 1..${MAX_BATCH_ROWS} ` +
          `(SQLite bound-parameter limit); got ${maxBatch}`
      );
    }
  }

  /** Queue a frame; auto-flushes when the batch size is reached. */
  add(row: TelemetryRow): void {
    this.buf.push(row);
    if (this.buf.length >= this.maxBatch) {
      this.flush();
    }
  }

  /** Drain and hand off the current buffer; no-op when empty. */
  flush(): void {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    // Invoke the sink synchronously, then fold this insert into `inFlight`
    // *together with* whatever was already pending. Folding (not overwriting)
    // is what lets drain() await EVERY in-flight batch: a fast second flush
    // used to replace the promise reference, abandoning the earlier insert so
    // drain() could return before it finished and lose that batch on close.
    const previous = this.inFlight;
    const current = Promise.resolve(this.sink(batch)).then(
      () => undefined,
      () => undefined
    );
    this.inFlight = Promise.all([previous, current]).then(() => undefined);
  }

  /**
   * Flush whatever remains and await the final insert. Use on teardown so the
   * last partial batch is durably written before the DB connection closes —
   * otherwise the trailing frames (up to {@link maxBatch}-1) race the close and
   * can be silently lost.
   */
  async drain(): Promise<void> {
    this.flush();
    await this.inFlight;
  }

  /** Number of frames not yet flushed. */
  get pending(): number {
    return this.buf.length;
  }
}

/** A live persistence handle bound to one connection session. */
export interface TelemetryPersistence {
  /** Queue a frame for the given session. */
  record: (frame: TelemetryFrame) => void;
  /** Flush remaining frames and stop the interval timer. */
  close: () => Promise<void>;
}

/**
 * Open the telemetry DB and return a batching persistence handle for one
 * connection session. Buffers frames and writes them as batched multi-row
 * INSERTs, flushing on size ({@link BATCH_SIZE}) or on a timer
 * ({@link FLUSH_INTERVAL_MS}). All DB work is best-effort: a failed open or
 * insert is logged and never propagated to the telemetry UI.
 *
 * On open the parent `telemetry_sessions` row is inserted; on close it is
 * updated with the end time and the final frame count (every frame handed to
 * {@link TelemetryPersistence.record} is counted, one per persisted frame).
 * Both session-row writes are additional best-effort executes layered on top
 * of the unchanged batching/flush/drain frame path.
 */
export async function openTelemetryPersistence(
  session: SessionMeta
): Promise<TelemetryPersistence> {
  let db: Database | null = null;
  try {
    db = await Database.load(TELEMETRY_DB_URL);
  } catch (e) {
    console.error("[telemetry] failed to open SQLite database", e);
  }

  // Open the parent session row (best-effort) before any frames are written.
  if (db) {
    const start = buildSessionStartInsert({
      sessionId: session.id,
      startedAt: Date.now(),
      targetName: session.targetName,
      firmware: session.firmware,
    });
    try {
      await db.execute(start.sql, start.params);
    } catch (e) {
      console.error("[telemetry] session start insert failed", e);
    }
  }

  // Count every frame handed to record(), one per persisted frame.
  let frameCount = 0;

  const sink: BatchSink = async (rows) => {
    if (!db) return;
    const stmt = buildTelemetryInsert(rows);
    if (!stmt) return;
    try {
      await db.execute(stmt.sql, stmt.params);
    } catch (e) {
      console.error("[telemetry] batched insert failed", e);
    }
  };

  const buffer = new TelemetryBatchBuffer(sink);
  const timer = setInterval(() => buffer.flush(), FLUSH_INTERVAL_MS);

  return {
    record: (frame) => {
      frameCount += 1;
      buffer.add({ sessionId: session.id, frame });
    },
    close: async () => {
      clearInterval(timer);
      // Await the final insert before closing so the trailing partial batch is
      // not dropped (see TelemetryBatchBuffer.drain).
      await buffer.drain();
      if (db) {
        // Stamp the session's end time + final frame count (best-effort).
        const end = buildSessionEndUpdate({
          sessionId: session.id,
          endedAt: Date.now(),
          frameCount,
        });
        try {
          await db.execute(end.sql, end.params);
        } catch (e) {
          console.error("[telemetry] session end update failed", e);
        }
      }
    },
  };
}
