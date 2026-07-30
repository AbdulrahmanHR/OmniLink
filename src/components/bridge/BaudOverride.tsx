import { useTranslation } from "react-i18next";
import { PASSTHROUGH_BAUDS } from "@/lib/bridge";

/** Shared classes for the native <select> (mirrors FindingsList / DeviceBar). */
const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

/**
 * Manual baud override for the M64 passthrough check (FR-FLASH-09b). A native
 * `<select>` over the common FC passthrough rates ({@link PASSTHROUGH_BAUDS}),
 * plus an "Auto" option that lets the backend run its full baud-fallback loop.
 * The selection only picks which rate is TRIED FIRST — the backend still
 * exhausts every candidate before declaring failure.
 *
 * Accessible: an associated `<label htmlFor>` + `aria-label`. `undefined` value
 * ⇒ Auto (no override).
 */
export function BaudOverride({
  value,
  onChange,
  disabled,
}: {
  value: number | undefined;
  onChange: (baud: number | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="passthrough-baud-override"
        className="whitespace-nowrap text-xs text-muted-foreground"
      >
        {t("bridge.passthrough.baudOverride")}
      </label>
      <select
        id="passthrough-baud-override"
        data-testid="passthrough-baud-override"
        className={SELECT_CLASS}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
        aria-label={t("bridge.passthrough.baudOverride")}
      >
        <option value="">{t("bridge.passthrough.baudAuto")}</option>
        {PASSTHROUGH_BAUDS.map((baud) => (
          <option key={baud} value={baud}>
            {baud}
          </option>
        ))}
      </select>
    </div>
  );
}
