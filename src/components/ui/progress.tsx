import * as React from "react";
import { cn } from "@/lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Completion 0–100. */
  value?: number;
  /** Class applied to the moving indicator (e.g. status color override). */
  indicatorClassName?: string;
}

/**
 * Lightweight determinate progress bar. Dependency-free to match the primitive
 * idiom in this directory; the fill animates its width with a Signal Lab glow.
 */
const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, indicatorClassName, value = 0, ...props }, ref) => {
    const clamped = Math.min(100, Math.max(0, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className={cn(
          "relative h-2 w-full overflow-hidden rounded-full bg-secondary",
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary shadow-[0_0_12px_-2px_var(--color-signal-glow)] transition-[width] duration-300 ease-out motion-reduce:transition-none",
            indicatorClassName
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    );
  }
);
Progress.displayName = "Progress";

export { Progress };
