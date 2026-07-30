import { useTranslation } from "react-i18next";
import { ChevronRight, Terminal } from "lucide-react";

interface FlashLogPanelProps {
  /** Raw build/upload log lines (FR-FLASH-06 / FR-FLASH-12 (b)). */
  log: string[];
  /** Whether the collapsible starts expanded. */
  defaultOpen?: boolean;
}

/**
 * Collapsible raw-log panel. Uses a native <details> element so it needs no
 * extra state or dependency, and stays keyboard-accessible by default.
 */
export function FlashLogPanel({ log, defaultOpen = false }: FlashLogPanelProps) {
  const { t } = useTranslation();

  return (
    <details
      open={defaultOpen}
      className="group rounded-md border border-border bg-card/40"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        <Terminal className="h-3.5 w-3.5" />
        {t("wizard.flash.log.title", { count: log.length })}
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-border px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {log.join("\n")}
      </pre>
    </details>
  );
}
