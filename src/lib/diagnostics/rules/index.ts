/**
 * The diagnostic rule registry (M36).
 *
 * Exports {@link ALL_RULES} in a **deterministic** order so the engine's findings
 * concatenation is reproducible. Re-exports each rule (and its id/explanation
 * constants) for direct use and tests.
 */

import type { DiagnosticRule } from "../types";
import { lqCollapseRule } from "./lq-collapse";
import { rssiFloorRule } from "./rssi-floor";
import { snrNoiseRule } from "./snr-noise";
import { packetInstabilityRule } from "./packet-instability";
import { txPowerSaturationRule } from "./tx-power-saturation";

export * from "./lq-collapse";
export * from "./rssi-floor";
export * from "./snr-noise";
export * from "./packet-instability";
export * from "./tx-power-saturation";

/**
 * All diagnostic rules, in deterministic evaluation order:
 * `lq-collapse`, `rssi-floor`, `snr-noise`, `packet-instability`,
 * `tx-power-saturation`.
 */
export const ALL_RULES: readonly DiagnosticRule[] = [
  lqCollapseRule,
  rssiFloorRule,
  snrNoiseRule,
  packetInstabilityRule,
  txPowerSaturationRule,
];
