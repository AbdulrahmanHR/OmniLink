/**
 * Pure Backpack-discovery model for the M19 ExpressLRS Backpack scanner.
 *
 * ExpressLRS Backpack devices (the TX-side telemetry/control bridge and the
 * VRX-side video receiver companion) expose their own WiFi self-AP just like a
 * plain ELRS device, but under distinct SSIDs ("ExpressLRS TX Backpack" /
 * "ExpressLRS VRX Backpack"). The M18 self-AP classifier in `wifiDiscovery.ts`
 * deliberately REJECTS those SSIDs (see {@link classifyElrsSsid}); this module
 * is the exact INVERSE — it ACCEPTS precisely those Backpack SSIDs and refuses
 * everything the M18 classifier claims. The two are complementary: a Backpack
 * SSID is accepted here AND still rejected there, so it can never leak into the
 * plain TX/RX list.
 *
 * Everything here is PURE and deterministic: no clock, no randomness, no I/O.
 * The transforms are shared verbatim by the Backpack scanner side, the WiFi
 * store and the unit tests.
 */

import type { WifiDevice } from "@/lib/wifiDiscovery";

/** Captive-portal HTTP API address every ELRS Backpack self-AP serves from. */
const AP_ADDRESS = "10.0.0.1";

/**
 * The two Backpack roles this module recognises. These are exactly the two
 * Backpack members the M19 lead added to `WifiDeviceKind`, so a value here is
 * assignable to a {@link WifiDevice} `kind` without widening.
 */
export type BackpackKind = "tx-backpack" | "vrx-backpack";

/**
 * A flashable Backpack target loaded from `data/targets/backpack.json`.
 *
 * `repoAsset` names the firmware asset to fetch/flash for this target; `id` is a
 * stable key and `name` is the human label shown in the picker.
 */
export interface BackpackTarget {
  id: string;
  name: string;
  kind: BackpackKind;
  repoAsset: string;
}

/**
 * Collapse runs of whitespace to single spaces and trim, lower-cased.
 *
 * Identical to `wifiDiscovery.normalize` so the two complementary classifiers
 * tokenize SSIDs the same way (case-insensitive, whitespace-tolerant).
 */
function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Classify a scanned SSID as an ExpressLRS Backpack self-AP and infer its role.
 *
 * Accepts the self-AP names "ExpressLRS TX Backpack" / "ExpressLRS VRX
 * Backpack", case-insensitively and whitespace-tolerantly (whitespace is
 * collapsed), with an optional trailing suffix/number ("ExpressLRS TX
 * Backpack 02", "expresslrs  tx  backpack 02").
 *
 * An SSID is a Backpack iff it contains BOTH the "expresslrs" token AND
 * "backpack". Role is then resolved: presence of the "vrx" substring => VRX
 * ("vrx-backpack"); otherwise a whole-word "tx" token => TX ("tx-backpack").
 * The whole-word match means "txt"-style noise does NOT count as TX.
 *
 * Anything missing "expresslrs" or "backpack", or carrying "backpack" with
 * neither role token ("ExpressLRS Backpack"), yields
 * `{ isBackpack:false, kind:null }`. This is the exact inverse of
 * {@link classifyElrsSsid}, which rejects every SSID accepted here.
 */
export function classifyBackpackSsid(ssid: string): {
  isBackpack: boolean;
  kind: BackpackKind | null;
} {
  const normalized = normalize(ssid);

  // Must look like an ExpressLRS Backpack self-AP to be claimed by M19.
  if (!normalized.includes("expresslrs") || !normalized.includes("backpack")) {
    return { isBackpack: false, kind: null };
  }

  // VRX is detected by substring; TX is a whole-word token so "txt" etc. miss.
  if (normalized.includes("vrx")) {
    return { isBackpack: true, kind: "vrx-backpack" };
  }
  if (/(^|\s)tx(\s|$)/.test(normalized)) {
    return { isBackpack: true, kind: "tx-backpack" };
  }

  // "backpack" + "expresslrs" but neither role token => not a Backpack self-AP.
  return { isBackpack: false, kind: null };
}

/**
 * Map a Backpack self-AP SSID to a {@link WifiDevice}, or `null` when the SSID
 * is not a Backpack self-AP per {@link classifyBackpackSsid}. The id is keyed
 * on the raw SSID (`ap:${ssid}`) and the address is always the captive-portal
 * {@link AP_ADDRESS}.
 */
export function backpackSsidToDevice(ssid: string): WifiDevice | null {
  const { isBackpack, kind } = classifyBackpackSsid(ssid);
  if (!isBackpack || kind === null) return null;
  return {
    id: `ap:${ssid}`,
    name: ssid,
    address: AP_ADDRESS,
    source: "ap",
    kind,
  };
}

/**
 * The Backpack role of a discovered WiFi device, or `null` when the row is not
 * a Backpack at all (a plain ELRS TX/RX, or an unclassified self-AP).
 *
 * The single place the `WifiDeviceKind` union is narrowed to a
 * {@link BackpackKind}, so the wizard's OTA-destination checks and the
 * `connectedBackpackKind` it puts on the flash request can never drift apart.
 */
export function wifiDeviceBackpackKind(
  kind: WifiDevice["kind"]
): BackpackKind | null {
  return kind === "tx-backpack" || kind === "vrx-backpack" ? kind : null;
}

/** i18n key for a Backpack role: "backpack.kind.tx" / "backpack.kind.vrx". */
export function backpackKindLabelKey(kind: BackpackKind): string {
  return kind === "vrx-backpack" ? "backpack.kind.vrx" : "backpack.kind.tx";
}

/** Narrow an unknown value to a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Narrow an unknown value to a valid {@link BackpackKind}. */
function isBackpackKind(value: unknown): value is BackpackKind {
  return value === "tx-backpack" || value === "vrx-backpack";
}

/**
 * Validate one raw entry into a {@link BackpackTarget}, or `null` when it is
 * malformed (`id`/`name`/`repoAsset` must be non-empty strings and `kind` must
 * be exactly one of the two Backpack roles).
 */
function parseBackpackTarget(raw: unknown): BackpackTarget | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(entry.id) ||
    !isNonEmptyString(entry.name) ||
    !isNonEmptyString(entry.repoAsset) ||
    !isBackpackKind(entry.kind)
  ) {
    return null;
  }
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    repoAsset: entry.repoAsset,
  };
}

/**
 * Parse the raw parsed-JSON of `data/targets/backpack.json` into a validated
 * {@link BackpackTarget} list.
 *
 * Accepts either the wrapped shape `{ targets: BackpackTarget[] }` or a bare
 * array, defensively. Malformed entries are dropped (never throws), and any
 * non-object/non-array input yields `[]`. Output order mirrors input order.
 */
export function parseBackpackTargets(raw: unknown): BackpackTarget[] {
  let list: unknown;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "object" && raw !== null) {
    list = (raw as Record<string, unknown>).targets;
  } else {
    return [];
  }

  if (!Array.isArray(list)) return [];

  const targets: BackpackTarget[] = [];
  for (const item of list) {
    const target = parseBackpackTarget(item);
    if (target !== null) targets.push(target);
  }
  return targets;
}

/**
 * FR-FLASH-10 cross-type guard: returns `true` when the selected target's role
 * differs from the connected device's role — i.e. the flash MUST be BLOCKED to
 * avoid writing TX firmware to a VRX Backpack or vice-versa. `false` means the
 * roles match and the flash may proceed.
 */
export function isBackpackCrossTypeFlash(
  targetKind: BackpackKind,
  deviceKind: BackpackKind,
): boolean {
  return targetKind !== deviceKind;
}
