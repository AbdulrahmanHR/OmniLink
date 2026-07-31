import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  Database,
  Download,
  FlaskConical,
  Info,
  KeyRound,
  Languages,
  Loader2,
  Map as MapIcon,
  Palette,
  RefreshCw,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  PROVIDERS,
  PROVIDER_IDS,
  useAssistantStore,
  type AIProvider,
} from "@/stores";
import { useThemeStore, type ThemeMode } from "@/stores/theme";
import {
  useLanguageStore,
  LANGUAGES,
  type LanguageCode,
} from "@/stores/language";
import { useRetentionStore } from "@/stores/retention";
import { useAlertsStore } from "@/stores/alerts";
import { playAlertSound } from "@/lib/alertSound";
import {
  osNotifyPermission,
  requestOsNotifyPermission,
  type OsNotifyPermission,
} from "@/lib/alertNotify";
import {
  cancelTilePackDownload,
  deleteTilePack,
  downloadTilePack,
  listTilePacks,
  onTileDownloadDone,
  onTileDownloadError,
  onTileDownloadProgress,
  type TileInventory,
  type TilePackStatus,
} from "@/lib/tauri";
import { formatPackSize } from "@/lib/tile-packs";
import {
  ImportPanel,
  KnowledgeSourcesPanel,
  RetrievalDebugPanel,
} from "@/components/knowledge";
import {
  createUpdaterController,
  initialUpdaterState,
  type UpdaterController,
  type UpdaterState,
} from "@/lib/updater";
import {
  isMlLabEnabled,
} from "@/lib/featureFlags";
import { DevFeatureFlags } from "@/components/settings/DevFeatureFlags";
import { PrivacyDataSettings } from "@/components/settings/PrivacyDataSettings";

/**
 * The ML lab (v2.5 / M56c), loaded lazily — mirroring the route-level split in
 * `App.tsx`.
 *
 * A STATIC import here would fold the whole ML library (`lib/ml/dataset`,
 * `anomalyModel`, `predictive`, …) into the `SettingsPage` chunk for **every**
 * user — including the overwhelming majority for whom `mlLab` is off and the
 * panel never mounts. `MlLabPanel` already `import()`s its ~110 KB of model
 * weights for exactly that reason; this finishes the job for the code that reads
 * them. Release invariant #2 says a normal user sees zero change from this
 * release, and ~108 KB of ML library in their bundle is not zero.
 *
 * The `lazy()` element sits INSIDE the `isMlLabEnabled()` guard below, so with
 * the flag off React never renders it and the dynamic import is never even
 * triggered — the chunk is not mounted, not executed, and not fetched.
 */
const MlLabPanel = React.lazy(() =>
  import("@/components/ml/MlLabPanel").then((m) => ({ default: m.MlLabPanel }))
);

/** Shared classes for the lightweight native <select> controls. */
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * One per-provider credential row (v1.7.2). Shows the provider, its stored-key
 * status, an API-key entry (key-required providers) and an optional base-URL
 * override (OpenAI-compatible providers). The raw key never leaves the input
 * except via the backend `ai_set_api_key` call (through the store) and is never
 * read back or displayed. A blank Save updates only the base URL — the stored
 * key is kept (use Remove to clear it).
 */
function ProviderKeyRow({
  provider,
  keyed,
}: {
  provider: AIProvider;
  keyed: boolean;
}) {
  const { t } = useTranslation();
  const keyInputId = React.useId();
  const baseUrlInputId = React.useId();
  const credential = useAssistantStore((s) => s.credentials[provider]);
  const setApiKey = useAssistantStore((s) => s.setApiKey);
  const clearApiKey = useAssistantStore((s) => s.clearApiKey);

  const cfg = PROVIDERS[provider];
  const requiresKey = cfg.requiresKey;
  const showBaseUrl = cfg.kind === "openai-compat";
  const storedBaseUrl = credential?.baseUrl ?? cfg.defaultBaseUrl;

  const [apiKey, setApiKeyInput] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState(storedBaseUrl);
  const [busy, setBusy] = React.useState(false);

  const baseUrlChanged = showBaseUrl && baseUrl.trim() !== storedBaseUrl;
  const canSave = !busy && (apiKey.trim().length > 0 || baseUrlChanged);

  const save = async () => {
    setBusy(true);
    await setApiKey(provider, apiKey, showBaseUrl ? baseUrl.trim() : undefined);
    setApiKeyInput("");
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    await clearApiKey(provider);
    setApiKeyInput("");
    setBusy(false);
  };

  const statusVariant = !requiresKey ? "secondary" : keyed ? "good" : "outline";
  const statusLabel = !requiresKey
    ? t("settings.byok.keyNotNeeded")
    : keyed
      ? t("settings.byok.keySet")
      : t("settings.byok.keyUnset");

  return (
    <div
      className="space-y-2 rounded-md border border-border p-3"
      data-testid={`ai-key-row-${provider}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {t(`ai.providers.${provider}`)}
        </span>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>

      {requiresKey ? (
        <div className="space-y-1">
          <Label htmlFor={keyInputId} className="sr-only">
            {t("settings.byok.apiKey")}
          </Label>
          <div className="flex gap-2">
            <Input
              id={keyInputId}
              type="password"
              autoComplete="off"
              data-testid={`ai-key-input-${provider}`}
              value={apiKey}
              placeholder={
                keyed
                  ? t("settings.byok.apiKeyStoredPlaceholder")
                  : t("settings.byok.apiKeyPlaceholder")
              }
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              data-testid={`ai-key-save-${provider}`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("settings.byok.save")}
            </Button>
            {keyed && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void clear()}
                disabled={busy}
                data-testid={`ai-key-clear-${provider}`}
              >
                {t("settings.byok.clear")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.byok.apiKeyHint")}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("settings.byok.noKeyNeeded")}
        </p>
      )}

      {showBaseUrl && (
        <div className="space-y-1">
          <Label htmlFor={baseUrlInputId}>{t("settings.byok.baseUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id={baseUrlInputId}
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {!requiresKey && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void save()}
                disabled={!canSave}
                data-testid={`ai-key-save-${provider}`}
              >
                {t("settings.byok.save")}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.byok.baseUrlHint")}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * BYOK (bring-your-own-key) AI settings (M9-API; keys-only v1.7.2). Settings
 * assigns PROVIDER CREDENTIALS ONLY — one API key (+ optional base URL) per
 * provider; the provider + model are chosen in the chat (and remembered). Each
 * provider's stored-key status is probed on mount via the store; keys persist
 * backend-side via `ai_set_api_key`, read at request time and never returned.
 */
function ByokSettings() {
  const { t } = useTranslation();
  const keyed = useAssistantStore((s) => s.keyed);
  const refreshKeyedProviders = useAssistantStore(
    (s) => s.refreshKeyedProviders
  );

  React.useEffect(() => {
    void refreshKeyedProviders();
  }, [refreshKeyedProviders]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.byok.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.byok.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2" data-testid="ai-settings-card">
        {PROVIDER_IDS.map((provider) => (
          <ProviderKeyRow
            key={provider}
            provider={provider}
            keyed={keyed[provider] ?? false}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/** Appearance settings — theme selection (moved here from the sidebar). */
function AppearanceSettings() {
  const { t } = useTranslation();
  const themeId = React.useId();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.appearance.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.appearance.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor={themeId}>{t("theme.label")}</Label>
          <select
            id={themeId}
            className={SELECT_CLASS}
            value={mode}
            onChange={(e) => setMode(e.target.value as ThemeMode)}
          >
            <option value="system">{t("theme.system")}</option>
            <option value="dark">{t("theme.dark")}</option>
            <option value="light">{t("theme.light")}</option>
            <option value="carbon">{t("theme.carbon")}</option>
          </select>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Display-language settings (M27, NFR-I18N). Lists the shippable locales and
 * switches the whole app on selection: `setLanguage` drives the live `i18next`
 * instance (so every `t()` and the `Intl`-based date/number formatting that keys
 * off `i18n.language` re-renders) and persists the choice in `useLanguageStore`
 * (localStorage `omnilink-language`), so it survives a reload. Option labels are
 * each locale's endonym, shown identically regardless of the active UI language.
 */
function LanguageSettings() {
  const { t } = useTranslation();
  const languageId = React.useId();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.language.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.language.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor={languageId}>{t("settings.language.label")}</Label>
          <select
            id={languageId}
            className={SELECT_CLASS}
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguageCode)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Session-retention settings (M24, FR-LOG-02). Bounds `omnilink.db` growth by
 * pruning old recorded telemetry sessions when the session list loads. The
 * policy is persisted in `useRetentionStore` and consumed by
 * `pruneSessions`/`selectSessionsToPrune` in `@/lib/sessions-db`. Disabled by
 * default so no recording is ever deleted until the operator opts in; the count
 * and age bounds combine as a union (a session past either limit is pruned).
 */
function RetentionSettings() {
  const { t } = useTranslation();
  const maxCountId = React.useId();
  const maxAgeId = React.useId();

  const enabled = useRetentionStore((s) => s.enabled);
  const maxCount = useRetentionStore((s) => s.maxCount);
  const maxAgeDays = useRetentionStore((s) => s.maxAgeDays);
  const setEnabled = useRetentionStore((s) => s.setEnabled);
  const setMaxCount = useRetentionStore((s) => s.setMaxCount);
  const setMaxAgeDays = useRetentionStore((s) => s.setMaxAgeDays);

  // Clamp a numeric-input value to a non-negative integer; an empty/garbage
  // field becomes 0, which `selectSessionsToPrune` treats as "bound disabled".
  const clampBound = (raw: string) =>
    Math.max(0, Math.floor(Number(raw) || 0));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.retention.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.retention.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("settings.retention.enable")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.retention.enableHint")}
            </p>
          </div>
          <Button
            type="button"
            variant={enabled ? "default" : "outline"}
            size="sm"
            role="switch"
            aria-checked={enabled}
            aria-label={t("settings.retention.enable")}
            onClick={() => setEnabled(!enabled)}
          >
            {enabled ? (
              <Check className="h-4 w-4" />
            ) : (
              <X className="h-4 w-4" />
            )}
            {enabled
              ? t("settings.retention.on")
              : t("settings.retention.off")}
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={maxCountId}>
              {t("settings.retention.maxCount")}
            </Label>
            <Input
              id={maxCountId}
              type="number"
              min={1}
              inputMode="numeric"
              value={maxCount}
              disabled={!enabled}
              onChange={(e) => setMaxCount(clampBound(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.retention.maxCountHint")}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={maxAgeId}>
              {t("settings.retention.maxAgeDays")}
            </Label>
            <Input
              id={maxAgeId}
              type="number"
              min={1}
              inputMode="numeric"
              value={maxAgeDays}
              disabled={!enabled}
              onChange={(e) => setMaxAgeDays(clampBound(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.retention.maxAgeDaysHint")}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * In-app self-update (Tauri updater plugin). The flow is entirely client-side:
 * `check()` hits the signed `latest.json` manifest configured in
 * tauri.conf.json (`plugins.updater.endpoints` → this repo's GitHub Releases
 * feed, verified against the real `pubkey`), and — if a newer version is
 * published — `downloadAndInstall` streams + verifies the signed bundle before
 * `relaunch()` restarts into it.
 *
 * The phase state machine lives in `@/lib/updater` so the transitions are
 * unit-tested headlessly; this component is a thin view over it. A
 * dev/browser/unsigned build has no updater runtime, so `check()` lands on the
 * dedicated `notConfigured` state (a calm "unavailable here" notice) instead of
 * a red error.
 */
/** One-shot controller bound to React state; see `@/lib/updater`. */
function useUpdater(): { state: UpdaterState; controller: UpdaterController } {
  const [state, setState] = React.useState<UpdaterState>(initialUpdaterState);
  const [controller] = React.useState<UpdaterController>(() =>
    createUpdaterController(setState)
  );
  return { state, controller };
}

function AppUpdateSettings() {
  const { t } = useTranslation();
  const { state, controller } = useUpdater();
  const { phase, update, progress, error } = state;
  const [currentVersion, setCurrentVersion] = React.useState<string>("");

  // Show the running app version up front so "up to date" has a reference.
  React.useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(""));
  }, []);

  const busy = phase === "checking" || phase === "downloading";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Download className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.update.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.update.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("settings.update.currentVersion")}</Label>
            <p className="font-mono text-sm text-muted-foreground">
              {currentVersion || "—"}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void controller.checkForUpdates()}
            disabled={busy}
          >
            {phase === "checking" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t("settings.update.check")}
          </Button>
        </div>

        {phase === "upToDate" && (
          <Badge variant="default" className="w-fit">
            <Check className="h-3 w-3" />
            {t("settings.update.upToDate")}
          </Badge>
        )}

        {(phase === "available" ||
          phase === "downloading" ||
          phase === "ready") &&
          update && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium text-foreground">
                    {t("settings.update.available", {
                      version: update.version,
                    })}
                  </p>
                  {update.date && (
                    <p className="text-xs text-muted-foreground">
                      {update.date}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  onClick={() => void controller.installAndRestart()}
                  disabled={phase === "downloading" || phase === "ready"}
                >
                  {phase === "downloading" || phase === "ready" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("settings.update.install")}
                </Button>
              </div>

              {update.body && (
                <p className="whitespace-pre-line text-xs text-muted-foreground">
                  {update.body}
                </p>
              )}

              {(phase === "downloading" || phase === "ready") && (
                <div className="space-y-1">
                  <Progress value={progress} />
                  <p className="text-xs text-muted-foreground">
                    {phase === "ready"
                      ? t("settings.update.restarting")
                      : t("settings.update.downloading", { progress })}
                  </p>
                </div>
              )}
            </div>
          )}

        {phase === "notConfigured" && (
          // Distinct from `error`: a dev/browser/unsigned build has no updater
          // runtime, so this is a calm "unavailable here" notice, not a failure.
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-0.5">
              <p className="font-medium text-foreground">
                {t("settings.update.notConfiguredTitle")}
              </p>
              <p className="text-xs opacity-90">
                {t("settings.update.notConfigured")}
              </p>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-0.5">
              <p className="font-medium">{t("settings.update.errorTitle")}</p>
              <p className="text-xs break-all opacity-90">{error}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** In-flight download state for one pack. */
interface PackProgress {
  percent: number;
  receivedBytes: number;
  totalBytes: number;
}

/** A single downloadable pack row with status + download/delete controls. */
function PackRow({
  pack,
  progress,
  error,
  onDownload,
  onCancel,
  onDelete,
}: {
  pack: TilePackStatus;
  progress: PackProgress | undefined;
  error: string | undefined;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const downloading = progress !== undefined;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {pack.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settings.tiles.packMeta", {
              size: formatPackSize(pack.sizeBytes),
              minZoom: pack.minZoom,
              maxZoom: pack.maxZoom,
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pack.downloaded ? (
            <>
              <Badge variant="default" className="w-fit">
                <Check className="h-3 w-3" />
                {t("settings.tiles.downloaded")}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t("settings.tiles.delete")}
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          ) : downloading ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
            >
              <X className="h-4 w-4" />
              {t("settings.tiles.cancel")}
            </Button>
          ) : (
            <Button type="button" onClick={onDownload}>
              <Download className="h-4 w-4" />
              {t("settings.tiles.download")}
            </Button>
          )}
        </div>
      </div>

      {downloading && (
        <div className="space-y-1">
          <Progress value={progress.percent < 0 ? undefined : progress.percent} />
          <p className="text-xs text-muted-foreground">
            {progress.percent < 0
              ? t("settings.tiles.downloadingUnknown", {
                  received: formatPackSize(progress.receivedBytes),
                })
              : t("settings.tiles.downloadingProgress", {
                  percent: progress.percent,
                  received: formatPackSize(progress.receivedBytes),
                  total: formatPackSize(progress.totalBytes),
                })}
          </p>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Offline map-tile management (M12, FR-TELEM-07): shows the bundled worldwide
 * base set and lets the user download / delete regional packs for offline field
 * use. Downloads stream via the Rust `tiles` worker + `tiles://*` events
 * (mirrors the flash seam), so progress updates live here.
 */
function OfflineMapTilesSettings() {
  const { t } = useTranslation();
  const [inventory, setInventory] = React.useState<TileInventory | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<Record<string, PackProgress>>(
    {}
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const refresh = React.useCallback(async () => {
    try {
      setInventory(await listTilePacks());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to the tiles download lifecycle events.
  React.useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let active = true;
    void onTileDownloadProgress((p) => {
      setProgress((prev) => ({
        ...prev,
        [p.packId]: {
          percent: p.percent,
          receivedBytes: p.receivedBytes,
          totalBytes: p.totalBytes,
        },
      }));
    }).then((un) => (active ? unlisteners.push(un) : un()));
    void onTileDownloadDone((d) => {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[d.packId];
        return next;
      });
      void refresh();
    }).then((un) => (active ? unlisteners.push(un) : un()));
    void onTileDownloadError((e) => {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[e.packId];
        return next;
      });
      // A user cancel surfaces as the "cancelled" category — not a red line.
      // M20: the payload is now structured + categorized (mirrors logs/flash),
      // so render a localized message: `tiles.errors.<summaryKey>` with the
      // category as the fallback, the raw detail as the last resort.
      if (e.category !== "cancelled") {
        const message = t(`tiles.errors.${e.summaryKey}`, {
          defaultValue: t(`tiles.errors.categories.${e.category}`, {
            defaultValue: e.detail,
          }),
        });
        setErrors((prev) => ({ ...prev, [e.packId]: message }));
      }
    }).then((un) => (active ? unlisteners.push(un) : un()));
    return () => {
      active = false;
      for (const un of unlisteners) un();
    };
  }, [refresh, t]);

  const startDownload = async (packId: string) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[packId];
      return next;
    });
    setProgress((prev) => ({
      ...prev,
      [packId]: { percent: 0, receivedBytes: 0, totalBytes: 0 },
    }));
    try {
      await downloadTilePack(packId);
    } catch (e) {
      setProgress((prev) => {
        const next = { ...prev };
        delete next[packId];
        return next;
      });
      setErrors((prev) => ({
        ...prev,
        [packId]: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <MapIcon className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.tiles.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.tiles.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Honest placeholder labeling — the bundled base map and all regional
            packs are solid-colour placeholder tiles, not real geography. */}
        <div className="space-y-3 rounded-md border border-dashed border-border p-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" aria-hidden="true" />
            <Label>{t("settings.tiles.placeholderTitle")}</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.tiles.placeholderNotice")}
          </p>
        </div>
        {loadError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs break-all opacity-90">{loadError}</p>
          </div>
        ) : !inventory ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("settings.tiles.loading")}
          </p>
        ) : (
          <>
            {/* Bundled base set */}
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {inventory.base.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.tiles.packMeta", {
                    size: formatPackSize(inventory.base.sizeBytes),
                    minZoom: inventory.base.minZoom,
                    maxZoom: inventory.base.maxZoom,
                  })}
                </p>
              </div>
              <Badge
                variant={inventory.base.available ? "default" : "outline"}
                className="w-fit shrink-0"
              >
                {inventory.base.available && <Check className="h-3 w-3" />}
                {inventory.base.available
                  ? t("settings.tiles.bundled")
                  : t("settings.tiles.baseMissing")}
              </Badge>
            </div>

            {/* Downloadable regional packs, grouped by continent */}
            <div className="space-y-2">
              {inventory.packs.map((pack) => (
                <PackRow
                  key={pack.id}
                  pack={pack}
                  progress={progress[pack.id]}
                  error={errors[pack.id]}
                  onDownload={() => void startDownload(pack.id)}
                  onCancel={() => void cancelTilePackDownload(pack.id)}
                  onDelete={() =>
                    void deleteTilePack(pack.id).then(() => void refresh())
                  }
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A compact on/off switch button mirroring the retention card's pattern. */
function ToggleSwitch({
  checked,
  label,
  onLabel,
  offLabel,
  onChange,
  disabled,
}: {
  checked: boolean;
  label: string;
  onLabel: string;
  offLabel: string;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={checked ? "default" : "outline"}
      size="sm"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {checked ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
      {checked ? onLabel : offLabel}
    </Button>
  );
}

/**
 * Live telemetry alerts (M26, FR-ALERT). Per-alarm enable + threshold tuning
 * (low RSSI, link-quality floor, link loss, optional GPS distance) plus a master
 * mute. Each alarm has a distinct trip/recover hysteresis band and a debounce
 * window so a value hovering at the limit raises exactly one alarm; the pure
 * evaluator lives in `@/lib/liveAlerts` and the config is persisted here. Mute
 * suppresses both the in-app toast and the OS notification.
 *
 * This card is also the single opt-in point for **desktop (OS) notifications**
 * (v3.0.3). The permission prompt must be raised from a real user gesture —
 * WebKit, the engine the shipped Linux/macOS app runs in, refuses
 * `Notification.requestPermission()` from anywhere else — so the "Enable"
 * button below is that gesture, exactly as the sound row's "Test" button is the
 * gesture that unlocks the AudioContext. Nothing prompts on launch.
 */
function AlertsSettings() {
  const { t } = useTranslation();
  const muted = useAlertsStore((s) => s.muted);
  const setMuted = useAlertsStore((s) => s.setMuted);
  const soundEnabled = useAlertsStore((s) => s.soundEnabled);
  const setSoundEnabled = useAlertsStore((s) => s.setSoundEnabled);

  // The engine owns the permission, so this is state we MIRROR, not state we
  // store: read it (never prompt) on first render, and refresh it from whatever
  // the request resolves to. No persisted flag is added — a user who granted
  // permission in an earlier version keeps working with no migration.
  const [osPermission, setOsPermission] = React.useState<OsNotifyPermission>(
    () => osNotifyPermission()
  );

  const signalLoss = useAlertsStore((s) => s.signalLoss);
  const lqDrop = useAlertsStore((s) => s.lqDrop);
  const failsafe = useAlertsStore((s) => s.failsafe);
  const gpsDistance = useAlertsStore((s) => s.gpsDistance);
  const setSignalLoss = useAlertsStore((s) => s.setSignalLoss);
  const setLqDrop = useAlertsStore((s) => s.setLqDrop);
  const setFailsafe = useAlertsStore((s) => s.setFailsafe);
  const setGpsDistance = useAlertsStore((s) => s.setGpsDistance);

  // Numeric parse: a real number for thresholds (RSSI is negative), and a
  // floored >= 1 integer for the debounce frame counts.
  const num = (raw: string) => (Number.isFinite(Number(raw)) ? Number(raw) : 0);
  const frames = (raw: string) => Math.max(1, Math.floor(Number(raw) || 1));

  const tripId = React.useId();
  const clearId = React.useId();
  const framesId = React.useId();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          {muted ? (
            <BellOff className="h-4 w-4 text-primary" />
          ) : (
            <Bell className="h-4 w-4 text-primary" />
          )}
          <CardTitle>{t("alerts.settings.title")}</CardTitle>
        </div>
        <CardDescription>{t("alerts.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Master mute */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("alerts.settings.mute")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("alerts.settings.muteHint")}
            </p>
          </div>
          <ToggleSwitch
            checked={!muted}
            label={t("alerts.settings.alertsActive")}
            onLabel={t("alerts.settings.unmuted")}
            offLabel={t("alerts.settings.muted")}
            onChange={(v) => setMuted(!v)}
          />
        </div>

        {/* Desktop (OS) notifications — the opt-in AND the user gesture the
            permission prompt requires (v3.0.3). `requestOsNotifyPermission()`
            is called SYNCHRONOUSLY in the click handler: an `await` in front of
            it would spend the gesture and WebKit would refuse the prompt. */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("alerts.settings.osNotify")}</Label>
            <p className="text-xs text-muted-foreground" data-testid="os-notify-hint">
              {t(`alerts.settings.osNotifyHint.${osPermission}`)}
            </p>
          </div>
          {osPermission === "default" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              data-testid="os-notify-enable"
              // The visible word is "Enable"; the accessible name adds what is
              // being enabled and CONTAINS the visible text (WCAG 2.5.3).
              aria-label={t("alerts.settings.osNotifyEnableLabel")}
              onClick={() => {
                void requestOsNotifyPermission().then(setOsPermission);
              }}
            >
              <Bell className="h-4 w-4" />
              {t("alerts.settings.osNotifyEnable")}
            </Button>
          ) : (
            <Badge
              data-testid="os-notify-state"
              variant={osPermission === "granted" ? "good" : "outline"}
              className="shrink-0"
            >
              {t(`alerts.settings.osNotifyState.${osPermission}`)}
            </Badge>
          )}
        </div>

        {/* Optional audio alert (FR-TELEM-03) — opt-in, off by default. */}
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("alerts.settings.sound")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("alerts.settings.soundHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Preview also satisfies the browser autoplay policy (a user gesture
                unlocks the AudioContext, so later alarm beeps are audible). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => playAlertSound()}
            >
              <Volume2 className="h-4 w-4" />
              {t("alerts.settings.soundTest")}
            </Button>
            <ToggleSwitch
              checked={soundEnabled}
              label={t("alerts.settings.sound")}
              onLabel={t("alerts.settings.on")}
              offLabel={t("alerts.settings.off")}
              onChange={(v) => setSoundEnabled(v)}
            />
          </div>
        </div>

        {/* Low RSSI */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-4">
            <Label>{t("alerts.type.signalLoss")}</Label>
            <ToggleSwitch
              checked={signalLoss.enabled}
              label={t("alerts.type.signalLoss")}
              onLabel={t("alerts.settings.on")}
              offLabel={t("alerts.settings.off")}
              onChange={(v) => setSignalLoss({ enabled: v })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${tripId}-rssi`}>{t("alerts.settings.rssiTrip")}</Label>
              <Input
                id={`${tripId}-rssi`}
                type="number"
                inputMode="numeric"
                value={signalLoss.trip}
                disabled={!signalLoss.enabled}
                onChange={(e) => setSignalLoss({ trip: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${clearId}-rssi`}>{t("alerts.settings.rssiClear")}</Label>
              <Input
                id={`${clearId}-rssi`}
                type="number"
                inputMode="numeric"
                value={signalLoss.clear}
                disabled={!signalLoss.enabled}
                onChange={(e) => setSignalLoss({ clear: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${framesId}-rssi`}>{t("alerts.settings.debounce")}</Label>
              <Input
                id={`${framesId}-rssi`}
                type="number"
                min={1}
                inputMode="numeric"
                value={signalLoss.minFrames}
                disabled={!signalLoss.enabled}
                onChange={(e) => setSignalLoss({ minFrames: frames(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Low link quality */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-4">
            <Label>{t("alerts.type.lqDrop")}</Label>
            <ToggleSwitch
              checked={lqDrop.enabled}
              label={t("alerts.type.lqDrop")}
              onLabel={t("alerts.settings.on")}
              offLabel={t("alerts.settings.off")}
              onChange={(v) => setLqDrop({ enabled: v })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${tripId}-lq`}>{t("alerts.settings.lqTrip")}</Label>
              <Input
                id={`${tripId}-lq`}
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={lqDrop.trip}
                disabled={!lqDrop.enabled}
                onChange={(e) => setLqDrop({ trip: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${clearId}-lq`}>{t("alerts.settings.lqClear")}</Label>
              <Input
                id={`${clearId}-lq`}
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={lqDrop.clear}
                disabled={!lqDrop.enabled}
                onChange={(e) => setLqDrop({ clear: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${framesId}-lq`}>{t("alerts.settings.debounce")}</Label>
              <Input
                id={`${framesId}-lq`}
                type="number"
                min={1}
                inputMode="numeric"
                value={lqDrop.minFrames}
                disabled={!lqDrop.enabled}
                onChange={(e) => setLqDrop({ minFrames: frames(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Link loss */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("alerts.type.failsafe")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("alerts.settings.linkLossHint")}
              </p>
            </div>
            <ToggleSwitch
              checked={failsafe.enabled}
              label={t("alerts.type.failsafe")}
              onLabel={t("alerts.settings.on")}
              offLabel={t("alerts.settings.off")}
              onChange={(v) => setFailsafe({ enabled: v })}
            />
          </div>
          <div className="space-y-1.5 sm:max-w-[12rem]">
            <Label htmlFor={`${framesId}-link`}>{t("alerts.settings.debounce")}</Label>
            <Input
              id={`${framesId}-link`}
              type="number"
              min={1}
              inputMode="numeric"
              value={failsafe.minFrames}
              disabled={!failsafe.enabled}
              onChange={(e) => setFailsafe({ minFrames: frames(e.target.value) })}
            />
          </div>
        </div>

        {/* GPS distance (optional) */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("alerts.type.gpsDistance")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("alerts.settings.gpsHint")}
              </p>
            </div>
            <ToggleSwitch
              checked={gpsDistance.enabled}
              label={t("alerts.type.gpsDistance")}
              onLabel={t("alerts.settings.on")}
              offLabel={t("alerts.settings.off")}
              onChange={(v) => setGpsDistance({ enabled: v })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${tripId}-gps`}>{t("alerts.settings.gpsTrip")}</Label>
              <Input
                id={`${tripId}-gps`}
                type="number"
                min={0}
                inputMode="numeric"
                value={gpsDistance.trip}
                disabled={!gpsDistance.enabled}
                onChange={(e) => setGpsDistance({ trip: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${clearId}-gps`}>{t("alerts.settings.gpsClear")}</Label>
              <Input
                id={`${clearId}-gps`}
                type="number"
                min={0}
                inputMode="numeric"
                value={gpsDistance.clear}
                disabled={!gpsDistance.enabled}
                onChange={(e) => setGpsDistance({ clear: num(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${framesId}-gps`}>{t("alerts.settings.debounce")}</Label>
              <Input
                id={`${framesId}-gps`}
                type="number"
                min={1}
                inputMode="numeric"
                value={gpsDistance.minFrames}
                disabled={!gpsDistance.enabled}
                onChange={(e) => setGpsDistance({ minFrames: frames(e.target.value) })}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** A labelled group of settings cards — the heading names the region for SR. */
function SettingsSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  const headingId = `settings-section-${id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2
        id={headingId}
        className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold text-foreground">
        {t("nav.settings")}
      </h1>

      <SettingsSection id="app" title={t("settings.sections.app")}>
        <AppUpdateSettings />
        <AppearanceSettings />
        <LanguageSettings />
      </SettingsSection>

      <SettingsSection id="telemetry" title={t("settings.sections.telemetry")}>
        <AlertsSettings />
        <OfflineMapTilesSettings />
      </SettingsSection>

      <SettingsSection id="ai" title={t("settings.sections.ai")}>
        <ByokSettings />
        <KnowledgeSourcesPanel />
        <ImportPanel />
        {/* RAG retrieval inspector — a dev tool, never a shipped surface. */}
        {import.meta.env.DEV && <RetrievalDebugPanel />}
      </SettingsSection>

      <SettingsSection id="data" title={t("settings.sections.data")}>
        <RetentionSettings />
        {/* GDPR-style local data portability + erasure (NFR-PRIV-02). Placed
            after retention as a "your data" danger-zone-style section —
            everything stays on this device. */}
        <PrivacyDataSettings />
      </SettingsSection>

      {/* v2.5 / M56c — the ML lab: session labeling + the data-readiness verdict.
          Gated at the RENDER BOUNDARY on the OFF-by-default `mlLab` flag: with the
          flag off the section is not mounted at all (it does not exist, rather than
          existing-but-disabled), so a normal user sees zero change from this
          release. It rides on the Settings page rather than a new route because it
          is a lab instrument over data the user already has — not a workflow — and
          `SettingsPage` is already where every flag-gated surface and every
          "your data" affordance lives. */}
      {isMlLabEnabled() && (
        <SettingsSection id="lab" title={t("settings.sections.lab")}>
          <React.Suspense fallback={null}>
            <MlLabPanel />
          </React.Suspense>
        </SettingsSection>
      )}

      {/* Dev-only "Preview features" toggle — reaches the flag-gated mock
          surfaces for QA/demos + e2e without editing `lib/featureFlags.ts`.
          `import.meta.env.DEV`-gated, so it never renders in a shipped build. */}
      {import.meta.env.DEV && <DevFeatureFlags />}
    </div>
  );
}
