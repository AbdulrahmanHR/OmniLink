import { create } from "zustand";
import { fetchBridgeContext, probeBridge } from "@/lib/tauri";
import type { BridgeClassificationDto, BridgeContextDto } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// M63: Controller-bridge discovery store (v2.2 "Controller Bridge Mode").
//
// A NON-PERSISTED runtime store (mirrors `stores/device.ts`): the bridge state
// reflects LIVE hardware — which serial port was probed and what it classified
// as — so it must never persist a stale classification across sessions. It is a
// parallel store to `device.ts` (serial/CRSF) and `wifi.ts`; it never touches
// the serial connection seam.
//
// READ-ONLY: `probe()` calls the `probe_bridge` command which sends only MSP GET
// queries. The FC is a passthrough bridge endpoint, never a managed device.
// ---------------------------------------------------------------------------

export type BridgeStatus = "idle" | "probing" | "classified" | "error";

/**
 * Lifecycle of the READ-ONLY controller-context fetch (M65): `idle` before any
 * fetch, `fetching` while in flight, `ready` once a context lands (which may
 * still be empty → the "not enough context" empty state), or `error` when no
 * controller answered / off-Tauri.
 */
export type BridgeContextStatus = "idle" | "fetching" | "ready" | "error";

interface BridgeState {
  /** Lifecycle of the most recent probe. */
  status: BridgeStatus;
  /** The classification from the most recent successful probe, if any. */
  classification: BridgeClassificationDto | null;
  /** The serial port the most recent probe targeted. */
  port: string | null;
  /** A probe failure message (open/busy/permission), or null. */
  error: string | null;

  /** The READ-ONLY context from the most recent successful fetch (M65), if any. */
  context: BridgeContextDto | null;
  /** Lifecycle of the most recent context fetch (M65). */
  contextStatus: BridgeContextStatus;
  /** A context-fetch failure message (no controller / open / off-Tauri), or null. */
  contextError: string | null;

  /**
   * Probe `port` for a controller bridge (READ-ONLY MSP handshake). Moves to
   * "probing", then lands on "classified" with the result, or "error" with the
   * message. Catches an invoke rejection gracefully (e.g. running outside Tauri
   * or a busy/missing port) so the caller never sees an unhandled rejection.
   */
  probe: (port: string) => Promise<void>;

  /**
   * Fetch READ-ONLY controller context from `port` (M65). Moves to "fetching",
   * then "ready" with the context (FC family/version + coarse serial ports), or
   * "error" when no controller answered or the invoke rejects (busy/missing port,
   * off-Tauri) — caught gracefully so the caller never sees an unhandled rejection.
   * The fetch sends ONLY read-only MSP GETs: there is NO write path to the FC.
   */
  fetchContext: (port: string) => Promise<void>;
  /** Clear just the context state (M65) back to idle, leaving the probe intact. */
  clearContext: () => void;

  /** Clear the bridge state back to idle. */
  reset: () => void;
}

/**
 * Whether a bridge operation still owns the serial port — a probe or a READ-ONLY
 * context fetch that has not resolved yet.
 *
 * The one state that must never be cleared out from under itself: the backend
 * keeps the port until the operation finishes, and `useSerialPortBusyReasonKey`
 * reads exactly this to explain why Connect / Start Flash are inert. Clearing it
 * mid-flight re-enabled both over a port OmniLink was still driving, and
 * orphaned the pending result's port attribution along with it. Shared by every
 * surface that can clear the store — the probe control's port-change effect AND
 * its close button — so the two cannot drift apart, which is exactly how the
 * close path ended up without the guard.
 */
export function isBridgeOperationInFlight(
  status: BridgeStatus,
  contextStatus: BridgeContextStatus
): boolean {
  return status === "probing" || contextStatus === "fetching";
}

const INITIAL_CONTEXT = {
  context: null,
  contextStatus: "idle" as BridgeContextStatus,
  contextError: null,
};

export const useBridgeStore = create<BridgeState>()((set) => ({
  status: "idle",
  classification: null,
  port: null,
  error: null,
  ...INITIAL_CONTEXT,

  probe: async (port) => {
    set({ status: "probing", port, error: null, classification: null });
    try {
      const classification = await probeBridge(port);
      // `port` is re-stated with the result, never left to whatever the store
      // holds by then: a `reset()` racing the in-flight probe nulled it, and a
      // classification with a null port is not stale for ANY port
      // (`isStaleBridgeResult(null, …)` is false) — so ttyUSB0's FC label and
      // its passthrough-check offer were re-attributed to whichever port was
      // selected next. A result belongs to the port it was taken on.
      set({ status: "classified", classification, port });
    } catch (e) {
      // Open/busy/permission failure, or running outside Tauri — land on a
      // clean error state the UI turns into `bridge.recovery.*` guidance.
      set({ status: "error", error: String(e), classification: null, port });
    }
  },

  fetchContext: async (port) => {
    set({ contextStatus: "fetching", port, contextError: null, context: null });
    try {
      const context = await fetchBridgeContext(port);
      // Re-stated with the result for the same reason as `probe` above.
      set({ contextStatus: "ready", context, port });
    } catch (e) {
      // No controller answered, busy/missing port, or off-Tauri — a clean error
      // state the surface turns into the "not enough context" empty state.
      set({
        contextStatus: "error",
        contextError: String(e),
        context: null,
        port,
      });
    }
  },

  clearContext: () => set({ ...INITIAL_CONTEXT }),

  reset: () =>
    set({
      status: "idle",
      classification: null,
      port: null,
      error: null,
      ...INITIAL_CONTEXT,
    }),
}));
