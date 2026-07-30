import { create } from "zustand";
import { persist } from "zustand/middleware";
import i18n from "@/lib/i18n";
import {
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_MODELS,
  selectAiContext,
  type AIProvider,
  type AiContextMode,
  type DiagnosticsAiContext,
} from "@/lib/aiContext";
import {
  aiClearApiKey,
  aiHasApiKey,
  aiSendMessage,
  aiSetApiKey,
  type AiWireMessage,
  type UserDefineSuggestion,
} from "@/lib/ai";
import {
  createConversation,
  deleteConversation,
  latestConversationId,
  listConversations,
  loadMessages,
  saveMessage,
  type ConversationMeta,
} from "@/lib/chat-db";
import type { RetrievedChunk } from "@/lib/knowledge";
import { retrieveForChat } from "@/lib/ragRetrieval";
import { useBridgeStore } from "./bridge";
import { useDeviceStore } from "./device";
import {
  selectEnabledSourceIdsFor,
  selectRetrievalIndex,
  useKnowledgeStore,
} from "./knowledge";
import { useTelemetryStore } from "./telemetry";
import { currentWizardTarget, useWizardStore } from "./wizard";

/** Who authored a chat message. */
export type ChatRole = "user" | "assistant";

/** A single message in the Omnia conversation. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Creation time (ms since epoch). */
  timestamp: number;
  /** True when the bubble is a local error notice rather than a model reply. */
  isError?: boolean;
  /** Optional validated config suggestion the model emitted (FR-AI-04). */
  suggestion?: UserDefineSuggestion;
  /**
   * Trusted-source citations retrieved for this answer (M51, RAG). Known
   * CLIENT-SIDE from local retrieval — NOT carried by the model reply — and
   * rendered as citation cards beside an assistant message.
   */
  citations?: RetrievedChunk[];
  /**
   * True when local retrieval found no trusted source at/above the D19 threshold
   * (M51). The answer still sends (with no retrieved docs); the UI shows the
   * "no trusted source found" state and the system prompt tells Omnia to qualify.
   */
  noSourceFound?: boolean;
}

// Re-export the provider model registry so existing imports (Settings, store
// index) keep working after the M9-API multi-provider expansion.
export { PROVIDER_MODELS, PROVIDERS, PROVIDER_IDS };
export type { AIProvider, AiContextMode };

/**
 * One named BYOK AI API configuration (multi-config, v1.6.3). The user can save
 * several — including two of the SAME provider with DIFFERENT keys — and switch
 * the active one freely.
 *
 * `id` is the stable unique identity AND the backend key-slot id: the API key is
 * stored in Rust keyed by this id (see `ai_set_api_key`'s `keyId`), so two
 * configs of one provider never share a key.
 */
export interface AiApiConfig {
  /** Stable unique id; ALSO the backend key-slot id. */
  id: string;
  /** User-facing name, e.g. "Work OpenAI". */
  label: string;
  /** Which provider/adapter this config talks to. */
  provider: AIProvider;
  /** Selected model id. */
  model: string;
  /** OpenAI-compat base-URL override; ignored for the anthropic kind. */
  baseUrl: string;
}

/**
 * A saved per-provider credential (v1.7.2). The API key itself stays
 * backend-side; this only records HOW to reach that provider's stored key.
 */
export interface ProviderCredential {
  /**
   * Backend key-slot id. Absent ⇒ the slot defaults to the provider id (the
   * common case for keys saved in v1.7.2+). A non-default id is preserved
   * through migration from a legacy multi-config so that user's stored key is
   * never orphaned.
   */
  keyId?: string;
  /** OpenAI-compat base-URL override (e.g. a custom Ollama host); absent ⇒ registry default. */
  baseUrl?: string;
}

/** The remembered chat selection (v1.7.2): which provider + model to send with. */
export interface AiSelection {
  provider: AIProvider;
  model: string;
}

interface AssistantState {
  /** Whether the chat panel is open. */
  isOpen: boolean;
  /** Conversation history, oldest first. */
  messages: ChatMessage[];
  /** Whether Omnia is "typing" its reply. */
  isTyping: boolean;

  // BYOK (v1.7.2): Settings stores per-provider CREDENTIALS only; the chat
  // remembers a {provider, model} SELECTION. Keys live backend-side keyed by
  // `ProviderCredential.keyId ?? provider`, so the LlmAdapter key seam is
  // unchanged.
  /** Per-provider saved credentials (override metadata; the key stays backend-side). */
  credentials: Partial<Record<AIProvider, ProviderCredential>>;
  /** Remembered chat selection (provider + model); restored across restarts. */
  selection: AiSelection;
  /** Which providers currently have a usable key (runtime probe; not persisted). */
  keyed: Partial<Record<AIProvider, boolean>>;
  /** Which hardware context Omnia is grounded in (M23). Persisted; default auto. */
  contextMode: AiContextMode;
  /**
   * The live composer draft (M51, runtime-only). Kept here so the pre-send
   * preview can retrieve the trusted excerpts the pending question would send,
   * in lockstep with what `sendMessage` will do. Not persisted.
   */
  draft: string;
  /**
   * One-shot diagnostic evidence (M39a) attached to the NEXT `sendMessage` when the
   * user clicked "Explain this finding" / "Ask Omnia about this session". Runtime-only
   * (NOT persisted) and cleared right after the send it rode on — so it never leaks
   * into an unrelated later turn. `null` when no diagnostic action is pending.
   */
  pendingDiagnostics: DiagnosticsAiContext | null;

  // Chat history (persisted in SQLite via src/lib/chat-db.ts).
  /** The conversation currently being written to, or null before the first turn. */
  activeConversationId: string | null;
  /** Whether the last conversation has been loaded from disk this session. */
  historyLoaded: boolean;
  /** Past conversation headers for the history list (newest-first). */
  conversations: ConversationMeta[];

  // Panel visibility
  open: () => void;
  close: () => void;
  toggle: () => void;

  // Conversation
  sendMessage: (content: string) => Promise<void>;
  clearConversation: () => void;
  /**
   * Cancel an in-flight reply (M23). Bumps the request token so the pending
   * `aiSendMessage` resolves into a dropped reply (`seq !== requestSeq`) and
   * clears the typing state immediately.
   */
  stopGeneration: () => void;
  /** Load the most recent conversation from disk (call once on app start). */
  initHistory: () => Promise<void>;
  /** Switch the panel to a stored conversation (from the history list). */
  loadConversation: (id: string) => Promise<void>;
  /** Re-read the conversation headers from disk (call when opening history). */
  refreshConversations: () => Promise<void>;
  /** Delete a stored conversation; resets the view if it was the active one. */
  removeConversation: (id: string) => Promise<void>;

  // BYOK actions (Settings credentials + chat selection).
  /**
   * Save (or replace) a provider's API key — stored backend-side under that
   * provider's key slot — plus an optional base-URL override. Re-probes
   * stored-key status. Never throws (a Tauri-less host just can't persist).
   */
  setApiKey: (provider: AIProvider, key: string, baseUrl?: string) => Promise<void>;
  /** Clear a provider's stored key + credential, then re-probe. */
  clearApiKey: (provider: AIProvider) => Promise<void>;
  /** Remember the chat selection (provider + model) and refresh its key status. */
  setSelection: (provider: AIProvider, model: string) => void;
  /** Choose which hardware context Omnia is grounded in (M23). */
  setContextMode: (mode: AiContextMode) => void;
  /** Record the live composer draft (drives the pre-send retrieval preview). */
  setDraft: (draft: string) => void;
  /**
   * Stage (or clear) the one-shot diagnostic evidence for the next send (M39a).
   * Set by the "Explain this finding" / "Ask Omnia about this session" actions;
   * `sendMessage` attaches it to the built context then clears it.
   */
  setPendingDiagnostics: (diagnostics: DiagnosticsAiContext | null) => void;
  /** Probe every provider's stored-key status (drives chat provider availability). */
  refreshKeyedProviders: () => Promise<void>;

  reset: () => void;
}

/**
 * The concrete send target derived from the remembered selection + its saved
 * credential. Pure selector so consumers (sendMessage, ChatControls, tests)
 * resolve `keyId`/`baseUrl` identically — the `keyId` IS the LlmAdapter key-slot
 * seam (`keyId ?? provider` backend-side), unchanged from the multi-config era.
 */
export function activeSend(
  state: Pick<AssistantState, "selection" | "credentials">
): { provider: AIProvider; model: string; keyId: string; baseUrl: string } {
  const { provider, model } = state.selection;
  const cred = state.credentials[provider];
  return {
    provider,
    model,
    keyId: cred?.keyId ?? provider,
    baseUrl: cred?.baseUrl ?? PROVIDERS[provider].defaultBaseUrl,
  };
}

/** Providers offerable in the chat picker: key-less (Ollama) or with a stored key. */
export function availableProviders(
  keyed: Partial<Record<AIProvider, boolean>>
): AIProvider[] {
  return PROVIDER_IDS.filter((p) => !PROVIDERS[p].requiresKey || keyed[p] === true);
}

/** Stable-enough unique id for a message. */
function messageId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Unique id for a conversation. */
function conversationId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Monotonic request token. Bumped on clear/reset/load so a slow in-flight reply
 * that resolves after the conversation changed is dropped instead of reappearing.
 */
let requestSeq = 0;

const DEFAULT_PROVIDER: AIProvider = "anthropic";

/** Default chat selection (used on a fresh install + as a migration fallback). */
const DEFAULT_SELECTION: AiSelection = {
  provider: DEFAULT_PROVIDER,
  model: PROVIDERS[DEFAULT_PROVIDER].models[0],
};

/** The backend key-slot id for a provider (its credential's, else the provider). */
function keyIdFor(
  credentials: Partial<Record<AIProvider, ProviderCredential>>,
  provider: AIProvider
): string {
  return credentials[provider]?.keyId ?? provider;
}

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      messages: [],
      isTyping: false,
      credentials: {},
      selection: { ...DEFAULT_SELECTION },
      keyed: {},
      contextMode: "auto",
      draft: "",
      pendingDiagnostics: null,
      activeConversationId: null,
      historyLoaded: false,
      conversations: [],

      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      toggle: () => set((state) => ({ isOpen: !state.isOpen })),

      sendMessage: async (content) => {
        const trimmed = content.trim();
        // Ignore empty input or re-entry while a reply is already in flight.
        if (trimmed.length === 0 || get().isTyping) return;

        // Capture + consume the one-shot diagnostic evidence (M39a) SYNCHRONOUSLY,
        // before the first await: the composer's own `submit()` clears the draft
        // right after calling us (and `setDraft("")` detaches staged evidence), so
        // reading it after an await would race that clear and drop the evidence.
        // Cleared here too, so a later turn (or the no-key return below) can't inherit it.
        const pendingDiagnostics = get().pendingDiagnostics;
        if (pendingDiagnostics) set({ pendingDiagnostics: null });

        const userMessage: ChatMessage = {
          id: messageId(),
          role: "user",
          content: trimmed,
          timestamp: Date.now(),
        };
        set((state) => ({ messages: [...state.messages, userMessage], isTyping: true }));

        const seq = requestSeq;
        const send = activeSend(get());

        // Lazily open a conversation row on the first turn, then persist the
        // user message. Persistence is best-effort and never blocks the reply.
        const convId = await ensureConversation(get, set);
        void saveMessage(convId, userMessage);

        // ---- No key configured (BYOK only) ---------------------------------
        // No fabricated answers: when the selected provider needs a key but none
        // is stored, tell the user honestly to add one in Settings. Probe the
        // backend FRESH here (a cached availability flag can lag a just-switched
        // selection); key-less providers (Ollama) are always ready.
        let ready = !PROVIDERS[send.provider].requiresKey;
        if (!ready) {
          try {
            ready = await aiHasApiKey(send.provider, send.keyId);
          } catch {
            ready = false;
          }
        }
        if (!ready) {
          const noKeyMessage: ChatMessage = {
            id: messageId(),
            role: "assistant",
            content: i18n.t("ai.noKeyConfigured"),
            timestamp: Date.now(),
          };
          if (seq === requestSeq) {
            set((state) => ({ messages: [...state.messages, noKeyMessage], isTyping: false }));
            void saveMessage(convId, noKeyMessage);
          }
          // The one-shot diagnostic evidence was already consumed synchronously up
          // top, so the no-key path leaves nothing staged for a later turn (M39a).
          return;
        }

        // ---- Local RAG retrieval (offline, client-side) --------------------
        // Ground the answer in trusted + user-imported excerpts BEFORE assembling
        // context. Scoped to THIS conversation's enabled knowledge sources (M52
        // per-chat — `ensureConversation` already promoted any pre-send draft
        // toggles onto `convId`) and scored against the COMBINED index (bundled
        // trusted packs + imported docs, M52); below the D19 threshold ⇒ no docs
        // are sent and the answer is marked "no source found" (Omnia qualifies it).
        const knowledge = useKnowledgeStore.getState();
        const retrieval = retrieveForChat(trimmed, {
          enabledSourceIds: selectEnabledSourceIdsFor(knowledge, convId),
          index: selectRetrievalIndex(knowledge),
        });

        const history: AiWireMessage[] = get().messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        // Scope the device/telemetry/wizard context to the user's chosen mode
        // (M23), then attach the retrieved docs (M51). `offline` sends nothing
        // device-specific but STILL carries retrieved docs — the offline KB path.
        // The privacy preview in ChatPanel goes through the same selector +
        // retrieval so it matches exactly.
        const context = selectAiContext(
          get().contextMode,
          useDeviceStore.getState().device,
          useTelemetryStore.getState().history,
          currentWizardTarget(useWizardStore.getState()),
          // M65: optionally fold in the READ-ONLY controller-bridge context when
          // one has been fetched. Rust `sanitize_context()` redacts it backend-side.
          useBridgeStore.getState().context,
          // M51: trusted retrieved docs (empty ⇒ omitted by buildAiContext).
          retrieval.docs,
          // M39a: the one-shot diagnostic evidence captured synchronously above.
          pendingDiagnostics
        );

        // Citations are known CLIENT-SIDE from retrieval; they do not depend on
        // the model reply carrying them.
        const citations = retrieval.chunks.length > 0 ? retrieval.chunks : undefined;

        try {
          const reply = await aiSendMessage({
            keyId: send.keyId,
            provider: send.provider,
            model: send.model,
            baseUrl: send.baseUrl,
            messages: history,
            context,
          });
          if (seq !== requestSeq) return; // conversation was cleared meanwhile
          const assistantMessage: ChatMessage = {
            id: messageId(),
            role: "assistant",
            content: reply.content,
            timestamp: Date.now(),
            suggestion: reply.suggestion ?? undefined,
            citations,
            noSourceFound: retrieval.noSourceFound,
          };
          set((state) => ({ messages: [...state.messages, assistantMessage], isTyping: false }));
          void saveMessage(convId, assistantMessage);
        } catch (e) {
          if (seq !== requestSeq) return;
          const errorMessage: ChatMessage = {
            id: messageId(),
            role: "assistant",
            content: i18n.t("ai.error", { message: String(e) }),
            timestamp: Date.now(),
            isError: true,
          };
          set((state) => ({ messages: [...state.messages, errorMessage], isTyping: false }));
          void saveMessage(convId, errorMessage);
        }
      },

      clearConversation: () => {
        // Detach from the current conversation (it stays in history); the next
        // message opens a fresh one. Bump the token so any in-flight reply drops.
        requestSeq += 1;
        set({ messages: [], isTyping: false, activeConversationId: null });
        // Abandon any unsent per-chat source toggles so the next fresh chat truly
        // starts with nothing disabled (M52 — a draft must not survive "New chat").
        useKnowledgeStore.getState().clearDraftSources();
      },

      stopGeneration: () => {
        // Bump the token so the in-flight `aiSendMessage` promise resolves into
        // a dropped reply (its `seq` no longer matches), and stop "typing" now.
        if (!get().isTyping) return;
        requestSeq += 1;
        set({ isTyping: false });
      },

      initHistory: async () => {
        if (get().historyLoaded) return;
        try {
          const id = await latestConversationId();
          if (id) {
            const msgs = await loadMessages(id);
            set({ activeConversationId: id, messages: msgs, historyLoaded: true });
            return;
          }
        } catch {
          // Persistence unavailable (e.g. outside Tauri) — start empty.
        }
        set({ historyLoaded: true });
      },

      loadConversation: async (id) => {
        requestSeq += 1;
        // Opening a stored chat abandons any unsent draft toggles from the fresh
        // chat we were in, so they never leak onto a later brand-new conversation.
        useKnowledgeStore.getState().clearDraftSources();
        const msgs = await loadMessages(id);
        set({ activeConversationId: id, messages: msgs, isTyping: false });
      },

      refreshConversations: async () => {
        const conversations = await listConversations();
        set({ conversations });
      },

      removeConversation: async (id) => {
        await deleteConversation(id);
        // If the deleted chat is the one on screen, drop back to a fresh chat
        // (bump the token so any in-flight reply for it is discarded).
        if (get().activeConversationId === id) {
          requestSeq += 1;
          set({ messages: [], isTyping: false, activeConversationId: null });
          // Same fresh-chat reset as clearConversation — drop any draft toggles.
          useKnowledgeStore.getState().clearDraftSources();
        }
        set({ conversations: get().conversations.filter((c) => c.id !== id) });
      },

      setApiKey: async (provider, key, baseUrl) => {
        // Reuse the provider's existing key-slot id when one was carried over by
        // migration (so a legacy slot is overwritten, not orphaned); otherwise
        // the slot defaults to the provider id.
        const keyId = keyIdFor(get().credentials, provider);
        const trimmed = key.trim();
        // Only write a non-empty key — a blank Save updates the base URL while
        // KEEPING the stored key (an empty key would clear the slot backend-side,
        // which is what `clearApiKey` is for).
        if (trimmed.length > 0) {
          try {
            await aiSetApiKey(provider, trimmed, keyId);
          } catch {
            // Tauri-less host: the key can't be persisted, but still record the
            // credential metadata so the UI reflects the user's intent.
          }
        }
        set((state) => {
          // Keep the credential minimal: only store overrides (a non-default
          // key slot or a custom base URL); a plain provider-slot key needs no
          // entry, but we keep one so the provider shows as configured.
          const cred: ProviderCredential = {};
          if (keyId !== provider) cred.keyId = keyId;
          if (baseUrl && baseUrl !== PROVIDERS[provider].defaultBaseUrl) {
            cred.baseUrl = baseUrl;
          }
          return { credentials: { ...state.credentials, [provider]: cred } };
        });
        await get().refreshKeyedProviders();
      },

      clearApiKey: async (provider) => {
        const keyId = keyIdFor(get().credentials, provider);
        // Swallow rejections so a Tauri-less env can't surface an unhandled
        // rejection.
        await aiClearApiKey(provider, keyId).catch(() => {});
        set((state) => {
          const credentials = { ...state.credentials };
          // Keep a custom base-URL override if one was set — only the key is
          // being removed, not the endpoint configuration.
          const baseUrl = credentials[provider]?.baseUrl;
          if (baseUrl) credentials[provider] = { baseUrl };
          else delete credentials[provider];
          return { credentials };
        });
        await get().refreshKeyedProviders();
      },

      setSelection: (provider, model) => {
        set({ selection: { provider, model } });
      },

      setContextMode: (contextMode) => set({ contextMode }),

      setDraft: (draft) =>
        // Clearing the composer detaches any staged one-shot diagnostic evidence
        // (M39a) — so an "Explain"/"Ask" prefill the user erased and replaced with an
        // unrelated question never rides that later send.
        set(
          draft.trim().length === 0
            ? { draft, pendingDiagnostics: null }
            : { draft }
        ),

      setPendingDiagnostics: (pendingDiagnostics) => set({ pendingDiagnostics }),

      refreshKeyedProviders: async () => {
        const credentials = get().credentials;
        const entries = await Promise.all(
          PROVIDER_IDS.map(async (p) => {
            if (!PROVIDERS[p].requiresKey) return [p, true] as const;
            try {
              return [p, await aiHasApiKey(p, keyIdFor(credentials, p))] as const;
            } catch {
              return [p, false] as const;
            }
          })
        );
        set({ keyed: Object.fromEntries(entries) as Partial<Record<AIProvider, boolean>> });
      },

      reset: () => {
        requestSeq += 1;
        set({
          isOpen: false,
          messages: [],
          isTyping: false,
          credentials: {},
          selection: { ...DEFAULT_SELECTION },
          keyed: {},
          contextMode: "auto",
          draft: "",
          pendingDiagnostics: null,
          activeConversationId: null,
          historyLoaded: false,
          conversations: [],
        });
      },
    }),
    {
      name: "omnilink-byok",
      // Persist only the BYOK credentials + remembered selection + context mode.
      // Chat history lives in SQLite; transient/runtime fields (messages, keyed,
      // draft, panel state) are excluded.
      partialize: (state) => ({
        credentials: state.credentials,
        selection: state.selection,
        contextMode: state.contextMode,
      }),
      // One-time migration of any older persisted blob to the v1.7.2 shape.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        migrateByokState(state);
        // Re-probe stored keys once the migrated credentials are in place.
        void state.refreshKeyedProviders();
      },
    }
  )
);

/** Every legacy/current persisted BYOK field shape. Migration I/O only. */
interface LegacyByokPersist {
  // pre-v1.6.3 flat shape
  provider?: AIProvider;
  models?: Partial<Record<AIProvider, string>>;
  baseUrls?: Partial<Record<AIProvider, string>>;
  // v1.6.3 keyed multi-config shape
  configs?: Record<string, AiApiConfig>;
  configOrder?: string[];
  activeConfigId?: string | null;
  // v1.7.2 shape
  credentials?: Partial<Record<AIProvider, ProviderCredential>>;
  selection?: AiSelection;
}

/**
 * One-time, LOSSLESS, IDEMPOTENT migration of any pre-v1.7.2 persisted BYOK blob
 * to the v1.7.2 shape (`{ credentials, selection }`): Settings keeps per-provider
 * credentials, the chat remembers a `{ provider, model }` selection.
 *
 * NO backend key is lost and NO Rust-side data move is needed:
 *  - From the **v1.6.3 multi-config** shape, each provider's credential carries
 *    over the chosen config's **key-slot id** (only when it differs from the
 *    provider id) and any custom base URL, so the stored secret keeps resolving;
 *    the previously-active config becomes the default `{ provider, model }`.
 *  - From the **pre-v1.6.3 flat** shape (keys already under the provider slot),
 *    no `keyId` override is needed; only custom base URLs carry over, and the
 *    last-used provider/model becomes the selection.
 *  - A blob with **no legacy fields** (an already-v1.7.2 install, or a fresh
 *    one) is left untouched — its persisted/default `credentials` + `selection`
 *    stand. The guard keys on the presence of LEGACY data (`configs` / flat
 *    `provider`/`models`), NOT on `selection`: the store initializer always
 *    seeds a default `selection`, so a `selection`-based guard would wrongly
 *    skip every real upgrade and orphan keys stored under non-default slots.
 *
 * Exported so the rehydrate migration is directly unit-testable.
 */
export function migrateByokState(state: LegacyByokPersist): void {
  const hasMultiConfig =
    !!state.configs && Object.keys(state.configs).length > 0;
  const hasFlat = !!state.provider || !!state.models;
  // Nothing legacy to convert — keep the persisted/default credentials +
  // selection as-is. This is the idempotency guard (a re-run on an already
  // migrated blob has no legacy fields) AND the fresh-install path.
  if (!hasMultiConfig && !hasFlat) {
    if (!state.credentials) state.credentials = {};
    if (!state.selection) state.selection = { ...DEFAULT_SELECTION };
    return;
  }

  const credentials: Partial<Record<AIProvider, ProviderCredential>> = {};
  let selection: AiSelection | null = null;

  if (hasMultiConfig && state.configs) {
    // v1.6.3 multi-config → per-provider credentials. Prefer the active config
    // for each provider, else the first in order; preserve only real overrides.
    const configs = state.configs;
    const order =
      state.configOrder && state.configOrder.length
        ? state.configOrder
        : Object.keys(configs);
    const activeId = state.activeConfigId ?? null;
    for (const id of order) {
      const cfg = configs[id];
      if (!cfg) continue;
      const p = cfg.provider;
      const isActive = id === activeId;
      if (credentials[p] && !isActive) continue;
      const cred: ProviderCredential = {};
      if (cfg.id !== p) cred.keyId = cfg.id; // non-default slot — keep the binding
      if (cfg.baseUrl && cfg.baseUrl !== PROVIDERS[p].defaultBaseUrl) {
        cred.baseUrl = cfg.baseUrl;
      }
      credentials[p] = cred;
    }
    // Default selection: the active config, else the FIRST config in order (a
    // user with saved configs but no active one shouldn't land on a provider
    // they never configured), else the registry default.
    const active = activeId ? configs[activeId] : undefined;
    const first = order.map((id) => configs[id]).find(Boolean);
    const chosen = active ?? first;
    if (chosen) selection = { provider: chosen.provider, model: chosen.model };
  } else if (state.provider || state.models) {
    // pre-v1.6.3 flat → keys already live under the provider slot (no keyId
    // override). Carry over custom base URLs + the last-used provider/model.
    const p = state.provider ?? DEFAULT_PROVIDER;
    const model = state.models?.[p] ?? PROVIDERS[p].models[0];
    selection = { provider: p, model };
    for (const prov of PROVIDER_IDS) {
      const b = state.baseUrls?.[prov];
      if (b && b !== PROVIDERS[prov].defaultBaseUrl) credentials[prov] = { baseUrl: b };
    }
  }

  state.credentials = credentials;
  state.selection = selection ?? { ...DEFAULT_SELECTION };

  // Drop every obsolete legacy field so it never lingers on the live state.
  const drop = state as Record<string, unknown>;
  for (const k of ["provider", "models", "baseUrls", "configs", "configOrder", "activeConfigId"]) {
    delete drop[k];
  }
}

/**
 * Lazily create the active conversation row on the first message of a chat.
 * Returns the conversation id to write subsequent messages against.
 */
async function ensureConversation(
  get: () => AssistantState,
  set: (partial: Partial<AssistantState>) => void
): Promise<string> {
  const existing = get().activeConversationId;
  if (existing) return existing;
  const id = conversationId();
  set({ activeConversationId: id });
  // Carry any pre-send per-chat source toggles (made while the chat had no id
  // yet) onto this fresh conversation so its first answer honors them (M52).
  useKnowledgeStore.getState().promoteDraftSources(id);
  await createConversation(id, Date.now());
  return id;
}
