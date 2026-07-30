/**
 * SQLite persistence for Omnia chat history (M9-API), via `tauri-plugin-sql`.
 *
 * Mirrors the telemetry writer (`src/lib/telemetry-db.ts`): the schema +
 * migration are registered in Rust (`src-tauri/src/db/mod.rs`) so the
 * `conversations`/`messages` tables exist before the first write. We persist
 * from the frontend because `tauri-plugin-sql` owns the connection pool on the
 * JS side; chat volume is tiny (one row per turn) so no batching is needed.
 *
 * Every operation is best-effort: a failed open/insert is logged and swallowed
 * so the assistant keeps working (e.g. when running outside Tauri) — history is
 * a convenience, never a correctness dependency.
 */

import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage } from "@/stores/assistant";
import type { UserDefineSuggestion } from "@/lib/ai";
import type { RetrievedChunk } from "@/lib/knowledge";

/** Shared connection URL — MUST match `TELEMETRY_DB_URL` (same database file). */
export const CHAT_DB_URL = "sqlite:omnilink.db";

/** A stored conversation header (newest-first listings use `updatedAt`). */
export interface ConversationMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
}

/** Row shape as returned by `SELECT` from the `messages` table. */
interface MessageRow {
  id: string;
  role: string;
  content: string;
  ts: number;
  is_error: number;
  suggestion: string | null;
  /** RAG citations JSON blob (M51); mirrors how `suggestion` is stored. */
  citations: string | null;
  /** D19 "no source found" flag (M51). */
  no_source_found: number;
}

/** Lazily-opened shared handle; null once an open has failed (don't retry-spam). */
let dbPromise: Promise<Database | null> | null = null;

async function db(): Promise<Database | null> {
  if (!dbPromise) {
    dbPromise = Database.load(CHAT_DB_URL).catch((e) => {
      console.error("[chat] failed to open SQLite database", e);
      return null;
    });
  }
  return dbPromise;
}

/** Insert a new, empty conversation. Returns false if persistence is unavailable. */
export async function createConversation(
  id: string,
  createdAt: number
): Promise<boolean> {
  const conn = await db();
  if (!conn) return false;
  try {
    await conn.execute(
      "INSERT INTO conversations (id, created_at, updated_at, title) VALUES ($1, $2, $2, NULL)",
      [id, createdAt]
    );
    return true;
  } catch (e) {
    console.error("[chat] createConversation failed", e);
    return false;
  }
}

/**
 * Append one message to a conversation and bump the conversation's `updated_at`.
 * The first user message also seeds the conversation title (trimmed to 80 chars)
 * so a future history list has something to show.
 */
export async function saveMessage(
  conversationId: string,
  message: ChatMessage
): Promise<void> {
  const conn = await db();
  if (!conn) return;
  try {
    await conn.execute(
      "INSERT INTO messages " +
        "(id, conversation_id, role, content, ts, is_error, suggestion, citations, no_source_found) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        message.id,
        conversationId,
        message.role,
        message.content,
        message.timestamp,
        message.isError ? 1 : 0,
        message.suggestion ? JSON.stringify(message.suggestion) : null,
        // Persist RAG citations exactly like `suggestion` — a JSON blob column.
        message.citations && message.citations.length > 0
          ? JSON.stringify(message.citations)
          : null,
        message.noSourceFound ? 1 : 0,
      ]
    );
    // Title the conversation from its first user turn, if still untitled.
    if (message.role === "user") {
      await conn.execute(
        "UPDATE conversations SET updated_at = $2, " +
          "title = COALESCE(title, $3) WHERE id = $1",
        [conversationId, message.timestamp, message.content.slice(0, 80)]
      );
    } else {
      await conn.execute(
        "UPDATE conversations SET updated_at = $2 WHERE id = $1",
        [conversationId, message.timestamp]
      );
    }
  } catch (e) {
    console.error("[chat] saveMessage failed", e);
  }
}

/** Load every message of a conversation, oldest-first. */
export async function loadMessages(
  conversationId: string
): Promise<ChatMessage[]> {
  const conn = await db();
  if (!conn) return [];
  try {
    const rows = await conn.select<MessageRow[]>(
      "SELECT id, role, content, ts, is_error, suggestion, citations, no_source_found " +
        "FROM messages WHERE conversation_id = $1 ORDER BY ts ASC, id ASC",
      [conversationId]
    );
    return rows.map(rowToMessage);
  } catch (e) {
    console.error("[chat] loadMessages failed", e);
    return [];
  }
}

/** The most-recently-updated conversation id, or null if there are none. */
export async function latestConversationId(): Promise<string | null> {
  const conn = await db();
  if (!conn) return null;
  try {
    const rows = await conn.select<{ id: string }[]>(
      "SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1"
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    console.error("[chat] latestConversationId failed", e);
    return null;
  }
}

/** All conversation headers, newest-first — for a history/switcher UI. */
export async function listConversations(): Promise<ConversationMeta[]> {
  const conn = await db();
  if (!conn) return [];
  try {
    const rows = await conn.select<
      { id: string; created_at: number; updated_at: number; title: string | null }[]
    >(
      "SELECT id, created_at, updated_at, title FROM conversations " +
        "ORDER BY updated_at DESC"
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      title: r.title,
    }));
  } catch (e) {
    console.error("[chat] listConversations failed", e);
    return [];
  }
}

/** Delete a conversation and (via ON DELETE CASCADE) its messages. */
export async function deleteConversation(id: string): Promise<void> {
  const conn = await db();
  if (!conn) return;
  try {
    await conn.execute("DELETE FROM conversations WHERE id = $1", [id]);
  } catch (e) {
    console.error("[chat] deleteConversation failed", e);
  }
}

/**
 * Map a raw DB row to a `ChatMessage`, parsing the optional suggestion JSON and
 * (M51) the RAG citations JSON — both stored/parsed the same best-effort way.
 */
function rowToMessage(row: MessageRow): ChatMessage {
  let suggestion: UserDefineSuggestion | undefined;
  if (row.suggestion) {
    try {
      suggestion = JSON.parse(row.suggestion) as UserDefineSuggestion;
    } catch {
      suggestion = undefined;
    }
  }
  let citations: RetrievedChunk[] | undefined;
  // `citations` is a new column (migration v5); older rows / off-Tauri hosts
  // return it as null/undefined, which degrades gracefully to no citations.
  if (row.citations) {
    try {
      const parsed = JSON.parse(row.citations) as RetrievedChunk[];
      if (Array.isArray(parsed) && parsed.length > 0) citations = parsed;
    } catch {
      citations = undefined;
    }
  }
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    timestamp: row.ts,
    isError: row.is_error === 1,
    suggestion,
    citations,
    noSourceFound: row.no_source_found === 1,
  };
}
