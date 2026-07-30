import * as React from "react";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "./use-focus-trap";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Explicit accessible name, used when the dialog renders no {@link DialogTitle}
   * (e.g. an icon-only confirm). When omitted the dialog is auto-labelled by its
   * `DialogTitle` via context — so most callers need pass nothing.
   */
  label?: string;
  /** Id of an external element that labels the dialog (overrides the title). */
  labelledBy?: string;
  children: React.ReactNode;
}

/**
 * Context carrying the generated id the {@link Dialog} expects its
 * {@link DialogTitle} to adopt, so the panel's `aria-labelledby` resolves to the
 * visible title with no wiring at the call site.
 */
const DialogTitleIdContext = React.createContext<string | undefined>(undefined);

/**
 * Minimal controlled modal dialog. Renders an overlay + centered panel and
 * closes on Escape or overlay click. Kept dependency-free (no radix) to match
 * the lightweight primitive idiom in this directory.
 *
 * Modal semantics (M28): the panel is a `role="dialog"` + `aria-modal="true"`
 * surface with an accessible name (its `DialogTitle`, or an explicit
 * `label`/`labelledBy`). {@link useFocusTrap} moves focus into the panel on
 * open, traps Tab/Shift+Tab while open, and restores focus to the trigger on
 * close. All `document` access is guarded for jsdom/SSR.
 */
function Dialog({ open, onClose, label, labelledBy, children }: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
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

  // Accessible-name precedence: an explicit `labelledBy` wins, then an explicit
  // `label`, else the auto-wired DialogTitle id. Only one of aria-label /
  // aria-labelledby is emitted so they never compete.
  const ariaLabelledBy = labelledBy ?? (label ? undefined : titleId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-background/80 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in"
        onClick={onClose}
      />
      <DialogTitleIdContext.Provider value={titleId}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={ariaLabelledBy}
          tabIndex={-1}
          className="relative z-10 w-full max-w-md rounded-lg border border-border bg-card p-5 text-card-foreground shadow-lg outline-none motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95"
        >
          {children}
        </div>
      </DialogTitleIdContext.Provider>
    </div>
  );
}

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

function DialogTitle({
  className,
  id,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  // Adopt the Dialog's generated id (unless the caller set an explicit one) so
  // the panel's aria-labelledby points at this visible title.
  const ctxId = React.useContext(DialogTitleIdContext);
  return (
    <h2
      id={id ?? ctxId}
      className={cn("text-base font-semibold leading-none", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)} {...props} />
  );
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-5 flex items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

export { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter };
