import * as React from "react";
import { useTranslation } from "react-i18next";
import { Bot, Check, Copy, Lightbulb, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseMessageSegments } from "@/lib/messageSegments";
import type { ChatMessage } from "@/stores";
import { ContextCitation } from "./ContextCitation";
import { SourceCitations } from "./SourceCitations";
import { SuggestionReview } from "./SuggestionReview";

interface MessageBubbleProps {
  message: ChatMessage;
}

/** Format a timestamp as a locale-aware short time (NFR-I18N-03: Intl API). */
function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

/**
 * A fenced ```code block``` rendered as a styled <pre> with a Copy button.
 * Copying flips to a transient "Copied" state via `navigator.clipboard`.
 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending "Copied" reset if the bubble unmounts mid-flash.
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = React.useCallback(() => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border bg-background/70">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {lang || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t("ai.code.copied") : t("ai.code.copy")}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? t("ai.code.copied") : t("ai.code.copy")}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

/**
 * Render message text into text / inline-`code` / fenced ```code``` segments
 * (parsing is the pure `parseMessageSegments` helper). Fenced blocks get a copy
 * button; inline spans keep the original mono styling.
 */
function renderContent(content: string) {
  return parseMessageSegments(content).map((seg, i) => {
    if (seg.kind === "codeBlock") {
      return <CodeBlock key={i} code={seg.content} lang={seg.lang} />;
    }
    if (seg.kind === "inlineCode") {
      return (
        <code
          key={i}
          className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {seg.content}
        </code>
      );
    }
    return <span key={i}>{seg.content}</span>;
  });
}

/**
 * The read-only suggestion chip (`key = value` + reason) plus a "Review change"
 * affordance that opens the {@link SuggestionReview} diff/apply panel (M54). The
 * informational display is unchanged; the Apply-through-review affordance is new.
 */
function SuggestionChip({
  suggestion,
}: {
  suggestion: NonNullable<ChatMessage["suggestion"]>;
}) {
  const { t } = useTranslation();
  const [reviewing, setReviewing] = React.useState(false);

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-semibold text-primary">
        <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
        {t("ai.suggestion.label")}
      </span>
      <code className="font-mono text-[0.85em] text-foreground">
        {suggestion.key} = {suggestion.value}
      </code>
      {suggestion.reason && (
        <span className="text-muted-foreground">{suggestion.reason}</span>
      )}
      <button
        type="button"
        onClick={() => setReviewing((v) => !v)}
        aria-expanded={reviewing}
        className="flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
        {reviewing
          ? t("ai.suggestion.hideReview")
          : t("ai.suggestion.review")}
      </button>
      {reviewing && (
        <SuggestionReview
          suggestion={suggestion}
          onApplied={() => setReviewing(false)}
        />
      )}
    </div>
  );
}

/** A single chat bubble — user (right, primary) vs assistant (left, card). */
export function MessageBubble({ message }: MessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const isUser = message.role === "user";
  // Citations are for genuine model answers, not local error notices.
  const showCitation = !isUser && !message.isError;
  // RAG source citations (M51): render on assistant answers that carry retrieved
  // citations OR the D19 "no trusted source found" state — never on user/error.
  const hasCitations = !!message.citations && message.citations.length > 0;
  const showSources =
    !isUser && !message.isError && (hasCitations || message.noSourceFound === true);

  return (
    <div
      className={cn(
        "flex items-end gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {!isUser && (
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
          aria-hidden="true"
        >
          <Bot className="h-4 w-4" />
        </div>
      )}
      <div
        className={cn(
          "flex max-w-[80%] flex-col gap-1",
          isUser ? "items-end" : "items-start"
        )}
      >
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm leading-relaxed",
            isUser
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : message.isError
                ? "rounded-bl-sm border border-destructive/50 bg-destructive/10 text-foreground"
                : "rounded-bl-sm border border-border bg-card text-card-foreground"
          )}
        >
          {renderContent(message.content)}
        </div>
        {!isUser && message.suggestion && (
          <SuggestionChip suggestion={message.suggestion} />
        )}
        {showSources && (
          <SourceCitations
            citations={message.citations ?? []}
            noSourceFound={message.noSourceFound}
          />
        )}
        {showCitation && <ContextCitation />}
        <time
          dateTime={new Date(message.timestamp).toISOString()}
          className="px-1 text-[10px] tabular-nums text-muted-foreground"
        >
          <span className="sr-only">
            {isUser ? t("ai.role.you") : t("ai.role.assistant")},{" "}
          </span>
          {formatTime(message.timestamp, i18n.language)}
        </time>
      </div>
    </div>
  );
}
