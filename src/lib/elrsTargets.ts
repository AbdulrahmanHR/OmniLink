/**
 * Curated ExpressLRS target catalogue — real reference data (NOT demo mock).
 *
 * This is the hand-maintained brand / model / firmware / RF-band reference the
 * real M8 flashing flow needs: it maps the hardware a user owns to its ELRS
 * build target, supported RF domains, and flash methods. The live firmware
 * version list comes from GitHub Releases at runtime (see `StepFrequency`); this
 * catalogue supplies the target metadata GitHub does not, and feeds the AI
 * context so Omnia knows which model is being discussed. Treat it as reference
 * data, not example/demo content.
 */

import type { DeviceType } from "@/stores/device";

/**
 * Regulatory domain / RF band an ELRS device can operate on. The 2.4GHz ISM
 * band plus the common sub-GHz long-range domains.
 */
export type RegulatoryDomain =
  | "ISM2400"
  | "FCC915"
  | "EU868"
  | "EU433"
  | "AU915"
  | "IN866";

/** How firmware is delivered to the device (visual-only in Phase 1). */
export type FlashMethod = "wifi" | "uart" | "betaflight";

/** A single flashable device under a brand. */
export interface DeviceModel {
  id: string;
  /** Literal display name (model names are proper nouns, not translated). */
  name: string;
  deviceType: DeviceType;
  /** ELRS build target identifier (shown in a mono font). */
  target: string;
  /** MCU family (ESP32 / ESP8285 / STM32 …). */
  mcu: string;
  /** Regulatory domains this hardware supports. */
  domains: RegulatoryDomain[];
  /** Available firmware versions, newest first. */
  firmwareVersions: string[];
  /** Supported delivery methods. */
  flashMethods: FlashMethod[];
}

/** A vendor grouping a set of device models. */
export interface Brand {
  id: string;
  /** Literal brand name (proper noun, not translated). */
  name: string;
  models: DeviceModel[];
}

/** Display metadata for a regulatory domain. */
export interface RegulatoryDomainMeta {
  id: RegulatoryDomain;
  /** i18n key for the descriptive band name. */
  labelKey: string;
  /** Frequency symbol shown inline (unit, not translated). */
  frequency: string;
}

/** Display metadata for a flash method. */
export interface FlashMethodMeta {
  id: FlashMethod;
  /** i18n key for the method name. */
  nameKey: string;
  /** i18n key for the short description. */
  descriptionKey: string;
}

/** Canonical regulatory-domain metadata, keyed for O(1) lookup below. */
export const REGULATORY_DOMAINS: readonly RegulatoryDomainMeta[] = [
  { id: "ISM2400", labelKey: "wizard.domains.ISM2400", frequency: "2.4 GHz" },
  { id: "FCC915", labelKey: "wizard.domains.FCC915", frequency: "915 MHz" },
  { id: "EU868", labelKey: "wizard.domains.EU868", frequency: "868 MHz" },
  { id: "AU915", labelKey: "wizard.domains.AU915", frequency: "915 MHz" },
  { id: "IN866", labelKey: "wizard.domains.IN866", frequency: "866 MHz" },
  { id: "EU433", labelKey: "wizard.domains.EU433", frequency: "433 MHz" },
] as const;

export const REGULATORY_DOMAIN_BY_ID: Record<
  RegulatoryDomain,
  RegulatoryDomainMeta
> = Object.fromEntries(
  REGULATORY_DOMAINS.map((d) => [d.id, d])
) as Record<RegulatoryDomain, RegulatoryDomainMeta>;

/** Canonical flash-method metadata, in display order. */
export const FLASH_METHODS: readonly FlashMethodMeta[] = [
  {
    id: "wifi",
    nameKey: "wizard.methods.wifi.name",
    descriptionKey: "wizard.methods.wifi.description",
  },
  {
    id: "uart",
    nameKey: "wizard.methods.uart.name",
    descriptionKey: "wizard.methods.uart.description",
  },
  {
    id: "betaflight",
    nameKey: "wizard.methods.betaflight.name",
    descriptionKey: "wizard.methods.betaflight.description",
  },
] as const;

export const FLASH_METHOD_BY_ID: Record<FlashMethod, FlashMethodMeta> =
  Object.fromEntries(FLASH_METHODS.map((m) => [m.id, m])) as Record<
    FlashMethod,
    FlashMethodMeta
  >;

// ---------------------------------------------------------------------------
// ELRS TARGET CATALOGUE (reference data).
// Components read brands/models through `ELRS_BRANDS` and the lookup helpers
// below. The firmware version list shown to the user is fetched live from
// GitHub Releases (FR-FLASH-01); the `firmwareVersions` here are the bundled
// offline fallback only.
// ---------------------------------------------------------------------------

/** Recent ELRS firmware versions reused across most 2.4GHz targets (offline fallback). */
const FW_24 = ["3.5.3", "3.5.2", "3.4.3", "3.3.0"];
/** Sub-GHz targets historically trail the 2.4GHz line slightly. */
const FW_900 = ["3.5.3", "3.5.1", "3.4.3"];

export const ELRS_BRANDS: Brand[] = [
  {
    id: "betafpv",
    name: "BetaFPV",
    models: [
      {
        id: "betafpv-nano-tx-2400",
        name: "Nano TX",
        deviceType: "TX",
        target: "BETAFPV_2400_TX",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "uart", "betaflight"],
      },
      {
        id: "betafpv-micro-tx-1w-2400",
        name: "Micro TX 1W",
        deviceType: "TX",
        target: "BETAFPV_2400_TX_MICRO_1W",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "uart"],
      },
      {
        id: "betafpv-superd-rx-2400",
        name: "SuperD RX",
        deviceType: "RX",
        target: "BETAFPV_2400_RX_SUPERD",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
      {
        id: "betafpv-nano-tx-900",
        name: "900 Nano TX",
        deviceType: "TX",
        target: "BETAFPV_900_TX_NANO",
        mcu: "ESP32",
        domains: ["FCC915", "EU868", "AU915"],
        firmwareVersions: FW_900,
        flashMethods: ["wifi", "uart"],
      },
    ],
  },
  {
    id: "radiomaster",
    name: "RadioMaster",
    models: [
      {
        id: "radiomaster-ranger-2400",
        name: "Ranger",
        deviceType: "TX",
        target: "RADIOMASTER_RANGER_2400",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "uart"],
      },
      {
        id: "radiomaster-ranger-nano-2400",
        name: "Ranger Nano",
        deviceType: "TX",
        target: "RADIOMASTER_RANGER_NANO_2400",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "uart", "betaflight"],
      },
      {
        id: "radiomaster-rp1-rx-2400",
        name: "RP1 RX",
        deviceType: "RX",
        target: "RADIOMASTER_RP1_2400_RX",
        mcu: "ESP8285",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
      {
        id: "radiomaster-bandit-900",
        name: "Bandit",
        deviceType: "TX",
        target: "RADIOMASTER_BANDIT_900",
        mcu: "ESP32",
        domains: ["FCC915", "EU868", "AU915", "IN866"],
        firmwareVersions: FW_900,
        flashMethods: ["wifi", "uart"],
      },
    ],
  },
  {
    id: "happymodel",
    name: "Happymodel",
    models: [
      {
        id: "happymodel-ep1-rx-2400",
        name: "EP1 RX",
        deviceType: "RX",
        target: "HAPPYMODEL_EP_2400_RX",
        mcu: "ESP8285",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
      {
        id: "happymodel-ep2-rx-2400",
        name: "EP2 RX",
        deviceType: "RX",
        target: "HAPPYMODEL_EP2_2400_RX",
        mcu: "ESP8285",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
      {
        id: "happymodel-es900-rx",
        name: "ES900 RX",
        deviceType: "RX",
        target: "HAPPYMODEL_ES900_RX",
        mcu: "ESP8285",
        domains: ["FCC915", "EU868", "EU433"],
        firmwareVersions: FW_900,
        flashMethods: ["wifi", "betaflight"],
      },
    ],
  },
  {
    id: "jumper",
    name: "Jumper",
    models: [
      {
        id: "jumper-aion-nano-tx-2400",
        name: "AION Nano TX",
        deviceType: "TX",
        target: "JUMPER_AION_NANO_2400_TX",
        mcu: "ESP32",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "uart"],
      },
      {
        id: "jumper-aion-rx-2400",
        name: "AION RX",
        deviceType: "RX",
        target: "JUMPER_AION_2400_RX",
        mcu: "ESP8285",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
    ],
  },
  {
    id: "immortalt",
    name: "ImmortalT",
    models: [
      {
        id: "immortalt-rx-2400",
        name: "ImmortalT RX",
        deviceType: "RX",
        target: "IMMORTALT_2400_RX",
        mcu: "ESP8285",
        domains: ["ISM2400"],
        firmwareVersions: FW_24,
        flashMethods: ["wifi", "betaflight"],
      },
      {
        id: "immortalt-900-rx",
        name: "ImmortalT 900 RX",
        deviceType: "RX",
        target: "IMMORTALT_900_RX",
        mcu: "ESP8285",
        domains: ["FCC915", "EU868"],
        firmwareVersions: FW_900,
        flashMethods: ["wifi", "betaflight"],
      },
    ],
  },
];

/**
 * Map a wizard regulatory domain to the ExpressLRS sub-GHz domain index used by
 * the options block (FR-FLASH-03). 2.4GHz hardware ignores the domain, so
 * `ISM2400` maps to `undefined` (the key is omitted from the patch).
 *
 * Indices follow the ELRS options-schema `regulatory.domain.choices` order:
 * `us_433`(0) `us_433_wide`(1) `eu_433`(2) `au_433`(3) `in_866`(4) `eu_868`(5)
 * `au_915`(6) `fcc_915`(7). See `data/elrs_options_schema.json`.
 */
export function domainToElrsIndex(
  domain: RegulatoryDomain | null
): number | undefined {
  switch (domain) {
    case "EU433":
      return 2;
    case "IN866":
      return 4;
    case "EU868":
      return 5;
    case "AU915":
      return 6;
    case "FCC915":
      return 7;
    case "ISM2400":
    default:
      return undefined;
  }
}

/** Find a brand by id. */
export function findBrand(id: string | null): Brand | null {
  if (!id) return null;
  return ELRS_BRANDS.find((b) => b.id === id) ?? null;
}

/** Strip case and non-alphanumerics so "Jumper AION 2400 TX" ≈ "JUMPER_AION_2400_TX". */
function normalizeTarget(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Exact normalized match on a build target. Pass 1 of {@link findTargetByName}. */
function exactTargetMatch(
  needle: string
): { brand: Brand; model: DeviceModel } | null {
  for (const brand of ELRS_BRANDS) {
    for (const model of brand.models) {
      if (normalizeTarget(model.target) === needle) return { brand, model };
    }
  }
  return null;
}

/**
 * Best-effort match a connected device's CRSF `targetName` against the catalogue
 * so the wizard can pre-select it. Tries an exact (normalized) match on the ELRS
 * build target first, then a substring match either direction. Returns null when
 * there's no confident match — never throws — so manual selection stays the
 * fallback (unflashed / RX hardware often can't self-identify).
 *
 * SAFETY: this is a RESOLUTION step, never a comparison. Its fuzziness answers
 * "which catalogue model is this device?", which is a different question from
 * "are these two build targets the same hardware?" — the latter is decided in
 * Rust by `flash::validate::targets_align`, which is EXACT and must stay exact
 * (`BETAFPV_2400_TX` and `BETAFPV_2400_TX_MICRO_1W` overlap but are different
 * radios). Never use this function as a comparison, and never relax
 * `targets_align` to match this function's tolerance. Callers that feed a safety
 * gate go through {@link resolveConnectedTarget}, which returns the resolved
 * catalogue target — so what the gate compares is always two catalogue targets,
 * never a display name.
 */
export function findTargetByName(
  targetName: string | null | undefined
): { brand: Brand; model: DeviceModel } | null {
  if (!targetName) return null;
  const needle = normalizeTarget(targetName);
  if (!needle) return null;

  // Pass 1 — exact normalized match on the build target.
  const exact = exactTargetMatch(needle);
  if (exact) return exact;
  // Pass 2 — case-insensitive substring either direction.
  for (const brand of ELRS_BRANDS) {
    for (const model of brand.models) {
      const hay = normalizeTarget(model.target);
      if (hay.includes(needle) || needle.includes(hay)) return { brand, model };
    }
  }
  return null;
}

/**
 * Resolve a connected device's CRSF name to its catalogue ELRS build target, for
 * the Rust flash guard's `connectedTargetName` (FR-FLASH-10).
 *
 * The CRSF handshake reports a free-form DISPLAY name (`DeviceInfo::name`, e.g.
 * "BetaFPV 2400 TX"), not a build target. Handing that raw string to a gate that
 * compares build targets exactly would refuse correct, legitimate flashes — and
 * a guard that blocks good flashes gets worked around, which is worse than no
 * guard. So the display name is resolved through the catalogue HERE, and only
 * the resolved target crosses the seam.
 *
 * `null` — no name, or a name that maps to no catalogue model — means "no
 * evidence", and the Rust guard abstains on it. A display name we cannot map is
 * never treated as proof of a mismatch.
 *
 * The catalogue lives in this module and nowhere in `src-tauri`, so this is the
 * only side that CAN resolve it.
 *
 * Deliberately EXACT-only — it does not use {@link findTargetByName}'s substring
 * pass. That pass resolves a display name to the shortest containing sibling, so
 * "BetaFPV 2400 TX Micro" lands on `BETAFPV_2400_TX` and a correct
 * `BETAFPV_2400_TX_MICRO_1W` flash would be refused. Costing a real flash to
 * catch a name we only half-recognise is the wrong trade for a safety gate: an
 * unrecognised name abstains and the other guards still run. The substring pass
 * stays in `findTargetByName` for wizard pre-select, where a wrong guess is one
 * click to correct.
 */
export function resolveConnectedTarget(
  targetName: string | null | undefined
): string | null {
  if (!targetName) return null;
  const needle = normalizeTarget(targetName);
  if (!needle) return null;
  return exactTargetMatch(needle)?.model.target ?? null;
}

/** Find a model by id within a brand. */
export function findModel(
  brandId: string | null,
  modelId: string | null
): DeviceModel | null {
  if (!modelId) return null;
  const brand = findBrand(brandId);
  if (!brand) return null;
  return brand.models.find((m) => m.id === modelId) ?? null;
}

// NOTE: the former `mockUidFromPhrase` cosmetic FNV preview was removed in
// M8-API. The binding UID is now derived by the Rust `derive_uid` command (MD5
// of the phrase) via the `useDerivedUid` hook, so the UID shown to the user is
// exactly the one that gets flashed (FR-FLASH-03).
