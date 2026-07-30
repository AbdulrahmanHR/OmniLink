import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  availableProviders,
  PROVIDERS,
  useAssistantStore,
  type AiContextMode,
  type AIProvider,
} from "@/stores";
import { aiListModels, type AiModelInfo } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * Shared classes for the lightweight native <select> controls — mirrors the
 * `SELECT_CLASS` pattern in SettingsPage/AnomalyPanel (no Select primitive
 * exists, so each surface re-declares it locally).
 */
const SELECT_CLASS =
  "flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The device/target context modes, in menu order (M23). */
const CONTEXT_MODES: readonly AiContextMode[] = [
  "auto",
  "device",
  "wizard",
  "offline",
];

/**
 * Inline command-center controls (M23; keys-only v1.7.2): the two-step
 * **provider → model** picker + the device-context picker, wired straight to
 * `useAssistantStore` so a user can switch any of them without leaving the chat.
 *
 * Only providers that have a saved API key (plus key-less Ollama) are offered;
 * keys are assigned per provider in Settings. Picking a provider then a model
 * sets the remembered selection (persisted, restored across restarts). The model
 * list comes live from `aiListModels` with the static registry as a fallback.
 */
export function ChatControls() {
  const { t } = useTranslation();
  const providerSelectId = React.useId();
  const modelSelectId = React.useId();
  const contextId = React.useId();

  const selection = useAssistantStore((s) => s.selection);
  const setSelection = useAssistantStore((s) => s.setSelection);
  const credentials = useAssistantStore((s) => s.credentials);
  const keyed = useAssistantStore((s) => s.keyed);
  const refreshKeyedProviders = useAssistantStore(
    (s) => s.refreshKeyedProviders
  );
  const contextMode = useAssistantStore((s) => s.contextMode);
  const setContextMode = useAssistantStore((s) => s.setContextMode);
  // Re-probe which providers have a stored key whenever the picker mounts (e.g.
  // after the user adds a key in Settings and reopens the chat).
  React.useEffect(() => {
    void refreshKeyedProviders();
  }, [refreshKeyedProviders]);

  // Providers offered in the picker: those with a stored key (key-less Ollama
  // always). The current selection is always kept in the option list so the
  // <select> value never silently diverges from `selection.provider` — even if
  // that provider isn't (yet) keyed.
  const providers = availableProviders(keyed);
  const providerOptions = providers.includes(selection.provider)
    ? providers
    : [selection.provider, ...providers];

  // Live model list for the selected provider, with the static registry as the
  // fallback (offline / no key / fetch error) and the current selection always
  // kept selectable even if absent from the live list. Depend on the SELECTED
  // provider's credential primitives only, so saving a key for an UNRELATED
  // provider doesn't refetch this list.
  const selectedCred = credentials[selection.provider];
  const selectedKeyId = selectedCred?.keyId;
  const selectedBaseUrl = selectedCred?.baseUrl;
  const [models, setModels] = React.useState<AiModelInfo[]>(() =>
    PROVIDERS[selection.provider].models.map((id) => ({ id, name: id }))
  );
  React.useEffect(() => {
    let cancelled = false;
    const provider = selection.provider;
    const fallback: AiModelInfo[] = PROVIDERS[provider].models.map((id) => ({
      id,
      name: id,
    }));
    const baseUrl =
      PROVIDERS[provider].kind === "openai-compat"
        ? (selectedBaseUrl ?? PROVIDERS[provider].defaultBaseUrl)
        : undefined;
    aiListModels(provider, baseUrl, selectedKeyId ?? provider)
      .then((list) => {
        if (!cancelled) setModels(list.length > 0 ? list : fallback);
      })
      .catch(() => {
        if (!cancelled) setModels(fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.provider, selectedKeyId, selectedBaseUrl]);

  const modelOptions: AiModelInfo[] = React.useMemo(() => {
    if (models.some((m) => m.id === selection.model)) return models;
    return [{ id: selection.model, name: selection.model }, ...models];
  }, [models, selection.model]);

  const onProviderChange = (provider: AIProvider) => {
    // Reset to the provider's default model; the live fetch refines the list.
    setSelection(provider, PROVIDERS[provider].models[0]);
  };

  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={providerSelectId}
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("ai.controls.provider")}
        </label>
        <select
          id={providerSelectId}
          data-testid="chat-provider-select"
          className={SELECT_CLASS}
          value={selection.provider}
          aria-label={t("ai.controls.provider")}
          onChange={(e) => onProviderChange(e.target.value as AIProvider)}
        >
          {providerOptions.map((p) => (
            <option key={p} value={p}>
              {t(`ai.providers.${p}`)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={modelSelectId}
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("ai.controls.model")}
        </label>
        <select
          id={modelSelectId}
          data-testid="chat-model-select"
          className={cn(SELECT_CLASS, "font-mono")}
          value={selection.model}
          aria-label={t("ai.controls.model")}
          onChange={(e) => setSelection(selection.provider, e.target.value)}
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      <div className="col-span-2 flex min-w-0 flex-col gap-1">
        <label
          htmlFor={contextId}
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {t("ai.context.label")}
        </label>
        <select
          id={contextId}
          className={SELECT_CLASS}
          value={contextMode}
          aria-label={t("ai.context.label")}
          title={t("ai.context.description")}
          onChange={(e) => setContextMode(e.target.value as AiContextMode)}
        >
          {CONTEXT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`ai.context.${mode}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
