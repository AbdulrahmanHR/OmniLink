import { describe, expect, it } from "vitest";
import { sanitizeRetrievedDocs, type RetrievedDoc } from "@/lib/knowledge";
import { buildAiContext, selectAiContext } from "@/lib/aiContext";

/**
 * Retrieved-docs redaction gate (M50, NFR-PRIV-01). Proves the privacy hard
 * rule for the NEW retrieved-docs channel: excerpts/titles laced with a binding
 * phrase, MAC, IPv4/IPv6, email, and GPS coordinates are sanitized so NONE of
 * those identifiers survive in the assembled/serialized payload. Mirrors
 * `tests/unit/redact.test.ts`, which covers the shared primitives this gate
 * is built on; the authoritative redaction is the Rust `sanitize_context()`
 * (`retrieved_docs_strip_identifiers` in ai.rs).
 */

const LACED: RetrievedDoc[] = [
  {
    sourceId: "imported-note",
    sourceTitle: "Rig owned by pilot@example.com",
    chunkId: "imported-note#0",
    excerpt:
      "Home base 37.7749,-122.4194 reachable at 192.168.1.50 or " +
      "fe80::1ff:fe23:4567:890a, radio de:ad:be:ef:00:11. " +
      "Binding phrase set on all gear.",
  },
];

const LEAK_NEEDLES = [
  "pilot@example.com",
  "example.com",
  "37.7749",
  "-122.4194",
  "122.4194",
  "192.168.1.50",
  "fe80::1ff:fe23:4567:890a",
  "de:ad:be:ef:00:11",
];

describe("sanitizeRetrievedDocs (TS mirror)", () => {
  const out = sanitizeRetrievedDocs(LACED);
  const blob = JSON.stringify(out);

  it("keeps the stable ids", () => {
    expect(out[0].sourceId).toBe("imported-note");
    expect(out[0].chunkId).toBe("imported-note#0");
  });

  it("carries no MAC / IP / email / GPS identifier anywhere", () => {
    for (const needle of LEAK_NEEDLES) {
      expect(blob, `leaked: ${needle}`).not.toContain(needle);
    }
  });

  it("shows the redaction actually ran", () => {
    expect(blob).toContain("[redacted]");
  });

  it("bounds the number of docs", () => {
    const many: RetrievedDoc[] = Array.from({ length: 20 }, (_, i) => ({
      sourceId: `s${i}`,
      sourceTitle: `Source ${i}`,
      chunkId: `s${i}#0`,
      excerpt: "safe excerpt",
    }));
    expect(sanitizeRetrievedDocs(many).length).toBeLessThanOrEqual(8);
  });
});

describe("AiContextInput.retrievedDocs assembled payload", () => {
  it("gathers the raw docs (gather, don't redact) but the sanitized mirror strips identifiers", () => {
    const ctx = buildAiContext(null, [], undefined, null, null, LACED);
    // The gather step carries the docs (raw) — redaction is the Rust/mirror step.
    expect(ctx.retrievedDocs).toHaveLength(1);
    // The privacy guarantee holds once the (TS-mirror) sanitizer runs on the
    // assembled payload — this is the path the preview-before-send screen uses.
    const sanitized = sanitizeRetrievedDocs(ctx.retrievedDocs ?? []);
    const blob = JSON.stringify(sanitized);
    for (const needle of LEAK_NEEDLES) {
      expect(blob, `leaked: ${needle}`).not.toContain(needle);
    }
  });

  it("threads retrievedDocs through every context mode, including offline", () => {
    for (const mode of ["auto", "device", "wizard", "offline"] as const) {
      const ctx = selectAiContext(mode, null, [], null, null, LACED);
      expect(ctx.retrievedDocs, `mode=${mode}`).toHaveLength(1);
    }
  });

  it("omits retrievedDocs when none are provided or the list is empty", () => {
    expect(buildAiContext(null, []).retrievedDocs).toBeUndefined();
    expect(
      buildAiContext(null, [], undefined, null, null, []).retrievedDocs,
    ).toBeUndefined();
    expect(
      selectAiContext("offline", null, [], null).retrievedDocs,
    ).toBeUndefined();
  });
});
