import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Persisted visibility state for optional dashboard panels (M13, FR-TELEM-04).
 *
 * The flight-path map is a toggleable optional panel; the operator's choice is
 * persisted to localStorage (key `omnilink-dashboard-panels`) so it survives
 * reloads. Follows the same zustand `persist` convention as the theme store.
 */
interface DashboardPanelsState {
  /** Whether the flight-path map panel is shown on the telemetry dashboard. */
  showFlightMap: boolean;
  /** Set the flight-path map panel visibility explicitly. */
  setShowFlightMap: (value: boolean) => void;
  /** Flip the flight-path map panel visibility. */
  toggleFlightMap: () => void;
}

export const useDashboardPanelsStore = create<DashboardPanelsState>()(
  persist(
    (set) => ({
      showFlightMap: true,
      setShowFlightMap: (value: boolean) => set({ showFlightMap: value }),
      toggleFlightMap: () =>
        set((state) => ({ showFlightMap: !state.showFlightMap })),
    }),
    {
      name: "omnilink-dashboard-panels",
    }
  )
);
