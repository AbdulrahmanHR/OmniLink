import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the profiles store's persist/delete failure handling.
 *
 * The fire-and-forget `persist()` and `deleteProfile()` paths must distinguish a
 * non-Tauri host (no backend to write to — tolerate silently) from a genuine
 * backend write/delete failure (disk full / permission), surfacing only the
 * latter as a `persistError` i18n key the UI can show.
 */

// Controllable mock of the Tauri runtime: `isTauri()` returns the mutable flag
// so each test can simulate (or not) a real Tauri host.
const core = vi.hoisted(() => ({
  isTauriValue: true,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => core.isTauriValue,
  invoke: core.invoke,
}));

// Controllable mocks of the persistence seam. Defaults are the happy path;
// individual tests override per-call to simulate a failure.
const tauri = vi.hoisted(() => ({
  saveProfile: vi.fn(() => Promise.resolve()),
  deleteStoredProfile: vi.fn(() => Promise.resolve()),
  loadProfiles: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/lib/tauri", () => ({
  saveProfile: tauri.saveProfile,
  deleteStoredProfile: tauri.deleteStoredProfile,
  loadProfiles: tauri.loadProfiles,
}));

// Fresh module per test so the store's initial state (and persistError) resets.
async function loadStore() {
  vi.resetModules();
  const mod = await import("@/stores/profiles");
  return mod.useProfilesStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  core.isTauriValue = true;
});

describe("useProfilesStore persistence failures", () => {
  it("surfaces persistError when a genuine save fails", async () => {
    tauri.saveProfile.mockRejectedValueOnce(new Error("disk full"));

    const store = await loadStore();
    store.getState().saveCurrentAsProfile("p");

    await vi.waitFor(() =>
      expect(store.getState().persistError).toBe("profiles.errors.saveFailed")
    );
  });

  it("tolerates a save failure silently on a non-Tauri host", async () => {
    core.isTauriValue = false;
    tauri.saveProfile.mockRejectedValueOnce(new Error("disk full"));

    const store = await loadStore();
    store.getState().saveCurrentAsProfile("p");

    // No backend to write to: persist() short-circuits before saveProfile.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tauri.saveProfile).not.toHaveBeenCalled();
    expect(store.getState().persistError).toBeNull();
  });

  it("surfaces persistError when a genuine delete fails", async () => {
    const store = await loadStore();
    const id = store.getState().saveCurrentAsProfile("p");

    tauri.deleteStoredProfile.mockRejectedValueOnce(new Error("permission"));
    store.getState().deleteProfile(id);

    await vi.waitFor(() =>
      expect(store.getState().persistError).toBe("profiles.errors.deleteFailed")
    );
  });
});
