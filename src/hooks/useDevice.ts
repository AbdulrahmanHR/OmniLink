import { useDeviceStore } from "@/stores";

/**
 * Custom hook for device connection management.
 * Wraps the device store, exposing the real Tauri-backed connection flow
 * (M6-API): serial-port enumeration + CRSF handshake.
 */
export function useDevice() {
  const status = useDeviceStore((s) => s.status);
  const device = useDeviceStore((s) => s.device);
  const error = useDeviceStore((s) => s.error);
  const ports = useDeviceStore((s) => s.ports);
  const selectedPort = useDeviceStore((s) => s.selectedPort);
  // Whether that selection is a deliberate pin (CONN-10). The bar needs it to
  // offer the way back to auto-follow — the only thing that clears a pin.
  const portPinned = useDeviceStore((s) => s.portPinned);
  const setSelectedPort = useDeviceStore((s) => s.setSelectedPort);
  const refreshPorts = useDeviceStore((s) => s.refreshPorts);
  const connect = useDeviceStore((s) => s.connect);
  const disconnect = useDeviceStore((s) => s.disconnect);

  return {
    status,
    device,
    error,
    ports,
    selectedPort,
    portPinned,
    isConnected: status === "connected",
    isConnecting: status === "connecting",
    setSelectedPort,
    refreshPorts,
    connect,
    disconnect,
  };
}
