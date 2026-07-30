import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Backpack } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
  BACKPACK_FIELDS,
  type BackpackField,
  type BackpackSettings,
} from "@/lib/backpackConfig";

interface BackpackConfigFormProps {
  value: BackpackSettings;
  onChange: (next: BackpackSettings) => void;
}

/**
 * Data-driven Backpack settings form (FR-FLASH-11c).
 *
 * Renders {@link BACKPACK_FIELDS} generically — there is NO bespoke per-field
 * JSX. `enum` fields become a native `<select>`, `bool` fields a checkbox; both
 * label/help strings come from each field's i18n keys. Reads AND writes flow
 * through `value`/`onChange`, so the form is a pure controlled component (real
 * device read/write is HW-pending; locally it is fully dev-verifiable).
 */
export function BackpackConfigForm({
  value,
  onChange,
}: BackpackConfigFormProps) {
  const { t } = useTranslation();

  // Override one field, preserving the rest. The assertion is required because
  // the computed key is the full keyof union while the new value is just one
  // field's type — the field.type branch guarantees they line up at runtime.
  const setField = (field: BackpackField, fieldValue: string | boolean) => {
    onChange({ ...value, [field.key]: fieldValue } as BackpackSettings);
  };

  return (
    <section
      data-testid="backpack-config-form"
      className="flex flex-col gap-4 rounded-md border border-border bg-card p-4"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Backpack className="h-4 w-4 text-primary" aria-hidden="true" />
        {t("backpack.config.title")}
      </h3>

      <div className="flex flex-col gap-4">
        {BACKPACK_FIELDS.map((field) => (
          <BackpackFieldRow
            key={field.key}
            field={field}
            value={value[field.key]}
            onChange={(next) => setField(field, next)}
          />
        ))}
      </div>
    </section>
  );
}

interface BackpackFieldRowProps {
  field: BackpackField;
  value: string | boolean;
  onChange: (next: string | boolean) => void;
}

/** One generically-rendered Backpack field (enum → select, bool → checkbox). */
function BackpackFieldRow({ field, value, onChange }: BackpackFieldRowProps) {
  const { t } = useTranslation();
  const controlId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      {field.type === "bool" ? (
        <label
          htmlFor={controlId}
          className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground"
        >
          <input
            id={controlId}
            data-testid={`backpack-field-${field.key}`}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {t(field.labelKey)}
        </label>
      ) : (
        <>
          <Label htmlFor={controlId} className="text-foreground">
            {t(field.labelKey)}
          </Label>
          <select
            id={controlId}
            data-testid={`backpack-field-${field.key}`}
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm",
              "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            )}
          >
            {(field.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(field.helpKey)}
      </p>
    </div>
  );
}
