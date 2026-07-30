import { useId } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Link2 } from "lucide-react";
import { useWizardStore } from "@/stores";
import { useDerivedUid } from "@/hooks";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectableTile } from "./SelectableTile";

/** Step 4 — binding phrase or traditional binding. */
export function StepBinding() {
  const { t } = useTranslation();
  const phraseInputId = useId();
  const useTraditional = useWizardStore((s) => s.useTraditionalBinding);
  const bindingPhrase = useWizardStore((s) => s.bindingPhrase);
  const setUseTraditional = useWizardStore((s) => s.setUseTraditionalBinding);
  const setBindingPhrase = useWizardStore((s) => s.setBindingPhrase);

  // The real ELRS UID (MD5 of the phrase), derived by the Rust backend so the
  // preview equals exactly what gets flashed (FR-FLASH-03).
  const uid = useDerivedUid(bindingPhrase, !useTraditional);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("wizard.binding.modeTitle")}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectableTile
            icon={KeyRound}
            title={t("wizard.binding.phrase.name")}
            description={t("wizard.binding.phrase.description")}
            selected={!useTraditional}
            onSelect={() => setUseTraditional(false)}
          />
          <SelectableTile
            icon={Link2}
            title={t("wizard.binding.traditional.name")}
            description={t("wizard.binding.traditional.description")}
            selected={useTraditional}
            onSelect={() => setUseTraditional(true)}
          />
        </div>
      </section>

      {useTraditional ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {t("wizard.binding.traditionalNote")}
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={phraseInputId}>
              {t("wizard.binding.phraseLabel")}
            </Label>
            <Input
              id={phraseInputId}
              value={bindingPhrase}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t("wizard.binding.phrasePlaceholder")}
              onChange={(e) => setBindingPhrase(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card/60 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              {t("wizard.binding.uidLabel")}
            </span>
            <span className="font-mono text-base font-semibold tabular-nums text-primary">
              {uid ?? "—"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t("wizard.binding.uidHint")}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
