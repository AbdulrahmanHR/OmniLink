import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M54 review/diff-before-apply routing (component-light logic test). Proves:
 *  - a validated suggestion produces the `after` diff set (one changed row);
 *  - applying routes through the EXISTING `importProfile` → `applyProfile` store
 *    actions — the single write that sets `activeSettings` (no second path);
 *  - a blocked safety-critical field never yields an appliable patch, so there
 *    is nothing to apply.
 *
 * Runs OFF-Tauri: `isTauri()` is mocked false so the profiles store's persist +
 * async hydration no-op, and `invoke` is stubbed to reject cleanly.
 */

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri in test"))),
}));

import { useProfilesStore } from "@/stores/profiles";
import {
  buildSuggestionAfter,
  suggestionToProfilePatch,
} from "@/lib/aiSuggestionSchema";
import { applySuggestedProfile } from "@/lib/suggestionApply";
import { diffProfiles } from "@/lib/profileDiff";
import type { ProfileSettings } from "@/lib/profileSettings";
import type { UserDefineSuggestion } from "@/lib/ai";

const BASELINE: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: false,
  modelId: 0,
  bindingPhrase: "",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

function sug(key: string, value: string): UserDefineSuggestion {
  return { key, value, reason: "" };
}

beforeEach(() => {
  useProfilesStore.setState({
    activeSettings: { ...BASELINE },
    userProfiles: [],
    appliedId: null,
  });
});

describe("suggestion → diff set", () => {
  it("a validated mappable suggestion builds an `after` with exactly one changed row", () => {
    const patch = suggestionToProfilePatch(sug("MODEL_MATCH", "1"));
    expect(patch).toEqual({ key: "modelMatch", value: true });

    const after = buildSuggestionAfter(BASELINE, patch!);
    expect(after.modelMatch).toBe(true);
    // Pure — the baseline is not mutated.
    expect(BASELINE.modelMatch).toBe(false);

    const { changeCount, rows } = diffProfiles(BASELINE, after);
    expect(changeCount).toBe(1);
    const changed = rows.find((r) => r.status === "changed");
    expect(changed?.key).toBe("modelMatch");
    expect(changed).toMatchObject({ before: false, after: true });
  });
});

describe("apply routing — single write through applyProfile", () => {
  it("applying makes `after` the active config via importProfile → applyProfile", () => {
    const patch = suggestionToProfilePatch(sug("TELEMETRY_RATIO", "1:16"));
    expect(patch).toEqual({ key: "telemetryRatio", value: "1:16" });
    const after = buildSuggestionAfter(
      useProfilesStore.getState().activeSettings,
      patch!
    );

    // Wrap the REAL store actions so we can assert the write path.
    const realImport = useProfilesStore.getState().importProfile;
    const realApply = useProfilesStore.getState().applyProfile;
    const importSpy = vi.fn(realImport);
    const applySpy = vi.fn(realApply);

    const id = applySuggestedProfile(after, "AI suggestion: TELEMETRY_RATIO", {
      importProfile: importSpy,
      applyProfile: applySpy,
    });

    expect(importSpy).toHaveBeenCalledTimes(1);
    // The SINGLE write that sets activeSettings is applyProfile(id).
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(id);

    const state = useProfilesStore.getState();
    expect(state.activeSettings).toEqual(after);
    expect(state.activeSettings.telemetryRatio).toBe("1:16");
    expect(state.appliedId).toBe(id);
    // The candidate was staged as a reviewable profile carrying `after`.
    expect(state.userProfiles.find((p) => p.id === id)?.settings).toEqual(after);
  });
});

describe("blocked field never yields an appliable patch", () => {
  it("a safety-critical / sensitive suggestion produces no patch and no `after`", () => {
    for (const s of [
      sug("TX_POWER", "1000"),
      sug("UNLOCK_HIGHER_POWER", "1"),
      sug("BINDING_PHRASE", "correct horse battery staple"),
      sug("FAILSAFE_MODE", "1"),
    ]) {
      const patch = suggestionToProfilePatch(s);
      expect(patch).toBeNull();
    }
    // Active config is untouched — nothing was appliable.
    expect(useProfilesStore.getState().activeSettings).toEqual(BASELINE);
    // Specifically, RF power stays at the baseline even though `txPower` is a
    // real ProfileSettings field the schema `maps_to` names.
    expect(useProfilesStore.getState().activeSettings.txPower).toBe(100);
  });
});
