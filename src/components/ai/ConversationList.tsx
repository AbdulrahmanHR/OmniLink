import * as React from "react";
import { useTranslation } from "react-i18next";
import { History, MessageSquarePlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useAssistantStore } from "@/stores";

/** Locale-aware date+time for a conversation's last-updated stamp (NFR-I18N-03). */
function formatDate(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

interface ConversationListProps {
  /** Return to the chat surface (after starting or opening a conversation). */
  onClose: () => void;
}

/**
 * Past-chats list: "New chat" plus every stored conversation (newest-first),
 * each openable or deletable. Reads/refreshes the headers from SQLite via the
 * store so history survives an app restart. Reuses an inline empty state when
 * there are no saved chats yet.
 */
export function ConversationList({ onClose }: ConversationListProps) {
  const { t, i18n } = useTranslation();
  const conversations = useAssistantStore((s) => s.conversations);
  const activeId = useAssistantStore((s) => s.activeConversationId);
  const refresh = useAssistantStore((s) => s.refreshConversations);
  const load = useAssistantStore((s) => s.loadConversation);
  const remove = useAssistantStore((s) => s.removeConversation);
  const clear = useAssistantStore((s) => s.clearConversation);

  // Re-read headers each time the list is shown so newly-saved chats appear.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const startNew = () => {
    clear();
    onClose();
  };

  const open = async (id: string) => {
    await load(id);
    onClose();
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={startNew}
        >
          <MessageSquarePlus />
          {t("ai.history.newChat")}
        </Button>
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          icon={History}
          title={t("ai.history.empty")}
          className="m-4 flex-1 py-0"
        />
      ) : (
        <ul
          className="flex flex-1 flex-col gap-1 overflow-y-auto p-2"
          aria-label={t("ai.history.title")}
        >
          {conversations.map((c) => (
            <li key={c.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => void open(c.id)}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  c.id === activeId && "bg-accent/60"
                )}
                aria-current={c.id === activeId ? "true" : undefined}
              >
                <span className="w-full truncate text-sm text-foreground">
                  {c.title || t("ai.history.untitled")}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {formatDate(c.updatedAt, i18n.language)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("ai.history.delete")}
                onClick={() => void remove(c.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
