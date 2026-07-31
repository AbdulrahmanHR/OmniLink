/**
 * Best-effort OS notification for live alerts (M26).
 *
 * Deliberately uses the zero-dependency Web Notifications API rather than
 * pulling in `@tauri-apps/plugin-notification` (a new JS package + a new Rust
 * crate + capability wiring — too heavyweight to add just for this milestone).
 * In a browser/dev build this surfaces a real OS toast; in a Tauri webview it
 * is best-effort. Either way the call is fully guarded so it NEVER throws in a
 * non-DOM (test/node) environment — the in-app toast is the reliable channel.
 *
 * ## Permission is requested from a USER GESTURE — never on mount (v3.0.3)
 *
 * The shipped Linux and macOS app runs in **WebKit** (WebKitGTK / WKWebView),
 * not Chromium, and WebKit enforces the spec's user-gesture requirement for
 * `Notification.requestPermission()`:
 *
 * ```
 * Notification prompting can only be done from a user gesture.
 * ```
 *
 * That error was emitted twice on the first real Tauri/WebKitGTK run, from the
 * mount-time `ensureOsNotifyPermission()` this module used to export — so OS
 * notification permission could **never** be granted in production, while every
 * Chromium-based test and dev run reported success (Chromium is lax about it).
 *
 * The request therefore lives behind an explicit opt-in in
 * **Settings → Live alerts → Desktop notifications**, whose click handler calls
 * {@link requestOsNotifyPermission} **synchronously** — no `await` may precede
 * it, because the gesture is spent at the end of the task that handled the
 * event. This mirrors the audio alert's "Test" button, which exists for exactly
 * the same reason (a gesture is required to unlock the AudioContext).
 *
 * **Nothing in this module prompts on its own.** Importing it, reading
 * {@link osNotifyPermission} and firing {@link osNotify} are all silent.
 */

/** Whether the Web Notifications API exists in this environment. */
function notificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof Notification !== "undefined";
}

/**
 * The OS-notification permission as the UI needs to reason about it: the three
 * engine states plus `unsupported` for a build/environment with no Notification
 * API at all (headless tests, a stripped webview).
 *
 * `denied` is **terminal** — the engine will not prompt again, so the app must
 * degrade to the in-app toast + notification center and say why, rather than
 * silently dropping OS notifications forever.
 */
export type OsNotifyPermission = "unsupported" | "default" | "granted" | "denied";

/** Read the current permission. Never prompts, never throws. */
export function osNotifyPermission(): OsNotifyPermission {
  try {
    if (!notificationsSupported()) return "unsupported";
    const current = Notification.permission;
    return current === "granted" || current === "denied" ? current : "default";
  } catch {
    return "unsupported";
  }
}

/**
 * Ask the OS for notification permission, resolving to the resulting state.
 *
 * **Call this synchronously from a real user-event handler** (a click/change),
 * with no `await` in front of it — see this module's header. Calling it from an
 * effect, a mount, a timeout or a promise continuation is exactly the defect
 * this replaced.
 *
 * Already-decided states short-circuit: `granted` and `denied` resolve
 * immediately **without** calling `requestPermission()`, so a user who said no
 * is never re-prompted (and a denied engine can never be nagged into a second
 * dialog it would refuse to show anyway).
 */
export function requestOsNotifyPermission(): Promise<OsNotifyPermission> {
  const current = osNotifyPermission();
  if (current !== "default") return Promise.resolve(current);
  return new Promise<OsNotifyPermission>((resolve) => {
    const settle = (value?: NotificationPermission) =>
      resolve(
        value === "granted" || value === "denied" ? value : osNotifyPermission()
      );
    try {
      // SYNCHRONOUS — the gesture is still active in this task.
      //
      // The deprecated callback argument is passed as well as using the return
      // value: older WebKit builds implement only the callback form and return
      // `undefined`, newer ones return a promise (and still honour the
      // callback). Whichever settles first wins; a later `resolve` is a no-op.
      const pending = Notification.requestPermission(settle) as
        | Promise<NotificationPermission>
        | undefined;
      if (pending && typeof pending.then === "function") {
        pending.then(settle, () => settle());
      }
    } catch {
      settle();
    }
  });
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
