/**
 * File/log attachment helpers for the Omnia composer (M23).
 *
 * Frontend-only: the user attaches small text/log/csv/json files which are read
 * as text and folded into the outgoing message in a clearly delimited, capped
 * form (so a chatty PlatformIO log can't blow the prompt budget). The framing
 * is structural protocol text for the model — not localized UI chrome.
 */

/** Default cap on the characters folded into a message *per attachment block*. */
export const ATTACHMENT_CHAR_CAP = 8000;

/** Per-file byte ceiling read from disk — guards against huge files. */
export const ATTACHMENT_READ_BYTES = 256 * 1024;

/** One attached file held by the composer before send. */
export interface ChatAttachment {
  /** Local-only id for list keys / removal. */
  id: string;
  /** Original file name, shown in the removable chip. */
  name: string;
  /** File contents read as text (already byte-capped at read time). */
  content: string;
}

/**
 * Format one attachment as a delimited, truncated block for inclusion in an
 * outgoing message. Pure + testable. Content is capped at `cap` characters and
 * a truncation note is appended when it overflows; an empty/whitespace name
 * falls back to a generic label so the block is always well-formed.
 */
export function formatAttachment(
  name: string,
  content: string,
  cap = ATTACHMENT_CHAR_CAP
): string {
  const safeName = name.trim() || "attachment";
  const limit = Math.max(0, cap);
  const truncated = content.length > limit;
  const body = truncated ? content.slice(0, limit) : content;
  const note = truncated ? `\n… [truncated to ${limit} characters]` : "";
  return `--- attachment: ${safeName} ---\n${body}${note}\n--- end attachment ---`;
}
