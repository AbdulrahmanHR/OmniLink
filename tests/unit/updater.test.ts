import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase-machine coverage for the in-app self-update controller (M22).
 *
 * The Settings → App Update card is a thin view over `createUpdaterController`
 * (`src/lib/updater.ts`), so the phase transitions are asserted here headlessly
 * with the Tauri updater/process plugins mocked — no Tauri runtime, no DOM.
 *
 * Transitions exercised (driven by the mocked updater download events):
 *   idle → checking → upToDate
 *   idle → checking → available → downloading → ready (+ relaunch)
 *   idle → checking → error               (a genuine failure)
 *   idle → checking → notConfigured       (non-Tauri host / updater not wired)
 */

// Controllable Tauri seam. `isTauriValue` toggles the dev/non-Tauri guard;
// `check`/`relaunch` are driven per-test (mirrors tests/unit/profiles.test.ts).
const updater = vi.hoisted(() => ({ check: vi.fn() }));
const proc = vi.hoisted(() => ({ relaunch: vi.fn(() => Promise.resolve()) }));
const core = vi.hoisted(() => ({ isTauriValue: true }));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: proc.relaunch }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => core.isTauriValue }));

import {
  createUpdaterController,
  initialUpdaterState,
  isUpdaterUnavailable,
  type UpdatePhase,
  type UpdaterState,
} from "@/lib/updater";

beforeEach(() => {
  vi.clearAllMocks();
  core.isTauriValue = true;
});

/** A fake `Update` whose `downloadAndInstall` replays the given events. */
function fakeUpdate(
  events: Array<
    | { event: "Started"; data: { contentLength?: number } }
    | { event: "Progress"; data: { chunkLength: number } }
    | { event: "Finished" }
  > = [
    { event: "Started", data: { contentLength: 100 } },
    { event: "Progress", data: { chunkLength: 40 } },
    { event: "Progress", data: { chunkLength: 60 } },
    { event: "Finished" },
  ]
) {
  return {
    version: "1.6.1",
    date: "2026-06-24",
    body: "Release notes",
    downloadAndInstall: vi.fn(
      async (onEvent: (e: (typeof events)[number]) => void) => {
        for (const e of events) onEvent(e);
      }
    ),
  };
}

/** Build a controller that records every emitted state. */
function recordingController() {
  const states: UpdaterState[] = [];
  const controller = createUpdaterController((s) => states.push(s));
  return { controller, states };
}

/** Consecutive-dedup of the phase column — the human-readable transition path. */
function phasePath(states: UpdaterState[]): UpdatePhase[] {
  const path: UpdatePhase[] = [];
  for (const s of states) {
    if (path[path.length - 1] !== s.phase) path.push(s.phase);
  }
  return path;
}

describe("createUpdaterController", () => {
  it("starts idle", () => {
    expect(initialUpdaterState.phase).toBe("idle");
    const { controller } = recordingController();
    expect(controller.getState().phase).toBe("idle");
  });

  it("idle → checking → upToDate when no newer release", async () => {
    updater.check.mockResolvedValueOnce(null);
    const { controller, states } = recordingController();

    await controller.checkForUpdates();

    expect(phasePath(states)).toEqual(["checking", "upToDate"]);
    expect(controller.getState().update).toBeNull();
  });

  it("idle → checking → available, then available → downloading → ready", async () => {
    const update = fakeUpdate();
    updater.check.mockResolvedValueOnce(update);
    const { controller, states } = recordingController();

    await controller.checkForUpdates();
    expect(phasePath(states)).toEqual(["checking", "available"]);
    expect(controller.getState().update).toBe(update);

    await controller.installAndRestart();

    expect(phasePath(states)).toEqual([
      "checking",
      "available",
      "downloading",
      "ready",
    ]);
    // Progress was driven from the Started/Progress/Finished events.
    const progresses = states
      .filter((s) => s.phase === "downloading")
      .map((s) => s.progress);
    expect(progresses).toContain(40);
    expect(progresses).toContain(100);
    expect(controller.getState().progress).toBe(100);
    // Relaunch only fires once the bundle is verified + installed.
    expect(proc.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch and lands on error if download fails", async () => {
    const update = fakeUpdate();
    update.downloadAndInstall.mockRejectedValueOnce(new Error("disk full"));
    updater.check.mockResolvedValueOnce(update);
    const { controller, states } = recordingController();

    await controller.checkForUpdates();
    await controller.installAndRestart();

    expect(phasePath(states)).toEqual([
      "checking",
      "available",
      "downloading",
      "error",
    ]);
    expect(controller.getState().error).toBe("disk full");
    expect(proc.relaunch).not.toHaveBeenCalled();
  });

  it("idle → checking → error on a genuine check() failure", async () => {
    updater.check.mockRejectedValueOnce(new Error("Network request failed"));
    const { controller, states } = recordingController();

    await controller.checkForUpdates();

    expect(phasePath(states)).toEqual(["checking", "error"]);
    expect(controller.getState().error).toBe("Network request failed");
  });

  it("idle → checking → notConfigured on a non-Tauri host (never calls check)", async () => {
    core.isTauriValue = false;
    const { controller, states } = recordingController();

    await controller.checkForUpdates();

    expect(phasePath(states)).toEqual(["checking", "notConfigured"]);
    expect(updater.check).not.toHaveBeenCalled();
  });

  it("routes an 'updater not wired' error to notConfigured, not error", async () => {
    // Verbatim `tauri-plugin-updater` 2.10.1 `Error::EmptyEndpoints`.
    updater.check.mockRejectedValueOnce(
      new Error("Updater does not have any endpoints set.")
    );
    const { controller, states } = recordingController();

    await controller.checkForUpdates();

    expect(phasePath(states)).toEqual(["checking", "notConfigured"]);
  });

  it("routes an unregistered-plugin invoke error to notConfigured, not error", async () => {
    // An installed build that took the non-desktop `cfg` branch in `lib.rs`
    // never registers the plugin, so the invoke is rejected before it reaches
    // the updater crate at all. This used to land in the red `error` state.
    updater.check.mockRejectedValueOnce(new Error("plugin updater not found"));
    const { controller, states } = recordingController();

    await controller.checkForUpdates();

    expect(phasePath(states)).toEqual(["checking", "notConfigured"]);
  });
});

describe("isUpdaterUnavailable", () => {
  it("flags the empty-endpoints failure the updater crate actually emits", () => {
    // `tauri-plugin-updater` 2.10.1, `Error::EmptyEndpoints`.
    expect(
      isUpdaterUnavailable(new Error("Updater does not have any endpoints set."))
    ).toBe(true);
    // Case-insensitive, and tolerant of the plugin's message being wrapped.
    expect(
      isUpdaterUnavailable("updater does not have any endpoints set.")
    ).toBe(true);
  });

  it("flags a missing-command / unregistered-plugin invoke rejection", () => {
    // `tauri` 2.11.3 `PluginStore::extend_api` when "updater" is not registered.
    expect(isUpdaterUnavailable(new Error("plugin updater not found"))).toBe(
      true
    );
    // …and the generic `Command {cmd} not found` shape, targeted at the updater.
    expect(
      isUpdaterUnavailable(new Error("Command plugin:updater|check not found"))
    ).toBe(true);
    expect(
      isUpdaterUnavailable(
        new Error("Command plugin:updater|download_and_install not found")
      )
    ).toBe(true);
  });

  it("treats a transient network failure as a genuine, actionable error", () => {
    // `Error::Network(String)` wrapping a reqwest failure — retrying is the fix,
    // so this must NOT be muted as "auto-update unavailable in this build".
    expect(
      isUpdaterUnavailable(
        new Error(
          "error sending request for url (https://github.com/AbdulrahmanHR/OmniLink/releases/latest/download/latest.json): operation timed out"
        )
      )
    ).toBe(false);
    // `Error::ReleaseNotFound` — the feed was reached but served nothing usable.
    expect(
      isUpdaterUnavailable(
        new Error("Could not fetch a valid release JSON from the remote")
      )
    ).toBe(false);
    expect(isUpdaterUnavailable(new Error("Network request failed"))).toBe(
      false
    );
    expect(
      isUpdaterUnavailable(new Error("signature verification failed"))
    ).toBe(false);
  });

  it("no longer swallows real failures via over-broad substrings", () => {
    // The old list matched bare "endpoints" / "not configured" / "updater not",
    // so genuine, actionable failures were shown as the calm "unavailable" card.
    expect(
      isUpdaterUnavailable(
        new Error("TLS handshake failed for one of the configured endpoints")
      )
    ).toBe(false);
    expect(
      isUpdaterUnavailable(new Error("proxy is not configured correctly"))
    ).toBe(false);
    // `Error::InsecureTransportProtocol` — a real misconfiguration the packager
    // must fix, and it must not be filed under "nothing to see here" either.
    expect(
      isUpdaterUnavailable(
        new Error(
          "The configured updater endpoint must use a secure protocol like `https`."
        )
      )
    ).toBe(false);
  });
});
