/**
 * Best-effort OS notification for live alerts (M26).
 *
 * Deliberately uses the zero-dependency Web Notifications API rather than
 * pulling in `@tauri-apps/plugin-notification` (a new JS package + a new Rust
 * crate + capability wiring — too heavyweight to add just for this milestone).
 * In a browser/dev build this surfaces a real OS toast; in a Tauri webview it
 * is best-effort. Either way the call is fully guarded so it NEVER throws in a
 * non-DOM (test/node) environment — the in-app toast is the reliable channel.
 */

/** Whether the Web Notifications API exists in this environment. */
function notificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof Notification !== "undefined";
}

/**
 * Lazily ask for notification permission (no-op if unsupported, already
 * decided, or running headless). Safe to call repeatedly.
 */
export function ensureOsNotifyPermission(): void {
  try {
    if (!notificationsSupported()) return;
    if (Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {
        /* user dismissed / unsupported — ignore */
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Fire an OS notification if permission has been granted. Returns silently on
 * any failure so a missing/blocked notification never disrupts the live stream.
 */
export function osNotify(title: string, body: string): void {
  try {
    if (!notificationsSupported()) return;
    if (Notification.permission === "granted") {
      // Fire-and-forget; we don't hold a handle to the toast.
      void new Notification(title, { body });
    }
  } catch {
    /* best-effort — never throw into the telemetry subscription */
  }
}
