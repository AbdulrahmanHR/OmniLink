import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Eraser,
  FileSearch,
  History,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  currentWizardTarget,
  DRAFT_CONVERSATION_KEY,
  selectEnabledSourceIdsFor,
  selectRetrievalIndex,
  useAssistantStore,
  useBridgeStore,
  useDeviceStore,
  useKnowledgeStore,
  useTelemetryStore,
  useWizardStore,
} from "@/stores";
import { selectAiContext } from "@/lib/aiContext";
import { aiPreviewPayload } from "@/lib/ai";
import { retrieveForChat, type ChatRetrieval } from "@/lib/ragRetrieval";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import { ChatInput } from "./ChatInput";
import { ChatControls } from "./ChatControls";
import { ChatSourcesControl } from "./ChatSourcesControl";
import { ConversationList } from "./ConversationList";

/** A structured starter prompt grouped under a capability category. */
interface GoalChip {
  /** Category bucket — maps to `ai.goals.categories.<category>`. */
  category: "telemetry" | "flashing" | "tuning" | "troubleshooting";
  /** i18n key for the chip's label. */
  labelKey: string;
  /** i18n key for the starter prompt sent on click. */
  promptKey: string;
}

/** Capability goal chips for the empty state, grouped by category (M23). */
const GOAL_CHIPS: readonly GoalChip[] = [
  {
    category: "telemetry",
    labelKey: "ai.goals.telemetry.label",
    promptKey: "ai.goals.telemetry.prompt",
  },
  {
    category: "telemetry",
    labelKey: "ai.goals.linkHealth.label",
    promptKey: "ai.goals.linkHealth.prompt",
  },
  {
    category: "flashing",
    labelKey: "ai.goals.flashing.label",
    promptKey: "ai.goals.flashing.prompt",
  },
  {
    category: "flashing",
    labelKey: "ai.goals.binding.label",
    promptKey: "ai.goals.binding.prompt",
  },
  {
    category: "tuning",
    labelKey: "ai.goals.power.label",
    promptKey: "ai.goals.power.prompt",
  },
  {
    category: "tuning",
    labelKey: "ai.goals.packetRate.label",
    promptKey: "ai.goals.packetRate.prompt",
  },
  {
    category: "troubleshooting",
    labelKey: "ai.goals.failsafe.label",
    promptKey: "ai.goals.failsafe.prompt",
  },
  {
    category: "troubleshooting",
    labelKey: "ai.goals.dropouts.label",
    promptKey: "ai.goals.dropouts.prompt",
  },
];

/** Category order for the empty-state goal sections. */
const GOAL_CATEGORIES = [
  "telemetry",
  "flashing",
  "tuning",
  "troubleshooting",
] as const;

/** Empty conversation state: intro + structured goal chips grouped by category. */
function EmptyState() {
  const { t } = useTranslation();
  const sendMessage = useAssistantStore((s) => s.sendMessage);

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary shadow-[0_0_24px_-4px_var(--color-signal-glow)]">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            {t("ai.empty.title")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("ai.empty.description")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {GOAL_CATEGORIES.map((category) => {
          const chips = GOAL_CHIPS.filter((c) => c.category === category);
          return (
            <section key={category} className="space-y-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`ai.goals.categories.${category}`)}
              </h3>
              <div className="flex flex-wrap gap-2">
                {chips.map((chip) => (
                  <button
                    key={chip.labelKey}
                    type="button"
                    onClick={() => sendMessage(t(chip.promptKey))}
                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {t(chip.labelKey)}
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The retrieved-context half of the preview (M51). */
interface PreviewExtras {
  retrieval: ChatRetrieval;
}

/**
 * The retrieved-context section of the preview (M51). Shows which trusted
 * excerpts the pending draft would send to the model, so the user sees the RAG
 * grounding before sending.
 */
function RetrievedContextPreview({ retrieval }: PreviewExtras) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* Retrieved trusted excerpts (or the no-source state). */}
      <div className="rounded-md border border-border bg-background/60 p-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <FileSearch className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          {t("ai.rag.preview.title")}
        </span>
        {retrieval.chunks.length > 0 ? (
          <>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("ai.rag.preview.count", { count: retrieval.chunks.length })}
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {retrieval.chunks.map((c) => (
                <li
                  key={c.chunkId}
                  className="truncate text-[11px] text-muted-foreground"
                >
                  • {c.sourceTitle}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("ai.rag.preview.none")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * NFR-PRIV-01 "Show what will be sent" (M51-extended): expandable that mirrors
 * the send path — local retrieval → context assembly → the EXACT sanitized
 * payload (via `ai_preview_payload`) — and renders the sanitized JSON alongside
 * the retrieved trusted excerpts that would ground the answer. Reuses
 * `retrieveForChat` + `selectAiContext` so the preview stays in lockstep with
 * `sendMessage`.
 */
function PayloadPreview() {
  const { t } = useTranslation();
  const [payload, setPayload] = React.useState<string>("");
  const [extras, setExtras] = React.useState<PreviewExtras | null>(null);

  const loadPreview = React.useCallback(async () => {
    // Retrieve the trusted + imported excerpts the pending draft would send —
    // same call, same enabled-source gating AND combined index as `sendMessage`
    // (M51/M52), so the preview stays in lockstep with the send path.
    const draft = useAssistantStore.getState().draft;
    const knowledge = useKnowledgeStore.getState();
    // Scope to THIS chat's enabled sources (M52 per-chat). Before the first turn
    // opens a conversation, use the draft bucket so the preview reflects any
    // pre-send toggles the "Sources for this chat" control has made.
    const convKey =
      useAssistantStore.getState().activeConversationId ?? DRAFT_CONVERSATION_KEY;
    const retrieval = retrieveForChat(draft, {
      enabledSourceIds: selectEnabledSourceIdsFor(knowledge, convKey),
      index: selectRetrievalIndex(knowledge),
    });

    // Mirror the send path through the same context selector (+ retrieved docs)
    // so the preview reflects exactly what the active context mode will send.
    const context = selectAiContext(
      useAssistantStore.getState().contextMode,
      useDeviceStore.getState().device,
      useTelemetryStore.getState().history,
      currentWizardTarget(useWizardStore.getState()),
      // M65: mirror the send path — fold in the read-only bridge context (if any)
      // so the privacy preview shows exactly the sanitized bridge data that leaves.
      useBridgeStore.getState().context,
      // M51: the retrieved trusted docs that would ground the answer.
      retrieval.docs,
      // M39a: the pending one-shot diagnostic evidence, so the preview shows the
      // sanitized aggregate that an "explain"/"ask" action will send.
      useAssistantStore.getState().pendingDiagnostics
    );

    setExtras({ retrieval });

    try {
      const sanitized = await aiPreviewPayload(context);
      setPayload(JSON.stringify(sanitized, null, 2));
    } catch {
      // Backend unavailable — show the locally-assembled context as a fallback.
      setPayload(JSON.stringify(context, null, 2));
    }
  }, []);

  return (
    <details
      className="border-t border-border px-3 py-2 text-xs"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void loadPreview();
      }}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        {t("ai.preview.title")}
      </summary>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {t("ai.preview.description")}
      </p>
      {extras && <RetrievedContextPreview retrieval={extras.retrieval} />}
      <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
        {payload || t("ai.preview.empty")}
      </pre>
    </details>
  );
}

/** The chat surface: header, scrollable message list, and composer. */
export function ChatPanel() {
  const { t } = useTranslation();
  const titleId = React.useId();

  const isOpen = useAssistantStore((s) => s.isOpen);
  const close = useAssistantStore((s) => s.close);
  const messages = useAssistantStore((s) => s.messages);
  const isTyping = useAssistantStore((s) => s.isTyping);
  const clearConversation = useAssistantStore((s) => s.clearConversation);

  // Whether the past-chats list is showing instead of the active conversation.
  const [historyOpen, setHistoryOpen] = React.useState(false);

  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message / typing indicator.
  React.useEffect(() => {
    if (!isOpen || historyOpen) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [isOpen, historyOpen, messages, isTyping]);

  const hasMessages = messages.length > 0;

  return (
    <Sheet open={isOpen} onClose={close} labelledBy={titleId}>
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border p-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold leading-tight">
            {t("ai.title")}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {t("ai.subtitle")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-label={t("ai.history.show")}
          aria-pressed={historyOpen}
        >
          <History />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={clearConversation}
          disabled={!hasMessages || historyOpen}
          aria-label={t("ai.clear")}
        >
          <Eraser />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={close}
          aria-label={t("common.close")}
        >
          <X />
        </Button>
      </header>

      {historyOpen ? (
        /* Past-chats list — restores any saved conversation across restarts. */
        <ConversationList onClose={() => setHistoryOpen(false)} />
      ) : (
        <>
          {/* Inline command-center controls: provider / model / device context. */}
          <ChatControls />

          {/* Message list */}
          {hasMessages ? (
            <div
              className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
              role="log"
              aria-live="polite"
              aria-label={t("ai.title")}
              // A11y (WCAG 2.1.1 / axe `scrollable-region-focusable`): the message
              // log scrolls, so it must be keyboard-focusable to be scrollable by
              // keyboard-only users. It already carries an accessible name above.
              tabIndex={0}
            >
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
              {isTyping && <TypingIndicator />}
              <div ref={bottomRef} />
            </div>
          ) : (
            <EmptyState />
          )}

          {/* M52 per-chat: enable/disable grounding sources for THIS conversation. */}
          <ChatSourcesControl />

          {/* NFR-PRIV-01: let the user inspect exactly what gets sent. */}
          <PayloadPreview />

          {/* FR-AI-05: persistent AI-generated + verify-before-flashing disclaimer. */}
          <p
            role="note"
            className="flex items-center gap-1.5 border-t border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            {t("ai.disclaimer")}
          </p>

          {/* Composer */}
          <ChatInput />
        </>
      )}
    </Sheet>
  );
}
