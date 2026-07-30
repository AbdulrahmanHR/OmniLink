/**
 * Pure controller-bridge labeling model for the M63 discovery feature.
 *
 * When a Betaflight/iNav flight controller is the path to an ELRS receiver, we
 * LABEL it as a passthrough bridge candidate — never as a managed device, and
 * never as a plain ELRS TX/RX or Backpack. These helpers map the Rust
 * {@link BridgeClassificationDto} (from `flash/bridge.rs`) to i18n keys and small
 * predicates the UI + tests share.
 *
 * Everything here is PURE and deterministic: no clock, no randomness, no I/O.
 */

import type {
  BridgeClassificationDto,
  BridgeContextDto,
  BridgeFamilyDto,
  PassthroughCheckReportDto,
  PassthroughFailureDto,
  PassthroughStepDto,
  PassthroughStepStatusDto,
} from "@/lib/tauri";

/**
 * i18n key for a bridge family label:
 *  - `"betaflight"` → `bridge.family.betaflight`
 *  - `"inav"`       → `bridge.family.inav`
 *  - `"unknown"`    → `bridge.family.unsupported`
 *
 * `"unknown"` maps to the "unsupported bridge" copy: an FC variant outside the
 * supported Betaflight/iNav set is surfaced as unsupported, never misclassified.
 */
export function bridgeFamilyLabelKey(family: BridgeFamilyDto): string {
  switch (family) {
    case "betaflight":
      return "bridge.family.betaflight";
    case "inav":
      return "bridge.family.inav";
    case "unknown":
      return "bridge.family.unsupported";
  }
}

/**
 * True only when the classification is a recognized controller-bridge candidate
 * (`kind === "bridge"`). This is the zero-false-positive gate: a `notAController`
 * (e.g. an ELRS RX speaking CRSF) or an `unsupportedBridge` is never a candidate.
 */
export function isBridgeCandidate(
  classification: BridgeClassificationDto | null | undefined,
): classification is Extract<BridgeClassificationDto, { kind: "bridge" }> {
  return classification?.kind === "bridge";
}

/**
 * Whether a classification should render a {@link BridgeLabel} chip. Both a
 * supported bridge AND an unsupported bridge are *labeled* (the latter so the
 * user understands why it cannot be used); a `notAController` shows recovery
 * guidance instead and so is not labeled.
 */
export function isLabeledBridge(
  classification: BridgeClassificationDto | null | undefined,
): classification is Extract<
  BridgeClassificationDto,
  { kind: "bridge" | "unsupportedBridge" }
> {
  return (
    classification?.kind === "bridge" ||
    classification?.kind === "unsupportedBridge"
  );
}

/**
 * Whether the bridge store's result belongs to some OTHER port than the one
 * being rendered — i.e. it is stale for this surface.
 *
 * The probe control is re-rendered with a new `port` whenever the picker
 * selection or the hotplug watcher moves it, while the (single, non-persisted)
 * store still holds the previous port's classification. Without this check the
 * popover labelled the newly selected device with ANOTHER device's result — and
 * offered it that result's passthrough check. A classification belongs to the
 * port it was taken on; anything else is dropped, never re-attributed.
 */
export function isStaleBridgeResult(
  probedPort: string | null | undefined,
  port: string
): boolean {
  return probedPort != null && probedPort !== port;
}

/**
 * The ordered i18n keys for the controller-bridge recovery hints shown when a
 * probe fails or returns `notAController`. Mirrors the Rust open/baud failure
 * mapping in `commands/bridge.rs`: wrong port, busy port, wrong baud, no MSP
 * response.
 */
export const BRIDGE_RECOVERY_KEYS = [
  "bridge.recovery.wrongPort",
  "bridge.recovery.busyPort",
  "bridge.recovery.wrongBaud",
  "bridge.recovery.noMspResponse",
] as const;

// ---------------------------------------------------------------------------
// M64: passthrough-diagnostics labeling model. Pure mappers from the Rust
// {@link PassthroughCheckReportDto} (from `flash/bridge.rs`) to i18n keys + small
// predicates the guided-check UI, the baud override, the event log and the
// tests share. No clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

/**
 * Common FC passthrough bauds offered in the manual override (mirrors the Rust
 * `COMMON_FC_BAUDS`, 420000 first). The check still runs the FULL fallback
 * discipline backend-side — the override only picks which rate is tried first.
 */
export const PASSTHROUGH_BAUDS = [420000, 115200, 230400, 460800] as const;

/**
 * The ordered guided-check steps, so the stepper can render the full sequence
 * (with each step's pass/fail/skipped/pending state) even before a report lands.
 * Mirrors the Rust `PASSTHROUGH_STEPS`.
 */
export const PASSTHROUGH_STEPS: readonly PassthroughStepDto[] = [
  "handshake",
  "uart",
  "receiver",
  "crsf",
] as const;

/** i18n key for a step label → `bridge.passthrough.step.<step>`. */
export function passthroughStepLabelKey(step: PassthroughStepDto): string {
  return `bridge.passthrough.step.${step}`;
}

/**
 * i18n key for a failure category's headline + recovery copy →
 * `bridge.passthrough.failure.<failure>`. The single source mapping a backend
 * {@link PassthroughFailureDto} to its specific, actionable display copy (NOT a
 * generic flash error) — the M64 acceptance.
 */
export function passthroughFailureLabelKey(
  failure: PassthroughFailureDto
): string {
  return `bridge.passthrough.failure.${failure}`;
}

/**
 * The per-step status to render in the stepper for `step`, given a report (or
 * `null` before/while running). Steps after the report's last-recorded one (and
 * all steps while `null`) are `"pending"`; otherwise the recorded pass/fail/
 * skipped is used.
 */
export function passthroughStepStatus(
  report: PassthroughCheckReportDto | null | undefined,
  step: PassthroughStepDto
): PassthroughStepStatusDto | "pending" {
  const outcome = report?.steps.find((o) => o.step === step);
  return outcome?.status ?? "pending";
}

/** True when the report is a full pass (no failure). */
export function isPassthroughSuccess(
  report: PassthroughCheckReportDto | null | undefined
): boolean {
  return !!report && report.failure === null;
}

/**
 * The ordered i18n keys for the GENERIC controller→RX wiring guidance (D29).
 * ORIGINAL copy authored for OmniLink — no third-party/board-specific diagrams.
 * Covers the four things a user must get right before passthrough can work:
 * cross-wired TX/RX, shared ground, RX power, and selecting the FC UART the RX
 * is actually wired to. Surfaced in the guided check.
 */
export const PASSTHROUGH_WIRING_KEYS = [
  "bridge.passthrough.wiring.tx",
  "bridge.passthrough.wiring.rx",
  "bridge.passthrough.wiring.power",
  "bridge.passthrough.wiring.uart",
] as const;

// ---------------------------------------------------------------------------
// M65: read-only controller-context labeling model. Pure mappers + predicates
// from the Rust {@link BridgeContextDto} to i18n keys, shared by the display-only
// context surface and its tests. No clock, no randomness, no I/O — and NOTHING
// here can mutate the controller (the surface is read-only by construction).
// ---------------------------------------------------------------------------

/**
 * The coarse serial-port function labels the backend emits (mirrors the Rust
 * `KNOWN_PORT_FUNCTIONS`). Only these survive sanitization; anything else is
 * dropped to `null`.
 */
export const BRIDGE_PORT_FUNCTIONS = [
  "serialRx",
  "msp",
  "gps",
  "telemetry",
  "blackbox",
] as const;

export type BridgePortFunction = (typeof BRIDGE_PORT_FUNCTIONS)[number];

/**
 * i18n key for a coarse serial-port function label →
 * `bridge.context.function.<fn>`, or `null` for an absent/unrecognized function
 * (so the UI can fall back to showing nothing rather than a missing key).
 */
export function bridgePortFunctionLabelKey(
  fn: string | null | undefined
): string | null {
  if (!fn) return null;
  return (BRIDGE_PORT_FUNCTIONS as readonly string[]).includes(fn)
    ? `bridge.context.function.${fn}`
    : null;
}

/**
 * Whether a fetched context carries NOTHING useful for ELRS troubleshooting —
 * no FC variant, no version, and no serial ports — which drives the
 * "not enough controller context" empty state. `null`/`undefined` is empty too.
 */
export function isBridgeContextEmpty(
  ctx: BridgeContextDto | null | undefined
): boolean {
  if (!ctx) return true;
  return (
    !ctx.fcVariant &&
    !ctx.apiVersion &&
    !ctx.fcVersion &&
    (ctx.serialPorts?.length ?? 0) === 0
  );
}
