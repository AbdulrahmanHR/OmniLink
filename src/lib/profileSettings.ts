import type { TFunction } from "i18next";

/**
 * Canonical shape of an ExpressLRS configuration profile's settings.
 *
 * This is the real, persistence-facing schema — the part of an `.elrsp`
 * file that describes radio/link configuration. It is intentionally kept
 * free of mock data and UI concerns so Phase 2 file IO can serialise it
 * directly. Field display metadata lives in {@link SETTING_FIELDS}.
 */
export interface ProfileSettings {
  /** Packet / RF rate in Hz (discrete; see {@link PACKET_RATE_OPTIONS}). */
  packetRate: number;
  /** Telemetry downlink ratio (discrete string token). */
  telemetryRatio: TelemetryRatio;
  /** Channel switch encoding mode. */
  switchMode: SwitchMode;
  /** TX power in mW (discrete; see {@link TX_POWER_OPTIONS}). */
  txPower: number;
  /** Whether dynamic (adaptive) TX power is enabled. */
  dynamicPower: boolean;
  /** Whether model match is enforced. */
  modelMatch: boolean;
  /** Model id used when model match is enabled (0-63). */
  modelId: number;
  /** Binding phrase (UID seed). */
  bindingPhrase: string;
  /** Antenna diversity mode. */
  antennaMode: AntennaMode;
  /** Fan activation power threshold in mW. */
  fanThreshold: number;
}

export type TelemetryRatio =
  | "Off"
  | "1:128"
  | "1:64"
  | "1:32"
  | "1:16"
  | "1:8"
  | "1:4"
  | "1:2"
  | "Std";

export type SwitchMode = "Hybrid" | "Wide";

export type AntennaMode = "Diversity" | "Antenna 1" | "Antenna 2";

/** Discrete ExpressLRS packet rates (Hz). */
export const PACKET_RATE_OPTIONS = [50, 150, 250, 500, 1000] as const;

/** Discrete ExpressLRS TX power steps (mW). */
export const TX_POWER_OPTIONS = [10, 25, 50, 100, 250, 500, 1000] as const;

/** A primitive profile setting value. */
export type SettingValue = ProfileSettings[keyof ProfileSettings];

/** All known setting keys. */
export type SettingKey = keyof ProfileSettings;

/** Logical grouping used to lay settings out in tables and the diff view. */
export type SettingGroup = "link" | "power" | "model" | "binding" | "antenna";

/** How a value should be rendered. */
type ValueKind = "number" | "boolean" | "text";

export interface SettingFieldMeta {
  key: SettingKey;
  group: SettingGroup;
  /** i18n key for the human label, e.g. `config.fields.packetRate`. */
  labelKey: string;
  kind: ValueKind;
  /** Optional inline unit symbol (not translated — a symbol like "mW"). */
  unit?: string;
}

/**
 * Field metadata in canonical display order. Drives the settings table, the
 * diff rows, and grouping. Ordering here is the single source of truth for
 * how settings are presented across the config UI.
 */
export const SETTING_FIELDS: readonly SettingFieldMeta[] = [
  { key: "packetRate", group: "link", labelKey: "config.fields.packetRate", kind: "number", unit: "Hz" },
  { key: "telemetryRatio", group: "link", labelKey: "config.fields.telemetryRatio", kind: "text" },
  { key: "switchMode", group: "link", labelKey: "config.fields.switchMode", kind: "text" },
  { key: "txPower", group: "power", labelKey: "config.fields.txPower", kind: "number", unit: "mW" },
  { key: "dynamicPower", group: "power", labelKey: "config.fields.dynamicPower", kind: "boolean" },
  { key: "fanThreshold", group: "power", labelKey: "config.fields.fanThreshold", kind: "number", unit: "mW" },
  { key: "modelMatch", group: "model", labelKey: "config.fields.modelMatch", kind: "boolean" },
  { key: "modelId", group: "model", labelKey: "config.fields.modelId", kind: "number" },
  { key: "bindingPhrase", group: "binding", labelKey: "config.fields.bindingPhrase", kind: "text" },
  { key: "antennaMode", group: "antenna", labelKey: "config.fields.antennaMode", kind: "text" },
] as const;

/** i18n keys for group headings, in display order. */
export const SETTING_GROUPS: readonly { id: SettingGroup; labelKey: string }[] = [
  { id: "link", labelKey: "config.groups.link" },
  { id: "power", labelKey: "config.groups.power" },
  { id: "model", labelKey: "config.groups.model" },
  { id: "binding", labelKey: "config.groups.binding" },
  { id: "antenna", labelKey: "config.groups.antenna" },
] as const;

/** Lookup of field metadata by key. */
export const SETTING_FIELD_BY_KEY: Record<SettingKey, SettingFieldMeta> =
  Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, f])) as Record<
    SettingKey,
    SettingFieldMeta
  >;

/**
 * Format a setting value for display. Booleans are translated to On/Off;
 * everything else is rendered as literal config data (shown in a mono font).
 * `undefined` (a field absent from one side of a diff) renders as an em dash.
 */
export function formatSettingValue(
  value: SettingValue | undefined,
  meta: SettingFieldMeta,
  t: TFunction
): string {
  if (value === undefined) return "—";
  if (meta.kind === "boolean") {
    return value ? t("config.values.on") : t("config.values.off");
  }
  return String(value);
}
