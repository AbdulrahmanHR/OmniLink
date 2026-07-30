import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import {
  furthestReachableIndex,
  isWizardStepValid,
  useWizardStore,
  WIZARD_STEPS,
  type WizardStep,
} from "@/stores";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AiWizardPanel,
  StepBinding,
  StepBrand,
  StepFrequency,
  StepModel,
  StepReview,
  WizardModeSelector,
  WizardNav,
  WizardStepper,
} from "@/components/wizard";

/** Renders the active step's body. */
function StepBody({ step }: { step: WizardStep }) {
  switch (step) {
    case "brand":
      return <StepBrand />;
    case "model":
      return <StepModel />;
    case "frequency":
      return <StepFrequency />;
    case "binding":
      return <StepBinding />;
    case "review":
      return <StepReview />;
  }
}

export function WizardPage() {
  const { t } = useTranslation();

  const step = useWizardStore((s) => s.step);
  const wizardMode = useWizardStore((s) => s.wizardMode);
  const next = useWizardStore((s) => s.next);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const reset = useWizardStore((s) => s.reset);
  const autoDetectFromDevice = useWizardStore((s) => s.autoDetectFromDevice);

  // Best-effort pre-selection from a connected device when the wizard opens.
  // Manual selection remains the fallback (the action no-ops without a match).
  useEffect(() => {
    autoDetectFromDevice();
  }, [autoDetectFromDevice]);

  // Derived booleans — each selector returns a primitive so re-renders are tight.
  const currentValid = useWizardStore((s) => isWizardStepValid(s, step));
  const maxReachableIndex = useWizardStore(furthestReachableIndex);
  const flashActive = useWizardStore(
    (s) =>
      s.flash.status === "running" ||
      s.flash.status === "done" ||
      s.flash.status === "error"
  );

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isReview = step === "review";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t("wizard.title")}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("wizard.subtitle")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reset}>
          <RotateCcw />
          {t("wizard.nav.startOver")}
        </Button>
      </div>

      {/* Mode selector (M53) — parallel flag; locked while a flash is active. */}
      <WizardModeSelector locked={flashActive} />

      {wizardMode === "ai" ? (
        /* AI-assisted mode renders its own panel; the static flow below is
           untouched. Its "Apply & review" hands off to the SAME review step. */
        <AiWizardPanel />
      ) : (
        <>
          {/* Stepper */}
          <WizardStepper
            current={step}
            maxReachableIndex={maxReachableIndex}
            onStepClick={goToStep}
            locked={flashActive}
          />

          {/* Active step */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t(`wizard.steps.${step}.title`)}
              </CardTitle>
              <CardDescription>
                {t(`wizard.steps.${step}.instruction`)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StepBody step={step} />
            </CardContent>
          </Card>

          {/* Navigation — hidden while the fake flash runs / after success. */}
          {!(isReview && flashActive) && (
            <WizardNav
              onBack={back}
              onNext={next}
              backDisabled={isFirst}
              nextDisabled={!currentValid}
              hideNext={isReview}
              hint={t(`wizard.validation.${step}`, { defaultValue: "" })}
            />
          )}
        </>
      )}
    </div>
  );
}
