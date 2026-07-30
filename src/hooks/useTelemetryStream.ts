import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useDevice } from "@/hooks/useDevice";
import { onLinkStats } from "@/lib/tauri";
import { linkStatsToFrame } from "@/lib/telemetry-crsf";
import {
  openTelemetryPersistence,
  type TelemetryPersistence,
} from "@/lib/telemetry-db";
import { useDeviceStore } from "@/stores/device";
import { useSessionStore } from "@/stores/session";
import { useTelemetryStore } from "@/stores/telemetry";

/**
 * Real telemetry pipeline (M7-API) — replaces the M2-UI simulator.
 *
 * While a device is connected this subscribes to the Rust
 * `device://link-stats` event, converts each decoded CRSF Link Statistics
 * payload into a {@link import("@/stores/telemetry").TelemetryFrame} via
 * {@link linkStatsToFrame}, and `push`es it into the telemetry store so the
 * existing dashboard components animate from live hardware data. Every frame is
 * also handed to a batching SQLite writer ({@link openTelemetryPersistence}).
 *
 * On disconnect / unmount it removes the listener, flushes + closes the DB
 * session, and clears the store. No mock data, no timers driving fake values.
 *
 * ## Render-rate decoupling
 * CRSF link statistics arrive at up to ~25 Hz. Every frame is persisted, but
 * the store (which drives the recharts LinkChart + d3 PolarPlot, the heaviest
 * render path in the app) is updated at most every {@link STORE_PUSH_MIN_MS} so
 * the dashboard re-renders at ~15 fps instead of 25 fps. The latest frame is
 * always the one shown; dropped intermediate frames only thin the chart trace,
 * never the persisted record.
 */

/** Minimum spacing between store pushes (~15 fps render cap). */
const STORE_PUSH_MIN_MS = 66;

/**
 * Live telemetry may drive the shared store only when a device is connected AND
 * no replay simulation is active; the live stream and the replay simulator are
 * mutually exclusive over the single {@link useTelemetryStore} (FR-SIM-02: a
 * SIMULATED badge must never sit over live data), so the live producer no-ops
 * while a sim owns the store.
 */
export function liveStreamActive(isConnected: boolean, isSimulating: boolean): boolean {
  return isConnected && !isSimulating;
}

export function useTelemetryStream(): void {
  const { isConnected } = useDevice();
  const isSimulating = useSessionStore((s) => s.isSimulating);
  const push = useTelemetryStore((s) => s.push);
  const clear = useTelemetryStore((s) => s.clear);

  useEffect(() => {
    if (!liveStreamActive(isConnected, isSimulating)) return;

    // One session per connection so persisted rows can be grouped/replayed.
    const sessionId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `session-${Date.now()}`;

    // Snapshot the connected device for the parent telemetry_sessions row. The
    // DTO may be null mid-transition (connect/disconnect race) — fall back to "".
    const device = useDeviceStore.getState().device;
    const session = {
      id: sessionId,
      targetName: device?.targetName ?? "",
      firmware: device?.firmwareVersion ?? "",
    };

    let unlisten: UnlistenFn | undefined;
    let persistence: TelemetryPersistence | undefined;
    let disposed = false;
    let lastPush = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      persistence = await openTelemetryPersistence(session);
      if (disposed) {
        // Disconnected before setup finished — tear the session straight back down.
        void persistence.close();
        persistence = undefined;
        return;
      }
      unlisten = await onLinkStats((stats) => {
        const frame = linkStatsToFrame(stats);
        // Persist every frame; throttle the store (render path) to ~15 fps.
        persistence?.record(frame);
        const now = Date.now();
        if (now - lastPush >= STORE_PUSH_MIN_MS) {
          // Leading edge: push immediately and cancel any pending trailing flush
          // (this newer frame supersedes it).
          clearTimeout(flushTimer);
          flushTimer = undefined;
          lastPush = now;
          push(frame);
        } else {
          // Throttled: schedule a trailing-edge flush so the last frame of a
          // burst still reaches the store and `latest` never stays stale.
          clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            if (disposed) return;
            lastPush = Date.now();
            push(frame);
          }, STORE_PUSH_MIN_MS - (now - lastPush));
        }
      });
      if (disposed) {
        unlisten();
        unlisten = undefined;
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(flushTimer);
      unlisten?.();
      void persistence?.close();
      clear();
    };
  }, [isConnected, isSimulating, push, clear]);
}
