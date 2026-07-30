import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        good: "border-transparent bg-status-good/15 text-status-good",
        warning: "border-transparent bg-status-warning/15 text-status-warning",
        // M41: the critical badge text sits on the faint `bg-status-critical/15`
        // tint over the card, where the base `text-status-critical` is only
        // ~3.7–4.0:1 (WCAG AA fail) in EVERY theme. `-strong` is the per-theme
        // contrast-safe critical — DARKENED on light (L0.45, ~5.1:1) and LIGHTENED
        // on dark/carbon (L0.72, ~6.3–6.6:1) — leaving the solid critical fill
        // (chart markers, NotificationBell count) untouched.
        critical:
          "border-transparent bg-status-critical/15 text-status-critical-strong",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

export { Badge };
