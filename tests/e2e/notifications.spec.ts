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
 * OS notifications, delivered natively (v3.0.3).
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
 * Chromium can reproduce none of that, so what these specs pin is the
 * engine-independent shape of the design: **nothing asks until a click asks**,
 * the click is the only asker, and each already-decided state renders its own
 * terminal branch instead of re-prompting.
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
test.describe("Desktop notification permission", () => {
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

  test("never prompts on mount — the Settings opt-in click is the only asker", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "default", "granted");
    await gotoApp(page, "/settings");

    // The always-mounted live-alert host (it owns the OS notification) is up and
    // the alerts card has rendered — and NOTHING has asked. This is the
    // regression guard for the defect: the old code asked from this mount.
    await expect(page.getByTestId("live-alert-host")).toBeAttached();
    const enable = page.getByTestId("os-notify-enable");
    await expect(enable).toBeVisible();
    expect(await requests(page)).toBe(0);

    // One click → exactly one request, and the row settles into the granted
    // state with no button left to click.
    await enable.click();
    await expect(page.getByTestId("os-notify-state")).toHaveText("Enabled");
    await expect(enable).toHaveCount(0);
    expect(await requests(page)).toBe(1);
  });

  test("a denied OS is terminal: no re-prompt, and the row says why it is silent", async ({
    page,
  }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "denied");
    await gotoApp(page, "/settings");

    // Denied is final — the OS will not be asked again, so the app offers no
    // button that would nag, and explains the silence instead of dropping OS
    // notifications quietly.
    await expect(page.getByTestId("os-notify-state")).toHaveText("Blocked");
    await expect(page.getByTestId("os-notify-enable")).toHaveCount(0);
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "In-app alerts and the notification center still work"
    );
    expect(await requests(page)).toBe(0);

    await expectNoSeriousA11y(page);
  });

  test("an already-granted permission is never re-requested", async ({ page }) => {
    await installTauriMock(page, {});
    await installNotificationPluginStub(page, "granted");
    await gotoApp(page, "/settings");

    // The returning user whose permission predates this release: the row
    // reflects it, offers no button, and asks for nothing.
    await expect(page.getByTestId("os-notify-state")).toHaveText("Enabled");
    await expect(page.getByTestId("os-notify-enable")).toHaveCount(0);
    expect(await requests(page)).toBe(0);
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
    await expect(page.getByTestId("os-notify-enable")).toHaveCount(0);
    await expect(page.getByTestId("os-notify-hint")).toContainText(
      "raised by the OmniLink desktop app"
    );
  });
});
