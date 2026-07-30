/**
 * AI-assisted wizard logic layer (M53, D20).
 *
 * Pure + dependency-free (no Tauri, no React), so the whole suggestion pipeline
 * is trivially unit-testable and runs offline. The AI-assisted wizard is
 * **assistive, not authoritative**: this module turns a small structured intent
 * into a suggestion built ENTIRELY from the real ELRS catalogue
 * (`elrsTargets.ts`), so every suggested target/setting is catalogue-valid by
 * construction. The one value that is NOT catalogue-frozen is the firmware
 * version: the caller resolves the latest stable upstream release and passes it
 * in (FWCHK-8), because this path skips the wizard's firmware step entirely and
 * the bundled tag ages out of the artifactory retention window.
 * It NEVER flashes and NEVER writes hardware — {@link
 * applyWizardSuggestion} routes the suggestion through the EXISTING wizard
 * selection setters + `goToStep("review")`, landing the user on the SAME
 * deterministic StepReview confirm/flash gate as the static wizard.
 *
 * The clarifying-question flow is deterministic (rule-based); an LLM is optional
 * grounding/enrichment only and never produces the applied selections. RAG
 * citations for the rationale come from the local M50/M51 retrieval pipeline via
 * `retrieveForChat` (called by the panel), so evidence stays offline + client-side.
 */

import {
  ELRS_BRANDS,
  REGULATORY_DOMAIN_BY_ID,
  type Brand,
  type DeviceModel,
  type FlashMethod,
  type RegulatoryDomain,
} from "@/lib/elrsTargets";
import type { WizardTargetSelection } from "@/lib/aiContext";
import { validateSuggestion } from "@/lib/aiSuggestionSchema";
import type { DeviceType } from "@/stores/device";
import type { WizardStep } from "@/stores/wizard";

// ---------------------------------------------------------------------------
// Clarifying intent — the small structured set of goals the flow gathers.
// Exactly the three dimensions M53 calls out: device role, use-case, region.
// ---------------------------------------------------------------------------

/** The flying style the user is optimizing for. */
export type WizardUseCase = "racing" | "freestyle" | "longRange" | "cinematic";

/** The user's regulatory region (drives the sub-GHz domain choice). */
export type WizardRegion = "us" | "eu" | "au" | "in" | "global";

/** The RF band a suggestion targets (derived from the use-case). */
export type WizardBand = "24" | "900";

/** Ordered device-role options for the clarifying UI. */
export const WIZARD_DEVICE_ROLES: readonly DeviceType[] = ["TX", "RX"];

/** Ordered use-case options for the clarifying UI. */
export const WIZARD_USE_CASES: readonly WizardUseCase[] = [
  "racing",
  "freestyle",
  "longRange",
  "cinematic",
];

/** Ordered region options for the clarifying UI. */
export const WIZARD_REGIONS: readonly WizardRegion[] = [
  "us",
  "eu",
  "au",
  "in",
  "global",
];

/** The fully-answered clarifying intent produced by the question flow. */
export interface WizardIntent {
  deviceRole: DeviceType;
  useCase: WizardUseCase;
  region: WizardRegion;
}

/** Common ELRS soft-AP address used when a WiFi-OTA suggestion needs a host. */
export const DEFAULT_WIFI_IP = "10.0.0.1";

// ---------------------------------------------------------------------------
// Suggestion model.
// ---------------------------------------------------------------------------

/** How confidently the intent mapped onto a catalogue entry. */
export type WizardMatchQuality = "exact" | "band" | "fallback";

/** Confidence score (0–1) attached to each match quality. Deterministic. */
export const CONFIDENCE_BY_QUALITY: Record<WizardMatchQuality, number> = {
  // Model supports the exact region-preferred domain for the target band.
  exact: 0.92,
  // Model supports the target band, but not the exact region domain.
  band: 0.74,
  // Had to relax the band entirely (no in-band model for the role).
  fallback: 0.5,
};

/** A single beginner-friendly explanation (i18n key + non-translated params). */
export interface WizardExplanation {
  /** i18n key under `wizard.ai.explain.*`. */
  key: string;
  /** Interpolation params — only non-translated primitives (never nested t()). */
  params?: Record<string, string | number>;
}

/**
 * The concrete selections a suggestion writes into the wizard store, mirroring
 * the static wizard's `WizardSelections`. Applied via the EXISTING setters.
 */
export interface WizardSuggestionSelections {
  brandId: string;
  modelId: string;
  domain: RegulatoryDomain;
  firmwareVersion: string;
  flashMethod: FlashMethod;
  /** Traditional (button/3-way) binding — the privacy-safe zero-secret default. */
  useTraditionalBinding: boolean;
  /** Suggested binding phrase (empty when traditional; never a fabricated secret). */
  bindingPhrase: string;
  /** WiFi-OTA host, set only when {@link flashMethod} is `wifi`; else null. */
  deviceIp: string | null;
}

/** The full AI-assisted suggestion surfaced in the summary card. */
export interface WizardSuggestion {
  /** The intent this suggestion was derived from. */
  intent: WizardIntent;
  /** The band actually chosen (may differ from the ideal on a fallback). */
  band: WizardBand;
  /** How well the intent mapped onto the catalogue. */
  quality: WizardMatchQuality;
  /** Confidence score in `[0, 1]`. */
  confidence: number;
  /** The suggested target descriptor (drives the summary + AI context). */
  target: WizardTargetSelection;
  /** The selections to apply through the existing setters. */
  selections: WizardSuggestionSelections;
  /** Beginner-friendly explanations for each suggested setting. */
  explanations: WizardExplanation[];
  /**
   * English retrieval query (NOT user-facing) used to fetch RAG citations for the
   * rationale via `retrieveForChat`. Kept in English because the corpus is English.
   */
  rationaleQuery: string;
}

// ---------------------------------------------------------------------------
// Intent → suggestion mapping (deterministic, catalogue-only).
// ---------------------------------------------------------------------------

/** Long-range wants sub-GHz reach; everything else favors 2.4 GHz latency. */
export function bandForUseCase(useCase: WizardUseCase): WizardBand {
  return useCase === "longRange" ? "900" : "24";
}

/** Which band a domain belongs to. */
function bandOfDomain(domain: RegulatoryDomain): WizardBand {
  return domain === "ISM2400" ? "24" : "900";
}

/** The region-preferred regulatory domain for a band. */
function preferredDomain(region: WizardRegion, band: WizardBand): RegulatoryDomain {
  if (band === "24") return "ISM2400";
  switch (region) {
    case "us":
      return "FCC915";
    case "eu":
      return "EU868";
    case "au":
      return "AU915";
    case "in":
      return "IN866";
    case "global":
    default:
      // 915 MHz is the most broadly-supported sub-GHz domain in the catalogue.
      return "FCC915";
  }
}

/**
 * Prefer USB/UART (most reliable first flash), then Betaflight passthrough (the
 * common RX path), then WiFi OTA. Falls back to whatever the model supports.
 */
const METHOD_PREFERENCE: readonly FlashMethod[] = ["uart", "betaflight", "wifi"];

function pickFlashMethod(model: DeviceModel): FlashMethod {
  for (const method of METHOD_PREFERENCE) {
    if (model.flashMethods.includes(method)) return method;
  }
  return model.flashMethods[0];
}

interface ModelPick {
  brand: Brand;
  model: DeviceModel;
  domain: RegulatoryDomain;
  quality: WizardMatchQuality;
}

/**
 * Pick the best catalogue model for a role + band + region-preferred domain.
 * Tiered so we always return a real, complete catalogue entry:
 *  1. exact  — role matches AND the model supports the region's preferred domain;
 *  2. band   — role matches AND the model supports SOME domain in the band;
 *  3. fallback — any model of the role (band could not be honored).
 */
function pickModel(
  deviceRole: DeviceType,
  band: WizardBand,
  wantDomain: RegulatoryDomain,
): ModelPick {
  // 1. exact region-domain match.
  for (const brand of ELRS_BRANDS) {
    for (const model of brand.models) {
      if (model.deviceType === deviceRole && model.domains.includes(wantDomain)) {
        return { brand, model, domain: wantDomain, quality: "exact" };
      }
    }
  }
  // 2. same band, different domain.
  for (const brand of ELRS_BRANDS) {
    for (const model of brand.models) {
      if (model.deviceType !== deviceRole) continue;
      const inBand = model.domains.find((d) => bandOfDomain(d) === band);
      if (inBand) return { brand, model, domain: inBand, quality: "band" };
    }
  }
  // 3. any model of the role.
  for (const brand of ELRS_BRANDS) {
    for (const model of brand.models) {
      if (model.deviceType === deviceRole) {
        return { brand, model, domain: model.domains[0], quality: "fallback" };
      }
    }
  }
  // Last resort — the catalogue always has models, so this is defensive only.
  const brand = ELRS_BRANDS[0];
  const model = brand.models[0];
  return { brand, model, domain: model.domains[0], quality: "fallback" };
}

/** i18n explanation key for a flash method. */
function methodExplainKey(method: FlashMethod): string {
  switch (method) {
    case "uart":
      return "methodUart";
    case "wifi":
      return "methodWifi";
    case "betaflight":
      return "methodBetaflight";
  }
}

function buildExplanations(
  band: WizardBand,
  domainFrequency: string,
  modelName: string,
  firmwareVersion: string,
  flashMethod: FlashMethod,
): WizardExplanation[] {
  return [
    { key: band === "900" ? "band900" : "band24" },
    { key: "domain", params: { band: domainFrequency } },
    { key: "model", params: { model: modelName } },
    { key: "firmware", params: { version: firmwareVersion } },
    { key: methodExplainKey(flashMethod) },
    { key: "bindingTraditional" },
  ];
}

/** Build the (non-user-facing, English) RAG rationale query for retrieval. */
function buildRationaleQuery(intent: WizardIntent, band: WizardBand): string {
  const role = intent.deviceRole === "TX" ? "transmitter" : "receiver";
  const bandLabel = band === "900" ? "900MHz long range" : "2.4GHz";
  const focus: Record<WizardUseCase, string> = {
    racing: "racing low latency packet rate power",
    freestyle: "freestyle packet rate power",
    longRange: "long range packet rate power antenna",
    cinematic: "cinematic smooth packet rate",
  };
  return `ExpressLRS ${bandLabel} ${role} ${focus[intent.useCase]} binding flashing`;
}

/**
 * Turn a fully-answered {@link WizardIntent} into a catalogue-valid suggestion.
 * Pure + deterministic. The result's target/selections are guaranteed to exist
 * in `ELRS_BRANDS`, so applying it can only ever reach a valid review state.
 *
 * @param liveFirmwareVersion  The latest STABLE upstream release, resolved by
 *   the caller (`latestStableRelease` over `fetchFirmwareReleases`) because this
 *   module stays Tauri-free. Pass `null`/omit when that fetch failed — the
 *   bundled catalogue version is then used as the offline fallback (FWCHK-8).
 */
export function buildWizardSuggestion(
  intent: WizardIntent,
  liveFirmwareVersion?: string | null,
): WizardSuggestion {
  const idealBand = bandForUseCase(intent.useCase);
  const wantDomain = preferredDomain(intent.region, idealBand);
  const { brand, model, domain, quality } = pickModel(
    intent.deviceRole,
    idealBand,
    wantDomain,
  );

  const band = bandOfDomain(domain);
  // FWCHK-8: prefer the live "latest stable" release. `model.firmwareVersions[0]`
  // is a frozen catalogue constant, and this path applies its suggestion STRAIGHT
  // TO REVIEW — StepFrequency (the only place that fetches the real release list)
  // never runs — so the constant used to travel unchecked into the flash request
  // and the artifactory URL. The day it ages out of the retention window every
  // AI-assisted flash 404s; until then a beginner is silently pinned to a frozen
  // version while the static wizard next door offers live ones.
  const firmwareVersion = liveFirmwareVersion ?? model.firmwareVersions[0];
  const flashMethod = pickFlashMethod(model);
  const domainMeta = REGULATORY_DOMAIN_BY_ID[domain];

  const selections: WizardSuggestionSelections = {
    brandId: brand.id,
    modelId: model.id,
    domain,
    firmwareVersion,
    flashMethod,
    // Traditional binding needs no secret phrase, so the review step is valid
    // immediately; the user can opt into a binding phrase on review.
    useTraditionalBinding: true,
    bindingPhrase: "",
    deviceIp: flashMethod === "wifi" ? DEFAULT_WIFI_IP : null,
  };

  const target: WizardTargetSelection = {
    brandName: brand.name,
    modelName: model.name,
    target: model.target,
    deviceType: model.deviceType,
    firmwareVersion,
    frequency: domainMeta.frequency,
  };

  return {
    intent,
    band,
    quality,
    confidence: CONFIDENCE_BY_QUALITY[quality],
    target,
    selections,
    explanations: buildExplanations(
      band,
      domainMeta.frequency,
      model.name,
      firmwareVersion,
      flashMethod,
    ),
    rationaleQuery: buildRationaleQuery(intent, band),
  };
}

// ---------------------------------------------------------------------------
// Apply — writes the suggestion through the EXISTING wizard setters.
// ---------------------------------------------------------------------------

/**
 * The subset of the wizard store's actions {@link applyWizardSuggestion} drives.
 * Passing this (rather than importing the store) keeps the module pure/cycle-free
 * and lets tests apply against the real store OR a spy.
 */
export interface WizardApplyActions {
  selectBrand: (brandId: string) => void;
  selectModel: (modelId: string) => void;
  selectDomain: (domain: RegulatoryDomain) => void;
  selectFirmware: (version: string) => void;
  selectFlashMethod: (method: FlashMethod) => void;
  setUseTraditionalBinding: (value: boolean) => void;
  setBindingPhrase: (phrase: string) => void;
  setDeviceIp: (ip: string) => void;
  goToStep: (step: WizardStep) => void;
}

/**
 * Apply a suggestion into the wizard store through the SAME setters the static
 * wizard uses — in strict **dependency order** (brand → model → domain →
 * firmware → method → binding). Order matters because each setter cascade-resets
 * its downstream selections (`selectBrand` clears model/domain/…; `selectModel`
 * clears domain/…), so a value written out of order would be wiped by a later
 * reset. Finally it routes through `goToStep("review")`, which re-validates every
 * predecessor via `isWizardStepValid` — so an incomplete/malformed suggestion
 * simply fails to advance instead of reaching a flashable state.
 *
 * SAFETY: this NEVER calls `startFlash` and never writes hardware. The ONLY flash
 * trigger remains StepReview's Flash button (M53 no-skip-review invariant).
 */
export function applyWizardSuggestion(
  suggestion: WizardSuggestion,
  actions: WizardApplyActions,
): void {
  const s = suggestion.selections;
  actions.selectBrand(s.brandId);
  actions.selectModel(s.modelId);
  actions.selectDomain(s.domain);
  actions.selectFirmware(s.firmwareVersion);
  actions.selectFlashMethod(s.flashMethod);
  actions.setUseTraditionalBinding(s.useTraditionalBinding);
  // M54 safety gate: a binding phrase is a SENSITIVE/blocked field. An
  // AI-suggested phrase is routed through the SAME suggestion validator as a
  // would-be `BINDING_PHRASE` user_define — which the closed deny-by-default
  // allowlist always rejects — so a crafted/adversarial wizard suggestion can
  // never write a binding secret. The user still enters their own phrase on the
  // deterministic binding step (this only gates the AI-suggested value).
  if (
    !s.useTraditionalBinding &&
    s.bindingPhrase &&
    validateSuggestion({ key: "BINDING_PHRASE", value: s.bindingPhrase })
  ) {
    actions.setBindingPhrase(s.bindingPhrase);
  }
  if (s.flashMethod === "wifi" && s.deviceIp) {
    actions.setDeviceIp(s.deviceIp);
  }
  // Route through goToStep so predecessors re-validate; never bypass it.
  actions.goToStep("review");
}

// ---------------------------------------------------------------------------
// Availability + graceful static fallback (D20) — no dead-end.
// ---------------------------------------------------------------------------

/** Why the AI-assisted mode degraded to the static fallback. */
export type WizardAiFallbackReason = "disabled" | "offline";

/** Signals that decide whether the AI-assisted mode can run. */
export interface WizardAiAvailabilityInput {
  /** At least one BYOK/local provider is offerable (`availableProviders` > 0). */
  hasProvider: boolean;
  /** The machine currently has connectivity (`navigator.onLine`). */
  online: boolean;
}

/** The availability verdict + the fallback reason when unavailable. */
export interface WizardAiAvailability {
  available: boolean;
  reason: WizardAiFallbackReason | null;
}

const AVAILABLE: WizardAiAvailability = { available: true, reason: null };

function unavailable(reason: WizardAiFallbackReason): WizardAiAvailability {
  return { available: false, reason };
}

/**
 * Decide whether the AI-assisted wizard can run, and if not, WHY — so the panel
 * can show a clear notice and offer the static fallback with no dead-end (D20).
 * Pure so every branch is unit-tested with controlled inputs.
 *
 * The only transport is BYOK/local: unavailable if there is no provider
 * (`disabled`) or the machine is offline (`offline`).
 *
 * Whatever the verdict, the static wizard is always reachable — this only gates
 * the AI surface, never the static flashing flow.
 */
export function evaluateWizardAiAvailability(
  input: WizardAiAvailabilityInput,
): WizardAiAvailability {
  if (!input.hasProvider) return unavailable("disabled");
  if (!input.online) return unavailable("offline");
  return AVAILABLE;
}
