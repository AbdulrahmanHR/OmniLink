import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_LIVE_ALERT_CONFIG,
  type LinkLossAlarmConfig,
  type LiveAlertConfig,
  type RangeAlarmConfig,
} from "@/lib/liveAlerts";

/**
 * Persisted live-alert thresholds (M26).
 *
 * Holds the operator-tunable {@link LiveAlertConfig} (per-alarm enable + the
 * trip/clear hysteresis band + debounce window) plus two UI preferences: a
 * master `muted` toggle and the opt-in `soundEnabled` audio alert. The pure
 * evaluator in `@/lib/liveAlerts` consumes the config only; the runner in
 * `@/components/alerts` reads `muted` to suppress BOTH the in-app toast and the
 * OS notification (and the beep), and reads `soundEnabled` to decide whether a
 * trip also plays a sound. Persisted to localStorage (key `omnilink-alerts`)
 * following the same zustand `persist` convention as the theme / retention
 * stores. `soundEnabled` is a new defaulted-`false` field: zustand's shallow
 * merge fills it from the initializer for any pre-existing persisted state, so
 * no persist `version` bump / migration is required.
 */
interface AlertsState extends LiveAlertConfig {
  /** Master mute — suppresses every in-app and OS notification when on. */
  muted: boolean;
  /**
   * Optional audio alert (FR-TELEM-03). When on (and not muted), a tripped
   * alarm also plays a short beep alongside the toast + OS notification.
   * Opt-in — defaults OFF, because an unexpected beep is intrusive. A UI
   * preference only; the pure evaluator never reads it.
   */
  soundEnabled: boolean;
  /** Flip the master mute. */
  toggleMuted: () => void;
  /** Set the master mute explicitly. */
  setMuted: (value: boolean) => void;
  /** Flip the audio-alert opt-in. */
  toggleSound: () => void;
  /** Set the audio-alert opt-in explicitly. */
  setSoundEnabled: (value: boolean) => void;
  /** Patch the low-RSSI alarm. */
  setSignalLoss: (patch: Partial<RangeAlarmConfig>) => void;
  /** Patch the low-link-quality alarm. */
  setLqDrop: (patch: Partial<RangeAlarmConfig>) => void;
  /** Patch the link-loss alarm. */
  setFailsafe: (patch: Partial<LinkLossAlarmConfig>) => void;
  /** Patch the GPS-distance alarm. */
  setGpsDistance: (patch: Partial<RangeAlarmConfig>) => void;
}

export const useAlertsStore = create<AlertsState>()(
  persist(
    (set) => ({
      ...DEFAULT_LIVE_ALERT_CONFIG,
      muted: false,
      soundEnabled: false,
      toggleMuted: () => set((s) => ({ muted: !s.muted })),
      setMuted: (value) => set({ muted: value }),
      toggleSound: () => set((s) => ({ soundEnabled: !s.soundEnabled })),
      setSoundEnabled: (value) => set({ soundEnabled: value }),
      setSignalLoss: (patch) => set((s) => ({ signalLoss: { ...s.signalLoss, ...patch } })),
      setLqDrop: (patch) => set((s) => ({ lqDrop: { ...s.lqDrop, ...patch } })),
      setFailsafe: (patch) => set((s) => ({ failsafe: { ...s.failsafe, ...patch } })),
      setGpsDistance: (patch) => set((s) => ({ gpsDistance: { ...s.gpsDistance, ...patch } })),
    }),
    {
      name: "omnilink-alerts",
    }
  )
);

/** Pluck the pure {@link LiveAlertConfig} out of the store state. */
export function selectLiveAlertConfig(state: AlertsState): LiveAlertConfig {
  return {
    signalLoss: state.signalLoss,
    lqDrop: state.lqDrop,
    failsafe: state.failsafe,
    gpsDistance: state.gpsDistance,
  };
}
