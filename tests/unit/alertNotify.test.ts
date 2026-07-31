import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OS-notification delivery (v3.0.3 — the native-plugin migration).
 *
 * Two defects were found on the engine the app actually ships in, in sequence:
 *
 *  1. `Notification.requestPermission()` was called from a mount effect, and
 *     WebKit (WebKitGTK on Linux, WKWebView on macOS) enforces the spec's
 *     user-gesture requirement that Chromium is lax about:
 *
 *     ```
 *     Notification prompting can only be done from a user gesture.
 *         ensureOsNotifyPermission — alertNotify.ts:25
 *     ```
 *
 *  2. Moving the request onto a genuine click did **not** fix it. On WebKitGTK
 *     2.52.3, from a real click on the real Settings button, permission went
 *     `default` -> `denied` in under 2.5 s with no prompt window ever shown —
 *     wry installs no `permission-request` handler, so the webview's default
 *     handler denies. The web Notification API is unobtainable in the shipped
 *     app however correctly it is called.
 *
 * So `alertNotify.ts` now speaks to `@tauri-apps/plugin-notification`, whose
 * three commands (`is_permission_granted`, `request_permission`, `notify`) go
 * to the OS natively and never touch the webview permission model.
 *
 * These specs pin the result from both ends:
 *  - **behavioural** — the module never prompts by itself (import, read, fire),
 *    a `granted`/`denied`/unsupported state never reaches `requestPermission()`
 *    at all, an undecidable answer still settles the UI, and a non-Tauri host
 *    degrades silently instead of throwing; and
 *  - **structural** — the ONE call site in `src/` is a click handler with no
 *    `await` in front of it, the live-alert host (which mounts on every app
 *    launch) does not reference the permission API at all, and NO source file —
 *    this module included — touches the web `Notification` global any more. A
 *    behavioural test cannot see those differences: the suite runs in Node with
 *    no DOM and no React renderer (see AGENTS.md § Testing), and "was it called
 *    from a gesture" is not observable from a mocked plugin either way.
 *
 * The plugin is mocked at the module boundary (the `tests/unit/updater.test.ts`
 * idiom) and the runtime probe — `"__TAURI_INTERNALS__" in window` — is driven
 * by installing/removing a fake `window`, so every state is reachable headless.
 */

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<unknown>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<(options: { title: string; body?: string }) => void>(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: plugin.isPermissionGranted,
  requestPermission: plugin.requestPermission,
  sendNotification: plugin.sendNotification,
}));

import {
  osNotify,
  osNotifyAllowed,
  osNotifyPermission,
  osNotifySupported,
  requestOsNotifyPermission,
} from "@/lib/alertNotify";

/**
 * Put the module in a Tauri runtime and script the plugin's answers.
 *
 * `granted` is what `is_permission_granted` reports — `true`/`false`/`null` for
 * granted/denied/undecided, exactly the `Option<bool>` the Rust command
 * returns. `outcome` is what a `request_permission` resolves to; requesting
 * also updates the reported state, as the real plugin's shim does.
 */
function installPlugin(
  granted: boolean | null,
  outcome: string = "granted"
): { sent: Array<{ title: string; body?: string }> } {
  const state = { granted };
  const sent: Array<{ title: string; body?: string }> = [];
  (globalThis as unknown as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {},
  };
  plugin.isPermissionGranted.mockImplementation(() =>
    Promise.resolve(state.granted)
  );
  plugin.requestPermission.mockImplementation(() => {
    if (outcome === "granted") state.granted = true;
    else if (outcome === "denied") state.granted = false;
    return Promise.resolve(outcome);
  });
  plugin.sendNotification.mockImplementation((options) => {
    sent.push(options);
  });
  return { sent };
}

/** Let the fire-and-forget chain inside `osNotify` settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  plugin.isPermissionGranted.mockReset();
  plugin.requestPermission.mockReset();
  plugin.sendNotification.mockReset();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("osNotifySupported — the runtime probe", () => {
  it("is false with no window at all (vitest/node)", () => {
    expect(osNotifySupported()).toBe(false);
  });

  it("is false in a plain browser — a webview global is not enough", () => {
    // The dev server and the Playwright runner both land here: `window` exists,
    // even `Notification` exists, but there is no native path to reach.
    (globalThis as unknown as { window?: unknown }).window = {
      Notification: class {},
    };
    expect(osNotifySupported()).toBe(false);
  });

  it("is true once the Tauri runtime has injected its internals", () => {
    installPlugin(true);
    expect(osNotifySupported()).toBe(true);
  });
});

describe("osNotifyPermission — read-only, never prompts", () => {
  it("reports 'unsupported' outside a Tauri runtime, without calling the plugin", async () => {
    await expect(osNotifyPermission()).resolves.toBe("unsupported");
    expect(plugin.isPermissionGranted).not.toHaveBeenCalled();
  });

  it("mirrors each state the OS can report", async () => {
    for (const [reported, expected] of [
      [true, "granted"],
      [false, "denied"],
      [null, "default"],
    ] as const) {
      installPlugin(reported);
      await expect(osNotifyPermission()).resolves.toBe(expected);
    }
  });

  it("reports 'unsupported' when the IPC itself fails, without throwing", async () => {
    installPlugin(null);
    plugin.isPermissionGranted.mockRejectedValue(new Error("no such command"));
    await expect(osNotifyPermission()).resolves.toBe("unsupported");
  });

  it("never calls requestPermission just to read the state", async () => {
    installPlugin(null);
    await osNotifyPermission();
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });
});

describe("the module never prompts on its own (the defect)", () => {
  it("importing it and firing a notification asks for NOTHING", async () => {
    const { sent } = installPlugin(true);

    await osNotifyPermission();
    osNotify("Low signal", "RSSI fell to -104 dBm");
    await flush();

    // The toast fired (permission was already granted) and no prompt was raised:
    // the whole point of the fix — nothing outside the opt-in may request.
    expect(sent).toEqual([{ title: "Low signal", body: "RSSI fell to -104 dBm" }]);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("firing while permission is undecided still asks for nothing (and shows nothing)", async () => {
    const { sent } = installPlugin(null);

    osNotify("Low signal", "body");
    await flush();

    expect(sent).toEqual([]);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });
});

describe("requestOsNotifyPermission — the gesture path", () => {
  it("requests exactly once from an undecided state and resolves the outcome", async () => {
    installPlugin(null, "granted");

    await expect(requestOsNotifyPermission()).resolves.toBe("granted");

    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    // The prompt is a request, not a notification: nothing was sent.
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("resolves 'denied' when the user says no", async () => {
    installPlugin(null, "denied");
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
  });

  it("does NOT re-prompt once denied — the state is terminal", async () => {
    installPlugin(false);

    // Even repeated clicks must not reach the OS: it would refuse anyway, and
    // the UI is expected to explain the block instead of nagging.
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("does NOT re-prompt once granted", async () => {
    installPlugin(true);

    await expect(requestOsNotifyPermission()).resolves.toBe("granted");
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("resolves 'unsupported' outside a Tauri runtime, without throwing or asking", async () => {
    await expect(requestOsNotifyPermission()).resolves.toBe("unsupported");
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("settles the UI on a PROMPT-shaped answer (the non-DOM PermissionState arms)", async () => {
    // `request_permission` returns a Tauri `PermissionState`, whose `prompt` and
    // `prompt-with-rationale` arms are outside the DOM `NotificationPermission`
    // union the plugin's own types declare. Both mean "still undecided" — they
    // must NOT be mistaken for a refusal, and must not hang the row either.
    for (const answer of ["prompt", "prompt-with-rationale"]) {
      installPlugin(null, answer);
      await expect(requestOsNotifyPermission()).resolves.toBe("default");
      expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
      plugin.requestPermission.mockReset();
    }
  });

  it("falls back to the OS's current state when the request rejects", async () => {
    installPlugin(null);
    plugin.requestPermission.mockRejectedValue(new Error("dismissed"));
    // Nothing was granted, so the UI stays on the un-decided branch rather than
    // exploding into an unhandled rejection.
    await expect(requestOsNotifyPermission()).resolves.toBe("default");
  });

  it("swallows a THROWING requestPermission (never breaks the click handler)", async () => {
    installPlugin(null);
    plugin.requestPermission.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(requestOsNotifyPermission()).resolves.toBe("default");
  });
});

describe("osNotify — unchanged gating (no regression)", () => {
  it("fires only when permission is already granted", async () => {
    for (const reported of [null, false] as const) {
      const { sent } = installPlugin(reported);
      osNotify("t", "b");
      await flush();
      expect(sent).toEqual([]);
    }
    const { sent } = installPlugin(true);
    osNotify("t", "b");
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("sends the SAME payload shape the web API carried: title + body", async () => {
    const { sent } = installPlugin(true);
    osNotify("Failsafe", "Link lost for 3 frames");
    await flush();
    expect(sent).toEqual([{ title: "Failsafe", body: "Link lost for 3 frames" }]);
  });

  it("never throws — and sends nothing — outside a Tauri runtime", async () => {
    expect(() => osNotify("t", "b")).not.toThrow();
    await flush();
    expect(plugin.isPermissionGranted).not.toHaveBeenCalled();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("swallows a send that throws", async () => {
    installPlugin(true);
    plugin.sendNotification.mockImplementation(() => {
      throw new Error("blocked by the OS");
    });
    expect(() => osNotify("t", "b")).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });

  it("swallows a permission read that rejects", async () => {
    installPlugin(true);
    plugin.isPermissionGranted.mockRejectedValue(new Error("ipc down"));
    expect(() => osNotify("t", "b")).not.toThrow();
    await flush();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("osNotifyAllowed — the product opt-in, since the OS is not one", () => {
  // The plugin's desktop backend returns `Ok(PermissionState::Granted)` from
  // BOTH `permission_state()` and `request_permission()`
  // (tauri-plugin-notification-2.3.3/src/desktop.rs:65-67), so asking the
  // platform gates on nothing: every desktop user reads as granted, always.
  // The persisted `osNotifyEnabled` flag is the real consent gate, and mute
  // still overrides it exactly as it does the toast and the beep.
  it("allows the notification ONLY when opted in and not muted", () => {
    expect(osNotifyAllowed({ osNotifyEnabled: true, muted: false })).toBe(true);
  });

  it("blocks it in every other combination", () => {
    expect(osNotifyAllowed({ osNotifyEnabled: false, muted: false })).toBe(false);
    expect(osNotifyAllowed({ osNotifyEnabled: true, muted: true })).toBe(false);
    expect(osNotifyAllowed({ osNotifyEnabled: false, muted: true })).toBe(false);
  });

  it("mirrors maybePlayAlertSound: mute beats an explicit opt-in", () => {
    // Same rule as the audio alert, so the two rows in the settings card behave
    // identically — turning the feature on does not survive the master mute.
    expect(osNotifyAllowed({ osNotifyEnabled: true, muted: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural guard: WHERE the request is made, and WHAT delivers it
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../src");

/** Every `.ts`/`.tsx` file under `src/`, as repo-relative paths. */
function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Read a source file with its comments removed.
 *
 * Same reasoning as `ciForkSafety.test.ts`'s YAML comment strip: the prose
 * *explaining* why the mount-time request was deleted, and why the web API was
 * abandoned, necessarily quotes `Notification.requestPermission()`, and a
 * scanner that cannot tell an explanation from a call would fail on the
 * documentation of its own fix. Block comments (including JSX `{/* … *\/}`) and
 * whole-line `//` comments go; code — and any trailing comment on a code line —
 * stays.
 */
function read(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

describe("permission is requested ONLY from a user gesture (structural)", () => {
  it("has exactly one call site outside the helper module: the Settings opt-in", () => {
    const callers = sourceFiles()
      .filter((f) => rel(f) !== "lib/alertNotify.ts")
      .filter((f) => /\brequestOsNotifyPermission\s*\(/.test(read(f)))
      .map(rel)
      .sort();
    expect(callers).toEqual(["pages/SettingsPage.tsx"]);
  });

  it("that call site is a click handler, with no `await` before the request", () => {
    const page = read(path.join(SRC, "pages/SettingsPage.tsx"));
    const at = page.indexOf("requestOsNotifyPermission(");
    expect(at).toBeGreaterThan(-1);

    // The opt-in is a toggle rather than an "Enable" button since v3.0.3 (the
    // OS grants unconditionally, so the app owns the consent), which means the
    // gesture arrives as the switch's `onChange` instead of a raw `onClick`.
    // Either is a real user event; what this pins is that the request is the
    // first thing it does.
    const handlerAt = Math.max(
      page.lastIndexOf("onClick={", at),
      page.lastIndexOf("onChange={", at)
    );
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = page.slice(handlerAt, at);

    // Nothing may run between the user event and the request. The native plugin
    // no longer enforces this, but "never ask outside a deliberate opt-in" is
    // the product rule, and an effect/timer hop is exactly how it gets lost.
    expect(handler).not.toMatch(/\bawait\b/);
    expect(handler).not.toMatch(/setTimeout|requestAnimationFrame|useEffect/);
    expect(at - handlerAt).toBeLessThan(200);
  });

  it("the always-mounted live-alert host touches no permission API", () => {
    // `LiveAlertHost` mounts once in `AppShell` on every launch — the exact
    // place the defective request used to live.
    const host = read(path.join(SRC, "components/alerts/LiveAlertHost.tsx"));
    expect(host).not.toMatch(/ensureOsNotifyPermission/);
    expect(host).not.toMatch(/requestOsNotifyPermission/);
    expect(host).not.toMatch(/requestPermission/);
  });

  it("no source file requests permission from an effect or a timer", () => {
    const offenders = sourceFiles()
      .filter((f) => rel(f) !== "lib/alertNotify.ts")
      .filter((f) => {
        const text = read(f);
        return /(useEffect|setTimeout|setInterval|queueMicrotask)\s*\([^)]*requestOsNotifyPermission/.test(
          text
        );
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("OS notifications are delivered NATIVELY, not by the webview (structural)", () => {
  it("the helper drives the Tauri plugin and nothing else", () => {
    const helper = read(path.join(SRC, "lib/alertNotify.ts"));
    expect(helper).toMatch(
      /from\s+"@tauri-apps\/plugin-notification"/
    );
    // The three plugin entry points, and no fourth: the ACL grants exactly the
    // commands behind these (see `src-tauri/capabilities/default.json`).
    for (const api of ["isPermissionGranted", "requestPermission", "sendNotification"]) {
      expect(helper).toContain(api);
    }
  });

  it("NO source file — the helper included — uses the web Notification global", () => {
    // The web API is not merely wrong to call from the wrong place: on the
    // engines this app ships in, it can never be granted at all. A second,
    // direct call site would silently re-introduce a channel that is dead in
    // production while passing every Chromium-based test.
    const offenders = sourceFiles()
      .filter((f) => {
        const text = read(f);
        return (
          /\bNotification\s*\.\s*(requestPermission|permission)\b/.test(text) ||
          /\bnew\s+Notification\s*\(/.test(text)
        );
      })
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });
});
