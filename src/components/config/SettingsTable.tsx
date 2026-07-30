import { useTranslation } from "react-i18next";
import {
  SETTING_FIELDS,
  SETTING_GROUPS,
  formatSettingValue,
  type ProfileSettings,
  type SettingGroup,
} from "@/lib/profileSettings";

interface SettingsTableProps {
  settings: ProfileSettings;
}

/** Renders a ProfileSettings as a labeled, grouped grid with mono values. */
export function SettingsTable({ settings }: SettingsTableProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      {SETTING_GROUPS.map((group) => {
        const fields = SETTING_FIELDS.filter(
          (f) => f.group === (group.id as SettingGroup)
        );
        if (fields.length === 0) return null;

        return (
          <div key={group.id}>
            <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(group.labelKey)}
            </h4>
            <dl className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {fields.map((field) => (
                <div
                  key={field.key}
                  className="flex items-center justify-between gap-4 px-3 py-2"
                >
                  <dt className="text-sm text-muted-foreground">
                    {t(field.labelKey)}
                  </dt>
                  <dd className="flex items-baseline gap-1">
                    <span className="font-mono text-sm text-foreground">
                      {formatSettingValue(settings[field.key], field, t)}
                    </span>
                    {field.unit && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {field.unit}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}
