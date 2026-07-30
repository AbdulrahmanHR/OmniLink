import * as React from "react";

/**
 * CSS selector matching the natively-focusable / tab-stoppable descendants of a
 * modal surface. Disabled controls and `tabindex="-1"` nodes are excluded so the
 * trap only ever cycles through genuine tab stops.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The visible, focusable descendants of `root`, in DOM order. The visibility
 * filter (`offsetParent`/`getClientRects`) drops `display:none` nodes so a
 * collapsed control never becomes a dead tab stop. In a non-layout environment
 * (jsdom) both signals are empty, so the caller falls back to focusing the
 * container itself — which is why the trap stays inert rather than throwing.
 */
function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
}

/**
 * Dependency-free focus management for modal surfaces (Dialog / Sheet).
 *
 * While `active`, focus is moved into the element referenced by `ref` (its first
 * tab stop, or the container itself as a fallback) and **trapped** there: Tab /
 * Shift+Tab wrap around the contained tab stops instead of escaping to the page
 * behind the modal. When the surface deactivates (close / unmount) focus is
 * **restored** to whatever element was focused when it opened — the trigger —
 * so keyboard users land back where they started.
 *
 * Initial focus is owned by the trap (not `autoFocus`): modal content must NOT
 * autofocus a field, because that would steal focus before the effect captures
 * the trigger and restore would fall through to `<body>` on close. All access is
 * guarded so jsdom unit tests and SSR never throw (outside a real layout engine
 * the hook simply no-ops past the focus moves).
 *
 * @param ref    Ref to the modal container (panel) whose focus is trapped.
 * @param active Whether the surface is currently open.
 */
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean
): void {
  // The element to return focus to on close (captured at open time).
  const restoreRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!active) return;
    if (typeof document === "undefined") return;
    const node = ref.current;
    if (!node) return;

    // Capture the trigger (focused when the modal opened) so focus can return
    // to it on close. Only an element OUTSIDE the panel qualifies: under React
    // StrictMode the effect runs mount→cleanup→mount and on the 2nd run focus
    // may already sit on a field inside the panel — capturing that would make
    // restore target a node that detaches on close (focus would fall to
    // <body>). Since modal content does not autofocus, the active element is
    // still the trigger when this first runs.
    const candidate = document.activeElement;
    if (candidate instanceof HTMLElement && !node.contains(candidate)) {
      restoreRef.current = candidate;
    }

    // Move focus into the panel: its first tab stop, else the panel itself
    // (which carries tabindex={-1} so it is programmatically focusable).
    const initial = getFocusable(node)[0] ?? node;
    initial.focus({ preventScroll: true });

    // Keep Tab / Shift+Tab cycling inside the panel. The listener lives on the
    // panel, so it only sees keystrokes while focus is already within it; the
    // wrap-around guards also re-capture focus if it ever lands on the panel
    // container itself.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = getFocusable(node);
      if (items.length === 0) {
        // Nothing to tab to — pin focus on the panel.
        e.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey) {
        if (current === first || !node.contains(current)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (current === last || !node.contains(current)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      // Restore focus to the trigger if it is still in the document.
      const trigger = restoreRef.current;
      if (trigger && document.contains(trigger)) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [active, ref]);
}
