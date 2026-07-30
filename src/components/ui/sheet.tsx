import * as React from "react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "./use-focus-trap";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** id of the element that labels the dialog (for aria-labelledby). */
  labelledBy?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Minimal controlled slide-in side panel. Renders an overlay + right-edge
 * panel, closes on Escape or overlay click. Dependency-free (no radix) to match
 * the lightweight primitive idiom in this directory (see dialog.tsx).
 *
 * Modal semantics (M28): `role="dialog"` + `aria-modal="true"` with an
 * accessible name (`labelledBy`). {@link useFocusTrap} moves focus into the
 * panel on open, traps Tab/Shift+Tab while open, and restores focus to the
 * trigger on close. All `document` access is guarded for jsdom/SSR.
 */
function Sheet({ open, onClose, labelledBy, className, children }: SheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open);

  React.useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-card text-card-foreground shadow-xl outline-none motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-300",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

export { Sheet };
