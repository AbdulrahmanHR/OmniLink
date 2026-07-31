import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Telemetry-session CSV with a sustained RSSI dropout (rssi1/rssi2 ≤ −104 for
 * four frames after a healthy start, then recovery). Two independent subsystems
 * react to it, and BOTH feed the one notification center:
 *  - **M37 diagnostics** analyze the whole session on import, raising one critical
 *    `rssi-floor` finding (the primary antenna sat at the floor) → a "Signal
 *    diagnostic" notification the instant the log loads; and
 *  - **M26 live alerts** re-evaluate each frame as it is scrubbed through, so the
 *    default `signalLoss` trip (−100 dBm, 3-frame debounce) fires its transient
 *    toast and enqueues a "Low signal" notification when the cursor enters the
 *    dropout, then recovers — both verified in `notificationFeed`/store units.
 */
const DROPOUT_CSV = path.join(__dirname, "fixtures", "alert-dropout.csv");

test.describe("Notification center", () => {
  // Deterministic axe + exercise the prefers-reduced-motion panel path.
  test.use({ reducedMotion: "reduce" });

  test("import diagnostic + a scrubbed live alert both surface, persist, and clear", async ({
    page,
  }) => {
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", DROPOUT_CSV);

    // Session loaded → the scrubber (one position index) is available.
    const scrubber = page.getByTestId("logs-scrubber-input");
    await expect(scrubber).toBeVisible();
    const lastIndex = (await scrubber.getAttribute("max")) ?? "";

    // M37: analyzing the imported session surfaces its critical link finding in
    // the notification center immediately — before any frame is scrubbed, and
    // without any live-alert toast (that path only fires on a played/scrubbed
    // frame). So the badge reads exactly 1 from the import-time diagnostic.
    await expect(page.getByTestId("notification-badge")).toHaveText("1");
    await expect(page.getByTestId("live-alert-signalLoss")).toHaveCount(0);

    // Scrub INTO the dropout: seeking forward pushes the passed frames through
    // the SAME live-alert evaluation the connected stream uses, so signalLoss
    // fires — surfacing the live toast AND enqueuing a SECOND notification. (Arrow
    // keys advance the range one step at a time, the proven scrub idiom.)
    await scrubber.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(scrubber).toHaveValue("6");
    await expect(page.getByTestId("live-alert-signalLoss")).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toHaveText("2");

    // Scrub to the end: the link recovers, so the transient toast clears — but
    // BOTH notifications PERSIST in the center (the whole point of this slice).
    await page.keyboard.press("End");
    await expect(scrubber).toHaveValue(lastIndex);
    await expect(page.getByTestId("live-alert-signalLoss")).toHaveCount(0);
    await expect(page.getByTestId("notification-badge")).toHaveText("2");

    // Open the dropdown: it lists both notifications, newest-first.
    await page.getByTestId("notification-bell").click();
    const panel = page.getByTestId("notification-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("notification-item")).toHaveCount(2);
    // The live alert: title is the reused alerts.type key, body the reused
    // alerts.message key rendered with its params (proves i18n, not frozen copy).
    await expect(panel.getByText("Low signal", { exact: true })).toBeVisible();
    await expect(panel.getByText(/RSSI fell to/)).toBeVisible();
    // The import diagnostic: title resolved from the diagnostics.* namespace.
    await expect(panel.getByText("Signal diagnostic", { exact: true })).toBeVisible();

    // The open, focus-trapped panel is accessible.
    await expectNoSeriousA11y(page);

    // Per-item mark-read: clearing the unread items one at a time decrements the
    // badge, proving it tracks the live unread COUNT (not a boolean).
    await panel.getByTestId("notification-mark-read").first().click();
    await expect(page.getByTestId("notification-badge")).toHaveText("1");
    await panel.getByTestId("notification-mark-read").first().click();
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
    // Both items stay in the list (read), so clear-all is still available.
    await expect(panel.getByTestId("notification-item")).toHaveCount(2);

    // Clear all empties the center.
    await panel.getByTestId("notification-clear-all").click();
    await expect(panel.getByTestId("notification-item")).toHaveCount(0);
    await expect(panel.getByTestId("notification-empty")).toBeVisible();
  });
});

/**
 * OS notifications, delivered natively — and gated by the app (v3.0.3).
 *
 * The app no longer uses the webview's Notification API at all. It could never
 * be granted in the shipped app: WebKit first refused
 * `Notification.requestPermission()` outside a user gesture, and then — from a
 * genuine click on the genuine Settings button, on WebKitGTK 2.52.3 — denied it
 * outright with no prompt window ever shown, because wry installs no
 * `permission-request` handler. `src/lib/alertNotify.ts` now calls
 * `@tauri-apps/plugin-notification`, whose three commands reach the OS
 * natively.
 *
 * **That migration also deleted the opt-in, and this suite is where that is
 * caught.** The plugin's desktop backend answers `permission_state()` with
 * `Ok(PermissionState::Granted)` unconditionally
 * (`tauri-plugin-notification-2.3.3/src/desktop.rs:65-67`), so a
 * permission-driven UI is a gate that is always open: for one commit every
 * tripped alarm raised a real system popup on a fresh install, with nothing but
 * the master mute able to stop it — including alarms tripped by *scrubbing an
 * old log*, which reaches the same evaluation path as live telemetry. The
 * consent gate is now the app's own persisted `osNotifyEnabled`, defaulting
 * OFF like the audio alert beside it.
 *
 * Chromium can reproduce none of the engine defects, so what these specs pin is
 * the engine-independent shape of the design: **nothing asks until the operator
 * asks, and nothing fires until the operator opts in** — end to end, through a
 * real import and a real scrub, counting what actually reached the OS seam.
 *
 * ## Why the plugin is stubbed
 * There is no Tauri runtime in this runner, so the plugin's `invoke` has
 * nothing to call — and the headless Chromium `Notification` it would otherwise
 * fall back on reports `permission === "denied"` unconditionally (verified
 * directly; `context.grantPermissions()` does not move it), which would make
 * the `default` and `granted` branches unreachable.
 * {@link installNotificationPluginStub} therefore reproduces, before
 * navigation, exactly what registering `tauri_plugin_notification` does in the
 * real app: its `js_init_script` REPLACES `window.Notification` with a shim
 * whose constructor, `permission` getter and `requestPermission()` are backed
 * by the three `plugin:notification|*` IPC commands. Those commands are then
 * answered from one scripted state layered over {@link installTauriMock} — the
 * `installFolderSyncMock` idiom for a stateful seam.
 *
 * The app under test is unmodified, and the REAL plugin JS it imports runs
 * against that seam; only the Rust side's answers are scripted.
 */
test.describe("Desktop notification opt-in", () => {
  test.use({ reducedMotion: "reduce" });

  type PermissionState = "default" | "granted" | "denied";

  /**
   * Install the native notification seam. `initial` is the permission the OS
   * reports on load, `outcome` is what a request resolves to. Every
   * `request_permission` command is counted in `window.__permissionRequests`,
   * and every `notify` is recorded in `window.__sentNotifications`.
   *
   * Call AFTER {@link installTauriMock} (it wraps that mock's `invoke`) and
   * BEFORE navigation.
   */
  async function installNotificationPluginStub(
    page: Page,
    initial: PermissionState,
    outcome: PermissionState = "granted"
  ): Promise<void> {
    await page.addInitScript(
      ([start, result]) => {
        let state = start as PermissionState;
        const w = window as unknown as {
          __permissionRequests: number;
          __sentNotifications: unknown[];
        };
        w.__permissionRequests = 0;
        w.__sentNotifications = [];

        const internals = (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        const base = internals.invoke.bind(internals);

        // The Rust side. `is_permission_granted` answers `Option<bool>`:
        // true = granted, false = denied, null = still undecided.
        internals.invoke = async (cmd, args = {}) => {
          switch (cmd) {
            case "plugin:notification|is_permission_granted":
              return state === "default" ? null : state === "granted";
            case "plugin:notification|request_permission":
              w.__permissionRequests += 1;
              state = result as PermissionState;
              return state;
            case "plugin:notification|notify":
              w.__sentNotifications.push(args.options);
              return undefined;
            default:
              return base(cmd, args);
          }
        };

        // The injected `window.Notification` shim (src/init-iife.js in the
        // crate). The plugin's JS reads `.permission`, calls
        // `.requestPermission()` and constructs it — all three land on the IPC
        // above, never on the webview's own implementation.
        const shim = function (this: unknown, title: string, options?: object) {
          void internals.invoke("plugin:notification|notify", {
            options: Object.assign({}, options, { title }),
          });
        } as unknown as typeof Notification;
        shim.requestPermission = (() =>
          internals.invoke(
            "plugin:notification|request_permission"
          )) as typeof Notification.requestPermission;
        Object.defineProperty(shim, "permission", {
          configurable: true,
          enumerable: true,
          get: () => state,
        });
        window.Notification = shim;
      },
      [initial, outcome] as const
    );
  }

  /** How many permission requests this document has made so far. */
  const requests = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __permissionRequests: number })
          .__permissionRequests
    );

  /**
   * Everything that actually reached the OS seam in THIS document. The init
   * script re-runs on every navigation, so this always counts one page load.
   */
  const sent = (page: Page) =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __sentNotifications: Array<{ title?: string; body?: string }>;
          }
        ).__sentNotifications
    );

  /**
   * Import {@link DROPOUT_CSV} on Session Analysis and scrub the cursor into the
   * dropout, which trips the default `signalLoss` alarm through the SAME
   * evaluation path the connected stream uses. The scrubber only exists once a
   * session has loaded, so reaching frame 6 is itself the proof that the import
   * worked and frames were evaluated.
   */
  async function scrubIntoDropout(page: Page): Promise<void> {
    await uploadFile(page, "logs-import-input", DROPOUT_CSV);
    const scrubber = page.getByTestId("logs-scrubber-input");
    await expect(scrubber).toBeVisible();
    await scrubber.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
    await expect(scrubber).toHaveValue("6");
  }

  /**
   * The two in-app channels an unmuted trip drives: the transient toast and the
   * persisted center entry (2 = the import diagnostic + this alarm). Asserting
   * them is what makes a `sent` assertion meaningful — the alarm demonstrably
   * fired, so an empty send list is a gate holding, not a test that did nothing.
   */
  async function expectInAppAlertFired(page: Page): Promise<void> {
    await expect(page.getByTestId("live-alert-signalLoss")).toBeVisible();
    await expect(page.getByTestId("notification-badge")).toHaveText("2");
  }

  test("default OFF: a granted OS still sends NOTHING until the operator opts in", async ({
    page,
  }) => {
    // The regression guard for the v3.0.3 plugin migration. The OS reports
    // `granted` — which on a real desktop it ALWAYS does, unconditionally — and
    // a real alarm trips from a scrubbed log. Nothing may reach the OS.
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/analysis");

    await scrubIntoDropout(page);
    // In-app alerting is untouched — the toast is up and the center counted it.
    await expectInAppAlertFired(page);

    // The desktop popup is the one channel that stayed shut. Scrubbing an old
    // log on a laptop with no hardware attached must not raise system
    // notifications, and on desktop the OS will never say no on the app's behalf.
    expect(await sent(page)).toEqual([]);
    expect(await requests(page)).toBe(0);
  });

  test("opting in makes the same alarm fire a desktop notification", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/settings");

    // Flip the persisted opt-in, then run the identical scenario.
    await page.getByTestId("os-notify-toggle").click();
    await expect(page.getByTestId("os-notify-toggle")).toHaveAttribute(
      "aria-checked",
      "true"
    );

    await gotoApp(page, "/analysis");
    await scrubIntoDropout(page);
    await expectInAppAlertFired(page);

    // Exactly one send, carrying the same i18n title/body the toast and the
    // notification center render — one alarm, one popup, not one per frame.
    await expect
      .poll(async () => (await sent(page)).length, {
        message: "one desktop notification for the one tripped alarm",
      })
      .toBe(1);
    const [notification] = await sent(page);
    expect(notification.title).toBe("Low signal");
    expect(notification.body).toMatch(/RSSI fell to/);
  });

  test("mute beats the opt-in — an opted-in operator who mutes gets silence", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/settings");

    await page.getByTestId("os-notify-toggle").click();
    await expect(page.getByTestId("os-notify-toggle")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    // The master mute suppresses every channel, exactly as it does for the beep.
    const mute = page.getByRole("switch", { name: "Alerts active" });
    await mute.click();
    await expect(mute).toHaveAttribute("aria-checked", "false");

    await gotoApp(page, "/analysis");
    await scrubIntoDropout(page);

    // Muted, so EVERY channel is silent: no toast, and `recordFiredAlerts`
    // suppresses the center entry too (as it does the import diagnostic, which
    // is why the badge is absent rather than 1). Nothing reached the OS either.
    await expect(page.getByTestId("live-alert-signalLoss")).toHaveCount(0);
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
    expect(await sent(page)).toEqual([]);

    // Positive control, so the silence above cannot be a test that did nothing:
    // unmute — changing ONLY that flag, with the opt-in still on from before —
    // and the identical import + scrub sends exactly one.
    await gotoApp(page, "/settings");
    await page.getByRole("switch", { name: "Alerts active" }).click();
    await gotoApp(page, "/analysis");
    await scrubIntoDropout(page);
    await expectInAppAlertFired(page);
    await expect
      .poll(async () => (await sent(page)).length)
      .toBe(1);
  });

  test("the opt-in persists across a reload", async ({ page }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/settings");

    const toggle = page.getByTestId("os-notify-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await expect(page.locator("main")).toBeVisible();

    // It is a persisted preference, not per-session UI state: the operator
    // consents once. And it does not re-ask on the way back up.
    await expect(page.getByTestId("os-notify-toggle")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "also raises a desktop notification"
    );
    expect(await requests(page)).toBe(0);
  });

  test("never prompts on mount — the Settings opt-in is the only asker", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "default", "granted");
    await gotoApp(page, "/settings");

    // The always-mounted live-alert host (it owns the OS notification) is up and
    // the alerts card has rendered — and NOTHING has asked. This is the
    // regression guard for the defect: the old code asked from this mount.
    await expect(page.getByTestId("live-alert-host")).toBeAttached();
    const toggle = page.getByTestId("os-notify-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await requests(page)).toBe(0);

    // Turning it on → exactly one request, from that gesture, and the row
    // settles into the on state.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await requests(page)).toBe(1);
  });

  test("a platform that reports granted does not opt the operator in for them", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/settings");

    // Every real desktop lands here, because the plugin's desktop backend
    // returns `Granted` unconditionally. The row must therefore show the app's
    // own OFF state — not "Enabled" — and ask for nothing on the way there.
    await expect(page.getByTestId("os-notify-toggle")).toHaveAttribute(
      "aria-checked",
      "false"
    );
    await expect(page.getByTestId("os-notify-state")).toHaveCount(0);
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "Off by default"
    );
    expect(await requests(page)).toBe(0);
  });

  test("a denied OS is terminal: no re-prompt, and the row says why it is silent", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "denied");
    await gotoApp(page, "/settings");

    // Denied is final — the OS will not be asked again, so the app offers no
    // control that would nag, and explains the silence instead of dropping OS
    // notifications quietly. (No desktop platform answers this today; the
    // branch is kept for the mobile backend and any platform that gains a real
    // permission model.)
    await expect(page.getByTestId("os-notify-state")).toHaveText("Blocked");
    await expect(page.getByTestId("os-notify-toggle")).toHaveCount(0);
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "In-app alerts and the notification center still work"
    );
    expect(await requests(page)).toBe(0);

    await expectNoSeriousA11y(page);
  });

  test("outside the desktop app there is no native path, and nothing is asked", async ({
    page,
  }) => {
    // No Tauri mock at all — a plain browser, which is what `npm run dev` and
    // every un-mocked spec in this suite are. The feature must degrade to the
    // "unavailable here" branch rather than falling back to the webview API
    // that cannot work in production anyway.
    await gotoApp(page, "/settings");

    await expect(page.getByTestId("os-notify-state")).toHaveText("Unavailable");
    await expect(page.getByTestId("os-notify-toggle")).toHaveCount(0);
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "raised by the OmniLink desktop app"
    );
  });
});
