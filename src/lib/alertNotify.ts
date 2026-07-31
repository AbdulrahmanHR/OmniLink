/**
 * OS notification for live alerts (M26), delivered natively (v3.0.3).
 *
 * ## Why this does NOT use the Web Notifications API
 *
 * It used to. The original M26 note called the web API "zero dependency" and
 * judged `@tauri-apps/plugin-notification` "too heavyweight". That trade was
 * wrong, and the first real runs of the app on the engine it actually ships in
 * proved it twice over:
 *
 * 1. **The gesture defect.** `Notification.requestPermission()` was called from
 *    a mount effect. WebKit (WebKitGTK on Linux, WKWebView on macOS) enforces
 *    the spec's user-gesture requirement that Chromium is lax about, so the
 *    console read `Notification prompting can only be done from a user
 *    gesture.` and permission could never be granted in production — while
 *    every Chromium test and dev run reported success. That was fixed by moving
 *    the request onto an explicit "Enable" button in Settings.
 *
 * 2. **The permission-request defect, which the fix could not reach.** With a
 *    genuine click delivered on that genuine button, on WebKitGTK 2.52.3,
 *    `Notification.permission` went `default` -> `denied` within 2.5 s and **no
 *    prompt window ever appeared**. WebKitGTK routes the request through the
 *    webview's `permission-request` signal; wry 0.55.1 installs no handler for
 *    it, so the default handler denies. The web API is therefore *unobtainable*
 *    in the shipped Linux app no matter how correctly it is called, and
 *    WKWebView / WebView2 have the same class of webview-permission problem.
 *
 * So the notification now goes through the OS **natively**. Registering
 * `tauri_plugin_notification` (see `src-tauri/src/lib.rs`) injects an init
 * script that REPLACES `window.Notification` with a shim backed by three Rust
 * commands — `notify`, `request_permission`, `is_permission_granted`, the only
 * three the ACL grants — so nothing here is subject to the webview permission
 * model at all.
 *
 * ## Why the APP owns the opt-in, not the OS
 *
 * The plugin's desktop backend does not ask anyone anything. Both
 * `permission_state()` and `request_permission()` are
 * `Ok(PermissionState::Granted)`, hard-coded
 * (`tauri-plugin-notification-2.3.3/src/desktop.rs:65-67`) — on Linux, macOS
 * and Windows alike. So {@link osNotifyPermission} answers `granted` on every
 * desktop build, no prompt window is ever shown, and there is nothing for a
 * user to refuse.
 *
 * That means the migration, taken alone, deleted the opt-in: for one commit
 * OS notifications fired for every tripped alarm with no consent step at all,
 * and only the master mute could stop them. **The consent gate is therefore
 * `osNotifyEnabled` in `@/stores/alerts` — a persisted flag defaulting to
 * OFF**, exactly like the `soundEnabled` audio alert in the same settings
 * card, because a system popup is at least as intrusive as a beep. This module
 * still reports what the platform says (a future platform, or the mobile
 * backend, genuinely can answer `denied`), but the product decision is the
 * flag, and {@link osNotifyAllowed} is where it is applied.
 *
 * ## What survived the migration, and why
 *
 * - **Nothing in this module prompts on its own.** Importing it, reading
 *   {@link osNotifyPermission} and firing {@link osNotify} are all silent.
 * - **The request stays behind a user gesture** — turning the toggle ON in
 *   Settings -> Live alerts, whose `onChange` calls
 *   {@link requestOsNotifyPermission} with no `await` in front of it. The
 *   plugin no longer *requires* a gesture (and on desktop no longer asks at
 *   all), but asking for a system permission the instant an app launches is
 *   bad UX independently of what the engine enforces, and the guard costs
 *   nothing on the platforms that will one day answer honestly. Structural
 *   tests pin it.
 * - **`denied` is terminal.** An already-decided state never reaches
 *   `requestPermission()`, so a user who said no is not nagged; the UI shows
 *   the "Blocked" badge and explains that in-app alerts and the notification
 *   center still work.
 * - **Every call is fully guarded** so it NEVER throws into the telemetry
 *   subscription.
 *
 * ## Outside a Tauri runtime
 *
 * The Vite dev server, the Playwright suite and the vitest Node process have no
 * `__TAURI_INTERNALS__`, which is the object the plugin's `invoke` dereferences
 * — directly and through the injected `window.Notification` shim. Without it
 * every call in this module would throw, so {@link osNotifySupported} short
 * circuits first and the whole feature reports `unsupported`. That is the
 * expected, correct outcome there: OS notifications are a desktop-app
 * capability, and the in-app toast plus the notification center remain the
 * reliable channels. Same runtime probe as `components/map/map-style.ts` and
 * `components/logs/ImportDropzone.tsx`.
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Whether the native notification plugin can be reached at all.
 *
 * Synchronous on purpose: the Settings row needs a sensible first render before
 * the asynchronous permission read settles, and {@link osNotify} needs to bail
 * out of a non-Tauri host without starting a promise it cannot finish.
 */
export function osNotifySupported(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The OS-notification permission as the UI needs to reason about it: the three
 * decidable states plus `unsupported` for a host with no native notification
 * path at all (a browser/dev build, the headless test runners).
 *
 * `denied` is **terminal** — the OS will not be asked again, so the app must
 * degrade to the in-app toast + notification center and say why, rather than
 * silently dropping OS notifications forever.
 */
export type OsNotifyPermission = "unsupported" | "default" | "granted" | "denied";

/**
 * Read the current permission. Never prompts, never throws.
 *
 * Asynchronous because the plugin's read crosses the Tauri IPC boundary. The
 * `is_permission_granted` command answers with an `Option<bool>` — `true` for
 * granted, `false` for denied, and `null` for a still-undecided prompt state —
 * which is exactly this module's tri-state, so it is mapped straight across.
 */
export async function osNotifyPermission(): Promise<OsNotifyPermission> {
  if (!osNotifySupported()) return "unsupported";
  try {
    // The plugin types this `Promise<boolean>`, but the command it wraps
    // returns `Option<bool>` and the `null` arm is the undecided state.
    const granted = (await isPermissionGranted()) as boolean | null | undefined;
    if (granted === true) return "granted";
    if (granted === false) return "denied";
    return "default";
  } catch {
    return "unsupported";
  }
}

/**
 * Ask the OS for notification permission, resolving to the resulting state.
 *
 * **Call this from a real user-event handler**, with no `await` in front of it
 * — see this module's header. It is no longer the engine that demands this, but
 * the opt-in is the product decision and the structural tests enforce it.
 *
 * Already-decided states short-circuit: `granted` and `denied` resolve without
 * calling `requestPermission()` at all, so a user who said no is never
 * re-prompted.
 */
export async function requestOsNotifyPermission(): Promise<OsNotifyPermission> {
  const current = await osNotifyPermission();
  if (current !== "default") return current;
  try {
    // Widened to `string`: the command returns a Tauri `PermissionState`, whose
    // `prompt` / `prompt-with-rationale` arms are outside the DOM
    // `NotificationPermission` union the plugin's types declare. Both mean
    // "still undecided", so they fall through to `default` rather than being
    // mistaken for a refusal.
    const outcome: string = await requestPermission();
    if (outcome === "granted" || outcome === "denied") return outcome;
    return await osNotifyPermission();
  } catch {
    return await osNotifyPermission();
  }
}

/**
 * Whether a tripped alarm may raise an OS notification right now.
 *
 * The single source of truth for the OS-notification gating
 * (`osNotifyEnabled && !muted`), mirroring `maybePlayAlertSound` in
 * `@/lib/alertSound`: the live-alert host calls it at the same point it raises
 * the toast and the beep, so the rule lives in one testable place rather than
 * being re-derived at the call site.
 *
 * `osNotifyEnabled` is the persisted opt-in, NOT an OS permission — see this
 * module's header: on desktop the plugin reports `Granted` unconditionally, so
 * asking the platform would gate on nothing. `muted` still wins over an
 * explicit opt-in, exactly as it does for the toast and the beep.
 */
export function osNotifyAllowed(opts: {
  osNotifyEnabled: boolean;
  muted: boolean;
}): boolean {
  return opts.osNotifyEnabled && !opts.muted;
}

/**
 * Fire an OS notification if permission has been granted. Returns silently on
 * any failure so a missing/blocked notification never disrupts the live stream.
 *
 * Stays `void` — the live-alert host calls it from a Zustand subscription and
 * has nothing to await — so the permission check and the send run
 * fire-and-forget on the microtask queue. Gating is unchanged: the toast is
 * raised only when the OS has already granted permission. The product opt-in is
 * a separate, earlier gate — {@link osNotifyAllowed}, applied by the caller.
 */
export function osNotify(title: string, body: string): void {
  if (!osNotifySupported()) return;
  void (async () => {
    try {
      if ((await isPermissionGranted()) !== true) return;
      // Fire-and-forget; we don't hold a handle to the toast.
      sendNotification({ title, body });
    } catch {
      /* best-effort — never throw into the telemetry subscription */
    }
  })();
}
