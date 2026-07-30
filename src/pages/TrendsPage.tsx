import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrendingUp, Trash2 } from "lucide-react";
import {
  deriveSuggestions,
  MIN_SESSIONS_FOR_TRENDS,
  summarizeTrends,
} from "@/lib/diagnostics";
import { useDiagnosticsHistoryStore } from "@/stores/diagnosticsHistory";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DeviceTrendCard, SuggestionCard } from "@/components/diagnostics";

/**
 * Personalized Local Trends & Setup Suggestions (M40, v2.0.2).
 *
 * Reads the user's OWN accumulated diagnostic history (recorded by the analysis
 * page as they analyze sessions) and renders cross-session trends per device plus
 * conservative setup suggestions. Both the aggregation ({@link summarizeTrends})
 * and the suggestions ({@link deriveSuggestions}) are pure — this page adds no
 * detection; it only reads records + renders.
 *
 * ## Honest empty states (never fabricated)
 * A fresh install has no history → an honest empty state. Below
 * {@link MIN_SESSIONS_FOR_TRENDS} recorded sessions → a distinct "not enough
 * recorded sessions yet" note. Only at/above the threshold does it show trend
 * cards + suggestions, and every number traces back to a real analyzed session.
 * The reset-history control genuinely clears the store, so the trend state
 * disappears with it (M40 acceptance).
 */
/** A device needs ≥2 recorded sessions before it has a trend (2 points minimum). */
const MIN_SESSIONS_PER_DEVICE_TREND = 2;

export function TrendsPage() {
  const { t } = useTranslation();
  const records = useDiagnosticsHistoryStore((s) => s.records);
  const [confirmReset, setConfirmReset] = useState(false);

  const trends = useMemo(() => summarizeTrends(records), [records]);
  const suggestions = useMemo(() => deriveSuggestions(trends), [trends]);
  // A single-session device can't be trended (a 1-point sparkline is not a trend),
  // so only devices with ≥2 sessions get a card; the rest are honestly counted.
  const trendableDevices = useMemo(
    () =>
      trends.devices.filter(
        (d) => d.sessionCount >= MIN_SESSIONS_PER_DEVICE_TREND
      ),
    [trends]
  );
  const excludedCount = trends.devices.length - trendableDevices.length;

  return (
    <div className="flex flex-col gap-4" data-testid="trends-page">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-foreground">
            {t("diagnostics.trends.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("diagnostics.trends.subtitle")}
          </p>
        </div>
        {records.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            data-testid="diagnostics-history-reset"
            onClick={() => setConfirmReset(true)}
          >
            <Trash2 aria-hidden />
            {t("diagnostics.history.resetTitle")}
          </Button>
        )}
      </div>

      {records.length === 0 ? (
        <EmptyState
          icon={TrendingUp}
          title={t("diagnostics.trends.emptyTitle")}
          description={t("diagnostics.trends.emptyDescription")}
        />
      ) : !trends.hasEnoughHistory ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("diagnostics.trends.notEnough", {
              have: trends.sessionCount,
              need: MIN_SESSIONS_FOR_TRENDS,
            })}
          </CardContent>
        </Card>
      ) : trendableDevices.length === 0 ? (
        // Enough total history, but every device has a single session — no device
        // can be trended yet. Honest note instead of a misleading 1-point card.
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("diagnostics.trends.noTrendableDevices")}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {trendableDevices.map((device) => (
              <DeviceTrendCard
                key={device.deviceKey ?? "__unknown__"}
                trend={device}
              />
            ))}
          </div>

          {excludedCount > 0 && (
            <p
              data-testid="diagnostics-trends-excluded"
              className="text-xs text-muted-foreground"
            >
              {t("diagnostics.trends.excludedDevices", { count: excludedCount })}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t("diagnostics.trends.suggestionsTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              {suggestions.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("diagnostics.trends.noSuggestions")}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {suggestions.map((s) => (
                    <li key={`${s.deviceKey ?? "__unknown__"}:${s.id}`}>
                      <SuggestionCard suggestion={s} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Reset confirmation: a real destructive dialog so an accidental click
          can't wipe the accumulated diagnostic history. */}
      <Dialog open={confirmReset} onClose={() => setConfirmReset(false)}>
        <DialogHeader>
          <DialogTitle>{t("diagnostics.history.resetConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("diagnostics.history.resetConfirmBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmReset(false)}
          >
            {t("diagnostics.history.resetCancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="diagnostics-history-reset-confirm"
            onClick={() => {
              useDiagnosticsHistoryStore.getState().clear();
              setConfirmReset(false);
            }}
          >
            <Trash2 aria-hidden />
            {t("diagnostics.history.resetConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
