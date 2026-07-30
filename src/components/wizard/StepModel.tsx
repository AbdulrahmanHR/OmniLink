import { useTranslation } from "react-i18next";
import { Cpu, ScanLine } from "lucide-react";
import { findBrand } from "@/lib/elrsTargets";
import { useWizardStore } from "@/stores";
import { Badge } from "@/components/ui/badge";
import { SelectableTile } from "./SelectableTile";

/** Step 2 — choose a device model under the selected brand. */
export function StepModel() {
  const { t } = useTranslation();
  const brandId = useWizardStore((s) => s.brandId);
  const modelId = useWizardStore((s) => s.modelId);
  const selectModel = useWizardStore((s) => s.selectModel);
  const detectedTargetName = useWizardStore((s) => s.detectedTargetName);

  const brand = findBrand(brandId);
  if (!brand) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* Auto-detect hint — shown when a connected device pre-selected a model. */}
      {detectedTargetName && (
        <div className="flex items-center gap-1.5 text-xs text-status-good">
          <ScanLine className="h-3.5 w-3.5 shrink-0" />
          <span>{t("wizard.model.detected", { target: detectedTargetName })}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {brand.models.map((model) => (
        <SelectableTile
          key={model.id}
          icon={Cpu}
          title={model.name}
          description={`${brand.name} · ${model.mcu}`}
          selected={model.id === modelId}
          onSelect={() => selectModel(model.id)}
        >
          <Badge variant={model.deviceType === "TX" ? "default" : "secondary"}>
            {t(`wizard.deviceType.${model.deviceType}`)}
          </Badge>
          <Badge variant="outline">
            <span className="font-mono">{model.target}</span>
          </Badge>
          <Badge variant="outline">
            {t("wizard.model.bandCount", { count: model.domains.length })}
          </Badge>
        </SelectableTile>
      ))}
      </div>
    </div>
  );
}
