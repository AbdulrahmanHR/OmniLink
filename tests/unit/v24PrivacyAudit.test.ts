import { describe, expect, it } from "vitest";
import { scrubText } from "@/lib/redact";
import { sanitizeRetrievedDocs, type RetrievedDoc } from "@/lib/knowledge";
import { buildAiContext, type AiContextInput } from "@/lib/aiContext";
import { isSensitiveSuggestionKey } from "@/lib/aiSuggestionSchema";
import { INJECTED, INJECTED_LITERALS, assertZeroIdentifiers } from "./_privacy";

/**
 * v2.4 PRIVACY AUDIT (M55) — the RAG payload carries ZERO identifiers.
 *
 * The launch-gate re-audit of the privacy hard rule for the NEW retrieval
 * channels. It reuses the shared `assertZeroIdentifiers` harness
 * (`tests/unit/_privacy.ts`: INJECTED literals + FORBIDDEN_KEYS +
 * `collectStrings`/`collectKeys` + the identifier-shape detector — extracted at
 * v2.5/M60 from the copy that used to live in each audit) on the
 * **assembled RAG payload**: an `AiContextInput` built from device context +
 * telemetry + a trusted retrieved doc + a user-imported doc, whose every
 * free-text field is laced with the full INJECTED identifier set (binding
 * phrase, MAC, IPv4, IPv6, email, GPS lat/lon).
 *
 * The payload is run through the TS sanitizer path — `scrubText` (the mirror of
 * Rust `scrub_value`/`cap_and_neutralize`) for device strings + `sanitizeRetrievedDocs`
 * (the mirror of Rust `sanitize_context`'s retrieved-docs handling) for the docs,
 * with sensitive `user_defines` DROPPED exactly as Rust does — and the assembled
 * outbound preview must contain ZERO identifiers. The AUTHORITATIVE scrub is the
 * Rust `sanitize_context`; a focused Rust `#[test]`
 * (`m55_rag_payload_carries_zero_identifiers`) asserts the same over its JSON
 * output. Runs OFF-Tauri (pure logic).
 */

// ---------------------------------------------------------------------------
// TS mirror of Rust `sanitize_context` for the assembled RAG payload. Mirrors
// the authoritative gate: scrub device free-text, DROP sensitive user_defines,
// whitelist deviceType, keep numeric telemetry, sanitize retrieved docs.
// ---------------------------------------------------------------------------

function tsSanitizePreview(ctx: AiContextInput): Record<string, unknown> {
  const defines: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.userDefines ?? {})) {
    if (isSensitiveSuggestionKey(k)) continue; // Rust drops sensitive keys entirely
    defines[scrubText(k)] = scrubText(v);
  }
  return {
    targetName: ctx.targetName ? scrubText(ctx.targetName) : null,
    firmwareVersion: ctx.firmwareVersion ? scrubText(ctx.firmwareVersion) : null,
    deviceType:
      ctx.deviceType === "TX" || ctx.deviceType === "RX" ? ctx.deviceType : null,
    userDefines: defines,
    telemetry: ctx.telemetry ?? null,
    retrievedDocs: sanitizeRetrievedDocs(ctx.retrievedDocs ?? []),
  };
}

// ---------------------------------------------------------------------------
// Laced inputs — a trusted retrieved doc + a user-imported doc, both with every
// free-text field carrying an identifier.
// ---------------------------------------------------------------------------

/** A trusted-pack excerpt and an imported-doc excerpt, both laced. */
const LACED_DOCS: RetrievedDoc[] = [
  {
    sourceId: "elrs-binding",
    sourceTitle: `ExpressLRS Binding (rig ${INJECTED.mac})`,
    chunkId: "elrs-binding#0",
    excerpt:
      `Bound link reachable at ${INJECTED.ipv4} or ${INJECTED.ipv6}; ` +
      `home base ${INJECTED.gpsLat},${INJECTED.gpsLon}. Contact ${INJECTED.email}.`,
  },
  {
    // sourceId `imported:*` — a user-IMPORTED doc travels the SAME outbound path.
    sourceId: "imported:field-notes",
    sourceTitle: `My field notes for ${INJECTED.email}`,
    chunkId: "imported:field-notes#0",
    excerpt: `Radio ${INJECTED.mac} at ${INJECTED.ipv4}, launch ${INJECTED.gpsLat} ${INJECTED.gpsLon}.`,
  },
];

/** Build the assembled AiContextInput with every device free-text field laced. */
function poisonedContext(): AiContextInput {
  return buildAiContext(
    {
      targetName: `RadioMaster ${INJECTED.mac} TX`,
      firmwareVersion: `3.5.3 (${INJECTED.ipv4})`,
      deviceType: "TX",
    } as never,
    [],
    {
      // A benign free-text define laced with identifiers…
      wizardNote: `home ${INJECTED.gpsLat},${INJECTED.gpsLon} ${INJECTED.email}`,
      // …and a SENSITIVE define carrying the binding secret (Rust drops it).
      MY_BINDING_PHRASE: INJECTED.bindingPhrase,
    },
    undefined,
    null,
    LACED_DOCS,
  );
}

describe("v2.4 privacy audit — assembled RAG payload carries zero identifiers", () => {
  it("the raw assembled context genuinely CONTAINS the identifiers (poison is real)", () => {
    const ctx = poisonedContext();
    const raw = JSON.stringify(ctx);
    // Prove the audit is non-tautological: the identifiers are really in the
    // gathered (pre-sanitization) payload before the sanitizer runs.
    expect(raw).toContain(INJECTED.mac);
    expect(raw).toContain(INJECTED.email);
    expect(raw).toContain(INJECTED.bindingPhrase);
    expect(raw).toContain(INJECTED.ipv6);
    expect(ctx.retrievedDocs).toHaveLength(2);
  });

  it("after the TS sanitizer path, ZERO identifiers survive in the outbound preview", () => {
    const preview = tsSanitizePreview(poisonedContext());
    assertZeroIdentifiers(preview);
    // The redaction actually ran (not a vacuous pass).
    expect(JSON.stringify(preview)).toContain("[redacted]");
  });

  it("the binding secret is DROPPED with its sensitive define key (not merely scrubbed)", () => {
    const preview = tsSanitizePreview(poisonedContext());
    const defines = preview.userDefines as Record<string, string>;
    expect(defines.MY_BINDING_PHRASE).toBeUndefined();
    // The literal appears nowhere in the payload.
    expect(JSON.stringify(preview)).not.toContain(INJECTED.bindingPhrase);
    // The benign define survives — scrubbed of its laced coordinates + email.
    const noteKey = Object.keys(defines).find((k) => k.includes("wizardNote"));
    expect(noteKey).toBeDefined();
  });

  it("stable source ids survive but every free-text doc field is scrubbed", () => {
    const preview = tsSanitizePreview(poisonedContext());
    const docs = preview.retrievedDocs as RetrievedDoc[];
    expect(docs).toHaveLength(2);
    // Internal ids are kept (they carry no identifier)…
    expect(docs[0].sourceId).toBe("elrs-binding");
    expect(docs[1].sourceId).toBe("imported:field-notes");
    // …and the imported doc is NOT reclassified — it stays an `imported:*` id.
    expect(docs[1].sourceId.startsWith("imported:")).toBe(true);
    // Titles + excerpts carry no identifier.
    const blob = JSON.stringify(docs);
    for (const lit of INJECTED_LITERALS) {
      expect(blob, `leaked in docs: ${lit}`).not.toContain(lit);
    }
  });

  it("every context MODE's assembled payload is identifier-free once sanitized", () => {
    // The preview-before-send screen is per-mode; each must be clean.
    for (const doc of LACED_DOCS) {
      const sanitized = sanitizeRetrievedDocs([doc]);
      assertZeroIdentifiers(sanitized);
    }
    // And the direct scrub of each laced device field is clean.
    for (const field of [
      `RadioMaster ${INJECTED.mac} TX`,
      `3.5.3 (${INJECTED.ipv4})`,
      `home ${INJECTED.gpsLat},${INJECTED.gpsLon} ${INJECTED.email}`,
    ]) {
      const scrubbed = scrubText(field);
      for (const lit of INJECTED_LITERALS) {
        expect(scrubbed, `leaked: ${lit}`).not.toContain(lit);
      }
    }
  });
});
