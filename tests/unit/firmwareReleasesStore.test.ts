import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareReleaseList } from "@/lib/tauri";

/**
 * FWCHK-2: the version reconcile lived in a component that can unmount first.
 *
 * The firmware grid is filled from the BUNDLED catalogue while the live GitHub
 * fetch is in flight, so a tag picked in that window can simply vanish when the
 * live releases land. `reconcileSelectedVersion` is the (pure, already tested)
 * rule that moves the selection back onto the rendered list — but it ran in a
 * `useEffect` on StepFrequency, which unmounts the moment the user navigates.
 * Pick a bundled tag while the fetch is running, click Next twice before it
 * resolves, and the reconcile never happened at all: the stale tag travelled
 * into the flash request and 404'd on an artifact that had aged out, which is
 * the exact failure it was added to prevent.
 *
 * It now runs where the release list LANDS. Nothing in this file renders a
 * component — that is the whole point.
 */

const tauri = vi.hoisted(() => ({
  fetchFirmwareReleases: vi.fn(),
  releaseFetchReason: vi.fn(() => "offline"),
  // The wizard store (imported for the selection) pulls in the flash + device
  // seams; they only have to exist for the module graph to link.
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve("cancelled")),
  saveProfile: vi.fn(() => Promise.resolve()),
  onFlashProgress: vi.fn(() => Promise.resolve(() => {})),
  onFlashLog: vi.fn(() => Promise.resolve(() => {})),
  onFlashDone: vi.fn(() => Promise.resolve(() => {})),
  onFlashError: vi.fn(() => Promise.resolve(() => {})),
  onFlashCancelled: vi.fn(() => Promise.resolve(() => {})),
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve(1)),
  disconnectDevice: vi.fn(() => Promise.resolve(1)),
  onDeviceConnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/lib/tauri", () => tauri);

/** Fresh module graph per test — the store caches its in-flight fetch. */
async function loadStores() {
  vi.resetModules();
  const wizard = await import("@/stores/wizard");
  const releases = await import("@/stores/firmwareReleases");
  return {
    useWizardStore: wizard.useWizardStore,
    useFirmwareReleasesStore: releases.useFirmwareReleasesStore,
  };
}

/** A model whose bundled catalogue list is `["3.5.3","3.5.2","3.4.3","3.3.0"]`. */
const BRAND = "betafpv";
const MODEL = "betafpv-nano-tx-2400";

function release(tag: string, prerelease = false) {
  return { tag, name: tag, changelog: "", publishedAt: "", prerelease };
}

/** What GitHub actually has today: 3.3.0 has aged out of the release list. */
const LIVE: FirmwareReleaseList = {
  releases: [release("3.6.0-RC1", true), release("3.5.3"), release("3.5.2")],
  stale: false,
  fetchedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFirmwareReleasesStore — reconcile where the list lands", () => {
  it("moves a stale bundled tag onto the live list with no step mounted", async () => {
    const { useWizardStore, useFirmwareReleasesStore } = await loadStores();
    // The state the user leaves behind by clicking Next before the fetch lands.
    useWizardStore.getState().selectBrand(BRAND);
    useWizardStore.getState().selectModel(MODEL);
    useWizardStore.getState().selectFirmware("3.3.0");
    useWizardStore.getState().goToStep("frequency");
    tauri.fetchFirmwareReleases.mockResolvedValueOnce(LIVE);

    await useFirmwareReleasesStore.getState().load();

    // The highest STABLE live tag — never the RC, which is opt-in (FWCHK-2).
    expect(useWizardStore.getState().firmwareVersion).toBe("3.5.3");
  });

  it("leaves a tag the live list still offers exactly where it was", async () => {
    const { useWizardStore, useFirmwareReleasesStore } = await loadStores();
    useWizardStore.getState().selectBrand(BRAND);
    useWizardStore.getState().selectModel(MODEL);
    useWizardStore.getState().selectFirmware("3.5.2");
    tauri.fetchFirmwareReleases.mockResolvedValueOnce(LIVE);

    await useFirmwareReleasesStore.getState().load();

    expect(useWizardStore.getState().firmwareVersion).toBe("3.5.2");
  });

  it("never touches a local-file firmware source", async () => {
    const { useWizardStore, useFirmwareReleasesStore } = await loadStores();
    useWizardStore.getState().selectBrand(BRAND);
    useWizardStore.getState().selectModel(MODEL);
    // M25: the two sources are mutually exclusive, so a null version means the
    // user is flashing a `.bin` — reconciling would silently discard it.
    useWizardStore.getState().selectLocalFirmware("/tmp/BETAFPV_2400_TX.bin");
    tauri.fetchFirmwareReleases.mockResolvedValueOnce(LIVE);

    await useFirmwareReleasesStore.getState().load();

    expect(useWizardStore.getState().firmwareVersion).toBeNull();
    expect(useWizardStore.getState().localFirmwarePath).toBe(
      "/tmp/BETAFPV_2400_TX.bin"
    );
  });

  it("leaves the selection alone when the fetch fails", async () => {
    const { useWizardStore, useFirmwareReleasesStore } = await loadStores();
    useWizardStore.getState().selectBrand(BRAND);
    useWizardStore.getState().selectModel(MODEL);
    useWizardStore.getState().selectFirmware("3.3.0");
    tauri.fetchFirmwareReleases.mockRejectedValueOnce(new Error("offline"));

    await useFirmwareReleasesStore.getState().load();

    // The bundled catalogue is what the grid falls back to, and 3.3.0 is in it.
    expect(useFirmwareReleasesStore.getState().state.kind).toBe("error");
    expect(useWizardStore.getState().firmwareVersion).toBe("3.3.0");
  });

  it("rescues a selected pre-release when the opt-in is switched back off", async () => {
    const { useWizardStore, useFirmwareReleasesStore } = await loadStores();
    useWizardStore.getState().selectBrand(BRAND);
    useWizardStore.getState().selectModel(MODEL);
    tauri.fetchFirmwareReleases.mockResolvedValueOnce(LIVE);
    await useFirmwareReleasesStore.getState().load();

    useFirmwareReleasesStore.getState().setShowPrereleases(true);
    useWizardStore.getState().selectFirmware("3.6.0-RC1");
    expect(useWizardStore.getState().firmwareVersion).toBe("3.6.0-RC1");

    // Unticking the box removes the RC from the grid; the store must not be
    // left holding a tag with no tile, no changelog and a live "Next".
    useFirmwareReleasesStore.getState().setShowPrereleases(false);

    expect(useWizardStore.getState().firmwareVersion).toBe("3.5.3");
  });

  it("fetches once — concurrent callers share it and a landed list is kept", async () => {
    const { useFirmwareReleasesStore } = await loadStores();
    tauri.fetchFirmwareReleases.mockResolvedValue(LIVE);

    await Promise.all([
      useFirmwareReleasesStore.getState().load(),
      useFirmwareReleasesStore.getState().load(),
    ]);
    // Re-mounting the step must not spend another of GitHub's 60/hour/IP.
    await useFirmwareReleasesStore.getState().load();

    expect(tauri.fetchFirmwareReleases).toHaveBeenCalledTimes(1);
    expect(useFirmwareReleasesStore.getState().state).toEqual({
      kind: "ready",
      list: LIVE,
    });
  });
});
