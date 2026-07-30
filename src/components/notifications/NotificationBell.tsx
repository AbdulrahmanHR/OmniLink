import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, BellOff, Check, CheckCheck, Trash2, X } from "lucide-react";
import {
  selectUnreadCount,
  useNotificationsStore,
} from "@/stores/notifications";
import type { AnomalySeverity } from "@/lib/liveAlerts";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/components/ui/use-focus-trap";
import { cn } from "@/lib/utils";

/** Severity → Signal Lab status token (mirrors LiveAlertHost / AnomalyPanel). */
const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

/** Display cap for the unread pill so a flood never blows out the bar. */
function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/**
 * Header notification bell + dropdown center (v1.7.1).
 *
 * Replaces the dead placeholder at `DeviceBar`. Reads the persisted
 * {@link useNotificationsStore} fed by the single M26 evaluation path, shows an
 * unread badge, and opens a focus-trapped, keyboard-operable dropdown listing
 * notifications newest-first with per-item mark-read, mark-all-read and
 * clear-all. New arrivals are announced via an `aria-live` region even while the
 * panel is closed. Panel entry animation respects `prefers-reduced-motion`
 * (declarative `motion-safe:`). Pure in-app store ⇒ no Tauri guard needed; the
 * bar mounts identically on web and in the Tauri webview.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const items = useNotificationsStore((s) => s.items);
  const unread = useNotificationsStore(selectUnreadCount);
  const isOpen = useNotificationsStore((s) => s.isOpen);
  const toggle = useNotificationsStore((s) => s.toggle);
  const close = useNotificationsStore((s) => s.close);
  const markRead = useNotificationsStore((s) => s.markRead);
  const markAllRead = useNotificationsStore((s) => s.markAllRead);
  const clear = useNotificationsStore((s) => s.clear);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Trap focus inside the open panel; focus returns to the bell on close.
  useFocusTrap(panelRef, isOpen);

  // Escape closes (the focus trap handles Tab/Shift+Tab; this adds Escape, the
  // same sibling effect Dialog/Sheet use).
  useEffect(() => {
    if (!isOpen) return;
    if (typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  // Click outside the bell + panel closes the dropdown.
  useEffect(() => {
    if (!isOpen) return;
    if (typeof document === "undefined") return;
    const onPointerDown = (e: PointerEvent) => {
      const node = wrapperRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen, close]);

  // Announce a genuinely-new arrival (not the persisted newest on first mount).
  const newest = items[0];
  const lastAnnouncedId = useRef<string | null>(newest?.id ?? null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (newest && newest.id !== lastAnnouncedId.current) {
      lastAnnouncedId.current = newest.id;
      // M37 diagnostic notifications (id `diag:…`) resolve their title from the
      // `diagnostics.*` namespace; M26 alarms keep the `alerts.*` resolution.
      const title = newest.id.startsWith("diag:")
        ? t(`diagnostics.notification.category.${newest.type}`)
        : t(`alerts.type.${newest.type}`);
      setAnnouncement(t("notifications.arrived", { title }));
    }
  }, [newest, t]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        data-testid="notification-bell"
        className="relative rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={
          unread > 0
            ? t("notifications.badgeLabel", { count: unread })
            : t("common.notifications")
        }
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={toggle}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span
            data-testid="notification-badge"
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-critical px-1 text-[0.625rem] font-semibold leading-none text-white"
          >
            {badgeText(unread)}
          </span>
        )}
      </button>

      {/* Arrivals live-region: announces new notifications even while closed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>

      {isOpen && (
        <div
          ref={panelRef}
          data-testid="notification-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={cn(
            "absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover text-popover-foreground shadow-lg focus:outline-none",
            "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1"
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            <h2 id={titleId} className="text-sm font-semibold text-foreground">
              {t("notifications.title")}
              {unread > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {t("notifications.unread", { count: unread })}
                </span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  data-testid="notification-mark-all-read"
                  aria-label={t("notifications.markAllRead")}
                  title={t("notifications.markAllRead")}
                  onClick={markAllRead}
                >
                  <CheckCheck aria-hidden className="size-3.5" />
                </Button>
              )}
              {items.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  data-testid="notification-clear-all"
                  aria-label={t("notifications.clearAll")}
                  title={t("notifications.clearAll")}
                  onClick={clear}
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={close}
              >
                <X aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>

          {items.length === 0 ? (
            <div
              data-testid="notification-empty"
              className="flex flex-col items-center gap-2 px-4 py-8 text-center text-muted-foreground"
            >
              <BellOff aria-hidden className="size-6 opacity-60" />
              <p className="text-xs">{t("notifications.empty")}</p>
            </div>
          ) : (
            <div
              role="log"
              aria-live="polite"
              aria-label={t("notifications.title")}
              className="max-h-80 overflow-y-auto"
            >
              <ul className="py-1">
                {items.map((n) => (
                <li
                  key={n.id}
                  data-testid="notification-item"
                  data-read={n.read ? "true" : "false"}
                  className={cn(
                    "flex items-start gap-2 px-3 py-2",
                    n.read && "opacity-60"
                  )}
                >
                  <span
                    aria-hidden
                    className="mt-1 size-2 shrink-0 rounded-full"
                    style={{ background: SEVERITY_COLOR[n.severity] }}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={cn(
                        "text-xs text-foreground",
                        !n.read && "font-semibold"
                      )}
                    >
                      {n.id.startsWith("diag:")
                        ? t(`diagnostics.notification.category.${n.type}`)
                        : t(`alerts.type.${n.type}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(n.body, n.params)}
                    </span>
                  </span>
                  {!n.read && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      data-testid="notification-mark-read"
                      aria-label={t("notifications.markRead")}
                      title={t("notifications.markRead")}
                      onClick={() => markRead(n.id)}
                    >
                      <Check aria-hidden className="size-3.5" />
                    </Button>
                  )}
                </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
