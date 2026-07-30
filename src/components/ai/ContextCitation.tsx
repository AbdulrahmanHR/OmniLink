import { useTranslation } from "react-i18next";
import { FileSearch } from "lucide-react";
import { findBrand, findModel } from "@/lib/elrsTargets";
import { useAssistantStore, useDeviceStore, useWizardStore } from "@/stores";

/**
 * Compact "based-on context" citation (M23): a presentational card that makes
 * an assistant answer's grounding transparent — it shows the active context
 * mode and the target/device that mode resolves to, and nudges the user to
 * verify against their live config. It cites only real, in-app state (the
 * connected device or the wizard target) — never invented sources.
 */
export function ContextCitation() {
  const { t } = useTranslation();
  const mode = useAssistantStore((s) => s.contextMode);
  const status = useDeviceStore((s) => s.status);
  const device = useDeviceStore((s) => s.device);
  const brandId = useWizardStore((s) => s.brandId);
  const modelId = useWizardStore((s) => s.modelId);

  const deviceLabel =
    status === "connected" && device ? device.targetName : null;
  const brand = findBrand(brandId);
  const model = findModel(brandId, modelId);
  const wizardLabel = brand && model ? `${brand.name} ${model.name}` : null;

  // Resolve the grounding label the same way `selectAiContext` resolves data.
  let grounding: string;
  switch (mode) {
    case "offline":
      grounding = t("ai.citation.offline");
      break;
    case "device":
      grounding = deviceLabel ?? t("ai.citation.none");
      break;
    case "wizard":
      grounding = wizardLabel ?? t("ai.citation.none");
      break;
    case "auto":
    default:
      grounding = deviceLabel ?? wizardLabel ?? t("ai.citation.none");
      break;
  }

  return (
    <div
      role="note"
      className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <FileSearch className="h-3.5 w-3.5 shrink-0 text-primary" />
        {t("ai.citation.title")}
      </span>
      <span>
        {t(`ai.context.${mode}`)}
        {" · "}
        <span className="font-mono text-foreground">{grounding}</span>
      </span>
      <span>{t("ai.citation.verify")}</span>
    </div>
  );
}
