import { useBridgeStore, usePassthroughStore } from "@/stores";

/**
 * i18n key describing which controller-bridge operation is currently holding the
 * serial port, or `null` when none is.
 *
 * The three bridge commands (`probe_bridge`, `fetch_bridge_context`,
 * `run_passthrough_check`) open the serial port directly, and the Rust
 * `DeviceManager` now refuses a second claimer while one runs. None of them
 * touches the device status, so `canClaimPort` is blind to them: without this
 * hook, Connect and Start Flash stayed enabled during a passthrough check that
 * holds the port for up to ~14s — Connect failed with a busy port, and a UART
 * flash sailed past its point of no return before esptool discovered it could
 * not open the port at all.
 *
 * Pure derivation from the two runtime stores; the caller decides whether to
 * disable an action, show the reason, or both.
 */
export function useSerialPortBusyReasonKey(): string | null {
  const probing = useBridgeStore((s) => s.status) === "probing";
  const fetchingContext = useBridgeStore((s) => s.contextStatus) === "fetching";
  const checking = usePassthroughStore((s) => s.status) === "running";

  // Longest hold first, so the reason names the operation the user will be
  // waiting on if more than one somehow overlaps.
  if (checking) return "device.portBusy.passthrough";
  if (probing) return "device.portBusy.probe";
  if (fetchingContext) return "device.portBusy.context";
  return null;
}
