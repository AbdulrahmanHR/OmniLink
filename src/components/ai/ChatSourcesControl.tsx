import { useTranslation } from "react-i18next";
import { Check, Library, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DRAFT_CONVERSATION_KEY,
  useAssistantStore,
  useKnowledgeStore,
} from "@/stores";
import { cn } from "@/lib/utils";

/**
 * One source row with a per-CHAT enable/disable switch. Trusted sources show a
 * shield-check; imported ones show the shield-alert + "yours" marker so they can
 * never be mistaken for an official source (mirrors the ImportPanel badge).
 */
function SourceToggleRow({
  title,
  trusted,
  enabled,
  onToggle,
}: {
  title: string;
  trusted: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const Icon = trusted ? ShieldCheck : ShieldAlert;
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/60 px-2 py-1.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            trusted ? "text-primary" : "text-status-warning",
          )}
          aria-hidden="true"
        />
        <span className="truncate text-[11px] text-foreground">{title}</span>
        {!trusted && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-status-warning">
            {t("ai.sources.untrusted")}
          </span>
        )}
      </span>
      <Button
        type="button"
        variant={enabled ? "default" : "outline"}
        size="sm"
        role="switch"
        aria-checked={enabled}
        aria-label={t(
          enabled ? "ai.sources.disableAria" : "ai.sources.enableAria",
          { title },
        )}
        onClick={() => onToggle(!enabled)}
      >
        {enabled ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {enabled ? t("ai.sources.on") : t("ai.sources.off")}
      </Button>
    </li>
  );
}

/**
 * "Sources for this chat" (M52 per-chat). A compact, collapsible control in the
 * chat surface that lets the user enable/disable each knowledge source — trusted
 * OR imported — FOR THE ACTIVE CONVERSATION only. Disabling a source here removes
 * it from grounding in this chat without touching any other chat.
 *
 * Before the first turn opens a real conversation (a fresh / "new" chat), toggles
 * write to the transient {@link DRAFT_CONVERSATION_KEY} bucket; `sendMessage`
 * promotes those choices onto the conversation the moment it is created, so the
 * first answer honors them. Every string goes through `t()`; each toggle is a
 * proper `role="switch"` with an `aria-checked` state and a labelled action.
 */
export function ChatSourcesControl() {
  const { t } = useTranslation();
  const activeConversationId = useAssistantStore((s) => s.activeConversationId);
  const convKey = activeConversationId ?? DRAFT_CONVERSATION_KEY;

  const sources = useKnowledgeStore((s) => s.sources);
  const importedSources = useKnowledgeStore((s) => s.importedSources);
  const disabled = useKnowledgeStore((s) => s.disabledByConversation[convKey]);
  const setSourceEnabled = useKnowledgeStore((s) => s.setSourceEnabled);

  const total = sources.length + importedSources.length;
  // Nothing to scope when there are no knowledge sources at all.
  if (total === 0) return null;

  // Count enabled from the CURRENTLY-LISTED sources only, so an orphaned disabled
  // id (e.g. a bundled source dropped in a later app version, still lingering in a
  // persisted conversation bucket) can never skew "N of M on" off the visible
  // switches.
  let enabledCount = 0;
  for (const s of sources) if (!disabled?.[s.metadata.id]) enabledCount += 1;
  for (const s of importedSources) if (!disabled?.[s.id]) enabledCount += 1;

  return (
    <details className="border-t border-border px-3 py-2 text-xs">
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <Library className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("ai.sources.title")}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums">
          {t("ai.sources.count", { enabled: enabledCount, total })}
        </span>
      </summary>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {t("ai.sources.description")}
      </p>
      <ul
        className="mt-2 flex flex-col gap-1.5"
        aria-label={t("ai.sources.title")}
      >
        {sources.map((s) => (
          <SourceToggleRow
            key={s.metadata.id}
            title={s.metadata.title}
            trusted
            enabled={!disabled?.[s.metadata.id]}
            onToggle={(next) => setSourceEnabled(convKey, s.metadata.id, next)}
          />
        ))}
        {importedSources.map((s) => (
          <SourceToggleRow
            key={s.id}
            title={s.title}
            trusted={false}
            enabled={!disabled?.[s.id]}
            onToggle={(next) => setSourceEnabled(convKey, s.id, next)}
          />
        ))}
      </ul>
      {enabledCount === 0 && (
        <p className="mt-2 text-[11px] text-status-warning" role="status">
          {t("ai.sources.allOff")}
        </p>
      )}
    </details>
  );
}
