import { useTranslation } from "react-i18next";
import type { SetupSuggestion, SuggestionConfidence } from "@/lib/diagnostics";
import { Badge } from "@/components/ui/badge";

interface SuggestionCardProps {
  suggestion: SetupSuggestion;
}

/** Confidence → Badge variant: measured is strongest, worth-checking weakest. */
const CONFIDENCE_VARIANT: Record<
  SuggestionConfidence,
  "good" | "warning" | "outline"
> = {
  measured: "good",
  likely: "warning",
  worthChecking: "outline",
};

/**
 * One conservative setup-suggestion card (M40).
 *
 * Renders a confidence chip (measured / likely / worth-checking) plus the localized
 * title and body of a pure {@link SetupSuggestion} — no logic here. The confidence
 * label + Badge variant make the "how sure are we" separation explicit so a hunch
 * is never dressed up as a measurement. Body copy interpolates only the
 * non-identifying `detail` counts.
 */
export function SuggestionCard({ suggestion }: SuggestionCardProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="diagnostics-suggestion"
      className="flex flex-col gap-1.5 rounded-md border border-border p-3"
    >
      <span className="flex flex-wrap items-center gap-2">
        <Badge variant={CONFIDENCE_VARIANT[suggestion.confidence]}>
          {t(`diagnostics.confidence.${suggestion.confidence}`)}
        </Badge>
        <span className="text-sm font-medium text-foreground">
          {t(suggestion.titleKey)}
        </span>
      </span>
      <span className="text-sm text-foreground/90">
        {t(suggestion.bodyKey, suggestion.detail)}
      </span>
    </div>
  );
}
