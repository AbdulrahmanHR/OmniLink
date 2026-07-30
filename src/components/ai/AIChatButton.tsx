import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssistantStore } from "@/stores";

/**
 * Floating action button (bottom-right) that toggles the AI assistant panel.
 * Carries a subtle Signal Lab glow; swaps to a close icon while the panel is
 * open for an unambiguous toggle affordance.
 */
export function AIChatButton() {
  const { t } = useTranslation();
  const isOpen = useAssistantStore((s) => s.isOpen);
  const toggle = useAssistantStore((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isOpen ? t("ai.closeAssistant") : t("ai.openAssistant")}
      aria-expanded={isOpen}
      className={cn(
        "fixed bottom-6 right-6 z-40 flex h-13 w-13 items-center justify-center rounded-full",
        "bg-primary text-primary-foreground shadow-lg",
        "shadow-[0_0_24px_-2px_var(--color-signal-glow)]",
        "transition-all duration-200 hover:scale-105 hover:bg-primary/90",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "motion-safe:animate-in motion-safe:zoom-in-90"
      )}
    >
      {isOpen ? (
        <X className="h-6 w-6" />
      ) : (
        <Sparkles className="h-6 w-6 motion-safe:animate-pulse" />
      )}
    </button>
  );
}
