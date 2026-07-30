import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action element (e.g. a Button). */
  action?: ReactNode;
  /** Container overrides (e.g. padding, `h-full`). */
  className?: string;
}

/**
 * Shared empty state: a muted icon medallion above a title and optional
 * description, on a recessed `surface-inset` well. Used wherever a feature has
 * no data to show yet (telemetry, profiles list, profile detail).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        // The hairline border stays: the recessed fill alone measures ~1.05:1
        // against the card in the light theme, so the region would read as
        // unframed floating text with no visible boundary.
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-surface-inset/50 py-24 text-center",
        className
      )}
    >
      {/* No pulse on the medallion: an infinite opacity throb is the loading-
          skeleton idiom, and this state is idle rather than loading — it would
          read as "still fetching" forever. Auto-starting motion that runs >5s
          with no pause/stop/hide also trips WCAG 2.2.2 (Level A). */}
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
