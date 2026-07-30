/**
 * Local link-diagnostics UI (M37, v2.0.0).
 *
 * The presentation layer over the pure on-device diagnostic engine
 * (`@/lib/diagnostics`) and its store (`@/stores/diagnostics`): a signal-health
 * gauge + breakdown panel (live / session / compact), an expandable findings
 * list, a configuration sheet, and the timeline chart markers. No detection logic
 * lives here — every surface reads the engine's already-computed results.
 */
export { SignalHealthGauge } from "./SignalHealthGauge";
export { SignalHealthPanel } from "./SignalHealthPanel";
export { FindingCard } from "./FindingCard";
export { FindingsList } from "./FindingsList";
export { SessionPatternCards } from "./SessionPatternCards";
export { DeviceTrendCard } from "./DeviceTrendCard";
export { SuggestionCard } from "./SuggestionCard";
export { DiagnosticSettings } from "./DiagnosticSettings";
export {
  buildDiagnosticMarkers,
  buildPatternMarkers,
  type DiagnosticMarkerOptions,
} from "./DiagnosticChartMarkers";
export { buildDiagnosticSummary } from "./util";
