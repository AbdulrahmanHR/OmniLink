import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * OS-notification permission (v3.0.3 — the WebKit user-gesture defect).
 *
 * The first real Tauri/WebKitGTK run of the app printed, twice:
 *
 * ```
 * Notification prompting can only be done from a user gesture.
 *     ensureOsNotifyPermission — alertNotify.ts:25
 * ```
 *
 * WebKit (WebKitGTK on Linux, WKWebView on macOS — i.e. the engine the SHIPPED
 * app runs in) enforces the spec's user-gesture requirement that Chromium is lax
 * about, so the old mount-time `ensureOsNotifyPermission()` could never grant
 * permission in production while passing every Chromium-based test.
 *
 * These specs pin the fix from both ends:
 *  - **behavioural** — the module never prompts by itself (import, read, fire),
 *    a `granted`/`denied`/unsupported state never reaches `requestPermission()`
 *    at all, and the request survives both the modern promise form and the
 *    legacy callback-only form of `Notification.requestPermission`; and
 *  - **structural** — the ONE call site in `src/` is a click handler with no
 *    `await` in front of it, and the live-alert host (which mounts on every
 *    app launch) does not reference the permission API at all. A behavioural
 *    test cannot see that difference: the suite runs in Node with no DOM and no
 *    React renderer (see AGENTS.md § Testing), and "was it called from a
 *    gesture" is not observable from a mocked `Notification` either way.
 *
 * The module reads `window`/`Notification` through `globalThis` at call time, so
 * each spec installs its own pair and every spec re-imports the module fresh.
 */

/** Install a mock Notification API (and a `window`) for the current spec. */
function installNotification(
  permission: "default" | "granted" | "denied",
  requestPermission: unknown = vi.fn(() => Promise.resolve(permission))
): { ctor: ReturnType<typeof vi.fn>; instances: Array<[string, unknown]> } {
  const instances: Array<[string, unknown]> = [];
  const ctor = vi.fn(function (this: unknown, title: string, options: unknown) {
    instances.push([title, options]);
  });
  Object.assign(ctor, { permission, requestPermission });
  (globalThis as unknown as { window?: unknown }).window = {};
  (globalThis as unknown as { Notification?: unknown }).Notification = ctor;
  return { ctor: ctor as unknown as ReturnType<typeof vi.fn>, instances };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("osNotifyPermission — read-only, never prompts", () => {
  it("reports 'unsupported' with no window / no Notification API (headless)", async () => {
    const { osNotifyPermission } = await import("@/lib/alertNotify");
    expect(osNotifyPermission()).toBe("unsupported");
  });

  it("mirrors each engine state", async () => {
    for (const state of ["default", "granted", "denied"] as const) {
      installNotification(state);
      vi.resetModules();
      const { osNotifyPermission } = await import("@/lib/alertNotify");
      expect(osNotifyPermission()).toBe(state);
    }
  });

  it("never calls requestPermission just to read the state", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    installNotification("default", request);
    const { osNotifyPermission } = await import("@/lib/alertNotify");
    osNotifyPermission();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("the module never prompts on its own (the defect)", () => {
  it("importing it and firing a notification asks for NOTHING", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    const { instances } = installNotification("granted", request);

    const { osNotify, osNotifyPermission } = await import("@/lib/alertNotify");
    osNotifyPermission();
    osNotify("Low signal", "RSSI fell to -104 dBm");

    // The toast fired (permission was already granted) and no prompt was raised:
    // the whole point of the fix — nothing outside a gesture may request.
    expect(instances).toEqual([["Low signal", { body: "RSSI fell to -104 dBm" }]]);
    expect(request).not.toHaveBeenCalled();
  });

  it("firing while permission is 'default' still asks for nothing (and shows nothing)", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    const { instances } = installNotification("default", request);

    const { osNotify } = await import("@/lib/alertNotify");
    osNotify("Low signal", "body");

    expect(instances).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("requestOsNotifyPermission — the gesture path", () => {
  it("requests exactly once from a 'default' state and resolves the outcome", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    const { ctor } = installNotification("default", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");

    const result = await requestOsNotifyPermission();

    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toBe("granted");
    // The prompt is a request, not a notification: nothing was constructed.
    expect(ctor).not.toHaveBeenCalled();
  });

  it("resolves 'denied' when the user says no", async () => {
    const request = vi.fn(() => Promise.resolve("denied" as NotificationPermission));
    installNotification("default", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
  });

  it("does NOT re-prompt once denied — the state is terminal", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    installNotification("denied", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");

    // Even repeated clicks must not reach the engine: it would refuse anyway,
    // and the UI is expected to explain the block instead of nagging.
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
    await expect(requestOsNotifyPermission()).resolves.toBe("denied");
    expect(request).not.toHaveBeenCalled();
  });

  it("does NOT re-prompt once granted", async () => {
    const request = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    installNotification("granted", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");

    await expect(requestOsNotifyPermission()).resolves.toBe("granted");
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves 'unsupported' with no Notification API, without throwing", async () => {
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");
    await expect(requestOsNotifyPermission()).resolves.toBe("unsupported");
  });

  it("supports the LEGACY callback-only form (older WebKit returns undefined)", async () => {
    // Safari/WebKitGTK shipped `requestPermission(cb)` long before the promise
    // form; a build that returns `undefined` must still settle the UI.
    const ctorRef: { current?: { permission: string } } = {};
    const request = vi.fn((cb?: (p: NotificationPermission) => void) => {
      if (ctorRef.current) ctorRef.current.permission = "granted";
      cb?.("granted");
      return undefined;
    });
    const { ctor } = installNotification("default", request);
    ctorRef.current = ctor as unknown as { permission: string };

    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");
    await expect(requestOsNotifyPermission()).resolves.toBe("granted");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back to the engine's current state when the promise rejects", async () => {
    const request = vi.fn(() => Promise.reject(new Error("dismissed")));
    installNotification("default", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");
    // Nothing was granted, so the UI stays on the un-decided branch rather than
    // exploding into an unhandled rejection.
    await expect(requestOsNotifyPermission()).resolves.toBe("default");
  });

  it("swallows a THROWING requestPermission (never breaks the click handler)", async () => {
    const request = vi.fn(() => {
      throw new Error("boom");
    });
    installNotification("default", request);
    const { requestOsNotifyPermission } = await import("@/lib/alertNotify");
    await expect(requestOsNotifyPermission()).resolves.toBe("default");
  });
});

describe("osNotify — unchanged gating (no regression)", () => {
  it("fires only when permission is already granted", async () => {
    for (const state of ["default", "denied"] as const) {
      const { instances } = installNotification(state);
      vi.resetModules();
      const { osNotify } = await import("@/lib/alertNotify");
      osNotify("t", "b");
      expect(instances).toEqual([]);
    }
    const { instances } = installNotification("granted");
    vi.resetModules();
    const { osNotify } = await import("@/lib/alertNotify");
    osNotify("t", "b");
    expect(instances).toHaveLength(1);
  });

  it("never throws headless (no window at all)", async () => {
    const { osNotify } = await import("@/lib/alertNotify");
    expect(() => osNotify("t", "b")).not.toThrow();
  });

  it("swallows a constructor that throws", async () => {
    const ctor = vi.fn(() => {
      throw new Error("blocked by the OS");
    });
    Object.assign(ctor, { permission: "granted", requestPermission: vi.fn() });
    (globalThis as unknown as { window?: unknown }).window = {};
    (globalThis as unknown as { Notification?: unknown }).Notification = ctor;
    const { osNotify } = await import("@/lib/alertNotify");
    expect(() => osNotify("t", "b")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structural guard: WHERE the request is made
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
 * *explaining* why the mount-time request was deleted necessarily quotes
 * `Notification.requestPermission()`, and a scanner that cannot tell an
 * explanation from a call would fail on the documentation of its own fix. Block
 * comments (including JSX `{/* … *\/}`) and whole-line `//` comments go; code —
 * and any trailing comment on a code line — stays.
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

    const handlerAt = page.lastIndexOf("onClick={", at);
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = page.slice(handlerAt, at);

    // Nothing may run between the user event and the request: an `await` (or an
    // effect/timer hop) ends the task WebKit counts the gesture in.
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

  it("routes every raw `Notification.requestPermission` through the helper", () => {
    // A second, direct call site would be free to re-introduce the defect
    // (mount-time prompt, awaited prompt) without tripping any test above.
    const offenders = sourceFiles()
      .filter((f) => rel(f) !== "lib/alertNotify.ts")
      .filter((f) => /Notification\s*\.\s*requestPermission/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
