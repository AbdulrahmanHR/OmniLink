import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { ELRS_BRANDS } from "@/lib/elrsTargets";
import { useWizardStore } from "@/stores";
import { SelectableTile } from "./SelectableTile";

/** Step 1 — choose a vendor. */
export function StepBrand() {
  const { t } = useTranslation();
  const brandId = useWizardStore((s) => s.brandId);
  const selectBrand = useWizardStore((s) => s.selectBrand);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ELRS_BRANDS.map((brand) => (
        <SelectableTile
          key={brand.id}
          icon={Radio}
          title={brand.name}
          description={t("wizard.brand.modelCount", {
            count: brand.models.length,
          })}
          selected={brand.id === brandId}
          onSelect={() => selectBrand(brand.id)}
        />
      ))}
    </div>
  );
}
