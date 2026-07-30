import { expect } from "vitest";
import { looksLikeIdentifier } from "@/lib/redact";

/**
 * The SHARED privacy-audit harness (test-only; not a product module).
 *
 * Extracted at v2.5 (M60) from `tests/unit/v23PrivacyAudit.test.ts` and
 * `tests/unit/v24PrivacyAudit.test.ts`, where it had been written once and then
 * copy-pasted. `tests/unit/ml/v25PrivacyAudit.test.ts` would have been the third
 * copy; instead all three now call this module, so a gap in the identifier list
 * (a new forbidden shape, a new forbidden key) is closed ONCE rather than in
 * three places that can silently drift apart.
 *
 * Not collected by vitest: the runner's include glob is
 * `tests/{unit,integration}/**\/*.{test,spec}.ts`, and this file is neither.
 *
 * ## What "zero identifiers" means here, precisely
 * Three independent checks, because each catches a leak the others cannot:
 *  1. {@link assertNoInjectedLiterals} — the exact poison literals the caller
 *     seeded are absent from the serialized payload. Catches a verbatim
 *     pass-through, INCLUDING one that arrives as a *number* (`JSON.stringify`
 *     renders `37.7749` as `37.7749`, so a coordinate that leaked into a numeric
 *     feature is still caught).
 *  2. {@link assertNoIdentifierTokens} — no string VALUE anywhere in the payload
 *     contains an identifier-SHAPED token, judged by the product's own detector
 *     (`looksLikeIdentifier`, the TS mirror of Rust `looks_like_identifier`).
 *     Catches an identifier the test never thought to inject.
 *  3. {@link assertNoForbiddenKeys} — no object KEY names a secret, an
 *     identifier, or a tracking beacon. Catches a leak that hides in a key
 *     rather than in a value.
 */

// ---------------------------------------------------------------------------
// The injected identifiers — one of each forbidden shape. After sanitize, NONE
// of these raw literals may survive in any stored/outbound/derived payload.
// ---------------------------------------------------------------------------

/** One poison value of every shape the privacy rule forbids. */
export const INJECTED = {
  bindingPhrase: "my-secret-bind-phrase-xyz",
  mac: "de:ad:be:ef:00:11",
  ipv4: "192.168.1.50",
  ipv6: "fe80::1ff:fe23:4567:890a",
  email: "pilot@example.com",
  gpsLat: "37.7749",
  gpsLon: "-122.4194",
} as const;

/** Every injected literal, as a flat list. */
export const INJECTED_LITERALS: readonly string[] = Object.values(INJECTED);

/**
 * Setting/identifier/tracking keys that must NEVER appear as an object key in a
 * stored or outbound payload. Matched by EXACT (lower-cased) equality — a
 * substring rule would reject innocent keys like `sourceId`.
 *
 * This is the UNION of the two lists the v2.3 and v2.4 audits each maintained
 * (v2.4's was the v2.3 list minus the tracking keys, for no stated reason). The
 * union is the strictly stronger check and neither existing audit regresses
 * under it.
 */
export const FORBIDDEN_KEYS: readonly string[] = [
  // Secrets / identifiers.
  "bindingphrase",
  "binding_phrase",
  "modelid",
  "model_id",
  "uid",
  "password",
  "ssid",
  // Tracking / telemetry beacons (v2.3 sponsor rule: no tracking by default).
  "track",
  "beacon",
  "impression",
  "analytics",
  "tracker",
  "pixel",
];

// ---------------------------------------------------------------------------
// Collectors.
// ---------------------------------------------------------------------------

/** Recursively collect every string VALUE in a JSON-ish object. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) =>
      collectStrings(v, out)
    );
  }
  return out;
}

/** Recursively collect every object KEY in a JSON-ish object. */
export function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

/**
 * Recursively collect every NUMBER in a JSON-ish object.
 *
 * Numeric payloads (an ML feature vector, a diagnostic detail bag) have no
 * strings to scan, so the string-shape detector is blind to them: a leaked
 * coordinate would arrive as `37.7749`, not `"37.7749"`. This collector is how a
 * numeric payload is checked against a known poison value.
 */
export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) =>
      collectNumbers(v, out)
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

/** No raw injected identifier literal survives anywhere in the serialized blob. */
export function assertNoInjectedLiterals(blob: unknown): void {
  const json = JSON.stringify(blob);
  for (const lit of INJECTED_LITERALS) {
    expect(json, `leaked literal "${lit}"`).not.toContain(lit);
  }
}

/** No identifier-SHAPED token survives in any string value (shape detector). */
export function assertNoIdentifierTokens(blob: unknown): void {
  for (const s of collectStrings(blob)) {
    for (const token of s.split(/[\s,;]+/).filter(Boolean)) {
      expect(
        looksLikeIdentifier(token),
        `identifier-shaped token survived: "${token}"`
      ).toBe(false);
    }
  }
}

/** Per-call adjustments to {@link FORBIDDEN_KEYS}. */
export interface KeyPolicy {
  /**
   * Keys this audit ADDITIONALLY forbids — one audit's legitimate key is another's
   * leak. The v2.5 ML audit forbids `sessionid` in a *model artifact*, even though
   * a `DatasetRow` legitimately carries a corpus-local `sessionId` in memory.
   */
  extraForbidden?: readonly string[];
  /**
   * Keys this audit EXEMPTS, with a stated reason. Exactly one exemption exists:
   * **`modelid`**.
   *
   * The list forbids `modelId` because in ELRS that is the per-user **device model
   * id** (a binding-adjacent identifier). The v2.5 ML artifacts use the same
   * spelling for something else entirely — the **ML model's** identity
   * (`"m58-isolation-forest"`), a build-time constant with no user in it. A key-name
   * scanner cannot tell the two apart, so the ML audit exempts the key **and**
   * asserts its VALUE is the frozen model/predictor id, which is the check that
   * actually matters.
   */
  exempt?: readonly string[];
}

/** No secret/identifier/tracking KEY appears anywhere in the blob. */
export function assertNoForbiddenKeys(blob: unknown, policy: KeyPolicy = {}): void {
  const exempt = new Set((policy.exempt ?? []).map((k) => k.toLowerCase()));
  const forbidden = new Set(
    [...FORBIDDEN_KEYS, ...(policy.extraForbidden ?? [])]
      .map((k) => k.toLowerCase())
      .filter((k) => !exempt.has(k))
  );
  for (const key of collectKeys(blob)) {
    expect(forbidden.has(key.toLowerCase()), `forbidden key present: "${key}"`).toBe(
      false
    );
  }
}

/** The full privacy guarantee, applied to one payload. */
export function assertZeroIdentifiers(blob: unknown, policy: KeyPolicy = {}): void {
  assertNoInjectedLiterals(blob);
  assertNoIdentifierTokens(blob);
  assertNoForbiddenKeys(blob, policy);
}
