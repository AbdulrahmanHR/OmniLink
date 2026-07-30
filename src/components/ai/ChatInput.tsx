import * as React from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Paperclip, SendHorizonal, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAssistantStore } from "@/stores";
import { matchSlashCommands } from "@/lib/slashCommands";
import {
  ATTACHMENT_CHAR_CAP,
  ATTACHMENT_READ_BYTES,
  formatAttachment,
  type ChatAttachment,
} from "@/lib/attachments";

/** Accepted attachment extensions/MIME for the hidden file picker. */
const ATTACH_ACCEPT = ".txt,.log,.csv,.json,text/plain,text/csv,application/json";

/** Local-only id for an attachment chip / list key. */
function attachmentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Fold the typed message + any attachments into the single outgoing string.
 * Each attachment is appended as a delimited, capped block (pure
 * `formatAttachment`), sharing one total character budget so several logs can't
 * blow the prompt size.
 */
function buildOutgoing(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;
  let remaining = ATTACHMENT_CHAR_CAP;
  const blocks: string[] = [];
  for (const a of attachments) {
    if (remaining <= 0) break;
    blocks.push(formatAttachment(a.name, a.content, remaining));
    remaining -= Math.min(a.content.length, remaining);
  }
  return [message, ...blocks].filter((s) => s.length > 0).join("\n\n");
}

/**
 * Power-user chat composer (M23): textarea + send/stop, slash-command menu, and
 * file/log attachments. Enter sends (Shift+Enter = newline); while the slash
 * menu is open the arrow keys navigate it and Enter/Tab accept the highlight.
 * While a reply is in flight the send button swaps to a prominent Stop control.
 */
export function ChatInput() {
  const { t } = useTranslation();
  const inputId = React.useId();
  const sendMessage = useAssistantStore((s) => s.sendMessage);
  const stopGeneration = useAssistantStore((s) => s.stopGeneration);
  const isTyping = useAssistantStore((s) => s.isTyping);
  // Mirror the draft into the store so the pre-send preview can retrieve/cost the
  // pending question in lockstep with what `sendMessage` will do (M51).
  const setDraft = useAssistantStore((s) => s.setDraft);
  // Read the store draft too so an EXTERNALLY-set draft (e.g. the M39a "Explain
  // this finding" / "Ask Omnia about this session" actions prefill it via setDraft)
  // flows into the composer even though the textarea is otherwise local state.
  const draft = useAssistantStore((s) => s.draft);

  // Seed from the store draft so a draft prefilled BEFORE the panel opened (the
  // M39a "Explain"/"Ask Omnia" actions set the draft then `open()`) is present the
  // moment the composer mounts; the render-phase sync below keeps it live after.
  const [value, setValue] = React.useState(draft);
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [menuDismissed, setMenuDismissed] = React.useState(false);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Adopt an externally-set draft into the local textarea using React's
  // "adjust state when a prop changes" render-phase pattern. Only re-sync when the
  // local value doesn't already match — during typing `value` already equals the new
  // `draft` (onChange mirrors value→draft), so this skips the per-keystroke no-op
  // (avoids a redundant re-render + can't disrupt IME/CJK composition) and fires ONLY
  // for a genuine external write (the M39a "Explain"/"Ask" prefill, or a clear).
  const [lastDraft, setLastDraft] = React.useState(draft);
  if (draft !== lastDraft) {
    setLastDraft(draft);
    if (draft !== value) setValue(draft);
  }

  // The slash-command menu shows while the value is a bare command token (no
  // whitespace yet) that matches at least one command and wasn't dismissed.
  const matches = matchSlashCommands(value);
  const showMenu = matches.length > 0 && !menuDismissed && !/\s/.test(value);
  const activeIndex = Math.min(selectedIndex, Math.max(0, matches.length - 1));

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !isTyping;

  const submit = React.useCallback(() => {
    if (isTyping) return;
    const trimmed = value.trim();
    if (trimmed.length === 0 && attachments.length === 0) return;
    sendMessage(buildOutgoing(trimmed, attachments));
    setValue("");
    setDraft("");
    setAttachments([]);
    setMenuDismissed(false);
    setSelectedIndex(0);
  }, [value, attachments, isTyping, sendMessage, setDraft]);

  // Expand a command into its prompt prefix (never auto-sends) and refocus the
  // textarea with the caret at the end so the user can finish the thought.
  const acceptCommand = React.useCallback(
    (promptKey: string) => {
      const prompt = t(promptKey);
      setValue(prompt);
      setDraft(prompt);
      setMenuDismissed(true);
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(prompt.length, prompt.length);
      });
    },
    [t, setDraft]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMenu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptCommand(matches[activeIndex].promptKey);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Read each picked file as text (byte-capped to guard against huge files) and
  // add a removable chip. Resets the input so the same file can be re-picked.
  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    for (const file of files) {
      try {
        const blob =
          file.size > ATTACHMENT_READ_BYTES
            ? file.slice(0, ATTACHMENT_READ_BYTES)
            : file;
        const content = await blob.text();
        setAttachments((prev) => [
          ...prev,
          { id: attachmentId(), name: file.name, content },
        ]);
      } catch {
        // Unreadable file — skip it rather than break the composer.
      }
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <form
      className="relative flex flex-col gap-2 border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Slash-command menu (above the input). */}
      {showMenu && (
        <ul
          className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          role="listbox"
          aria-label={t("ai.commands.title")}
        >
          {matches.map((cmd, i) => (
            <li key={cmd.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                // mouse-down (not click) so the textarea doesn't blur first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptCommand(cmd.promptKey);
                }}
                className={
                  "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors " +
                  (i === activeIndex
                    ? "bg-accent/60 text-foreground"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground")
                }
              >
                <span className="font-mono text-xs text-foreground">
                  /{cmd.id}
                  <span className="ml-2 font-sans font-medium">
                    {t(cmd.labelKey)}
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t(cmd.descriptionKey)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Attachment chips. */}
      {attachments.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={t("ai.attach.label")}
        >
          {attachments.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground"
            >
              <Paperclip className="h-3 w-3 shrink-0" />
              <span className="max-w-40 truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={t("ai.attach.remove", { name: a.name })}
                className="rounded-full p-0.5 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Generating state + Stop control (M23). */}
      {isTyping && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
            {t("ai.generating")}
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={stopGeneration}
          >
            <Square className="fill-current" />
            {t("ai.stop")}
          </Button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <Label htmlFor={inputId} className="sr-only">
          {t("ai.inputLabel")}
        </Label>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACH_ACCEPT}
          className="hidden"
          onChange={(e) => void onFilesSelected(e)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={isTyping}
          onClick={() => fileInputRef.current?.click()}
          aria-label={t("ai.attach.button")}
          title={t("ai.attach.button")}
        >
          <Paperclip />
        </Button>

        <Textarea
          id={inputId}
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={isTyping}
          placeholder={t("ai.placeholder")}
          onChange={(e) => {
            setValue(e.target.value);
            setDraft(e.target.value);
            setMenuDismissed(false);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-9 flex-1 py-1.5"
        />

        {isTyping ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={stopGeneration}
            aria-label={t("ai.stop")}
          >
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label={t("ai.send")}
          >
            <SendHorizonal />
          </Button>
        )}
      </div>
    </form>
  );
}
