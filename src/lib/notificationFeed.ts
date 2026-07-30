/**
 * Glue between the M26 live-alert evaluation and the v1.7.1 notification center.
 *
 * The ONLY producer is `LiveAlertHost`, which already owns the single
 * `evaluateFrame` path; this module just turns the `firedAlerts` it surfaces
 * into persisted notifications. There is **no second detector** — if these
 * functions are the only enqueue site (they are), exactly one notification is
 * stored per fired alarm, inheriting M26's hysteresis + debounce. Mute is
 * honoured here so a muted session never fills the center.
 */
import type { LiveAlert } from "@/lib/liveAlerts";
import type { DiagnosticFinding } from "@/lib/diagnostics";
import type { ParsedLog } from "@/lib/blackbox";
import {
  useNotificationsStore,
  type AppNotification,
} from "@/stores/notifications";

/**
 * Map one fired {@link LiveAlert} to a notification payload. `body` carries the
 * i18n message **key** (not resolved text) so the panel re-translates on a
 * language switch; `id` is `kind:frame-ts`, stable per fire (the store dedups on
 * it, so a double subscriber tick never double-counts).
 */
export function notificationFromAlert(
  alert: LiveAlert
): Omit<AppNotification, "read"> {
  return {
    id: `${alert.kind}:${alert.t}`,
    type: alert.kind,
    severity: alert.severity,
    ts: alert.t,
    body: alert.messageKey,
    params: alert.detail,
  };
}

/**
 * Enqueue one notification per fired alarm — unless muted, which suppresses new
 * entries (mirroring how the M26 toast / OS notification are muted). Reading the
 * store imperatively (not via a hook) keeps this callable from the telemetry
 * subscription without re-rendering.
 */
export function recordFiredAlerts(
  firedAlerts: readonly LiveAlert[],
  muted: boolean
): void {
  if (muted || firedAlerts.length === 0) return;
  const enqueue = useNotificationsStore.getState().enqueue;
  for (const alert of firedAlerts) enqueue(notificationFromAlert(alert));
}

/** Keep only the finite-number entries of a finding's detail bag (drop any
 * string values — never forward an identifier into a notification). */
function numericOnly(
  detail: Record<string, number | string>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Enqueue one notification per M37 diagnostic finding from an analyzed session —
 * unless muted or empty. The `id` is prefixed `diag:` (so {@link
 * import("@/components/notifications/NotificationBell")} resolves the title from
 * the `diagnostics.*` namespace and the dedup key never collides with an M26
 * alarm), the title comes from the finding's {@link DiagnosticFinding.category},
 * and `params` carries numbers only — never a string detail or identifier. Called
 * once per analysis from the Session Analysis page (a single enqueue site).
 */
export function recordDiagnosticFindings(
  findings: readonly DiagnosticFinding[],
  log: ParsedLog,
  muted: boolean
): void {
  if (muted || findings.length === 0) return;
  const enqueue = useNotificationsStore.getState().enqueue;
  for (const f of findings) {
    enqueue({
      id: `diag:${f.ruleId}:${f.evidenceWindow.startIndex}`,
      type: f.category,
      severity: f.severity,
      ts: log.time[f.evidenceWindow.startIndex] ?? 0,
      body: f.explanation,
      params: numericOnly(f.detail),
    });
  }
}
