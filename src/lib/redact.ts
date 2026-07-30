/**
 * Shared redaction primitives (NFR-PRIV-01).
 *
 * The shape-based identifier detector and free-text scrubber every outbound path
 * in this app is built on. This is the pure TypeScript half; the AUTHORITATIVE
 * redaction is `sanitize_context()` in `src-tauri/src/commands/ai.rs`, and these
 * functions MIRROR its `looks_like_identifier` / `scrub_value` /
 * `cap_and_neutralize` exactly. **The two must stay in lockstep: a value scrubbed
 * there must be scrubbed identically here.** The mirror exists because the
 * preview/test/off-Tauri data path runs entirely in the webview and never reaches
 * Rust — the same parity precedent as `lib/aiContext.ts` ↔ `sanitize_context()`.
 *
 * Discipline (ported from the Rust baseline):
 *  - detect MAC / IPv4 / IPv6 / email / GPS-coordinate shapes and replace them
 *    with `[redacted]`, including a coordinate pair split across two tokens; and
 *  - neutralize markup + cap length so a crafted field can't smuggle structure.
 *
 * Everything here is PURE and deterministic — no clock, no IO.
 *
 * **History (v3.0 / M69).** These three exports lived in `lib/syncSanitize.ts`
 * until the platform excision deleted the cloud-sync stack. They were never
 * sync-specific: `lib/knowledge/retrievalSanitize.ts` (the v2.4 RAG redaction
 * gate) and the shared privacy-audit harness `tests/unit/_privacy.ts` both build
 * on them. Deleting their old host would have taken load-bearing privacy code
 * with it, so they were relocated here — moved verbatim, behaviour unchanged —
 * and only the cloud-sync profile sanitizer around them was deleted.
 */

/** Placeholder substituted for any token that matches a sensitive shape. */
export const REDACTED = "[redacted]";

/** Max characters kept from any single scrubbed field (mirrors Rust MAX_FIELD_LEN). */
const MAX_FIELD_LEN = 200;

/** Trim leading/trailing non-alphanumerics so shape checks see the bare value. */
function stripPunctuation(s: string): string {
  return s.replace(/^[^0-9a-zA-Z]+/, "").replace(/[^0-9a-zA-Z]+$/, "");
}

/** A decimal number with a fractional part in the lat/long magnitude range. */
function isCoordinate(token: string): boolean {
  const cleaned = stripPunctuation(token);
  if (!cleaned.includes(".")) return false;
  const n = Number(cleaned);
  return !Number.isNaN(n) && Math.abs(n) <= 180;
}

/** IPv6 shape: colon-separated 1–4 hex groups with `::` or at least 3 colons. */
function isIpv6(token: string): boolean {
  if (!token.includes(":")) return false;
  const colons = (token.match(/:/g) ?? []).length;
  if (!token.includes("::") && colons < 3) return false;
  const groups = token.split(":").filter((g) => g !== "");
  return (
    groups.length > 0 &&
    groups.every((g) => g.length <= 4 && /^[0-9a-fA-F]+$/.test(g))
  );
}

/**
 * Shape-based detector for MAC / IPv4 / IPv6 / email / GPS-coordinate tokens.
 * Mirrors `looks_like_identifier` in `commands/ai.rs`.
 */
export function looksLikeIdentifier(token: string): boolean {
  if (token === "") return false;
  // Email: contains '@' with a '.' after it.
  const at = token.indexOf("@");
  if (at >= 0 && token.slice(at + 1).includes(".")) return true;
  // MAC: six colon/dash-separated hex pairs.
  const macParts = token.split(/[:-]/);
  if (
    macParts.length === 6 &&
    macParts.every((p) => /^[0-9a-fA-F]{2}$/.test(p))
  ) {
    return true;
  }
  // IPv4: four dot-separated 0..=255 octets.
  const octets = token.split(".");
  if (
    octets.length === 4 &&
    octets.every((o) => o !== "" && /^\d+$/.test(o) && Number(o) <= 255)
  ) {
    return true;
  }
  // IPv6.
  if (isIpv6(token)) return true;
  // GPS-ish: a long signed decimal with a fractional part (lat/long).
  if (token.includes(".")) {
    const n = Number(token);
    if (!Number.isNaN(n)) {
      const fracLen = token.split(".")[1]?.length ?? 0;
      if (fracLen >= 4 && Math.abs(n) <= 180) return true;
    }
  }
  return false;
}

/** True if a whitespace token packs an identifier or a joined coordinate pair. */
function tokenIsSensitive(token: string): boolean {
  const parts = token
    .split(/[,;]/)
    .map(stripPunctuation)
    .filter((p) => p !== "");
  if (parts.some((p) => looksLikeIdentifier(p))) return true;
  return parts.length >= 2 && parts.filter((p) => isCoordinate(p)).length >= 2;
}

/**
 * Truncate to {@link MAX_FIELD_LEN} and HTML-escape angle brackets / flatten
 * control chars so a scrubbed field can never inject structure. Mirrors
 * `cap_and_neutralize` in Rust.
 */
function capAndNeutralize(s: string): string {
  const chars = [...s];
  let out = "";
  for (const ch of chars.slice(0, MAX_FIELD_LEN)) {
    const code = ch.charCodeAt(0);
    if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    // Flatten C0 (0x00–0x1f) AND C1 (0x7f–0x9f) control chars to a space, to
    // match Rust `char::is_control()` (which covers the full Cc category). A
    // narrower `code === 0x7f` here would leave C1 controls (e.g. U+0085 NEL)
    // intact and diverge from what the authoritative Rust sanitizer emits.
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += " ";
    else out += ch;
  }
  if (chars.length > MAX_FIELD_LEN) out += "…";
  return out.trim();
}

/**
 * Scrub a free-text value of GPS pairs, MAC / IPv4 / IPv6 addresses, and emails,
 * then neutralize markup. Pure and regex-shape based — the exact discipline of
 * `scrub_value` in `commands/ai.rs`.
 */
export function scrubText(value: string): string {
  // Split on the same whitespace Rust `split_whitespace()` (Unicode White_Space)
  // recognizes. JS `\s` covers most of it but NOT U+0085 (NEL), so add it
  // explicitly to keep tokenization in lockstep with `scrub_value` in Rust.
  const tokens = value.split(/[\s\u0085]+/).filter((t) => t !== "");
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (tokenIsSensitive(token)) {
      out.push(REDACTED);
      i += 1;
      continue;
    }
    // Two adjacent in-range decimals are almost certainly a coordinate pair.
    if (
      i + 1 < tokens.length &&
      isCoordinate(token) &&
      isCoordinate(tokens[i + 1])
    ) {
      out.push(REDACTED, REDACTED);
      i += 2;
      continue;
    }
    out.push(token);
    i += 1;
  }
  return capAndNeutralize(out.join(" "));
}
