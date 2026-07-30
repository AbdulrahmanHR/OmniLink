import { describe, expect, it } from "vitest";
import { REDACTED, scrubText, looksLikeIdentifier } from "@/lib/redact";

/**
 * Shared redaction primitives (NFR-PRIV-01). Proves the privacy hard rule at its
 * source: free text laced with a MAC / IPv4 / IPv6 / email / GPS coordinate is
 * scrubbed so NONE of those shapes survive, markup cannot smuggle structure, and
 * ordinary configuration prose is left alone. Mirror-tests the Rust
 * `looks_like_identifier` / `scrub_value` / `cap_and_neutralize` in
 * `commands/ai.rs`, which is the authoritative redaction.
 *
 * v3.0 (M69): this file was `tests/unit/syncSanitize.test.ts`. The cloud-sync
 * profile sanitizer it also covered was deleted with the platform stack. Every
 * case that exercises the three shared primitives is carried over UNCHANGED,
 * and the marker assertion the dropped `sanitizeSyncProfile` tag case used to
 * make is now asserted directly against `scrubText`.
 */

describe("scrubText shape redaction", () => {
  it("redacts a MAC address", () => {
    expect(scrubText("rig de:ad:be:ef:00:11")).not.toContain("de:ad:be:ef");
  });
  it("redacts an IPv4 address", () => {
    expect(scrubText("ping 192.168.1.50 ok")).not.toContain("192.168.1.50");
  });
  it("redacts an email", () => {
    expect(scrubText("by pilot@example.com")).not.toContain("pilot@example.com");
  });
  it("redacts a comma-joined GPS coordinate pair", () => {
    const out = scrubText("home 37.7749,-122.4194");
    expect(out).not.toContain("37.7749");
    expect(out).not.toContain("-122.4194");
  });
  it("redacts a space-joined GPS coordinate pair", () => {
    const out = scrubText("at 37.7749 -122.4194 now");
    expect(out).not.toContain("37.7749");
    expect(out).not.toContain("122.4194");
  });
  it("leaves ordinary config text untouched", () => {
    expect(scrubText("Racing rig 500Hz Hybrid")).toBe("Racing rig 500Hz Hybrid");
  });
  it("neutralizes angle brackets so a field cannot inject structure", () => {
    expect(scrubText("a <tag> b")).toBe("a &lt;tag&gt; b");
  });

  it("substitutes the REDACTED marker in place of each sensitive token", () => {
    // The dropped `sanitizeSyncProfile` tag case was the only one asserting the
    // marker POSITIVELY (`"loc [redacted]"`) rather than only asserting that the
    // identifier was absent. Asserting it here keeps that coverage: a scrubber
    // that silently DELETED tokens would satisfy every `not.toContain` above.
    expect(REDACTED).toBe("[redacted]");
    expect(scrubText("loc 37.7749,-122.4194")).toBe(`loc ${REDACTED}`);
    expect(scrubText("rig de:ad:be:ef:00:11")).toBe(`rig ${REDACTED}`);
    expect(scrubText("by pilot@example.com")).toBe(`by ${REDACTED}`);
    // A space-joined pair burns two tokens, so two markers come back.
    expect(scrubText("at 37.7749 -122.4194 now")).toBe(
      `at ${REDACTED} ${REDACTED} now`,
    );
  });

  it("flattens C1 controls + NEL to stay in TS↔Rust sanitizer lockstep", () => {
    // Rust `char::is_control()` covers C0 AND C1 (U+0080–U+009F), and
    // `split_whitespace()` treats U+0085 (NEL) as whitespace. The TS mirror must
    // match: a NEL between two words collapses to a single space (not preserved),
    // and a stray C1 control is flattened — otherwise the two sanitizers would
    // emit different bytes for the same input.
    expect(scrubText("foo\u0085bar")).toBe("foo bar");
    expect(scrubText("alpha\u0085beta")).toBe("alpha beta");
    // A C1 control embedded in a token is flattened, never carried through.
    expect(scrubText("ab\u0090cd")).not.toContain("\u0090");
  });
});

describe("looksLikeIdentifier", () => {
  it("flags MAC / IPv4 / IPv6 / email / high-precision GPS", () => {
    expect(looksLikeIdentifier("de:ad:be:ef:00:11")).toBe(true);
    expect(looksLikeIdentifier("10.0.0.1")).toBe(true);
    expect(looksLikeIdentifier("fe80::1ff:fe23:4567:890a")).toBe(true);
    expect(looksLikeIdentifier("a@b.com")).toBe(true);
    expect(looksLikeIdentifier("37.7749")).toBe(true);
  });
  it("does not flag ordinary tokens or low-precision numbers", () => {
    expect(looksLikeIdentifier("Hybrid")).toBe(false);
    expect(looksLikeIdentifier("500")).toBe(false);
    expect(looksLikeIdentifier("3.5")).toBe(false);
  });
});
