import { useTranslation } from "react-i18next";
import { Check, FlaskConical, RotateCcw, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  clearDevFlags,
  getFeatureFlag,
  persistDevFlag,
  setFeatureFlag,
  type FeatureFlags,
} from "@/lib/featureFlags";

/**
 * Dev-only "Preview features" panel (punch-list item 8). Rendered ONLY under
 * `import.meta.env.DEV` (see `SettingsPage` — it is never mounted in a shipped
 * build), so QA/demos + e2e can reach the flag-gated surface WITHOUT editing
 * `lib/featureFlags.ts`. Production is untouched: flags stay OFF and code-only.
 *
 * Each row is a labeled switch for one flag. Flags are NOT reactive, so a toggle
 * persists the choice (`persistDevFlag`) + flips the in-memory value
 * (`setFeatureFlag`) and then reloads — the clean, honest "apply" that makes
 * every gated surface re-read the flag. Reset clears the override blob and
 * restores ship defaults (all OFF).
 *
 * v3.0 (M69) removed the five platform flags this panel used to list, leaving
 * the v2.5 ML lab as the only preview surface. The panel is kept rather than
 * deleted because that surface still needs a way in.
 */
const PREVIEW_FLAGS: readonly (keyof FeatureFlags)[] = ["mlLab"];

export function DevFeatureFlags() {
  const { t } = useTranslation();

  const toggle = (key: keyof FeatureFlags, next: boolean) => {
    persistDevFlag(key, next);
    setFeatureFlag(key, next);
    window.location.reload();
  };

  const reset = () => {
    clearDevFlags();
    window.location.reload();
  };

  return (
    <Card data-testid="dev-feature-flags">
      <CardHeader>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.devFlags.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.devFlags.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {PREVIEW_FLAGS.map((key) => {
          const checked = getFeatureFlag(key);
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <Label>{t(`settings.devFlags.flag.${key}`)}</Label>
              <Button
                type="button"
                variant={checked ? "default" : "outline"}
                size="sm"
                role="switch"
                aria-checked={checked}
                aria-label={t(`settings.devFlags.flag.${key}`)}
                data-testid={`dev-flag-${key}`}
                onClick={() => toggle(key, !checked)}
              >
                {checked ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                {checked
                  ? t("settings.devFlags.on")
                  : t("settings.devFlags.off")}
              </Button>
            </div>
          );
        })}

        <p className="text-xs text-muted-foreground">
          {t("settings.devFlags.applyNote")}
        </p>

        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="dev-flags-reset"
          onClick={reset}
        >
          <RotateCcw className="h-4 w-4" />
          {t("settings.devFlags.reset")}
        </Button>
      </CardContent>
    </Card>
  );
}
