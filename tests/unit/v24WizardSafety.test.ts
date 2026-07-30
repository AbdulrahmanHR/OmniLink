import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlashErrorPayload,
  FlashLogPayload,
  FlashProgressPayload,
} from "@/lib/tauri";

/**
 * v2.4 WIZARD SAFETY REGRESSION (M55) — the consolidated launch gate proving the
 * M53 AI-assisted wizard and M54 suggestion hardening can NEVER skip the
 * review/apply gates.
 *
 * Binds four invariants into one regression suite:
 *  1. Applying an AI suggestion ALWAYS lands exactly on the static `review` step
 *     and NEVER calls `startFlash` — the sole flash trigger stays StepReview's
 *     button (M53 no-skip-review).
 *  2. A malformed/incomplete AI suggestion fails to advance (it cannot reach a
 *     flashable state by bypassing `isWizardStepValid`).
 *  3. A crafted/adversarial AI wizard OR profile suggestion cannot write a
 *     blocked safety-critical / sensitive field (M54 validator: binding secret,
 *     RF power, failsafe/arming) — validation runs FIRST, so no blocked key yields
 *     a wizard write or a profile patch.
 *  4. The STATIC wizard remains reachable + fully functional regardless of AI /
 *     billing / connectivity state (D20 no-dead-end).
 *
 * The Tauri seam is mocked (mirroring `wizardFlash`/`wizardAiCannotSkipReview`)
 * so the real wizard store loads and `startFlash` is a spy we assert is untouched.
 */

const handlers = vi.hoisted(() => ({
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tauri", () => ({
  startFlash: handlers.startFlash,
  cancelFlash: handlers.cancelFlash,
  onFlashProgress: (_h: (p: FlashProgressPayload) => void) => Promise.resolve(() => {}),
  onFlashLog: (_h: (l: FlashLogPayload) => void) => Promise.resolve(() => {}),
  onFlashDone: (_h: () => void) => Promise.resolve(() => {}),
  onFlashError: (_h: (e: FlashErrorPayload) => void) => Promise.resolve(() => {}),
  onFlashCancelled: (_h: () => void) => Promise.resolve(() => {}),
  saveProfile: vi.fn(() => Promise.resolve()),
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  connectDevice: vi.fn(() => Promise.resolve()),
  disconnectDevice: vi.fn(() => Promise.resolve()),
  onDeviceConnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceDisconnected: vi.fn(() => Promise.resolve(() => {})),
  onDeviceError: vi.fn(() => Promise.resolve(() => {})),
  onLinkStats: vi.fn(() => Promise.resolve(() => {})),
}));

import { isWizardStepValid, useWizardStore } from "@/stores/wizard";
import {
  applyWizardSuggestion,
  buildWizardSuggestion,
  type WizardSuggestion,
  type WizardSuggestionSelections,
} from "@/lib/wizardAssist";
import {
  suggestionToProfilePatch,
  validateSuggestion,
} from "@/lib/aiSuggestionSchema";
import type { ProfileSettings } from "@/lib/profileSettings";

/** Craft a suggestion object with overridable selections (apply reads only these). */
function craft(sel: Partial<WizardSuggestionSelections>): WizardSuggestion {
  return {
    intent: { deviceRole: "TX", useCase: "racing", region: "us" },
    band: "24",
    quality: "exact",
    confidence: 0.92,
    target: {
      brandName: "BetaFPV",
      modelName: "Nano TX",
      target: "BETAFPV_2400_TX",
      deviceType: "TX",
      firmwareVersion: "3.5.3",
      frequency: "2.4 GHz",
    },
    selections: {
      brandId: "betafpv",
      modelId: "betafpv-nano-tx-2400",
      domain: "ISM2400",
      firmwareVersion: "3.5.3",
      flashMethod: "uart",
      useTraditionalBinding: true,
      bindingPhrase: "",
      deviceIp: null,
      ...sel,
    },
    explanations: [],
    rationaleQuery: "q",
  };
}

const wizard = () => useWizardStore.getState();

beforeEach(() => {
  wizard().reset();
  handlers.startFlash.mockClear();
});

// ---------------------------------------------------------------------------
// 1 + 2. AI apply always lands on review, never flashes; malformed can't advance.
// ---------------------------------------------------------------------------

describe("AI wizard apply routes to review and never flashes", () => {
  it("a complete suggestion lands EXACTLY on review; startFlash never called", () => {
    const suggestion = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "racing",
      region: "us",
    });
    applyWizardSuggestion(suggestion, wizard());

    const s = wizard();
    expect(s.step).toBe("review"); // on the static review step, not past it
    expect(s.flash.status).toBe("idle"); // no flash engaged
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("every deterministic intent lands on review with startFlash untouched", () => {
    for (const deviceRole of ["TX", "RX"] as const) {
      for (const useCase of ["racing", "freestyle", "longRange", "cinematic"] as const) {
        for (const region of ["us", "eu", "au", "in", "global"] as const) {
          wizard().reset();
          handlers.startFlash.mockClear();
          applyWizardSuggestion(
            buildWizardSuggestion({ deviceRole, useCase, region }),
            wizard(),
          );
          const s = wizard();
          expect(s.step, `${deviceRole}/${useCase}/${region}`).toBe("review");
          expect(handlers.startFlash).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("a suggestion with no binding cannot reach review (fails validation to advance)", () => {
    applyWizardSuggestion(
      craft({ useTraditionalBinding: false, bindingPhrase: "" }),
      wizard(),
    );
    const s = wizard();
    expect(s.step).not.toBe("review");
    expect(isWizardStepValid(s, "binding")).toBe(false);
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("a WiFi suggestion with an invalid device IP cannot reach review", () => {
    applyWizardSuggestion(
      craft({ flashMethod: "wifi", deviceIp: "999.999.999.999" }),
      wizard(),
    );
    const s = wizard();
    expect(s.step).not.toBe("review");
    expect(isWizardStepValid(s, "frequency")).toBe(false);
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. A crafted suggestion cannot write a blocked safety-critical / sensitive field.
// ---------------------------------------------------------------------------

describe("a crafted AI suggestion cannot write a blocked field", () => {
  it("a smuggled binding secret is rejected — bindingPhrase stays empty, review unreachable", () => {
    applyWizardSuggestion(
      craft({
        useTraditionalBinding: false,
        bindingPhrase: "smuggled-secret-phrase",
      }),
      wizard(),
    );
    const s = wizard();
    expect(s.bindingPhrase).toBe("");
    expect(s.bindingPhrase).not.toBe("smuggled-secret-phrase");
    expect(isWizardStepValid(s, "binding")).toBe(false);
    expect(s.step).not.toBe("review");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("a crafted PROFILE suggestion for a blocked field yields NO patch (M54 validator)", () => {
    // Each of these is a safety-critical / RF-power / sensitive key an adversarial
    // model reply might emit. Validation runs FIRST, so none produces a patch even
    // though some have a real `maps_to` profile field.
    for (const key of [
      "TX_POWER",
      "UNLOCK_HIGHER_POWER",
      "MAX_POWER",
      "FAILSAFE_MODE",
      "ARMING_ALLOWED",
      "MY_BINDING_PHRASE",
      "BINDING_PHRASE",
      "WIFI_PASSWORD",
    ]) {
      expect(
        validateSuggestion({ key, value: "1" }),
        `blocked key ${key} must not validate`,
      ).toBe(false);
      expect(
        suggestionToProfilePatch({ key, value: "1" }),
        `blocked key ${key} must not yield a patch`,
      ).toBeNull();
    }
  });

  it("an ALLOWED tunable still maps to a reviewable profile patch (gate is not a blanket block)", () => {
    const patch = suggestionToProfilePatch({ key: "MODEL_MATCH", value: "1" });
    expect(patch).not.toBeNull();
    expect(patch?.key).toBe("modelMatch");
    expect(patch?.value).toBe(true);
    // A validated enum tunable maps to its profile field + keeps the token value.
    const tr = suggestionToProfilePatch({ key: "TELEMETRY_RATIO", value: "1:128" });
    expect(tr).not.toBeNull();
    expect(tr?.key).toBe("telemetryRatio");
    expect(tr?.value).toBe("1:128");
    // A validated-but-unmappable tunable (no ProfileSettings field) yields no
    // patch — it still can't silently mutate settings.
    expect(validateSuggestion({ key: "TLM_REPORT_INTERVAL_MS", value: "480" })).toBe(true);
    expect(suggestionToProfilePatch({ key: "TLM_REPORT_INTERVAL_MS", value: "480" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The static wizard remains reachable + functional (D20 no-dead-end).
// ---------------------------------------------------------------------------

describe("the static wizard remains reachable and functional", () => {
  it("a full manual selection reaches review with every predecessor valid", () => {
    wizard().setWizardMode("static");
    const s0 = wizard();
    expect(s0.wizardMode).toBe("static");

    s0.selectBrand("betafpv");
    s0.selectModel("betafpv-nano-tx-2400");
    s0.selectDomain("ISM2400");
    s0.selectFirmware("3.5.3");
    s0.selectFlashMethod("uart");
    s0.setUseTraditionalBinding(true);
    s0.goToStep("review");

    const s = wizard();
    expect(s.step).toBe("review");
    for (const step of ["brand", "model", "frequency", "binding"] as const) {
      expect(isWizardStepValid(s, step)).toBe(true);
    }
    // Reaching review is NOT flashing — the flash trigger is still StepReview only.
    expect(s.flash.status).toBe("idle");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("switching AI → static always yields a working static wizard (no dead-end)", () => {
    wizard().setWizardMode("ai");
    expect(wizard().wizardMode).toBe("ai");
    wizard().setWizardMode("static");
    expect(wizard().wizardMode).toBe("static");

    // The deterministic suggestion engine still works offline and lands on review.
    applyWizardSuggestion(
      buildWizardSuggestion({ deviceRole: "RX", useCase: "longRange", region: "eu" }),
      wizard(),
    );
    expect(wizard().step).toBe("review");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A no-op reference so ProfileSettings import is load-bearing (type-level check).
// ---------------------------------------------------------------------------

describe("blocked-field profile patch never mutates the active settings shape", () => {
  it("a rejected suggestion leaves an active ProfileSettings untouched", () => {
    const active: ProfileSettings = {
      packetRate: 250,
      telemetryRatio: "1:128",
      switchMode: "Wide",
      txPower: 100,
      dynamicPower: true,
      modelMatch: false,
      modelId: 0,
      bindingPhrase: "",
      antennaMode: "Diversity",
      fanThreshold: 100,
    };
    const patch = suggestionToProfilePatch({ key: "TX_POWER", value: "2000" });
    expect(patch).toBeNull();
    // Nothing to apply ⇒ the review 'after' is identical to 'before'.
    expect(active.txPower).toBe(100);
  });
});
