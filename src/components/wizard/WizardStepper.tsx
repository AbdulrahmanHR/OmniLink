import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { WIZARD_STEPS, type WizardStep } from "@/stores";

interface WizardStepperProps {
  current: WizardStep;
  /** Highest step index the user may jump to (clickable threshold). */
  maxReachableIndex: number;
  onStepClick: (step: WizardStep) => void;
  /** When true, no step is interactive (e.g. while a flash is in progress). */
  locked?: boolean;
}

/** Horizontal numbered step indicator with completed / active states. */
export function WizardStepper({
  current,
  maxReachableIndex,
  onStepClick,
  locked = false,
}: WizardStepperProps) {
  const { t } = useTranslation();
  const currentIndex = WIZARD_STEPS.indexOf(current);

  return (
    <ol className="flex items-center gap-1" aria-label={t("wizard.title")}>
      {WIZARD_STEPS.map((step, index) => {
        const isCompleted = index < currentIndex;
        const isCurrent = index === currentIndex;
        const isInteractive = index <= maxReachableIndex && !locked;

        return (
          <li key={step} className="flex flex-1 items-center gap-1">
            <button
              type="button"
              disabled={!isInteractive}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => onStepClick(step)}
              className={cn(
                "group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-200 motion-reduce:transition-none",
                isInteractive
                  ? "cursor-pointer hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
                  : "cursor-not-allowed opacity-60"
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-all duration-200 motion-reduce:transition-none",
                  isCompleted &&
                    "border-status-good bg-status-good/15 text-status-good",
                  isCurrent &&
                    "border-primary bg-primary text-primary-foreground shadow-[0_0_14px_-2px_var(--color-signal-glow)]",
                  !isCompleted &&
                    !isCurrent &&
                    "border-border bg-muted text-muted-foreground"
                )}
              >
                {isCompleted ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "hidden truncate text-xs font-medium sm:inline",
                  isCurrent ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {t(`wizard.steps.${step}.title`)}
              </span>
            </button>
            {index < WIZARD_STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1 transition-colors duration-200 motion-reduce:transition-none",
                  index < currentIndex ? "bg-status-good" : "bg-border"
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
