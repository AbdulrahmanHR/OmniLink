import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Listener-lifecycle coverage for the WiFi discovery store (M18).
 *
 * `stores/wifi.ts` mirrors `stores/device.ts` registration-for-registration, so
 * it carried the same two defects verbatim:
 *  - CONN-8: `Promise.all` over three `listen()` calls discards the handles that
 *    DID resolve when a later one rejects — never collected, never called — and
 *    the `.catch` then resets the guard, so the next `init()` registers a SECOND
 *    copy of each survivor;
 *  - CONN-9: the cached promise outlived its own dispose, so a re-mount got back
 *    an already-spent cleanup and the app silently stopped receiving `wifi://*`.
 */

const tauri = vi.hoisted(() => ({
  // Callbacks are captured (not just counted) so a test can drive the real
  // registered handler exactly as a `wifi://*` event would.
  onWifiDiscovered: vi.fn((_cb: (d: unknown) => void) =>
    Promise.resolve(() => {})
  ),
  onWifiScanError: vi.fn((_cb: (p: unknown) => void) =>
    Promise.resolve(() => {})
  ),
  onWifiScanComplete: vi.fn((_cb: (generation: number) => void) =>
    Promise.resolve(() => {})
  ),
  startWifiScan: vi.fn(() => Promise.resolve()),
  stopWifiScan: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  onWifiDiscovered: tauri.onWifiDiscovered,
  onWifiScanError: tauri.onWifiScanError,
  onWifiScanComplete: tauri.onWifiScanComplete,
  startWifiScan: tauri.startWifiScan,
  stopWifiScan: tauri.stopWifiScan,
}));

// Fresh module per test so the module-level guard + refcount reset.
async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/wifi");
  return mod.useWifiStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useWifiStore.init", () => {
  it("resolves to a no-op cleanup when the event bridge rejects", async () => {
    tauri.onWifiDiscovered.mockRejectedValueOnce(
      new Error("transformCallback is not a function")
    );

    const useWifiStore = await loadStore();
    const dispose = await useWifiStore.getState().init();

    expect(dispose).toBeTypeOf("function");
    expect(() => dispose()).not.toThrow();
  });

  it("returns a cleanup that removes all registered listeners", async () => {
    const un = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(un);
    tauri.onWifiScanError.mockResolvedValueOnce(un);
    tauri.onWifiScanComplete.mockResolvedValueOnce(un);

    const useWifiStore = await loadStore();
    const dispose = await useWifiStore.getState().init();
    dispose();

    expect(un).toHaveBeenCalledTimes(3);
  });

  it("unlistens the handlers that DID register when a later listen() rejects", async () => {
    const unDiscovered = vi.fn();
    const unComplete = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(unDiscovered);
    tauri.onWifiScanError.mockRejectedValueOnce(new Error("bridge down"));
    tauri.onWifiScanComplete.mockResolvedValueOnce(unComplete);

    const useWifiStore = await loadStore();
    const dispose = await useWifiStore.getState().init();

    // CONN-8: these two used to leak — registered, then dropped on the floor.
    expect(unDiscovered).toHaveBeenCalledTimes(1);
    expect(unComplete).toHaveBeenCalledTimes(1);
    expect(() => dispose()).not.toThrow();
    expect(unDiscovered).toHaveBeenCalledTimes(1);
  });

  it("does not double-register the survivors when the retry succeeds", async () => {
    const leaked = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(leaked);
    tauri.onWifiScanError.mockRejectedValueOnce(new Error("bridge down"));
    tauri.onWifiScanComplete.mockResolvedValueOnce(leaked);

    const useWifiStore = await loadStore();
    await useWifiStore.getState().init();
    expect(leaked).toHaveBeenCalledTimes(2);

    const fresh = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(fresh);
    tauri.onWifiScanError.mockResolvedValueOnce(fresh);
    tauri.onWifiScanComplete.mockResolvedValueOnce(fresh);
    const dispose = await useWifiStore.getState().init();
    dispose();

    expect(fresh).toHaveBeenCalledTimes(3);
    expect(leaked).toHaveBeenCalledTimes(2);
  });

  it("re-registers after its own dispose instead of handing back a spent cleanup", async () => {
    const first = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(first);
    tauri.onWifiScanError.mockResolvedValueOnce(first);
    tauri.onWifiScanComplete.mockResolvedValueOnce(first);

    const useWifiStore = await loadStore();
    const disposeFirst = await useWifiStore.getState().init();
    disposeFirst();
    expect(first).toHaveBeenCalledTimes(3);

    const second = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(second);
    tauri.onWifiScanError.mockResolvedValueOnce(second);
    tauri.onWifiScanComplete.mockResolvedValueOnce(second);
    const disposeSecond = await useWifiStore.getState().init();

    expect(tauri.onWifiDiscovered).toHaveBeenCalledTimes(2);
    // The re-mounted app really is listening again.
    const onDiscovered = tauri.onWifiDiscovered.mock.calls[1][0];
    onDiscovered({
      id: "elrs-rx",
      name: "ELRS RX",
      address: "10.0.0.1",
      source: "ap",
      kind: "rx",
    });
    expect(useWifiStore.getState().discovered).toHaveLength(1);

    disposeSecond();
    expect(second).toHaveBeenCalledTimes(3);
    expect(first).toHaveBeenCalledTimes(3);
  });

  it("keeps the listeners while a second init() still holds them", async () => {
    // React StrictMode double-mounts call init() twice before either dispose.
    const un = vi.fn();
    tauri.onWifiDiscovered.mockResolvedValueOnce(un);
    tauri.onWifiScanError.mockResolvedValueOnce(un);
    tauri.onWifiScanComplete.mockResolvedValueOnce(un);

    const useWifiStore = await loadStore();
    const disposeA = await useWifiStore.getState().init();
    const disposeB = await useWifiStore.getState().init();

    expect(tauri.onWifiDiscovered).toHaveBeenCalledTimes(1);
    disposeA();
    disposeA(); // idempotent — must not consume the other holder's ref
    expect(un).not.toHaveBeenCalled();

    disposeB();
    expect(un).toHaveBeenCalledTimes(3);
  });
});
