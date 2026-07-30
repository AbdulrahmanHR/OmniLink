import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import type {
  DiagnosticCategory,
  DiagnosticSensitivity,
} from "@/lib/diagnostics";
import { useDiagnosticsStore } from "@/stores/diagnostics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** The three sensitivity presets, in cautious → aggressive order. */
const PRESETS: readonly DiagnosticSensitivity[] = [
  "beginner",
  "intermediate",
  "advanced",
];

/** The four diagnostic categories (per-rule master switches). */
const CATEGORIES: readonly DiagnosticCategory[] = [
  "signal",
  "link",
  "power",
  "stability",
];

/** Compact on/off switch mirroring the SettingsPage `ToggleSwitch` pattern. */
function ToggleSwitch({
  checked,
  label,
  onLabel,
  offLabel,
  onChange,
}: {
  checked: boolean;
  label: string;
  onLabel: string;
  offLabel: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <Button
      type="button"
      variant={checked ? "default" : "outline"}
      size="sm"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      {checked ? <Check aria-hidden /> : <X aria-hidden />}
      {checked ? onLabel : offLabel}
    </Button>
  );
}

/**
 * Diagnostics configuration panel (M37): a self-contained trigger button that
 * opens a {@link Sheet}. Inside, the operator picks a sensitivity preset, toggles
 * the per-category master switches, and (under an advanced disclosure) overrides
 * a few representative per-rule thresholds. Every control writes straight through
 * to the diagnostics store — no detection logic lives here.
 */
export function DiagnosticSettings() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const titleId = useId();
  const baseId = useId();

  // Separate selectors (avoid a fresh-object snapshot loop).
  const sensitivity = useDiagnosticsStore((s) => s.config.sensitivity);
  const enabledCategories = useDiagnosticsStore((s) => s.config.enabledCategories);
  const rules = useDiagnosticsStore((s) => s.config.rules);
  const setSensitivityPreset = useDiagnosticsStore((s) => s.setSensitivityPreset);
  const updateConfig = useDiagnosticsStore((s) => s.updateConfig);

  const num = (raw: string): number =>
    Number.isFinite(Number(raw)) ? Number(raw) : 0;

  // Representative per-rule threshold overrides. Each nested partial is a valid
  // DeepPartial<DiagnosticConfig>, so the store's deep-merge applies it cleanly.
  const thresholdRows: {
    id: string;
    labelKey: string;
    unit: string;
    value: number;
    onChange: (n: number) => void;
  }[] = [
    {
      id: "lq",
      labelKey: "diagnostics.settings.threshold.lqFloor",
      unit: "%",
      value: rules.lqCollapse.absThreshold,
      onChange: (n) => updateConfig({ rules: { lqCollapse: { absThreshold: n } } }),
    },
    {
      id: "rssi",
      labelKey: "diagnostics.settings.threshold.rssiFloor",
      unit: "dBm",
      value: rules.rssiFloor.floorDbm,
      onChange: (n) => updateConfig({ rules: { rssiFloor: { floorDbm: n } } }),
    },
    {
      id: "snr",
      labelKey: "diagnostics.settings.threshold.snrStd",
      unit: "dB",
      value: rules.snrNoise.stdThreshold,
      onChange: (n) => updateConfig({ rules: { snrNoise: { stdThreshold: n } } }),
    },
    {
      id: "jitter",
      labelKey: "diagnostics.settings.threshold.jitter",
      unit: "",
      value: rules.packetInstability.jitterThreshold,
      onChange: (n) =>
        updateConfig({ rules: { packetInstability: { jitterThreshold: n } } }),
    },
    {
      id: "txrssi",
      labelKey: "diagnostics.settings.threshold.txPoorRssi",
      unit: "dBm",
      value: rules.txPowerSaturation.poorRssiDbm,
      onChange: (n) =>
        updateConfig({ rules: { txPowerSaturation: { poorRssiDbm: n } } }),
    },
  ];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="diagnostics-settings-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal aria-hidden />
        {t("diagnostics.settings.open")}
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} labelledBy={titleId}>
        <div
          data-testid="diagnostics-settings-sheet"
          className="flex h-full flex-col"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border p-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-semibold text-foreground">
                {t("diagnostics.settings.title")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("diagnostics.settings.description")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t("common.close")}
              onClick={() => setOpen(false)}
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </header>

          <div className="flex-1 space-y-6 overflow-y-auto p-4">
            {/* Sensitivity preset */}
            <section className="space-y-2">
              <Label>{t("diagnostics.settings.sensitivity")}</Label>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((preset) => {
                  const active = sensitivity === preset;
                  return (
                    <Button
                      key={preset}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      data-testid={`diagnostics-preset-${preset}`}
                      aria-pressed={active}
                      onClick={() => setSensitivityPreset(preset)}
                    >
                      {t(`diagnostics.settings.preset.${preset}`)}
                    </Button>
                  );
                })}
              </div>
            </section>

            {/* Per-category master switches */}
            <section className="space-y-2">
              <Label>{t("diagnostics.settings.categories")}</Label>
              <div className="flex flex-col gap-2">
                {CATEGORIES.map((category) => (
                  <div
                    key={category}
                    className="flex items-center justify-between gap-4 rounded-md border border-border p-2"
                  >
                    <span className="text-sm text-foreground">
                      {t(`diagnostics.category.${category}`)}
                    </span>
                    <ToggleSwitch
                      checked={enabledCategories[category]}
                      label={t(`diagnostics.category.${category}`)}
                      onLabel={t("diagnostics.settings.on")}
                      offLabel={t("diagnostics.settings.off")}
                      onChange={(v) =>
                        updateConfig({ enabledCategories: { [category]: v } })
                      }
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* Advanced threshold overrides */}
            <section className="space-y-3">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                className="flex items-center gap-1.5 rounded-sm text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <ChevronDown
                  aria-hidden
                  className={cn(
                    "size-4 motion-safe:transition-transform",
                    advancedOpen && "rotate-180"
                  )}
                />
                {t("diagnostics.settings.advancedToggle")}
              </button>

              {advancedOpen && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t("diagnostics.settings.thresholds")}
                  </p>
                  <p className="text-xs text-muted-foreground/80">
                    {t("diagnostics.settings.thresholdsSessionOnly")}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {thresholdRows.map((row) => {
                      const inputId = `${baseId}-${row.id}`;
                      return (
                        <div key={row.id} className="space-y-1.5">
                          <Label htmlFor={inputId}>
                            {t(row.labelKey)}
                            {row.unit && (
                              <span className="ml-1 text-muted-foreground">
                                ({row.unit})
                              </span>
                            )}
                          </Label>
                          <Input
                            id={inputId}
                            type="number"
                            inputMode="numeric"
                            className="font-mono tabular-nums"
                            value={row.value}
                            onChange={(e) => row.onChange(num(e.target.value))}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSensitivityPreset(sensitivity)}
                  >
                    <RotateCcw aria-hidden />
                    {t("diagnostics.settings.reset")}
                  </Button>
                </div>
              )}
            </section>
          </div>
        </div>
      </Sheet>
    </>
  );
}
