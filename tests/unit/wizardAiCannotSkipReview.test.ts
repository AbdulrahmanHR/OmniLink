import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FlashErrorPayload,
  FlashLogPayload,
  FlashProgressPayload,
} from "@/lib/tauri";

/**
 * M53 CRITICAL SAFETY TEST — the AI-assisted wizard can NEVER skip review/flash.
 *
 * Proves that applying an AI suggestion:
 *  - always routes through `goToStep("review")` (predecessors re-validate), so a
 *    complete suggestion lands EXACTLY on the `review` step and nowhere further;
 *  - can NOT reach a flashable state from a malformed/incomplete suggestion — it
 *    fails to advance instead of bypassing `isWizardStepValid`;
 *  - NEVER invokes `startFlash`. Only StepReview's Flash button calls it.
 *
 * The Tauri seam is mocked (mirroring `wizardFlash.test.ts`) so the real wizard
 * store loads; `startFlash` is a spy we assert is never touched by the AI path.
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

describe("AI wizard cannot skip review", () => {
  beforeEach(() => {
    useWizardStore.getState().reset();
    handlers.startFlash.mockClear();
  });

  it("a complete suggestion lands exactly on review, flash NOT started", () => {
    const suggestion = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "racing",
      region: "us",
    });
    applyWizardSuggestion(suggestion, useWizardStore.getState());

    const s = useWizardStore.getState();
    // Landed on the SAME static review step — not past it.
    expect(s.step).toBe("review");
    // The flash has NOT started; the only trigger is StepReview's button.
    expect(s.flash.status).toBe("idle");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("selections survive the cascade resets (applied in dependency order)", () => {
    const suggestion = buildWizardSuggestion({
      deviceRole: "RX",
      useCase: "longRange",
      region: "us",
    });
    applyWizardSuggestion(suggestion, useWizardStore.getState());

    const s = useWizardStore.getState();
    const sel = suggestion.selections;
    // If any setter ran out of order, an upstream cascade-reset would have wiped
    // one of these back to null — so equality proves correct ordering.
    expect(s.brandId).toBe(sel.brandId);
    expect(s.modelId).toBe(sel.modelId);
    expect(s.domain).toBe(sel.domain);
    expect(s.firmwareVersion).toBe(sel.firmwareVersion);
    expect(s.flashMethod).toBe(sel.flashMethod);
    expect(s.useTraditionalBinding).toBe(sel.useTraditionalBinding);
    // And every predecessor of review is genuinely valid.
    for (const step of ["brand", "model", "frequency", "binding"] as const) {
      expect(isWizardStepValid(s, step)).toBe(true);
    }
  });

  it("a suggestion with no binding cannot reach review", () => {
    // Traditional off + empty phrase ⇒ the binding step is invalid.
    applyWizardSuggestion(
      craft({ useTraditionalBinding: false, bindingPhrase: "" }),
      useWizardStore.getState(),
    );

    const s = useWizardStore.getState();
    // goToStep("review") refused because a predecessor failed to validate.
    expect(s.step).not.toBe("review");
    expect(isWizardStepValid(s, "binding")).toBe(false);
    expect(s.flash.status).toBe("idle");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("a WiFi suggestion with an invalid device IP cannot reach review", () => {
    applyWizardSuggestion(
      craft({ flashMethod: "wifi", deviceIp: "999.999.999.999" }),
      useWizardStore.getState(),
    );

    const s = useWizardStore.getState();
    expect(s.step).not.toBe("review");
    // The frequency step fails because WiFi OTA needs a valid host.
    expect(isWizardStepValid(s, "frequency")).toBe(false);
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });

  it("M54: a crafted suggestion can NOT write a blocked field (binding secret)", () => {
    // A crafted/adversarial suggestion tries to smuggle a fabricated binding
    // phrase (a SENSITIVE/blocked field) into the wizard while claiming a
    // non-traditional binding. The M54 guard routes it through the same
    // suggestion validator (which rejects BINDING_PHRASE), so it is NEVER set —
    // the wizard's binding phrase stays empty and review is unreachable.
    applyWizardSuggestion(
      craft({
        useTraditionalBinding: false,
        bindingPhrase: "smuggled-secret-phrase",
      }),
      useWizardStore.getState(),
    );

    const s = useWizardStore.getState();
    expect(s.bindingPhrase).toBe("");
    expect(s.bindingPhrase).not.toBe("smuggled-secret-phrase");
    // With no phrase and traditional binding off, the binding step is invalid,
    // so the AI path cannot reach review or flash.
    expect(isWizardStepValid(s, "binding")).toBe(false);
    expect(s.step).not.toBe("review");
    expect(handlers.startFlash).not.toHaveBeenCalled();
  });
});
