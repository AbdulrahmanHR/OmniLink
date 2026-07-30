import { describe, expect, it } from "vitest";

/**
 * M54 — Suggestion Validation and Review Hardening (TS mirror of the
 * authoritative Rust gate in `src-tauri/src/commands/ai.rs`).
 *
 * Covers the same adversarial matrix the Rust `#[test]`s assert — unknown key,
 * sensitive key, RF-power/failsafe/arming key, wrong type, out-of-range,
 * malformed/empty payload — plus the mapping layer: a validated safe suggestion
 * becomes the correct `ProfileSettings` patch via the schema `maps_to`, while a
 * blocked / sensitive / unmappable suggestion yields NO patch.
 */

import {
  SUGGESTABLE_DEFINE_KEYS,
  isSensitiveSuggestionKey,
  suggestableRule,
  suggestionToProfilePatch,
  validateSuggestion,
} from "@/lib/aiSuggestionSchema";
import type { UserDefineSuggestion } from "@/lib/ai";

function sug(key: string, value: string): UserDefineSuggestion {
  return { key, value, reason: "" };
}

describe("validateSuggestion — accepts allowlisted safe tunables in range", () => {
  it("accepts the original safe tunables", () => {
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "480"))).toBe(true);
    expect(validateSuggestion(sug("FAN_MIN_RUNTIME", "30"))).toBe(true);
    expect(validateSuggestion(sug("AUTO_WIFI_ON_INTERVAL", "60"))).toBe(true);
    expect(validateSuggestion(sug("LOCK_ON_FIRST_CONNECTION", "1"))).toBe(true);
  });

  it("accepts the M54 extended safe tunables (schema `link` group)", () => {
    expect(validateSuggestion(sug("MODEL_MATCH", "1"))).toBe(true);
    expect(validateSuggestion(sug("MODEL_MATCH", "0"))).toBe(true);
    expect(validateSuggestion(sug("TELEMETRY_RATIO", "1:32"))).toBe(true);
    expect(validateSuggestion(sug("TELEMETRY_RATIO", "Off"))).toBe(true);
    expect(validateSuggestion(sug("TELEMETRY_RATIO", "Std"))).toBe(true);
  });

  it("every allowlisted key resolves a rule", () => {
    for (const key of SUGGESTABLE_DEFINE_KEYS) {
      expect(suggestableRule(key)).not.toBeNull();
    }
  });
});

describe("validateSuggestion — rejects the adversarial matrix", () => {
  it("rejects RF-power / failsafe / arming / regulatory keys", () => {
    for (const [k, v] of [
      ["TX_POWER", "1000"],
      ["UNLOCK_HIGHER_POWER", "1"],
      ["DOMAIN", "eu_868"],
      ["FAILSAFE_MODE", "1"],
      ["FAILSAFE_DELAY", "1000"],
      ["ARMING_ALLOWED", "1"],
      ["ARM_CHANNEL", "5"],
    ] as const) {
      expect(validateSuggestion(sug(k, v))).toBe(false);
    }
  });

  it("rejects binding / UID / password / SSID (sensitive)", () => {
    for (const [k, v] of [
      ["BINDING_PHRASE", "secret"],
      ["MY_BINDING_PHRASE", "secret"],
      ["UID", "1"],
      ["MY_UID", "1,2,3,4,5,6"],
      ["HOME_PASSWORD", "hunter2"],
      ["HOME_SSID", "MyNet"],
    ] as const) {
      expect(isSensitiveSuggestionKey(k)).toBe(true);
      expect(validateSuggestion(sug(k, v))).toBe(false);
    }
  });

  it("rejects unknown keys, wrong type, out-of-range, and malformed/empty", () => {
    expect(validateSuggestion(sug("MY_RANDOM_KEY", "1"))).toBe(false);
    expect(validateSuggestion(sug("LOCK_ON_FIRST_CONNECTION", "2"))).toBe(false);
    expect(validateSuggestion(sug("MODEL_MATCH", "true"))).toBe(false);
    expect(validateSuggestion(sug("TELEMETRY_RATIO", "1:3"))).toBe(false);
    expect(validateSuggestion(sug("TELEMETRY_RATIO", "std"))).toBe(false); // case-sensitive
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "999999"))).toBe(false);
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "12.5"))).toBe(false);
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "0x10"))).toBe(false);
    expect(validateSuggestion(sug("", "1"))).toBe(false);
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", ""))).toBe(false);
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "   "))).toBe(false);
  });

  it("rejects malformed suggestion objects", () => {
    expect(validateSuggestion(null)).toBe(false);
    expect(validateSuggestion(undefined)).toBe(false);
    // @ts-expect-error — non-string fields must be rejected, not throw.
    expect(validateSuggestion({ key: 5, value: 1 })).toBe(false);
  });
});

describe("suggestionToProfilePatch — mapping via schema maps_to", () => {
  it("maps a validated bool suggestion to the ProfileSettings key + coerced value", () => {
    expect(suggestionToProfilePatch(sug("MODEL_MATCH", "1"))).toEqual({
      key: "modelMatch",
      value: true,
    });
    expect(suggestionToProfilePatch(sug("MODEL_MATCH", "0"))).toEqual({
      key: "modelMatch",
      value: false,
    });
  });

  it("maps a validated enum suggestion to the ProfileSettings token", () => {
    expect(suggestionToProfilePatch(sug("TELEMETRY_RATIO", "1:16"))).toEqual({
      key: "telemetryRatio",
      value: "1:16",
    });
  });

  it("yields NO patch for a validated-but-unmappable safe tunable", () => {
    // Valid + allowlisted, but its schema maps_to is not a ProfileSettings key.
    expect(validateSuggestion(sug("TLM_REPORT_INTERVAL_MS", "480"))).toBe(true);
    expect(suggestionToProfilePatch(sug("TLM_REPORT_INTERVAL_MS", "480"))).toBeNull();
  });

  it("yields NO patch for blocked safety-critical / sensitive keys, even though txPower/bindingPhrase ARE profile fields", () => {
    // TX_POWER maps_to `txPower` in the schema, but validation rejects it first.
    expect(suggestionToProfilePatch(sug("TX_POWER", "1000"))).toBeNull();
    expect(suggestionToProfilePatch(sug("UNLOCK_HIGHER_POWER", "1"))).toBeNull();
    expect(suggestionToProfilePatch(sug("BINDING_PHRASE", "secret"))).toBeNull();
    expect(suggestionToProfilePatch(sug("MODEL_MATCH", "2"))).toBeNull(); // invalid value
  });
});
