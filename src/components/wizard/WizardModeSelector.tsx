import { useTranslation } from "react-i18next";
import { Sparkles, Wrench } from "lucide-react";
import { useWizardStore, type WizardMode } from "@/stores";
import { cn } from "@/lib/utils";

/**
 * Wizard mode selector (M53) — a segmented radio control that toggles between the
 * deterministic `static`/offline wizard and the optional `ai`-assisted mode. It
 * is a PARALLEL flag only: it never touches `WIZARD_STEPS` or step validity, just
 * which surface `WizardPage` renders. Locked (disabled) while a flash is active
 * so the experience can't be swapped mid-flash.
 *
 * a11y: a real `radiogroup` (fieldset + legend) with two native radio inputs, so
 * axe and keyboard/AT users get first-class semantics; every string via `t()`.
 */

interface ModeOption {
  mode: WizardMode;
  labelKey: string;
  hintKey: string;
  Icon: typeof Wrench;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    mode: "static",
    labelKey: "wizard.mode.static",
    hintKey: "wizard.mode.staticHint",
    Icon: Wrench,
  },
  {
    mode: "ai",
    labelKey: "wizard.mode.ai",
    hintKey: "wizard.mode.aiHint",
    Icon: Sparkles,
  },
];

export function WizardModeSelector({ locked = false }: { locked?: boolean }) {
  const { t } = useTranslation();
  const wizardMode = useWizardStore((s) => s.wizardMode);
  const setWizardMode = useWizardStore((s) => s.setWizardMode);

  return (
    <fieldset
      data-testid="wizard-mode-selector"
      disabled={locked}
      className="min-w-0"
    >
      <legend className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("wizard.mode.label")}
      </legend>
      <div
        role="radiogroup"
        aria-label={t("wizard.mode.label")}
        className="inline-flex rounded-lg border border-border bg-card/60 p-0.5"
      >
        {MODE_OPTIONS.map(({ mode, labelKey, hintKey, Icon }) => {
          const active = wizardMode === mode;
          return (
            <label
              key={mode}
              title={t(hintKey)}
              data-testid={`wizard-mode-${mode}`}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
                locked && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name="wizard-mode"
                value={mode}
                checked={active}
                disabled={locked}
                onChange={() => setWizardMode(mode)}
                className="sr-only"
              />
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t(labelKey)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
