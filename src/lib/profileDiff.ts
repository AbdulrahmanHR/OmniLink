import {
  SETTING_FIELDS,
  type ProfileSettings,
  type SettingKey,
  type SettingValue,
} from "./profileSettings";

/**
 * Per-field diff status.
 * - `unchanged`: present on both sides with equal values.
 * - `changed`: present on both sides with different values.
 * - `added`: present only on the "after" side.
 * - `removed`: present only on the "before" side.
 */
export type DiffStatus = "unchanged" | "changed" | "added" | "removed";

export interface DiffRow {
  key: SettingKey;
  before: SettingValue | undefined;
  after: SettingValue | undefined;
  status: DiffStatus;
}

export interface DiffResult {
  rows: DiffRow[];
  /** Number of rows whose status is not `unchanged`. */
  changeCount: number;
  /** True when every row is `unchanged`. */
  identical: boolean;
}

function classify(
  before: SettingValue | undefined,
  after: SettingValue | undefined
): DiffStatus {
  if (before === undefined && after !== undefined) return "added";
  if (before !== undefined && after === undefined) return "removed";
  return Object.is(before, after) ? "unchanged" : "changed";
}

/**
 * Pure diff of two profile setting sets, producing one row per known field in
 * canonical {@link SETTING_FIELDS} order. Accepts partial inputs so it can also
 * express added/removed fields (e.g. when comparing across schema versions).
 *
 * `before` is the baseline (typically the device's current/active config) and
 * `after` is the candidate (the selected profile being previewed).
 */
export function diffProfiles(
  before: Partial<ProfileSettings>,
  after: Partial<ProfileSettings>
): DiffResult {
  const rows: DiffRow[] = SETTING_FIELDS.map(({ key }) => {
    const b = before[key];
    const a = after[key];
    return { key, before: b, after: a, status: classify(b, a) };
  });

  const changeCount = rows.reduce(
    (n, row) => (row.status === "unchanged" ? n : n + 1),
    0
  );

  return { rows, changeCount, identical: changeCount === 0 };
}
