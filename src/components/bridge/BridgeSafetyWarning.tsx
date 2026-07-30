import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Hardware-safety warning shown BEFORE any controller bridge connect/probe
 * action (M63). Reuses the shipped flashing-safety warning recipe from
 * `StepReview.tsx` (inline status-warning box + lucide `TriangleAlert`, copy via
 * `t()`), with `role="alert"` so assistive tech announces it.
 *
 * The default copy (`bridge.safety.warning`) covers the props-off / bench-test
 * posture: a controller probe energizes the FC/RX, so props must be off and
 * nothing must be able to spin. `messageKey` overrides the copy so M64's
 * passthrough flow can show its RX-energizing-specific warning
 * (`bridge.passthrough.safety`) via the SAME accessible recipe.
 */
export function BridgeSafetyWarning({
  className,
  messageKey = "bridge.safety.warning",
}: {
  className?: string;
  messageKey?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      data-testid="bridge-safety-warning"
      className={cn(
        "flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs text-status-warning",
        className
      )}
    >
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{t(messageKey)}</span>
    </div>
  );
}
