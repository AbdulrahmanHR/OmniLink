import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import {
  findBrand,
  findModel,
  findTargetByName,
  REGULATORY_DOMAIN_BY_ID,
  type FlashMethod,
  type RegulatoryDomain,
} from "@/lib/elrsTargets";
import type { WizardTargetSelection } from "@/lib/aiContext";
import type { ProfileSettings } from "@/lib/profileSettings";
import {
  cancelFlash,
  onFlashCancelled,
  onFlashDone,
  onFlashError,
  onFlashLog,
  onFlashProgress,
  saveProfile,
  startFlash as invokeStartFlash,
  type FlashCancelOutcome,
  type FlashErrorPayload,
  type FlashRequestPayload,
  type StoredProfileDto,
} from "@/lib/tauri";
import { useDeviceStore, type DeviceInfo } from "@/stores/device";

/** Ordered finite set of wizard steps. */
export const WIZARD_STEPS = [
  "brand",
  "model",
  "frequency",
  "binding",
  "review",
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Which wizard experience is active (M53). A **parallel** UI flag — NOT a new
 * step, so {@link WIZARD_STEPS} is untouched and every existing step-validity /
 * navigation helper is unchanged:
 *   - `static` — the deterministic, offline, account-free flashing wizard (the
 *     default and the always-available fallback per D20).
 *   - `ai` — the optional adaptive, AI-assisted mode that suggests a target +
 *     settings and hands off to the SAME `review` step to confirm/flash.
 */
export type WizardMode = "static" | "ai";

/**
 * Lifecycle of the real flash sequence (M8-API). Driven by the Rust
 * `start_flash` worker via the `flash://*` events; a user cancel lands back on
 * `idle` (never `error`).
 */
export type FlashStatus = "idle" | "running" | "done" | "error";

/** Discrete stages reported by the backend during a real flash (FR-FLASH-07). */
export type FlashStage = "fetch" | "erase" | "write" | "verify" | "done";

interface FlashState {
  status: FlashStatus;
  /** Progress 0–100 (raw; round for display). */
  percent: number;
  stage: FlashStage;
  /** Estimated seconds remaining (FR-FLASH-07); null until estimable. */
  etaSeconds: number | null;
  /** Streamed build/upload log lines (FR-FLASH-06). */
  log: string[];
  /** Categorized failure detail, present only when status === "error". */
  error: FlashErrorPayload | null;
  /**
   * M25: set when the best-effort pre-flash config backup for a local-file flash
   * could not be taken. Surfaced as a non-blocking warning — the flash still
   * proceeds, but the user is told there is no fresh recovery snapshot.
   */
  backupWarning: boolean;
}

/** A device-identity guard refusal, remembered per destination + selection. */
export interface IdentityRefusal {
  /** Serial port the refused flash was aimed at (`null` for a WiFi OTA). */
  port: string | null;
  /** Build target the wizard had selected when it was refused. */
  target: string;
}

interface WizardSelections {
  brandId: string | null;
  modelId: string | null;
  domain: RegulatoryDomain | null;
  firmwareVersion: string | null;
  flashMethod: FlashMethod | null;
  /** When true, skip the binding phrase and use button/3-way binding. */
  useTraditionalBinding: boolean;
  bindingPhrase: string;
  /** Device IP/host for WiFi OTA (FR-FLASH-09); only used when method=wifi. */
  deviceIp: string;
  /**
   * M25: absolute path of a user-selected local firmware `.bin`, or null to use
   * a GitHub release. A local file is an alternative firmware *source*
   * (mutually exclusive with {@link firmwareVersion}); the transport/method is
   * still chosen separately.
   */
  localFirmwarePath: string | null;
  /** Display basename of {@link localFirmwarePath} (null when none picked). */
  localFirmwareName: string | null;
}

interface WizardState extends WizardSelections {
  step: WizardStep;
  /**
   * Active wizard experience (M53). Defaults to `static` and is orthogonal to
   * the step machine — it selects which surface `WizardPage` renders, never which
   * step is valid. The AI-assisted mode applies its suggestion through the SAME
   * selection setters + `goToStep("review")`, so it can never bypass the static
   * confirm/flash gate.
   */
  wizardMode: WizardMode;
  flash: FlashState;
  /**
   * The `(port, target)` pair a device-identity guard (FR-FLASH-10) has already
   * refused, or null.
   *
   * The refusal has to be STICKY because the flash that earned it is also what
   * removed the proof: a serial flash disconnects the device before the engine
   * evaluates the guards, so the "try again" the error screen offers used to be
   * a click that sent `connectedDeviceType: null` + `connectedTargetName: null`,
   * abstained both guards, and wrote the refused image. The identity itself now
   * survives the disconnect (`lastIdentity` in `stores/device.ts`), so the retry
   * is refused on its own merits too — this is the belt to that braces: the
   * click is answered up front, in the wizard, instead of by re-running a flash
   * whose answer is already known.
   *
   * Consumed by `StepReview`, which lifts it as soon as a device is connected
   * again (a live handshake is better evidence than a remembered refusal) or the
   * selection moves to another model/port. Cleared by a flash that completes.
   */
  identityRefusal: IdentityRefusal | null;
  /**
   * CRSF target name of a connected device that was auto-matched to the
   * catalogue, surfaced as a "Detected" hint. Cleared once the user touches the
   * brand/model picker (a manual choice always wins).
   */
  detectedTargetName: string | null;

  // Navigation
  next: () => void;
  back: () => void;
  goToStep: (step: WizardStep) => void;

  /** Switch between the static and AI-assisted wizard experiences (M53). */
  setWizardMode: (mode: WizardMode) => void;

  /**
   * Best-effort: if a device is connected with a recognized CRSF target and the
   * user hasn't picked anything yet, pre-select its brand/model. No-op when
   * there's no device or no confident match. Never throws.
   */
  autoDetectFromDevice: () => void;

  // Selections (each resets the now-invalid downstream selections)
  selectBrand: (brandId: string) => void;
  selectModel: (modelId: string) => void;
  selectDomain: (domain: RegulatoryDomain) => void;
  selectFirmware: (version: string) => void;
  /**
   * M25: pick a local firmware `.bin` (absolute `path`) as the firmware source,
   * or pass `null` to clear it and return to release-based selection. Picking a
   * file clears any selected release version (the two sources are exclusive).
   */
  selectLocalFirmware: (path: string | null) => void;
  selectFlashMethod: (method: FlashMethod) => void;
  setBindingPhrase: (phrase: string) => void;
  setUseTraditionalBinding: (value: boolean) => void;
  setDeviceIp: (ip: string) => void;

  // Real flash (M8-API) + reset
  /**
   * Start a flash. For a local-file flash (`request.localFilePath` set), a
   * best-effort config backup is taken first (M25), named with the
   * caller-supplied localized `recoveryProfileName`; failure is non-blocking and
   * surfaces via `flash.backupWarning`.
   */
  startFlash: (
    request: FlashRequestPayload,
    recoveryProfileName?: string
  ) => Promise<void>;
  cancelFlash: () => Promise<void>;
  resetFlash: () => void;
  reset: () => void;
}

const INITIAL_SELECTIONS: WizardSelections = {
  brandId: null,
  modelId: null,
  domain: null,
  firmwareVersion: null,
  flashMethod: null,
  useTraditionalBinding: false,
  bindingPhrase: "",
  // Common ELRS soft-AP address; the field is editable in the wizard.
  deviceIp: "10.0.0.1",
  localFirmwarePath: null,
  localFirmwareName: null,
};

const IDLE_FLASH: FlashState = {
  status: "idle",
  percent: 0,
  stage: "fetch",
  etaSeconds: null,
  log: [],
  error: null,
  backupWarning: false,
};

// ---------------------------------------------------------------------------
// Real flash driver (M8-API). `startFlash` invokes the Rust `start_flash`
// command; progress/log/done/error all arrive via the `flash://*` events.
// The listeners are registered lazily on first use (idempotent, like the
// device store) and drive the `flash` slice of this store. While a flash runs
// the device store status is set to "flashing"; how it is settled afterwards
// depends on whether the flash took the serial port (see
// `settleDeviceAfterFlash`).
// ---------------------------------------------------------------------------

/** Cap the retained log so a chatty PlatformIO build can't grow unbounded. */
const MAX_LOG_LINES = 2000;

/**
 * The "couldn't start flashing" slice — the worker never ran, so NOTHING was
 * written to the device.
 *
 * Shared by every pre-worker refusal (a dead `flash://*` bridge, a CRSF
 * handshake in flight) and by an `invoke` that never reached the worker: the
 * caller is `void startFlash(...)`, so a refusal that only returned would be an
 * invisible dead click.
 */
function startFailed(detail: string): Pick<FlashState, "status" | "error"> {
  return {
    status: "error",
    error: {
      category: "unknown",
      summaryKey: "startFailed",
      detail,
      recoverySteps: ["retry"],
      diagnostic: detail,
    },
  };
}

/** Guards against registering the `flash://*` listeners more than once. */
let flashListenersReady: Promise<void> | null = null;

/** The per-flash state the settle is keyed on (see {@link activeFlash}). */
interface FlashSession {
  /**
   * Whether this flash took the serial port away from the CRSF reader
   * (uart/betaflight). Decides how the device store is settled on completion.
   */
  releasedPort: boolean;
}

/**
 * The one flash this store is driving, or null when none is running.
 *
 * Two jobs, both of which a module-global boolean did badly:
 *
 *  - It is the flash LOCKOUT (FLASH-3), and it is claimed SYNCHRONOUSLY at the
 *    top of `startFlash`. The old guard read `flash.status === "running"`, which
 *    is not set until four awaits later — one of them a real IPC round trip
 *    (`disconnect()` joins the reader thread) — so a second click landed inside
 *    that window and ran the whole preamble again.
 *  - It IDENTIFIES the flash a settle belongs to. The second call above reached
 *    `start_flash`, was refused by the backend, and its `catch` settled: with a
 *    shared flag that settle consumed the WINNER's teardown, running
 *    `device.reset()` while flash A was writing — re-enabling the picker,
 *    Connect and the bridge probe over the port esptool owned, and turning the
 *    later `flash://done` into a no-op. Keyed on identity, a losing call's
 *    settle is inert.
 */
let activeFlash: FlashSession | null = null;

/**
 * The request the most recent flash was started with, or null before the first
 * one. Deliberately NOT cleared on completion: the `flash://*` handlers run
 * after the worker is gone and still need to know what was attempted — which
 * device an OTA addressed (`settleDeviceAfterFlash`) and which
 * `(port, target)` pair a guard refused ({@link WizardState.identityRefusal}).
 */
let lastFlashRequest: FlashRequestPayload | null = null;

/** How a flash ended, as reported by the `flash://*` events. */
type FlashOutcome = "done" | "error" | "cancelled";

/**
 * Whether a port-preserving (WiFi OTA) flash actually addressed the device we
 * are connected to over serial — the only case in which it can have invalidated
 * anything the handshake read.
 *
 * The two transports share no handle: a CRSF link is a serial port, an OTA is
 * an IP on the network. What the request DOES carry is the identity of both
 * ends — `connectedTargetName` is the connected device resolved to a catalogue
 * target, `target` is what the OTA wrote — so equal targets is the evidence
 * that the radio on the desk is the one that was just re-flashed. Anything else
 * (a different model, or a name the catalogue could not resolve) is not
 * evidence that the connected device was touched, and guessing costs the very
 * identity the FR-FLASH-10 guards run on.
 */
function otaAddressedConnectedDevice(
  request: FlashRequestPayload | null
): boolean {
  const connected = request?.connectedTargetName;
  return Boolean(connected) && connected === request?.target;
}

/**
 * Summary keys of the two device-IDENTITY guards (FR-FLASH-10). Their evidence
 * is the connected device rather than the firmware image, so it is the evidence
 * a serial flash destroys on its way past them — see
 * {@link WizardState.identityRefusal}.
 */
const IDENTITY_REFUSAL_KEYS = ["txRxMismatch", "connectedTargetMismatch"];

/**
 * Whether a transport needs exclusive ownership of the serial port. Mirrors
 * `method_holds_serial_port` in `src-tauri/src/commands/flash.rs`: the serial
 * transports do, WiFi OTA (HTTP) does not and must never disturb a live CRSF
 * connection.
 */
function methodHoldsSerialPort(method: FlashRequestPayload["method"]): boolean {
  return method === "uart" || method === "betaflight";
}

/**
 * Whether the flash has passed the **point of no return** — the device's flash
 * memory is being rewritten, so stopping now would leave a truncated image
 * (a bricked device).
 *
 * Mirrors `FlashCancel::enter_write` in `src-tauri/src/flash/cancel.rs`, which
 * the uploaders take immediately before esptool is spawned / the OTA POST goes
 * out — i.e. exactly when the `write` stage is announced. The backend refuses a
 * cancel from that instant on (returning `writeInProgress`), so gating the UI on
 * the same stage means the control disappears precisely when it stops working.
 */
export function isPointOfNoReturn(stage: FlashStage): boolean {
  return stage === "write" || stage === "verify" || stage === "done";
}

/**
 * Whether the user may still cancel: a flash that is actually running and has
 * not yet started writing to the device (FLASH-4/FLASH-11).
 */
export function canCancelFlash(status: FlashStatus, stage: FlashStage): boolean {
  return status === "running" && !isPointOfNoReturn(stage);
}

function ensureFlashListeners(set: FlashSetter): Promise<void> {
  if (!flashListenersReady) {
    flashListenersReady = (async () => {
      // FLASH-12: `allSettled`, never `all` (the same care `stores/device.ts`
      // takes). With `all`, a rejection discarded the handles that HAD resolved
      // — never collected, never removed — and the rejected promise stayed
      // CACHED forever, so every later `startFlash` threw here before touching
      // any state: the caller is `void startFlash(...)`, so the click was a
      // silent no-op plus an unhandled rejection for the rest of the session.
      const results = await Promise.allSettled([
        onFlashProgress((p) =>
          set((s) => ({
            flash: {
              ...s.flash,
              status: "running",
              percent: p.percent,
              stage: p.stage,
              etaSeconds: p.etaSeconds ?? null,
            },
          }))
        ),
        onFlashLog((l) =>
          set((s) => ({
            flash: {
              ...s.flash,
              log: [...s.flash.log, l.line].slice(-MAX_LOG_LINES),
            },
          }))
        ),
        onFlashDone(() => {
          settleDeviceAfterFlash("done");
          set((s) => ({
            flash: { ...s.flash, status: "done", percent: 100, stage: "done" },
            // A flash that ran all the way through was guarded on the way in,
            // so whatever a previous attempt refused has been resolved.
            identityRefusal: null,
          }));
        }),
        onFlashError((err) => {
          settleDeviceAfterFlash("error");
          set((s) => ({
            flash: { ...s.flash, status: "error", error: err },
            // FR-FLASH-10: remember an identity refusal, because the flash has
            // just destroyed the state the user would read it from — the click
            // that produced it also dropped the CRSF link, so the "try again"
            // this error offers must not be allowed to run unguarded (see
            // `identityRefusal`).
            ...(IDENTITY_REFUSAL_KEYS.includes(err.summaryKey) &&
            lastFlashRequest
              ? {
                  identityRefusal: {
                    port: lastFlashRequest.port ?? null,
                    target: lastFlashRequest.target,
                  },
                }
              : {}),
          }));
        }),
        // A cancel is a distinct outcome (MINOR 4): the backend emits
        // `flash://cancelled` instead of `flash://error`, so we land on idle
        // and never show a spurious error.
        onFlashCancelled(() => {
          settleDeviceAfterFlash("cancelled");
          set(() => ({ flash: { ...IDLE_FLASH } }));
        }),
      ]);
      const unlisteners = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : []
      );
      const failure = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (failure) {
        // Partial registration: remove what DID land, so a retry starts from
        // zero listeners instead of doubling up the survivors.
        unlisteners.forEach((un) => un());
        throw failure.reason;
      }
    })().catch((e: unknown) => {
      // `listen()` rejects outside Tauri (browser/dev) and can fail transiently.
      // Drop the cache so the NEXT `startFlash` re-registers, and re-throw so
      // the caller turns it into a visible flash error rather than a dead click.
      flashListenersReady = null;
      throw e;
    });
  }
  return flashListenersReady;
}

/**
 * Settle the device store once a flash finishes (done / error / cancelled).
 *
 * * Serial flash (the port was released, CONN-1): the device has rebooted —
 *   possibly into different firmware — so the cached identity (target name,
 *   firmware version, param count, baud) is stale and MUST NOT be shown as if it
 *   were live (CONN-6). Clear it and land on "disconnected"; `selectedPort` is
 *   untouched, so the flashed port stays pre-selected and the user reconnects
 *   with one click once the device finishes rebooting. Deliberately NOT an
 *   auto-reconnect: after esptool resets the MCU the port often re-enumerates
 *   (and a Betaflight passthrough FC always does), so an immediate CRSF
 *   handshake would race the reboot and usually fail with a scary
 *   "device stayed silent" error.
 * * WiFi OTA (the port was never touched): RECOMPUTED from what is actually
 *   left, never restored from a pre-flash snapshot (CONN-11). The snapshot lied
 *   in both directions — a flash started from "connecting" restored a spinner
 *   with no reader behind it and no pending event, permanently inert because
 *   `canClaimPort("connecting")` is false; and a device unplugged mid-OTA
 *   restored "connected" with a null identity (green dot, Disconnect button, no
 *   device chip, a telemetry session that never receives a frame). The link
 *   counts as live only if an identity survived the flash; otherwise we land on
 *   "error" with the message the flashing-guarded handler retained, or on
 *   "disconnected".
 *
 *   What the OTA invalidates is NARROW, and used not to be. Dropping the whole
 *   identity on every port-preserving outcome produced exactly the shape
 *   described above — `connected` with a null device — for a flash that never
 *   went near the connected device: an OTA writes to an IP on the network, the
 *   serial CRSF reader is untouched and still live, and on `cancelled` nothing
 *   was written at all. It also silently disarmed the FR-FLASH-10 guards for
 *   the NEXT flash (no `connectedDeviceType`, no `connectedTargetName`, no
 *   `backupTarget`) with nothing on screen to say so. So: only a COMPLETED OTA
 *   that actually addressed this device changes anything, and what it changes
 *   is the FIRMWARE, not the hardware — the version word is dropped (the bar
 *   renders "unknown" and the next `backupTarget` records `null` rather than a
 *   v3.4.3 the device no longer runs), while the target name / class the guards
 *   depend on stay exactly as the handshake read them.
 *
 * Idempotent — `cancelFlash()` and the `flash://cancelled` event both call it.
 * `session` identifies the flash being settled and defaults to the active one;
 * a call carrying any other (a refused second click, an `invoke` that rejects
 * after the `flash://*` events already landed) is a no-op, so it can never run
 * a still-running flash's teardown. See {@link activeFlash}.
 */
function settleDeviceAfterFlash(
  outcome: FlashOutcome,
  session: FlashSession | null = activeFlash
): void {
  if (session === null || session !== activeFlash) return;
  activeFlash = null;
  const device = useDeviceStore.getState();
  if (session.releasedPort) {
    // Unconditional (no `status === "flashing"` guard): a `device://*` event
    // that landed first must not leave a half-settled, stale-identity state.
    device.reset();
    return;
  }
  // Anything other than "flashing" means the user has moved on since the flash
  // started (a reconnect while the OTA ran) — don't stomp what they have done.
  if (device.status !== "flashing") return;
  // The guarded `device://*` handlers null the identity out the moment the link
  // actually drops, so its survival IS the liveness signal.
  if (device.device === null) {
    // `error` holds the message the flashing guard suppressed, if any — and one
    // from THIS flash only, because `startFlash` clears the field on the way
    // into "flashing" (see there).
    device.setStatus(device.error ? "error" : "disconnected");
    return;
  }
  if (outcome === "done" && otaAddressedConnectedDevice(lastFlashRequest)) {
    device.setDevice({ ...device.device, firmwareVersion: null });
  }
  device.setStatus("connected");
}

type FlashSetter = (
  partial: (state: WizardState) => Partial<WizardState>
) => void;

// ---------------------------------------------------------------------------
// Step validity. Pure helpers exported so components can subscribe to a derived
// boolean (and only re-render when it flips) via a selector.
// ---------------------------------------------------------------------------

/**
 * Validate a WiFi-OTA device address — a dotted-quad IPv4 or a hostname. Kept
 * permissive (no DNS) but rejects empty/obviously malformed input so the wizard
 * doesn't start a flash that the backend will immediately fail with `noDeviceIp`.
 */
export function isValidDeviceIp(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const ipv4 =
    /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  if (ipv4.test(v)) return true;
  // Hostname fallback (e.g. "elrs-tx.local"). Require at least one letter so a
  // malformed all-numeric "IP" like "256.0.0.1" is rejected rather than slipping
  // through as a numeric hostname.
  if (!/[a-zA-Z]/.test(v)) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
    v
  );
}

/**
 * Neutral factory-default settings recorded in a pre-flash recovery profile when
 * the device's live config is not available to the wizard. The same baseline the
 * engine's `.elrsp` backup writes (`flash/backup.rs`, `baseline_settings`), since
 * a live parameter read-back is a config-path feature that does not exist yet:
 * both recovery artifacts preserve the device IDENTITY and start the user from
 * one known baseline (M25 / FR-FLASH-05).
 */
const RECOVERY_PROFILE_SETTINGS: ProfileSettings = {
  packetRate: 250,
  telemetryRatio: "1:64",
  switchMode: "Hybrid",
  txPower: 100,
  dynamicPower: false,
  modelMatch: false,
  modelId: 0,
  bindingPhrase: "",
  antennaMode: "Diversity",
  fanThreshold: 250,
};

/** Derive a display basename from an absolute file path (handles `/` and `\`). */
export function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * Build the best-effort pre-flash recovery profile for a local-file flash from
 * the connected device's identity (M25). Persisted via the existing
 * config-profile store (config.rs `save_profile`) so the user can recover. The
 * localized `name` is supplied by the caller — this helper stays string-free and
 * pure so it is unit-testable.
 */
export function buildRecoveryProfile(
  device: DeviceInfo,
  now: number,
  name: string
): StoredProfileDto {
  const safeTarget = device.targetName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return {
    id: `preflash-backup-${safeTarget}-${now}`,
    name,
    settings: { ...RECOVERY_PROFILE_SETTINGS },
    updatedAt: now,
  };
}

/** Whether the given step's required selections are satisfied. */
export function isWizardStepValid(
  state: WizardSelections,
  step: WizardStep
): boolean {
  switch (step) {
    case "brand":
      return state.brandId !== null;
    case "model":
      return state.modelId !== null;
    case "frequency":
      return (
        state.domain !== null &&
        // Firmware source: either a GitHub release version or a local `.bin`
        // (M25). The two are mutually exclusive but at least one is required.
        (state.firmwareVersion !== null || state.localFirmwarePath !== null) &&
        state.flashMethod !== null &&
        // WiFi OTA additionally requires a valid device IP/host (FR-FLASH-09).
        (state.flashMethod !== "wifi" || isValidDeviceIp(state.deviceIp))
      );
    case "binding":
      return state.useTraditionalBinding || state.bindingPhrase.trim().length > 0;
    case "review":
      return true;
  }
}

/**
 * Index of the first incomplete step — the furthest step the user may jump to.
 * Drives which stepper segments are clickable.
 */
export function furthestReachableIndex(state: WizardSelections): number {
  for (let i = 0; i < WIZARD_STEPS.length; i++) {
    if (!isWizardStepValid(state, WIZARD_STEPS[i])) return i;
  }
  return WIZARD_STEPS.length - 1;
}

/**
 * Derive the AI-facing target descriptor from the current wizard selections, or
 * null when no model is chosen yet. Pure — fed into `buildAiContext` so Omnia
 * knows the brand/model/band being discussed (best-effort; the firmware/band are
 * included only once chosen).
 */
export function currentWizardTarget(
  state: WizardSelections
): WizardTargetSelection | null {
  const brand = findBrand(state.brandId);
  const model = findModel(state.brandId, state.modelId);
  if (!brand || !model) return null;
  const domainMeta = state.domain
    ? REGULATORY_DOMAIN_BY_ID[state.domain]
    : null;
  return {
    brandName: brand.name,
    modelName: model.name,
    target: model.target,
    deviceType: model.deviceType,
    firmwareVersion: state.firmwareVersion,
    frequency: domainMeta?.frequency ?? null,
  };
}

export const useWizardStore = create<WizardState>()((set, get) => ({
  step: "brand",
  wizardMode: "static",
  ...INITIAL_SELECTIONS,
  flash: { ...IDLE_FLASH },
  identityRefusal: null,
  detectedTargetName: null,

  autoDetectFromDevice: () => {
    const { device, status } = useDeviceStore.getState();
    if (status !== "connected" || !device) return;
    const match = findTargetByName(device.targetName);
    if (!match) return;
    // Only pre-select when nothing has been chosen yet — never clobber a manual
    // selection that's already in progress.
    set((s) =>
      s.brandId === null && s.modelId === null
        ? {
            brandId: match.brand.id,
            modelId: match.model.id,
            detectedTargetName: device.targetName,
          }
        : {}
    );
  },

  next: () => {
    const state = get();
    const index = WIZARD_STEPS.indexOf(state.step);
    if (index >= WIZARD_STEPS.length - 1) return;
    if (!isWizardStepValid(state, state.step)) return;
    set({ step: WIZARD_STEPS[index + 1] });
  },

  back: () => {
    const index = WIZARD_STEPS.indexOf(get().step);
    if (index <= 0) return;
    set({ step: WIZARD_STEPS[index - 1] });
  },

  goToStep: (step) => {
    const target = WIZARD_STEPS.indexOf(step);
    const state = get();
    // Only allow navigating to a step whose every predecessor is complete.
    for (let i = 0; i < target; i++) {
      if (!isWizardStepValid(state, WIZARD_STEPS[i])) return;
    }
    set({ step });
  },

  setWizardMode: (wizardMode) => set({ wizardMode }),

  selectBrand: (brandId) => {
    if (get().brandId === brandId) return;
    // Changing brand invalidates everything model-and-below. A manual pick also
    // dismisses the auto-detect hint.
    set({
      brandId,
      modelId: null,
      domain: null,
      firmwareVersion: null,
      flashMethod: null,
      localFirmwarePath: null,
      localFirmwareName: null,
      detectedTargetName: null,
    });
  },

  selectModel: (modelId) => {
    if (get().modelId === modelId) return;
    // Domain / firmware / method all depend on the chosen model. A manual pick
    // also dismisses the auto-detect hint.
    set({
      modelId,
      domain: null,
      firmwareVersion: null,
      flashMethod: null,
      localFirmwarePath: null,
      localFirmwareName: null,
      detectedTargetName: null,
    });
  },

  selectDomain: (domain) => set({ domain }),
  // Picking a release version clears any local-file source (mutually exclusive).
  selectFirmware: (firmwareVersion) =>
    set({ firmwareVersion, localFirmwarePath: null, localFirmwareName: null }),
  selectLocalFirmware: (path) =>
    set(
      path === null
        ? { localFirmwarePath: null, localFirmwareName: null }
        : {
            localFirmwarePath: path,
            localFirmwareName: fileNameFromPath(path),
            // A local file replaces the release version as the firmware source.
            firmwareVersion: null,
          }
    ),
  selectFlashMethod: (flashMethod) => set({ flashMethod }),

  setBindingPhrase: (bindingPhrase) => set({ bindingPhrase }),
  setUseTraditionalBinding: (useTraditionalBinding) =>
    set({ useTraditionalBinding }),
  setDeviceIp: (deviceIp) => set({ deviceIp }),

  startFlash: async (request, recoveryProfileName) => {
    // FLASH-3: one flash at a time, claimed BEFORE the first await — see
    // `activeFlash` for what the four awaits below used to let a second click
    // do. Every early return from here on has to release it again.
    if (activeFlash !== null || get().flash.status === "running") return;
    const session: FlashSession = { releasedPort: false };
    activeFlash = session;
    // CONN-11: never start on top of a handshake in flight. A CRSF connect is a
    // ~4.5s baud sweep that owns the port and can still fail; flashing through
    // it left the settle with nothing to land on (the reader is gone, the
    // `device://error` was suppressed as flash noise) and the bar spun on
    // "connecting" forever — with every port control dead, since
    // `canClaimPort("connecting")` is false. The user cancels or waits it out.
    if (useDeviceStore.getState().status === "connecting") {
      activeFlash = null;
      set(() => ({
        flash: {
          ...IDLE_FLASH,
          ...startFailed("a connection attempt is still in progress"),
        },
      }));
      return;
    }
    // Register the flash event listeners before kicking off the worker so no
    // early progress/log events are missed.
    try {
      await ensureFlashListeners(set);
    } catch (e) {
      // The `flash://*` bridge is unavailable: without it the UI would never
      // see progress, done or error, so this is a failure to start — shown as
      // one instead of rejecting into the caller's `void startFlash(...)`.
      activeFlash = null;
      set(() => ({ flash: { ...IDLE_FLASH, ...startFailed(String(e)) } }));
      return;
    }

    // M25: before a local-file flash, take a best-effort config backup so the
    // user can recover, reusing the existing config-profile persistence
    // (config.rs `save_profile`). Best-effort + isTauri-guarded: a failure is
    // non-blocking and only raises a warning (the flash still proceeds; the Rust
    // engine also writes its own mandatory `.elrsp` backup before erase/write).
    let backupWarning = false;
    if (request.localFilePath && isTauri()) {
      const connected = useDeviceStore.getState().device;
      if (connected && recoveryProfileName) {
        try {
          await saveProfile(
            buildRecoveryProfile(connected, Date.now(), recoveryProfileName)
          );
        } catch {
          backupWarning = true;
        }
      }
    }

    // CONN-1/FLASH-3: the CRSF reader thread owns the serial port exclusively
    // (TIOCEXCL + flock on POSIX, exclusive open on Windows), so esptool and the
    // Betaflight passthrough handshake cannot open it while we stay connected.
    // Hand the port over BEFORE the worker starts — and keep the store honest:
    // the device is genuinely no longer connected. `start_flash` enforces the
    // same invariant server-side, so this is state truthfulness, not the
    // safety mechanism. WiFi OTA flashes over HTTP and keeps its connection.
    // Remembered for the `flash://*` handlers, which run after the request is
    // long gone: which device an OTA addressed, and which `(port, target)` pair
    // an identity guard refused.
    lastFlashRequest = request;
    session.releasedPort = methodHoldsSerialPort(request.method);
    if (session.releasedPort) {
      const store = useDeviceStore.getState();
      // Remember which port is being flashed so it stays pre-selected for the
      // post-flash reconnect (see `settleDeviceAfterFlash`).
      const port = request.port ?? store.device?.port ?? null;
      await store.disconnect();
      if (port) useDeviceStore.getState().setSelectedPort(port);
    }

    // Move the device into the flashing state for the duration — this is what
    // locks out the connect / bridge-probe affordances (CONN-2). Nothing is
    // snapshotted to restore afterwards: `settleDeviceAfterFlash` recomputes
    // the outcome from what actually survived (CONN-11).
    //
    // Clearing `error` is what SCOPES that recompute to this flash: the settle
    // reads the field to choose between "error" and "disconnected", and nothing
    // else narrowed it to the current attempt — only the serial path cleared it,
    // as a side effect of `disconnect()`. A WiFi OTA therefore inherited
    // whatever was left over ("Permission denied on /dev/ttyUSB0" from a failed
    // connect, or the previous session's "Lost connection to …") and presented
    // it as this flash's outcome: a red error chip in the device bar next to the
    // wizard's success screen. From here on the field can only ever carry a
    // message the flashing-guarded `device://error` handler captured during THIS
    // flash.
    const deviceStore = useDeviceStore.getState();
    deviceStore.setError(null);
    deviceStore.setStatus("flashing");

    set({
      flash: {
        status: "running",
        percent: 0,
        stage: "fetch",
        etaSeconds: null,
        log: [],
        error: null,
        backupWarning,
      },
    });

    try {
      await invokeStartFlash(request);
    } catch (e) {
      // The worker never started (bad args / backend unavailable) — surface it
      // as a flash error so the UI shows the failure path rather than hanging.
      // Settled against THIS session: `start_flash` resolves only when the
      // worker is done, so a rejection can arrive after `flash://error` already
      // settled, and the second settle must not run again.
      settleDeviceAfterFlash("error", session);
      set((s) => ({ flash: { ...s.flash, ...startFailed(String(e)) } }));
    }
  },

  cancelFlash: async () => {
    let outcome: FlashCancelOutcome = "cancelled";
    try {
      // The backend signals + joins the worker, which kills any child process
      // and emits `flash://cancelled` (handled above) — never `flash://error`.
      outcome = await cancelFlash();
    } catch {
      // Ignore — fall through to a clean local reset regardless.
    }
    if (outcome === "writeInProgress") {
      // REFUSED (FLASH-4): the device is being written and the backend let the
      // flash carry on, so the UI must NOT pretend it stopped. Reflect the
      // backend's reason locally — it only refuses past the write stage — so the
      // cancel control drops out immediately instead of a click that does
      // nothing until the next progress event arrives.
      set((s) => ({ flash: { ...s.flash, stage: "write" } }));
      return;
    }
    // Deterministic local reset: both this and the `flash://cancelled` handler
    // converge on IDLE, so the UI can never flip to a false error on cancel.
    settleDeviceAfterFlash("cancelled");
    set({ flash: { ...IDLE_FLASH } });
  },

  resetFlash: () => {
    set({ flash: { ...IDLE_FLASH } });
  },

  reset: () => {
    // "Start Over" clears the selections/step/flash but deliberately PRESERVES
    // `wizardMode` (a shallow merge): the mode is a UI preference, so a user in
    // AI mode who starts over stays in AI mode rather than being bounced out.
    // It also preserves `identityRefusal` — starting the wizard over changes
    // nothing about the hardware on the port, so re-picking the same model must
    // land on the same refusal rather than on an unguarded flash.
    set({
      step: "brand",
      ...INITIAL_SELECTIONS,
      flash: { ...IDLE_FLASH },
      detectedTargetName: null,
    });
  },
}));
