import { describe, expect, it } from "vitest";
import {
  applyWizardSuggestion,
  bandForUseCase,
  buildWizardSuggestion,
  CONFIDENCE_BY_QUALITY,
  WIZARD_DEVICE_ROLES,
  WIZARD_REGIONS,
  WIZARD_USE_CASES,
  type WizardApplyActions,
  type WizardIntent,
} from "@/lib/wizardAssist";
import { findBrand, findModel } from "@/lib/elrsTargets";
import { retrieveForChat } from "@/lib/ragRetrieval";

/**
 * M53 — AI-assisted wizard logic. Proves intent → suggestion always maps onto a
 * catalogue-valid target/settings, that confidence + citations attach, and that
 * apply writes the setters in dependency order (final selections survive the
 * cascade resets).
 */

/** Every possible fully-answered intent. */
function allIntents(): WizardIntent[] {
  const out: WizardIntent[] = [];
  for (const deviceRole of WIZARD_DEVICE_ROLES) {
    for (const useCase of WIZARD_USE_CASES) {
      for (const region of WIZARD_REGIONS) {
        out.push({ deviceRole, useCase, region });
      }
    }
  }
  return out;
}

describe("buildWizardSuggestion — catalogue validity", () => {
  it("every intent maps onto a real, complete catalogue entry", () => {
    for (const intent of allIntents()) {
      const s = buildWizardSuggestion(intent);
      const brand = findBrand(s.selections.brandId);
      const model = findModel(s.selections.brandId, s.selections.modelId);

      expect(brand, JSON.stringify(intent)).not.toBeNull();
      expect(model, JSON.stringify(intent)).not.toBeNull();
      // The suggested target descriptor matches the chosen model.
      expect(s.target.target).toBe(model!.target);
      expect(s.target.deviceType).toBe(intent.deviceRole);
      expect(model!.deviceType).toBe(intent.deviceRole);
      // Every suggested setting is one the model actually supports.
      expect(model!.domains).toContain(s.selections.domain);
      expect(model!.firmwareVersions).toContain(s.selections.firmwareVersion);
      expect(model!.flashMethods).toContain(s.selections.flashMethod);
      // Confidence is the deterministic value for the match quality.
      expect(s.confidence).toBe(CONFIDENCE_BY_QUALITY[s.quality]);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      // Beginner explanations are attached, all under wizard.ai.explain.*.
      expect(s.explanations.length).toBeGreaterThan(0);
    }
  });

  it("derives the band from the use-case (long-range ⇒ 900 MHz)", () => {
    expect(bandForUseCase("longRange")).toBe("900");
    expect(bandForUseCase("racing")).toBe("24");
    const lr = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "longRange",
      region: "us",
    });
    expect(lr.band).toBe("900");
    // US long-range TX exactly matches an FCC915-capable module.
    expect(lr.selections.domain).toBe("FCC915");
    expect(lr.quality).toBe("exact");
  });

  it("2.4 GHz use-cases pick an ISM2400 target regardless of region", () => {
    for (const region of WIZARD_REGIONS) {
      const s = buildWizardSuggestion({ deviceRole: "TX", useCase: "racing", region });
      expect(s.band).toBe("24");
      expect(s.selections.domain).toBe("ISM2400");
      expect(s.quality).toBe("exact");
    }
  });

  it("degrades to a band-only match when no model supports the region domain", () => {
    // No RX in the catalogue supports AU915, so a long-range AU receiver falls
    // back to another in-band (900 MHz) domain — a lower-confidence 'band' match.
    const s = buildWizardSuggestion({
      deviceRole: "RX",
      useCase: "longRange",
      region: "au",
    });
    expect(s.band).toBe("900");
    expect(s.quality).toBe("band");
    expect(s.confidence).toBe(CONFIDENCE_BY_QUALITY.band);
    const model = findModel(s.selections.brandId, s.selections.modelId);
    expect(model!.domains).toContain(s.selections.domain);
    expect(s.selections.domain).not.toBe("AU915");
  });

  it("suggests the live latest-stable release, not the frozen catalogue tag", () => {
    // FWCHK-8: this path applies straight to review, so StepFrequency's live
    // release fetch never runs — the suggested version used to be a hardcoded
    // catalogue constant that flows unchecked into the flash request and then
    // the artifactory URL. Every AI-assisted flash 404s the day it ages out.
    const s = buildWizardSuggestion(
      { deviceRole: "TX", useCase: "racing", region: "us" },
      "9.9.9"
    );
    expect(s.selections.firmwareVersion).toBe("9.9.9");
    // The version is one value, surfaced consistently everywhere it is shown.
    expect(s.target.firmwareVersion).toBe("9.9.9");
    expect(
      s.explanations.find((e) => e.key === "firmware")?.params?.version
    ).toBe("9.9.9");
  });

  it("falls back to the bundled catalogue version when the fetch failed", () => {
    for (const intent of allIntents()) {
      const base = buildWizardSuggestion(intent);
      const model = findModel(base.selections.brandId, base.selections.modelId);
      // `null` (fetch failed / nothing but pre-releases) and an omitted argument
      // both mean "offline": keep the curated, stable catalogue tag.
      for (const live of [null, undefined]) {
        const s = buildWizardSuggestion(intent, live);
        expect(s.selections.firmwareVersion).toBe(model!.firmwareVersions[0]);
      }
    }
  });

  it("attaches RAG citations via retrieveForChat on the rationale", () => {
    const s = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "longRange",
      region: "us",
    });
    expect(s.rationaleQuery.length).toBeGreaterThan(0);
    const retrieval = retrieveForChat(s.rationaleQuery);
    // Well-formed retrieval: either grounded chunks, or an honest no-source flag.
    expect(Array.isArray(retrieval.chunks)).toBe(true);
    expect(retrieval.noSourceFound).toBe(retrieval.chunks.length === 0);
    for (const c of retrieval.chunks) {
      expect(c.sourceTitle.length).toBeGreaterThan(0);
      expect(c.excerpt.length).toBeGreaterThan(0);
      expect(c.score).toBeGreaterThan(0);
    }
  });
});

describe("applyWizardSuggestion — dependency order + cascade survival", () => {
  /** A fake store that reproduces the real cascade-reset semantics. */
  function makeFakeStore() {
    const state = {
      brandId: null as string | null,
      modelId: null as string | null,
      domain: null as string | null,
      firmwareVersion: null as string | null,
      flashMethod: null as string | null,
      useTraditionalBinding: false,
      bindingPhrase: "",
      deviceIp: "10.0.0.1",
      step: "brand" as string,
    };
    const calls: string[] = [];
    const actions: WizardApplyActions = {
      selectBrand: (id) => {
        calls.push("brand");
        // selectBrand resets everything model-and-below (mirrors the store).
        state.brandId = id;
        state.modelId = null;
        state.domain = null;
        state.firmwareVersion = null;
        state.flashMethod = null;
      },
      selectModel: (id) => {
        calls.push("model");
        state.modelId = id;
        state.domain = null;
        state.firmwareVersion = null;
        state.flashMethod = null;
      },
      selectDomain: (d) => {
        calls.push("domain");
        state.domain = d;
      },
      selectFirmware: (v) => {
        calls.push("firmware");
        state.firmwareVersion = v;
      },
      selectFlashMethod: (m) => {
        calls.push("method");
        state.flashMethod = m;
      },
      setUseTraditionalBinding: (v) => {
        calls.push("binding");
        state.useTraditionalBinding = v;
      },
      setBindingPhrase: (p) => {
        calls.push("phrase");
        state.bindingPhrase = p;
      },
      setDeviceIp: (ip) => {
        calls.push("ip");
        state.deviceIp = ip;
      },
      goToStep: (step) => {
        calls.push(`goto:${step}`);
        state.step = step;
      },
    };
    return { state, calls, actions };
  }

  it("applies brand→model→domain→firmware→method→binding, then goToStep(review)", () => {
    const suggestion = buildWizardSuggestion({
      deviceRole: "TX",
      useCase: "racing",
      region: "us",
    });
    const { state, calls, actions } = makeFakeStore();
    applyWizardSuggestion(suggestion, actions);

    // Order: each selection setter runs before the ones that depend on it.
    expect(calls.indexOf("brand")).toBeLessThan(calls.indexOf("model"));
    expect(calls.indexOf("model")).toBeLessThan(calls.indexOf("domain"));
    expect(calls.indexOf("domain")).toBeLessThan(calls.indexOf("firmware"));
    expect(calls.indexOf("firmware")).toBeLessThan(calls.indexOf("method"));
    expect(calls.indexOf("method")).toBeLessThan(calls.indexOf("binding"));
    // goToStep("review") is always the final call.
    expect(calls[calls.length - 1]).toBe("goto:review");

    // Despite the cascade resets, every value survived.
    const sel = suggestion.selections;
    expect(state.brandId).toBe(sel.brandId);
    expect(state.modelId).toBe(sel.modelId);
    expect(state.domain).toBe(sel.domain);
    expect(state.firmwareVersion).toBe(sel.firmwareVersion);
    expect(state.flashMethod).toBe(sel.flashMethod);
    expect(state.step).toBe("review");
  });

  it("sets the WiFi host only for a WiFi suggestion", () => {
    const uart = makeFakeStore();
    applyWizardSuggestion(
      buildWizardSuggestion({ deviceRole: "TX", useCase: "racing", region: "us" }),
      uart.actions,
    );
    // The BetaFPV Nano TX suggestion prefers UART, so no deviceIp is written.
    expect(uart.calls).not.toContain("ip");
  });
});
