/**
 * User-imported document parsing for local RAG (M52, D18).
 *
 * Turns a local `.txt`/`.md` note into the SAME retrieval {@link Chunk} shape as
 * a trusted pack (reusing the M50 `chunkMarkdown`), tagged with the
 * `user-imported` trust level. Pure + deterministic + NO I/O: the file bytes are
 * read by the caller (the desktop `knowledge_read_doc` Rust command, or the
 * browser File API in dev); this module only validates + chunks the text.
 *
 * SAFETY (the D18 core): imported docs are UNTRUSTED context.
 *  - {@link parseImportedDoc} ALWAYS stamps `trustLevel: "user-imported"` — it
 *    never reads a trust claim from the file content — so nothing an imported
 *    doc SAYS can make it official/trusted (the trust-escalation guard).
 *  - Import bounds ({@link MAX_IMPORTED_DOC_BYTES}, {@link MAX_IMPORTED_DOCS},
 *    the extension allowlist) mirror the existing per-field discipline
 *    (`MAX_FIELD_LEN` / `MAX_DEFINES`), bounding cost and the injection surface.
 *  - The chunks flow through the EXACT SAME retrieval → `sanitize_retrieved_docs`
 *    → `<retrieved_docs untrusted>` fence as trusted packs; there is no second,
 *    weaker path for imported content.
 */

import { chunkMarkdown, type Chunk } from "./chunk";
import type { TrustLevel } from "./types";

/**
 * Hard cap on a single imported doc's size (bytes). 256 KB comfortably covers a
 * long manual page while bounding the localStorage footprint and the token/
 * injection surface. Enforced Rust-side too (`knowledge_read_doc`) as defense in
 * depth, and mirrored on the browser File-API path.
 */
export const MAX_IMPORTED_DOC_BYTES = 256 * 1024;

/** Max number of imported docs kept at once (bounds the local index + storage). */
export const MAX_IMPORTED_DOCS = 20;

/** The only extensions accepted for import (text/Markdown only — DI-3; PDF deferred). */
export const ALLOWED_IMPORT_EXTENSIONS = [".txt", ".md", ".markdown"] as const;

/** Extensions passed to the native file dialog (no leading dot). */
export const IMPORT_DIALOG_EXTENSIONS = ["txt", "md", "markdown"] as const;

/** Prefix that marks a source id as user-imported (`imported:<uuid>`). */
export const IMPORTED_SOURCE_PREFIX = "imported:";

/** Upper bound for a derived title (a heading/filename can be arbitrarily long). */
const MAX_IMPORTED_TITLE_CHARS = 120;

/**
 * One user-imported source: its metadata plus the retrieval {@link Chunk}s it
 * contributes. Persisted LOCALLY (never uploaded). `trustLevel` is fixed to
 * `user-imported` by construction and is the invariant the escalation guard
 * pins.
 */
export interface ImportedSource {
  /** Generated stable id, `imported:<uuid>`. Also the chunks' `sourceId`. */
  id: string;
  /** User-facing title: the first Markdown heading, else the filename. */
  title: string;
  /** ALWAYS `user-imported` — stamped here, never read from content. */
  trustLevel: Extract<TrustLevel, "user-imported">;
  /** Size of the imported text in bytes (UTF-8). */
  byteSize: number;
  /** Import time (ms since epoch). */
  importedAt: number;
  /** The retrieval chunks (same shape/ids as trusted-pack chunks). */
  chunks: Chunk[];
}

/** Why an import was rejected (drives the localized error surface). */
export type ImportRejectReason = "extension" | "too-large" | "empty" | "limit";

/** The outcome of an import attempt. */
export type ImportResult =
  | { ok: true; source: ImportedSource }
  | { ok: false; reason: ImportRejectReason };

/** True when a source id is a user-imported one (`imported:` prefix). */
export function isImportedSourceId(id: string): boolean {
  return id.startsWith(IMPORTED_SOURCE_PREFIX);
}

/** True when a filename ends in an allowed import extension (case-insensitive). */
export function importedExtensionAllowed(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ALLOWED_IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** UTF-8 byte length of a string (matches the Rust byte cap). */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Basename of a path (posix or windows separators), extension stripped. */
function baseName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Collapse whitespace and truncate a derived title to a sane length. */
function boundTitle(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_IMPORTED_TITLE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_IMPORTED_TITLE_CHARS).trimEnd()}…`;
}

/**
 * Derive a user-facing title: the first Markdown ATX heading when the doc OPENS
 * with one, else the filename (extension stripped). Bounded in length. This is
 * DATA (rendered as-is, like a trusted source's title), not an instruction — the
 * heading is never interpreted.
 */
export function deriveTitle(fileName: string, content: string): string {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) return boundTitle(m[2]);
    break; // only the leading block may supply a heading title
  }
  const name = baseName(fileName).trim();
  return boundTitle(name.length > 0 ? name : fileName || "note");
}

/** Generate a stable `imported:<uuid>` id (crypto UUID, with a dev fallback). */
export function generateImportedId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${IMPORTED_SOURCE_PREFIX}${uuid}`;
}

/**
 * Parse imported text into an {@link ImportedSource}. Validates the extension
 * and byte bound, rejects empty content, then chunks the prose with the SAME
 * `chunkMarkdown` used for trusted packs. The trust level is stamped
 * `user-imported` UNCONDITIONALLY — content is never consulted for it — so an
 * imported doc can never escalate its own trust.
 *
 * `now`/`id` are injectable so the result is deterministic under test.
 */
export function parseImportedDoc(
  fileName: string,
  content: string,
  now: number = Date.now(),
  id: string = generateImportedId(),
): ImportResult {
  if (!importedExtensionAllowed(fileName)) return { ok: false, reason: "extension" };
  const byteSize = byteLength(content);
  if (byteSize > MAX_IMPORTED_DOC_BYTES) return { ok: false, reason: "too-large" };
  if (content.trim().length === 0) return { ok: false, reason: "empty" };

  const title = deriveTitle(fileName, content);
  // SAFETY: `user-imported` is fixed here — NEVER derived from `content`.
  const chunks = chunkMarkdown(id, title, content);
  if (chunks.length === 0) return { ok: false, reason: "empty" };

  return {
    ok: true,
    source: {
      id,
      title,
      trustLevel: "user-imported",
      byteSize,
      importedAt: now,
      chunks,
    },
  };
}
