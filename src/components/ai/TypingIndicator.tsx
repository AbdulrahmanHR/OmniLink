import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";

/** Animated three-dot "assistant is typing" indicator (motion-safe). */
export function TypingIndicator() {
  const { t } = useTranslation();

  return (
    <div className="flex items-end gap-2" aria-live="polite">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Bot className="h-4 w-4" />
      </div>
      <div
        className="flex items-center gap-1 rounded-xl rounded-bl-sm border border-border bg-card px-3 py-2.5"
        role="status"
        aria-label={t("ai.typing")}
      >
        <span className="sr-only">{t("ai.typing")}</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
          />
        ))}
      </div>
    </div>
  );
}
