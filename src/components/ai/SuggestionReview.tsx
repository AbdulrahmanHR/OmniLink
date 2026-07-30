import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileDiff } from "@/components/config/ProfileDiff";
import { useProfilesStore } from "@/stores/profiles";
import {
  buildSuggestionAfter,
  suggestionToProfilePatch,
  validateSuggestion,
} from "@/lib/aiSuggestionSchema";
import { applySuggestedProfile } from "@/lib/suggestionApply";
import type { UserDefineSuggestion } from "@/lib/ai";

interface SuggestionReviewProps {
  suggestion: UserDefineSuggestion;
  /** Optional confidence in `[0,1]` — below the threshold shows a low-confidence warning. */
  confidence?: number;
  /** Called after the change is applied (e.g. to collapse the review). */
  onApplied?: () => void;
}

/** Suggestions at or below this confidence get a clear low-confidence warning. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * The M54 review/diff-before-apply affordance for an AI-suggested setting.
 *
 * A suggestion reaching here has already passed the AUTHORITATIVE Rust gate; the
 * client re-validates (defense-in-depth) and maps it to a {@link ProfileSettings}
 * patch. When the patch is mappable, it builds `after = { ...activeSettings,
 * <mapped> }` and shows the EXISTING {@link ProfileDiff}, gated behind an
 * explicit two-step Apply → Confirm (required user confirmation). Applying routes
 * through the SINGLE existing apply path (`importProfile` → `applyProfile`).
 *
 * A validated-but-unmappable, low-confidence, or blocked/unsupported suggestion
 * shows a clear warning and is NEVER auto-applied — there is nothing appliable.
 */
export function SuggestionReview({
  suggestion,
  confidence,
  onApplied,
}: SuggestionReviewProps) {
  const { t } = useTranslation();
  const activeSettings = useProfilesStore((s) => s.activeSettings);
  const importProfile = useProfilesStore((s) => s.importProfile);
  const applyProfile = useProfilesStore((s) => s.applyProfile);

  const [confirming, setConfirming] = useState(false);
  const [applied, setApplied] = useState(false);

  const patch = useMemo(
    () => suggestionToProfilePatch(suggestion),
    [suggestion]
  );
  const after = useMemo(
    () => (patch ? buildSuggestionAfter(activeSettings, patch) : null),
    [activeSettings, patch]
  );

  const isValid = validateSuggestion(suggestion);
  const lowConfidence =
    typeof confidence === "number" && confidence <= LOW_CONFIDENCE_THRESHOLD;

  const handleApply = () => {
    if (!after) return;
    applySuggestedProfile(
      after,
      t("ai.suggestion.appliedProfileName", { key: suggestion.key }),
      { importProfile, applyProfile }
    );
    setApplied(true);
    setConfirming(false);
    onApplied?.();
  };

  // Validated but not mappable to a profile field (or blocked/unsupported):
  // show a warning, never an Apply button — nothing can be written.
  if (!patch || !after) {
    return (
      <div
        role="note"
        className="flex flex-col gap-1.5 rounded-lg border border-status-warning/50 bg-status-warning/5 px-3 py-2 text-xs"
      >
        <span className="flex items-center gap-1.5 font-semibold text-status-warning">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          {isValid
            ? t("ai.suggestion.unsupported")
            : t("ai.suggestion.blocked")}
        </span>
        <p className="text-muted-foreground">
          {isValid
            ? t("ai.suggestion.unsupportedHint")
            : t("ai.suggestion.blockedHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-background/60 px-3 py-2.5">
      <span className="text-xs font-semibold text-foreground">
        {t("ai.suggestion.reviewTitle")}
      </span>

      {lowConfidence && (
        <p
          role="note"
          className="flex items-start gap-1.5 rounded-md border border-status-warning/50 bg-status-warning/5 px-2 py-1.5 text-[11px] text-status-warning"
        >
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>{t("ai.suggestion.lowConfidence")}</span>
        </p>
      )}

      <ProfileDiff before={activeSettings} after={after} />

      {applied ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-status-good">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {t("ai.suggestion.applied")}
        </p>
      ) : confirming ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            {t("ai.suggestion.confirmPrompt")}
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" onClick={handleApply}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t("ai.suggestion.confirm")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("ai.suggestion.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setConfirming(true)}
        >
          {t("ai.suggestion.apply")}
        </Button>
      )}
    </div>
  );
}
