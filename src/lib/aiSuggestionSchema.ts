/**
 * AI suggestion validation + mapping (M54 — Suggestion Validation and Review
 * Hardening). Pure, dependency-free (no React, no Tauri) so the whole gate is
 * trivially unit-testable and runs offline.
 *
 * This is the CLIENT-SIDE mirror of the authoritative Rust gate in
 * `src-tauri/src/commands/ai.rs` (`suggestable_rule` / `validate_suggestion`).
 * The Rust gate is authoritative — a prompt-injected model reply that bypasses
 * the frontend still can't reach app state — and this mirror is defense-in-depth
 * PLUS the driver for the review UI. Both derive their rules from
 * `data/elrs_options_schema.json`, the single source of truth.
 *
 * On top of the shared validation, this module adds the MAPPING LAYER: a
 * validated raw ELRS `user_define` key is translated (via the schema `maps_to`)
 * into the corresponding {@link ProfileSettings} key + coerced value, so a
 * validated suggestion becomes a `ProfileSettings` patch the review/diff screen
 * can preview. Unknown / blocked / sensitive / unmappable → NO patch.
 */

import schema from "../../data/elrs_options_schema.json";
import type { UserDefineSuggestion } from "@/lib/ai";
import {
  SETTING_FIELD_BY_KEY,
  type ProfileSettings,
  type SettingKey,
  type SettingValue,
} from "@/lib/profileSettings";

// ---------------------------------------------------------------------------
// Schema-derived rule model.
// ---------------------------------------------------------------------------

/** Loose view of one schema field — only the bits this gate needs. */
interface RawSchemaField {
  type: string;
  mechanism: string;
  choices?: string[];
  min?: number;
  sensitive?: boolean;
  safety_critical?: boolean;
  maps_to?: string;
  define?: string;
}

interface RawSchemaGroup {
  fields: Record<string, RawSchemaField>;
}

const RAW_GROUPS = schema.groups as unknown as Record<string, RawSchemaGroup>;

/** Index every schema field that carries a `define` → the field, by define key. */
const FIELD_BY_DEFINE: Record<string, RawSchemaField> = (() => {
  const out: Record<string, RawSchemaField> = {};
  for (const group of Object.values(RAW_GROUPS)) {
    for (const field of Object.values(group.fields ?? {})) {
      if (field.define) out[field.define] = field;
    }
  }
  return out;
})();

/**
 * The CLOSED, deny-by-default allowlist of suggestable `user_define` keys —
 * mirrors the `suggestable_rule` match arms in Rust. A key not in this set is
 * never suggestable, no matter what the schema marks editable.
 */
export const SUGGESTABLE_DEFINE_KEYS = [
  "TLM_REPORT_INTERVAL_MS",
  "FAN_MIN_RUNTIME",
  "AUTO_WIFI_ON_INTERVAL",
  "LOCK_ON_FIRST_CONNECTION",
  "MODEL_MATCH",
  "TELEMETRY_RATIO",
] as const;

const ALLOWLIST = new Set<string>(SUGGESTABLE_DEFINE_KEYS);

/**
 * Integer upper bounds (safety caps). The schema carries `min` but not a `max`
 * for these tunables, so the upper bound is defined here in lockstep with the
 * Rust `IntRange` arms (the Rust `suggestable_rules_match_schema` test asserts
 * the lower bound equals the schema `min`).
 */
const INT_RANGES: Record<string, { min: number; max: number }> = {
  TLM_REPORT_INTERVAL_MS: { min: 0, max: 65535 },
  FAN_MIN_RUNTIME: { min: 0, max: 3600 },
  AUTO_WIFI_ON_INTERVAL: { min: 0, max: 600 },
};

/** A resolved value rule (mirrors the Rust `ValueRule`). */
export type SuggestionRule =
  | { kind: "bool" }
  | { kind: "int"; min: number; max: number }
  | { kind: "enum"; choices: readonly string[] };

/**
 * `user_define` key fragments that flag a sensitive field (binding / UID /
 * password / SSID). Matched case-insensitively as substrings — mirrors the Rust
 * `SENSITIVE_DEFINE_FRAGMENTS` / `is_sensitive_key`.
 */
const SENSITIVE_FRAGMENTS = [
  "binding_phrase",
  "binding",
  "bind_phrase",
  "uid",
  "my_uid",
  "phrase",
  "wifi_password",
  "password",
  "ssid",
  "home_wifi",
];

/** True if a key names a sensitive field that must never be suggestable. */
export function isSensitiveSuggestionKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_FRAGMENTS.some((frag) => lower.includes(frag));
}

/**
 * Resolve the value rule for a suggestable key, or `null` if the key is not on
 * the closed allowlist / not a safe schema field. Deny-by-default: the key must
 * be allowlisted, present in the schema, `binary_patch`, and neither `sensitive`
 * nor `safety_critical`.
 */
export function suggestableRule(key: string): SuggestionRule | null {
  if (!ALLOWLIST.has(key)) return null;
  const field = FIELD_BY_DEFINE[key];
  if (!field) return null;
  // Defense-in-depth: never editable if the schema marks it unsafe.
  if (
    field.sensitive === true ||
    field.safety_critical === true ||
    field.mechanism !== "binary_patch"
  ) {
    return null;
  }
  if (field.type === "bool") return { kind: "bool" };
  if (field.type === "enum") {
    return { kind: "enum", choices: field.choices ?? [] };
  }
  if (field.type === "int") {
    const range = INT_RANGES[key];
    return range ? { kind: "int", min: range.min, max: range.max } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation (mirrors the authoritative Rust `validate_suggestion`).
// ---------------------------------------------------------------------------

/** Integer token: optional leading sign then digits only (rejects `12.5`, `0x1`, `1e3`). */
const INT_TOKEN = /^[+-]?\d+$/;

/**
 * True only if the suggestion names an allowlisted, non-sensitive key whose
 * trimmed value passes the key's type/range/enum rule. Malformed input
 * (missing/empty key or value, wrong type) is rejected. Authoritative gate is
 * Rust; this must agree with it.
 */
export function validateSuggestion(
  s: Pick<UserDefineSuggestion, "key" | "value"> | null | undefined
): boolean {
  if (!s || typeof s.key !== "string" || typeof s.value !== "string") {
    return false;
  }
  if (isSensitiveSuggestionKey(s.key)) return false;
  const rule = suggestableRule(s.key);
  if (!rule) return false;
  const value = s.value.trim();
  switch (rule.kind) {
    case "bool":
      return value === "0" || value === "1";
    case "int": {
      if (!INT_TOKEN.test(value)) return false;
      const n = Number(value);
      return Number.isInteger(n) && n >= rule.min && n <= rule.max;
    }
    case "enum":
      return rule.choices.includes(value);
  }
}

// ---------------------------------------------------------------------------
// Mapping layer — validated suggestion → ProfileSettings patch.
// ---------------------------------------------------------------------------

/** A single validated, mapped change to apply to a {@link ProfileSettings}. */
export interface ProfileSettingPatch {
  key: SettingKey;
  value: SettingValue;
}

/**
 * Resolve the {@link ProfileSettings} key a suggestable define maps to (via the
 * schema `maps_to`), or `null` if it maps to nothing the profile schema knows.
 * Only allowlisted keys are considered; a schema `maps_to` that is not a real
 * `ProfileSettings` field is unmappable.
 */
function mappedSettingKey(defineKey: string): SettingKey | null {
  const mapsTo = FIELD_BY_DEFINE[defineKey]?.maps_to;
  if (!mapsTo) return null;
  return mapsTo in SETTING_FIELD_BY_KEY ? (mapsTo as SettingKey) : null;
}

/**
 * Translate a raw ELRS `user_define` suggestion into a validated
 * {@link ProfileSettings} patch, or `null` when it must not (invalid / blocked /
 * sensitive / unmappable). Validation runs FIRST, so a blocked key (e.g.
 * `TX_POWER`, `UNLOCK_HIGHER_POWER`, a binding secret) can never yield a patch
 * even though its schema `maps_to` names a real profile field.
 */
export function suggestionToProfilePatch(
  s: Pick<UserDefineSuggestion, "key" | "value"> | null | undefined
): ProfileSettingPatch | null {
  if (!s || !validateSuggestion(s)) return null;
  const settingKey = mappedSettingKey(s.key);
  if (!settingKey) return null; // validated but unmappable
  const meta = SETTING_FIELD_BY_KEY[settingKey];
  const raw = s.value.trim();
  let value: SettingValue;
  if (meta.kind === "boolean") {
    value = raw === "1";
  } else if (meta.kind === "number") {
    value = Number(raw);
  } else {
    // text/enum token — already validated against the schema `choices`.
    value = raw as SettingValue;
  }
  return { key: settingKey, value };
}

/**
 * Build the candidate `after` settings for a review/diff screen: the active
 * settings with a single validated patch applied. Pure — never mutates `active`.
 */
export function buildSuggestionAfter(
  active: ProfileSettings,
  patch: ProfileSettingPatch
): ProfileSettings {
  return { ...active, [patch.key]: patch.value };
}
