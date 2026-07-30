import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout";

import "@/lib/i18n";
import {
  useThemeStore,
  useDeviceStore,
  useAssistantStore,
  useWifiStore,
} from "@/stores";
import { lazy, useEffect, useRef } from "react";

// Route-level code-splitting: page components (and their heavy deps, e.g.
// recharts/d3 on the telemetry route) load on demand, keeping the initial
// bundle small. The AppShell/layout stays eager so the chrome renders instantly.
const HomePage = lazy(() =>
  import("@/pages/HomePage").then((m) => ({ default: m.HomePage }))
);
// Flashing IS the guided wizard — it lives at /flash; there is no separate
// doorway page or /wizard route.
const FlashPage = lazy(() =>
  import("@/pages/WizardPage").then((m) => ({ default: m.WizardPage }))
);
const TelemetryPage = lazy(() =>
  import("@/pages/TelemetryPage").then((m) => ({ default: m.TelemetryPage }))
);
const ProfilesPage = lazy(() =>
  import("@/pages/ProfilesPage").then((m) => ({ default: m.ProfilesPage }))
);
// Unified Session Analysis (v1.7.0) — one loaded session driven by one position
// index that can be scrubbed (forensic, the former Logs page) OR played back
// through the live dashboard (replay, the former Simulator page). Works with no
// hardware connected. The old /logs + /simulator routes redirect here.
const SessionAnalysisPage = lazy(() =>
  import("@/pages/SessionAnalysisPage").then((m) => ({
    default: m.SessionAnalysisPage,
  }))
);
// Personalized Local Trends & Setup Suggestions (M40, v2.0.2) — aggregates the
// user's own accumulated diagnostic history into per-device trends + conservative
// setup suggestions. Works fully offline; shows honest empty/not-enough states
// until enough real sessions are recorded.
const TrendsPage = lazy(() =>
  import("@/pages/TrendsPage").then((m) => ({ default: m.TrendsPage }))
);
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage }))
);

export default function App() {
  // Initialize theme on mount (run once)
  const initialized = useRef(false);
  const setMode = useThemeStore((s) => s.setMode);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      const { mode } = useThemeStore.getState();
      setMode(mode);
    }
  }, [setMode]);

  // Register device connection (CRSF) event listeners once on mount.
  useEffect(() => {
    // `init()` resolves asynchronously, and under StrictMode the unmount fires
    // BEFORE it does — so a plain `cleanup?.()` would still be undefined and
    // this mount's hold on the listeners would never be released. Releasing on
    // late arrival keeps the store's refcount honest (CONN-9).
    let unmounted = false;
    let cleanup: (() => void) | undefined;
    void useDeviceStore
      .getState()
      .init()
      .then((dispose) => {
        if (unmounted) dispose();
        else cleanup = dispose;
      });
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, []);

  // Register WiFi discovery (mDNS + self-AP) event listeners once on mount —
  // mirrors the device store wiring; idempotent so re-mounts don't duplicate.
  useEffect(() => {
    let unmounted = false;
    let cleanup: (() => void) | undefined;
    void useWifiStore
      .getState()
      .init()
      .then((dispose) => {
        if (unmounted) dispose();
        else cleanup = dispose;
      });
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, []);

  // Probe which providers have a stored key (M9-API) so the chat picker offers
  // the right providers, and restore the most recent conversation from disk so
  // chat history survives a restart.
  useEffect(() => {
    const assistant = useAssistantStore.getState();
    void assistant.refreshKeyedProviders();
    void assistant.initHistory();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/flash" element={<FlashPage />} />
          <Route path="/telemetry" element={<TelemetryPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/analysis" element={<SessionAnalysisPage />} />
          <Route path="/trends" element={<TrendsPage />} />
          {/* v1.7.0 consolidation: the former Logs + Simulator pages merged into
              Session Analysis. Keep redirects so old deep links don't 404. */}
          <Route path="/logs" element={<Navigate to="/analysis" replace />} />
          <Route
            path="/simulator"
            element={<Navigate to="/analysis" replace />}
          />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
