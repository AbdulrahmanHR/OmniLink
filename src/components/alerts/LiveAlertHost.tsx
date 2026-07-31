import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, X } from "lucide-react";
import { useTelemetryStore, type TelemetryFrame } from "@/stores/telemetry";
import { selectLiveAlertConfig, useAlertsStore } from "@/stores/alerts";
import {
  evaluateFrames,
  initialAlertState,
  type AlertKind,
  type AnomalySeverity,
  type LiveAlert,
  type LiveAlertConfig,
  type LiveAlertState,
} from "@/lib/liveAlerts";
import { osNotify } from "@/lib/alertNotify";
import { maybePlayAlertSound } from "@/lib/alertSound";
import { recordFiredAlerts } from "@/lib/notificationFeed";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Severity → Signal Lab status token (mirrors the M15 AnomalyPanel mapping). */
const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  info: "var(--color-status-good)",
  warning: "var(--color-status-warning)",
  critical: "var(--color-status-critical)",
};

// ---------------------------------------------------------------------------
// Pure runner logic (exported for unit test — no DOM, no store, no i18n)
//
// These two functions ARE the runner: the component below is the thin
// subscribe-and-render shell around them. They are exported so a Node unit test
// can drive the batch path deterministically without a DOM (the suite has no
// jsdom — see AGENTS.md § Testing), and they stay in this file rather than a
// shared module because they are private to this host and have no other
// consumer. The cost is a fast-refresh full reload when this one file is edited
// in dev, which is why `react-refresh/only-export-components` is silenced per
// export below rather than for the file.
// ---------------------------------------------------------------------------

/**
 * Where the runner is up to: the threaded {@link LiveAlertState} plus the newest
 * frame it has already evaluated. `anchor` is a *reference* into the shared
 * telemetry history, which is what lets the next change be diffed without the
 * store having to tell us what it appended.
 */
export interface LiveAlertCursor {
  state: LiveAlertState;
  /** Newest frame already evaluated, or `null` before the first one. */
  anchor: TelemetryFrame | null;
}

/** One advance of the cursor over a telemetry-store change. */
export interface LiveAlertAdvance extends LiveAlertCursor {
  /** The frames evaluated on this change, oldest → newest. */
  evaluated: readonly TelemetryFrame[];
  /**
   * True when the window was REPLACED rather than appended to (a new session,
   * a `clear()`, or a backward/large seek that rebuilt it). The state machine
   * is reset before evaluating, and standing toasts are dropped.
   */
  didReset: boolean;
  firedAlerts: LiveAlert[];
  clearedKinds: AlertKind[];
}

/**
 * Diff the shared rolling history against the last frame we evaluated.
 *
 * The buffer is either **appended to** (live `push`, or a forward scrub whose
 * newly-passed frames arrive in ONE `setHistory`) or **replaced** wholesale.
 * Locating `anchor` by reference distinguishes the two and, because it is
 * located in the *new* array, `TELEMETRY_HISTORY_CAP` eviction is handled for
 * free: whatever fell off the front simply shifts the anchor's index, and the
 * slice after it is exactly the frames never seen before — none re-evaluated,
 * none skipped. A missing anchor means the window is a different window, so the
 * frames in it are not "newly elapsed" and must NOT be replayed; only the newest
 * one is evaluated, from a fresh state, to re-baseline at the new position.
 */
function windowDelta(
  history: readonly TelemetryFrame[],
  anchor: TelemetryFrame | null
): { frames: readonly TelemetryFrame[]; replaced: boolean } {
  if (history.length === 0) return { frames: [], replaced: true };
  const at = anchor === null ? -1 : history.lastIndexOf(anchor);
  if (at >= 0) return { frames: history.slice(at + 1), replaced: false };
  return { frames: [history[history.length - 1]], replaced: true };
}

/**
 * Advance the runner over one telemetry-store change: work out which frames are
 * newly appended and fold the SINGLE {@link evaluateFrames} state machine over
 * all of them (not just the newest — that is the whole point; see the host's
 * doc comment). Pure: same inputs → same outputs, no side effects.
 */
// eslint-disable-next-line react-refresh/only-export-components -- runner logic, unit-tested; see the section note above
export function advanceLiveAlerts(
  history: readonly TelemetryFrame[],
  cursor: LiveAlertCursor,
  config: LiveAlertConfig
): LiveAlertAdvance {
  const { frames, replaced } = windowDelta(history, cursor.anchor);
  const base = replaced ? initialAlertState() : cursor.state;
  const anchor = history.length === 0 ? null : history[history.length - 1];
  if (frames.length === 0) {
    return {
      state: base,
      anchor,
      evaluated: [],
      didReset: replaced,
      firedAlerts: [],
      clearedKinds: [],
    };
  }
  const { finalState, firedAlerts, clearedKinds } = evaluateFrames(frames, config, base);
  return {
    state: finalState,
    anchor,
    evaluated: frames,
    didReset: replaced,
    firedAlerts,
    clearedKinds,
  };
}

/**
 * Fold one {@link advanceLiveAlerts} result into the standing toast list.
 *
 * A batch can trip AND clear the same alarm (fire, then `minFrames` recovered
 * frames), or clear then re-trip it, and the flattened fired/cleared lists carry
 * no ordering — so the batch's FINAL phase decides what is on screen, which is
 * both order-independent and simply what is true now. Returns `active` itself
 * when nothing changed, so the caller's `setActive` bails out of the re-render.
 */
// eslint-disable-next-line react-refresh/only-export-components -- runner logic, unit-tested; see the section note above
export function reconcileToasts(
  active: LiveAlert[],
  advance: Pick<LiveAlertAdvance, "state" | "firedAlerts" | "clearedKinds" | "didReset">,
  muted: boolean
): LiveAlert[] {
  const { state, firedAlerts, clearedKinds, didReset } = advance;
  // Keep only the LAST fire per kind: the list is keyed by kind, and a batch can
  // legitimately contain two fires of one alarm.
  const latestFire = new Map<AlertKind, LiveAlert>();
  for (const alert of firedAlerts) latestFire.set(alert.kind, alert);
  const touched = new Set<AlertKind>([...clearedKinds, ...latestFire.keys()]);
  // A reset drops every standing toast: the machine no longer remembers the
  // alarm, so nothing left on screen could ever be cleared by a later frame.
  const kept = didReset ? [] : active.filter((a) => !touched.has(a.kind));
  // Mute suppresses the toast (but never the clearing of one already shown).
  const standing = muted
    ? []
    : [...latestFire.values()].filter((a) => state[a.kind].phase === "alarming");
  const next = [...kept, ...standing];
  const unchanged =
    next.length === active.length && next.every((a, i) => a === active[i]);
  return unchanged ? active : next;
}

/** Live, reactive `prefers-reduced-motion` flag (guarded for non-DOM envs). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * App-wide live-alert host (M26).
 *
 * Mounted exactly once in {@link import("@/components/layout").AppShell}, so the
 * telemetry subscription is a single instance with a clean teardown — no render
 * loop, no duplicate/leaked subscriptions. It threads the pure
 * {@link evaluateFrames} state machine across frames (kept in a ref so it never
 * triggers a re-render), raises an in-app toast per fired alarm, dismisses it on
 * recovery, and fires a best-effort OS notification — all suppressed while the
 * store is muted. Toasts respect `prefers-reduced-motion`.
 *
 * ## Why it watches `history`, not `latest`
 * The shared telemetry buffer does not only grow one frame at a time. A forward
 * scrub in {@link import("@/stores/session").useSessionStore} appends EVERY
 * newly-passed frame in a single `setHistory()`, and `latest` is only the last
 * of them — so evaluating `latest` alone evaluated one frame where N had
 * elapsed. Any alarm with hysteresis then never accumulated its debounce
 * counter: `signalLoss` needs 3 consecutive recovered frames to clear, so a
 * jump over the recovery left its toast standing forever. The runner therefore
 * diffs the history ({@link advanceLiveAlerts}) and folds the one state machine
 * over every appended frame, which is exactly what the live path already did
 * frame by frame.
 */
export function LiveAlertHost() {
  const { t } = useTranslation();
  const cursorRef = useRef<LiveAlertCursor>({ state: initialAlertState(), anchor: null });
  const [active, setActive] = useState<LiveAlert[]>([]);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // NOTE (v3.0.3): this effect deliberately does NOT ask for OS-notification
    // permission. A mount-time request used to live on this line; it could
    // never be granted in production, because the shipped app runs in WebKit /
    // WebView2 and the webview's own Notification API is unobtainable there —
    // first refused outside a user gesture, then denied outright even from one.
    // OS notifications now go through the native Tauri notification plugin, and
    // the opt-in lives in Settings → Live alerts; see `@/lib/alertNotify`.
    // `osNotify` below is unchanged in behaviour and still fires whenever
    // permission has already been granted.

    // Subscribe to the live telemetry store; act ONLY when the shared history
    // changes (it also empties to `[]` on disconnect). Plain zustand subscribe —
    // not a render loop — with the returned unsubscribe as the effect cleanup.
    const unsubscribe = useTelemetryStore.subscribe((store, prev) => {
      if (store.history === prev.history) return;

      const alerts = useAlertsStore.getState();
      const advance = advanceLiveAlerts(
        store.history,
        cursorRef.current,
        selectLiveAlertConfig(alerts)
      );
      cursorRef.current = { state: advance.state, anchor: advance.anchor };

      const { firedAlerts, clearedKinds, didReset } = advance;
      if (!didReset && firedAlerts.length === 0 && clearedKinds.length === 0) return;

      // Mute suppresses BOTH the OS notification and the in-app toast.
      if (!alerts.muted) {
        for (const alert of firedAlerts) {
          osNotify(t(`alerts.type.${alert.kind}`), t(alert.messageKey, alert.detail));
        }
      }

      // Optional audio alert (FR-TELEM-03): a beep on TRIP only (firedAlerts is
      // trip-only), gated on the opt-in preference AND the same master mute.
      // One beep per batch, not one per frame.
      maybePlayAlertSound(firedAlerts, {
        soundEnabled: alerts.soundEnabled,
        muted: alerts.muted,
      });

      // Persist the same fired alarms to the notification center (v1.7.1).
      // Reuses this single evaluation path — no second detector — and honours
      // mute (suppresses new entries) inside `recordFiredAlerts`. Each alarm is
      // recorded under `kind:frame-ts`, so a batch that trips one alarm once
      // stores exactly one entry however many frames it spanned.
      recordFiredAlerts(firedAlerts, alerts.muted);

      setActive((prevActive) => reconcileToasts(prevActive, advance, alerts.muted));
    });

    return unsubscribe;
  }, [t]);

  const dismiss = (kind: AlertKind) =>
    setActive((prev) => prev.filter((a) => a.kind !== kind));

  return (
    <div
      // A labelled live-region landmark (like Sonner's toast host): the `role`
      // makes the `aria-label` permitted — a bare <div> forbids naming, which
      // axe flags as `aria-prohibited-attr` — and gives assistive tech a named
      // region to surface the toasts.
      role="region"
      aria-live="assertive"
      aria-label={t("alerts.regionLabel")}
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      data-testid="live-alert-host"
    >
      {active.map((alert) => (
        <div
          key={alert.kind}
          role="alert"
          data-testid={`live-alert-${alert.kind}`}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg",
            !reducedMotion && "animate-in fade-in slide-in-from-bottom-2"
          )}
        >
          <span
            aria-hidden
            className="mt-1 size-2 shrink-0 rounded-full"
            style={{ background: SEVERITY_COLOR[alert.severity] }}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Bell aria-hidden className="size-3.5" />
              {t(`alerts.type.${alert.kind}`)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(alert.messageKey, alert.detail)}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            aria-label={t("alerts.dismiss")}
            onClick={() => dismiss(alert.kind)}
          >
            <X aria-hidden className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
