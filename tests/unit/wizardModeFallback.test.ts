import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlashErrorPayload,
  FlashLogPayload,
  FlashProgressPayload,
} from "@/lib/tauri";

/**
 * M53 — graceful static fallback (D20). When AI is unavailable / disabled /
 * offline, the AI-assisted wizard must degrade to the static wizard with NO
 * dead-end. This covers:
 *  - the pure availability decision for every trigger, and
 *  - that switching to static mode always yields a fully working static wizard,
 *    independent of any AI state (an AI failure never blocks the static flow).
 *
 * v3.0 (M69): the Managed transport was deleted, so the Managed/out-of-credits
 * branches of `evaluateWizardAiAvailability` and their cases are gone. BYOK/local
 * is the only transport, and the static fallback it degrades to is unchanged.
 */

vi.mock("@/lib/tauri", () => ({
  startFlash: vi.fn(() => Promise.resolve()),
  cancelFlash: vi.fn(() => Promise.resolve()),
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

import {
  evaluateWizardAiAvailability,
  applyWizardSuggestion,
  buildWizardSuggestion,
  type WizardAiAvailabilityInput,
} from "@/lib/wizardAssist";
import { isWizardStepValid, useWizardStore } from "@/stores/wizard";

/** A fully-available baseline (BYOK, online) to override per case. */
const BASE: WizardAiAvailabilityInput = {
  hasProvider: true,
  online: true,
};

describe("evaluateWizardAiAvailability", () => {
  it("is available with a BYOK/local provider online", () => {
    expect(evaluateWizardAiAvailability(BASE)).toEqual({
      available: true,
      reason: null,
    });
  });

  it("falls back to 'disabled' when no provider is configured", () => {
    expect(
      evaluateWizardAiAvailability({ ...BASE, hasProvider: false }),
    ).toEqual({ available: false, reason: "disabled" });
  });

  it("falls back to 'offline' on the BYOK path when offline", () => {
    expect(
      evaluateWizardAiAvailability({ ...BASE, online: false }),
    ).toEqual({ available: false, reason: "offline" });
  });

});

describe("static fallback is reachable with no dead-end", () => {
  beforeEach(() => {
    useWizardStore.getState().reset();
    useWizardStore.getState().setWizardMode("static");
  });

  it("switching from AI mode to static always yields a working static wizard", () => {
    // Simulate an unavailable AI environment (no provider, and offline).
    const verdict = evaluateWizardAiAvailability({
      hasProvider: false,
      online: false,
    });
    expect(verdict.available).toBe(false);

    // Enter AI mode, then the fallback drops back to static.
    useWizardStore.getState().setWizardMode("ai");
    expect(useWizardStore.getState().wizardMode).toBe("ai");
    useWizardStore.getState().setWizardMode("static");
    expect(useWizardStore.getState().wizardMode).toBe("static");

    // The static wizard is fully functional regardless of AI state: a complete
    // manual selection validates and can reach review.
    const store = useWizardStore.getState();
    store.selectBrand("betafpv");
    store.selectModel("betafpv-nano-tx-2400");
    store.selectDomain("ISM2400");
    store.selectFirmware("3.5.3");
    store.selectFlashMethod("uart");
    store.setUseTraditionalBinding(true);
    store.goToStep("review");

    const s = useWizardStore.getState();
    expect(s.step).toBe("review");
    for (const step of ["brand", "model", "frequency", "binding"] as const) {
      expect(isWizardStepValid(s, step)).toBe(true);
    }
  });

  it("a suggestion built offline can still be applied to reach static review", () => {
    // The deterministic suggestion engine needs no network, so even when the AI
    // transport is down the user is never stranded.
    const suggestion = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "freestyle",
      region: "eu",
    });
    applyWizardSuggestion(suggestion, useWizardStore.getState());
    expect(useWizardStore.getState().step).toBe("review");
  });
});
