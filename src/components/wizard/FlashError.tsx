import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardCheck, Copy, RotateCcw, XCircle } from "lucide-react";
import type { FlashErrorPayload } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FlashLogPanel } from "./FlashLogPanel";

interface FlashErrorProps {
  error: FlashErrorPayload;
  log: string[];
  /** Reset the flash slice back to idle so the user can try again. */
  onRetry: () => void;
}

/**
 * Failure view (FR-FLASH-08 / FR-FLASH-12): categorized human-readable summary,
 * context-specific recovery steps, the raw log in a collapsible panel, and a
 * "Copy Diagnostic Report" button.
 */
export function FlashError({ error, log, onRetry }: FlashErrorProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copyDiagnostic = async () => {
    try {
      await navigator.clipboard.writeText(error.diagnostic);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — leave the button label unchanged.
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-lg border border-status-critical/40 bg-status-critical/10 p-4">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-critical" />
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t(`wizard.flash.errors.${error.summaryKey}`, {
              defaultValue: t(`wizard.flash.categories.${error.category}`),
            })}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(`wizard.flash.categories.${error.category}`)}
          </p>
        </div>
      </div>

      {/* Recovery steps */}
      {error.recoverySteps.length > 0 && (
        <div className="rounded-md border border-border bg-card/60 p-4">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("wizard.flash.recoveryTitle")}
          </h4>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
            {error.recoverySteps.map((step) => (
              <li key={step}>{t(`wizard.flash.recovery.${step}`)}</li>
            ))}
          </ol>
        </div>
      )}

      {/* Raw log (FR-FLASH-12 (b)) */}
      <FlashLogPanel log={log.length > 0 ? log : [error.detail]} defaultOpen />

      <Separator />
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={copyDiagnostic}>
          {copied ? <ClipboardCheck /> : <Copy />}
          {copied ? t("wizard.flash.copied") : t("wizard.flash.copyDiagnostic")}
        </Button>
        <Button size="sm" onClick={onRetry}>
          <RotateCcw />
          {t("wizard.flash.retry")}
        </Button>
      </div>
    </div>
  );
}
