import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface WizardNavProps {
  onBack: () => void;
  onNext: () => void;
  backDisabled: boolean;
  nextDisabled: boolean;
  /** Hide the Next button on the final step (Flash lives in the review card). */
  hideNext?: boolean;
  /** Optional validation hint shown when Next is disabled. */
  hint?: string;
}

/** Back / Next control row for the wizard. */
export function WizardNav({
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  hideNext = false,
  hint,
}: WizardNavProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" onClick={onBack} disabled={backDisabled}>
        <ArrowLeft />
        {t("wizard.nav.back")}
      </Button>

      <div className="flex items-center gap-3">
        {hint && nextDisabled && !hideNext && (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {hint}
          </span>
        )}
        {!hideNext && (
          <Button onClick={onNext} disabled={nextDisabled}>
            {t("wizard.nav.next")}
            <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  );
}
