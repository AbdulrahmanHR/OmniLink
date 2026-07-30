/**
 * Message-content parsing for Omnia bubbles (M23).
 *
 * Pure + dependency-free so the parser is trivially unit-testable. Splits a
 * message into a flat list of segments the renderer maps to DOM:
 *   - fenced ```code blocks``` → a styled <pre> with a Copy button,
 *   - inline `code` spans → a mono <code>,
 *   - everything else → plain text.
 * An unterminated fence is deliberately treated as plain text (no half-open
 * code block), matching how chat models stream partial output.
 */

/** One renderable piece of a message. */
export interface Segment {
  kind: "text" | "inlineCode" | "codeBlock";
  /** Segment text (code blocks exclude the fences + language line). */
  content: string;
  /** Language tag for a fenced block, when one was supplied (e.g. `bash`). */
  lang?: string;
}

const FENCE = "```";

/**
 * Split a plain-text run into text + inline-`code` segments. Odd-indexed
 * backtick splits are code (mirrors the original single-backtick handling).
 */
function pushText(segments: Segment[], text: string): void {
  if (text.length === 0) return;
  const parts = text.split("`");
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      segments.push({ kind: "inlineCode", content: part });
    } else if (part.length > 0) {
      segments.push({ kind: "text", content: part });
    }
  });
}

/**
 * Parse message `content` into ordered segments. Pure.
 *
 * Fenced blocks open with ``` optionally followed by a language token on the
 * same line; the first newline ends the language line. An opening fence with no
 * closing fence is emitted verbatim as a single text segment.
 */
export function parseMessageSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let textStart = 0;

  while (i < content.length) {
    if (!content.startsWith(FENCE, i)) {
      i += 1;
      continue;
    }

    const close = content.indexOf(FENCE, i + FENCE.length);
    if (close === -1) {
      // Unterminated fence: flush preceding text, then the remainder verbatim.
      pushText(segments, content.slice(textStart, i));
      segments.push({ kind: "text", content: content.slice(i) });
      return segments;
    }

    // Flush the text that precedes this block.
    pushText(segments, content.slice(textStart, i));

    const inner = content.slice(i + FENCE.length, close);
    const nl = inner.indexOf("\n");
    let lang: string | undefined;
    let code: string;
    if (nl === -1) {
      // Single-line ```code``` — no language line.
      code = inner;
    } else {
      // The opening line is the info string (consumed); a clean single-token
      // value becomes the language tag, otherwise it's dropped (markdown rule).
      const firstLine = inner.slice(0, nl).trim();
      if (firstLine.length > 0 && !/\s/.test(firstLine)) lang = firstLine;
      code = inner.slice(nl + 1);
    }
    // Drop the single newline that typically precedes the closing fence.
    code = code.replace(/\n$/, "");
    segments.push({ kind: "codeBlock", content: code, lang });

    i = close + FENCE.length;
    textStart = i;
  }

  pushText(segments, content.slice(textStart));
  return segments;
}
