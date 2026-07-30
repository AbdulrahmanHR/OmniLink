import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Check,
  Loader2,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useKnowledgeStore } from "@/stores";
import type { KnowledgeSource, TrustLevel } from "@/lib/knowledge";

/** i18n key for a trust level ("official" -> `…trust.official`). */
function trustLevelKey(level: TrustLevel): string {
  return level === "official"
    ? "settings.knowledge.trust.official"
    : "settings.knowledge.trust.omnilinkNotes";
}

/** Format an ISO date (or ms timestamp) for the active locale, or `null`. */
function useDateFormatter(): (value: string | number) => string | null {
  const { i18n } = useTranslation();
  return React.useCallback(
    (value: string | number) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
      }).format(date);
    },
    [i18n.language],
  );
}

/** One trusted source row: metadata badges + a per-source update button. */
function SourceRow({ source }: { source: KnowledgeSource }) {
  const { t } = useTranslation();
  const formatDate = useDateFormatter();
  const { metadata, cached } = source;

  const updateSource = useKnowledgeStore((s) => s.updateSource);
  const busy = useKnowledgeStore((s) => s.updating[metadata.id] ?? false);
  const lastUpdated = useKnowledgeStore(
    (s) => s.lastUpdated[metadata.id],
  );

  const freshDate = formatDate(metadata.freshnessDate);
  const refreshedDate =
    lastUpdated !== undefined ? formatDate(lastUpdated) : null;

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {metadata.title}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge
              variant={metadata.trustLevel === "official" ? "good" : "default"}
            >
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {t(trustLevelKey(metadata.trustLevel))}
            </Badge>
            <Badge variant="outline">
              {t("settings.knowledge.version", { version: metadata.version })}
            </Badge>
            <Badge variant="secondary">
              {t("settings.knowledge.license", { license: metadata.license })}
            </Badge>
            <Badge variant={cached ? "good" : "outline"}>
              {cached ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <WifiOff className="h-3 w-3" aria-hidden="true" />
              )}
              {cached
                ? t("settings.knowledge.cached")
                : t("settings.knowledge.notCached")}
            </Badge>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {freshDate
              ? t("settings.knowledge.freshness", { date: freshDate })
              : null}
            {/* The clause below ALWAYS renders (refreshed OR bundled), so the
                separator only depends on a freshness date preceding it. */}
            {freshDate ? " · " : null}
            {refreshedDate
              ? t("settings.knowledge.refreshed", { date: refreshedDate })
              : t("settings.knowledge.bundled")}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("settings.knowledge.updateAria", {
            title: metadata.title,
          })}
          disabled={busy}
          onClick={() => void updateSource(metadata.id)}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          {busy
            ? t("settings.knowledge.updating")
            : t("settings.knowledge.update")}
        </Button>
      </div>
    </li>
  );
}

/**
 * Trusted knowledge sources panel (M49, D16/D17). Lists each allowlist-admitted
 * source with its version, license, and trust level, an offline/cached badge and
 * freshness date, plus a per-source and a global on-demand Update control. The
 * list is the composed, offline-usable set from `loadAllowedSources()` (via the
 * knowledge store); no source outside the allowlist can appear here.
 *
 * Read-only listing + refresh only — M49 adds no retrieval, no chat surface, and
 * no new outbound data path. Every string goes through `t()`; icon-only affordances
 * carry `aria-label`s and buttons show visible focus (shared Button styles).
 */
export function KnowledgeSourcesPanel() {
  const { t } = useTranslation();
  const sources = useKnowledgeStore((s) => s.sources);
  const updateAll = useKnowledgeStore((s) => s.updateAll);
  const anyBusy = useKnowledgeStore((s) =>
    Object.values(s.updating).some(Boolean),
  );

  // Honest, transient feedback for the global "Update all" action. Cleared on
  // each click, then set from the run's summary: with today's bundled sources
  // every source comes back `up-to-date` (no real fetch happens), so the
  // message states the pack is already current rather than implying a remote
  // sync occurred. The `refreshed N` branch only fires once the deferred real
  // fetch returns `updated` results.
  const [updateAllStatus, setUpdateAllStatus] = React.useState<string | null>(
    null,
  );

  const handleUpdateAll = React.useCallback(async () => {
    setUpdateAllStatus(null);
    try {
      const summary = await updateAll();
      setUpdateAllStatus(
        summary.updated > 0
          ? t("settings.knowledge.updateAllRefreshed", {
              count: summary.updated,
            })
          : t("settings.knowledge.updateAllCurrent"),
      );
    } catch {
      // `updateAll` is a no-throw no-op today (bundled sources), but the D17
      // seam re-throws, so once the deferred real fetch lands a failure must
      // surface honestly rather than leave the status stuck on "checking…".
      setUpdateAllStatus(t("settings.knowledge.updateAllFailed"));
    }
  }, [updateAll, t]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            <CardTitle>{t("settings.knowledge.title")}</CardTitle>
          </div>
          {sources.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t("settings.knowledge.updateAllAria")}
              disabled={anyBusy}
              onClick={() => void handleUpdateAll()}
            >
              {anyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              {t("settings.knowledge.updateAll")}
            </Button>
          )}
        </div>
        <CardDescription>{t("settings.knowledge.description")}</CardDescription>
        {updateAllStatus ? (
          <p
            className="text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
            data-testid="knowledge-update-all-status"
          >
            {updateAllStatus}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={t("settings.knowledge.empty.title")}
            description={t("settings.knowledge.empty.description")}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {sources.map((source) => (
              <SourceRow key={source.metadata.id} source={source} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
