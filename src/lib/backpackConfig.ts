/**
 * Pure, data-driven model of the ExpressLRS Backpack settings form (FR-FLASH-11c).
 *
 * Everything in this module is DERIVED at load time from the `backpack` group of
 * `data/elrs_options_schema.json` — the field list, their types, choices and
 * defaults are NOT hardcoded here. Add/rename/retune a field in that schema and
 * this module (and the {@link BackpackConfigForm} that consumes it) follows
 * automatically. The module is deterministic: no I/O, no clock, no randomness.
 *
 * The schema field keys are snake_case (e.g. `vtx_channel`); the runtime
 * settings keys are the camelCase form (e.g. `vtxChannel`). The same camelCase
 * form is also the i18n key fragment under `backpack.config.*`, so a single
 * snake→camel transform yields both the {@link BackpackSettings} key AND the
 * label/help translation keys — keeping the whole thing data-driven.
 */

import schema from "../../data/elrs_options_schema.json";

/** A Backpack field is either a fixed choice list (enum) or a toggle (bool). */
export type BackpackFieldType = "enum" | "bool";

/**
 * Runtime, controlled-form shape for the Backpack settings. Keys are the
 * camelCase form of the schema field keys; this is the value both read from and
 * written back to the device (HW read/write is pending — locally dev-verifiable).
 */
export interface BackpackSettings {
  vtxChannel: string;
  dvrControl: string;
  headTracker: boolean;
}

/**
 * Runtime mirror of every {@link BackpackSettings} key, doubling as a desync
 * guard. The `satisfies Record<keyof BackpackSettings, true>` clause forces this
 * object to name EXACTLY the interface keys — a removed key is a "property
 * missing" error, a stray key an excess-property error — so it can never drift
 * from the interface. The {@link BACKPACK_FIELDS} regression test then asserts
 * these keys equal the schema-derived field keys, so a schema edit that desyncs
 * the static type from the data-driven defaults (see the double cast in
 * {@link DEFAULT_BACKPACK_SETTINGS}) fails CI instead of silently shipping
 * `undefined` defaults at runtime.
 */
export const BACKPACK_SETTINGS_KEYS = Object.keys({
  vtxChannel: true,
  dvrControl: true,
  headTracker: true,
} satisfies Record<keyof BackpackSettings, true>) as (keyof BackpackSettings)[];

/**
 * A descriptor for one rendered Backpack field, derived from the schema. `key`
 * is the camelCase {@link BackpackSettings} key; `labelKey`/`helpKey` are i18n
 * keys under `backpack.config.*`.
 */
export interface BackpackField {
  key: keyof BackpackSettings;
  type: BackpackFieldType;
  labelKey: string;
  helpKey: string;
  choices?: string[];
  default: string | boolean;
}

/** Loose view of a schema field — only the bits this loader needs. */
interface RawSchemaField {
  type: string;
  mechanism: string;
  default: unknown;
  label: string;
  help: string;
  choices?: string[];
}

/** Convert a snake_case schema key to its camelCase settings/i18n form. */
function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Narrow a raw schema field type to a supported {@link BackpackFieldType}. */
function toFieldType(type: string): BackpackFieldType {
  return type === "bool" ? "bool" : "enum";
}

// The single source of truth: the schema's `backpack` group. Cast through the
// loose RawSchemaField view so heterogeneous field shapes (some carry
// `choices`, some don't) can be iterated generically.
const rawFields = schema.groups.backpack.fields as unknown as Record<
  string,
  RawSchemaField
>;

/**
 * Field descriptors derived FROM the schema (data-driven). Order follows the
 * schema's field declaration order.
 */
export const BACKPACK_FIELDS: BackpackField[] = Object.entries(rawFields).map(
  ([schemaKey, field]) => {
    const camel = toCamelCase(schemaKey);
    const type = toFieldType(field.type);
    return {
      key: camel as keyof BackpackSettings,
      type,
      labelKey: `backpack.config.${camel}.label`,
      helpKey: `backpack.config.${camel}.help`,
      choices: field.choices,
      default: type === "bool" ? Boolean(field.default) : String(field.default),
    };
  }
);

/**
 * Default settings, derived from the schema defaults (data-driven). Built by
 * folding {@link BACKPACK_FIELDS} so it stays in lockstep with the schema.
 */
export const DEFAULT_BACKPACK_SETTINGS: BackpackSettings =
  BACKPACK_FIELDS.reduce<Record<string, string | boolean>>((acc, field) => {
    acc[field.key] = field.default;
    return acc;
  }, {}) as unknown as BackpackSettings;
