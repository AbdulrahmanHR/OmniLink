/**
 * Pure telemetry ladder constants (no store, no I/O).
 *
 * The discrete ExpressLRS TX-power and packet-rate ladders live here in a
 * dependency-free module so the pure on-device engine (`@/lib/diagnostics/**`)
 * and other `@/lib/**` modules can read them without importing the impure
 * Zustand store layer. `@/stores/telemetry` re-exports both for back-compat, so
 * every existing `@/stores/telemetry` importer keeps working unchanged.
 */

/** Discrete ExpressLRS TX power steps (mW). */
export const TX_POWER_STEPS = [10, 25, 50, 100, 250, 500] as const;

/** Discrete ExpressLRS packet rates (Hz). */
export const PACKET_RATES = [50, 150, 250, 500] as const;
