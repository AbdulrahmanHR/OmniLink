import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

interface SelectableTileProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Optional trailing content (badges / spec chips). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared selectable card tile used across the wizard's choice steps. Mirrors the
 * ProfileCard interaction model (button role, keyboard select, active glow) so
 * the wizard feels native to the rest of the app.
 */
export function SelectableTile({
  icon: Icon,
  title,
  description,
  selected,
  disabled = false,
  onSelect,
  children,
  className,
}: SelectableTileProps) {
  return (
    <Card
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "relative flex flex-col gap-2 p-4 outline-none transition-all duration-200 motion-reduce:transition-none",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring",
        selected
          ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary),0_0_22px_-6px_var(--color-signal-glow)]"
          : "border-border",
        className
      )}
    >
      {selected && (
        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
            selected
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 pr-5">
          <p className="truncate text-sm font-semibold text-foreground">
            {title}
          </p>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {children && <div className="flex flex-wrap gap-1.5">{children}</div>}
    </Card>
  );
}
