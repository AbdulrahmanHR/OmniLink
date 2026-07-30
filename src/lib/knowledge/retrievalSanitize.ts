/**
 * TS-side redaction mirror for retrieved RAG docs (M50, NFR-PRIV-01).
 *
 * The retrieved-docs channel is a NEW outbound path, so it gets the same
 * privacy gate every outbound path in this app gets. This is the pure
 * TypeScript half — it runs on the preview/test data path and MIRRORS the Rust
 * `sanitize_context()` retrieved-docs handling in `src-tauri/src/commands/ai.rs`
 * (the authoritative redaction), building on the shared primitives in
 * `lib/redact.ts` that mirror the same Rust baseline. The two must stay in
 * lockstep.
 *
 * Discipline (reusing the shared `scrubText` shape-scrubber):
 *  - scrub `sourceTitle` + `excerpt` of MAC / IPv4 / IPv6 / email / GPS-pair
 *    shapes (`[redacted]`) and neutralize markup + cap length;
 *  - keep the stable `sourceId` / `chunkId` (internal ids) but still neutralize
 *    them defensively; and
 *  - bound the number of docs to {@link MAX_RETRIEVED_DOCS}.
 *
 * Trusted bundled packs don't contain identifiers, but M52's user-imported docs
 * will — landing the gate now keeps the substrate ahead of that wiring. Pure and
 * deterministic; NO redaction wiring into the live prompt happens here (M51).
 */

import { scrubText } from "@/lib/redact";
import type { RetrievedDoc } from "./retrieve";
import { MAX_RETRIEVED_DOCS } from "./retrievalConsts";

/**
 * Run retrieved docs through the redaction gate. Returns a bounded list whose
 * titles + excerpts provably carry no MAC / IP / email / GPS identifier (proven
 * by `tests/unit/knowledgeRedaction.test.ts`, mirroring the Rust `#[test]`s).
 */
export function sanitizeRetrievedDocs(
  docs: readonly RetrievedDoc[],
  max = MAX_RETRIEVED_DOCS,
): RetrievedDoc[] {
  return docs.slice(0, max).map((doc) => ({
    // Internal ids are our own stable strings; still neutralize markup via the
    // shared scrubber so a crafted id can't smuggle structure.
    sourceId: scrubText(doc.sourceId),
    sourceTitle: scrubText(doc.sourceTitle),
    chunkId: scrubText(doc.chunkId),
    excerpt: scrubText(doc.excerpt),
  }));
}
