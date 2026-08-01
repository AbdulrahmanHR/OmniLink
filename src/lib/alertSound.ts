/**
 * Best-effort audio alert for live telemetry alarms (FR-TELEM-03).
 *
 * The optional counterpart to the in-app toast + OS notification (see
 * `@/lib/alertNotify`): when the operator opts in, a tripped alarm also plays a
 * short beep. It follows the SAME philosophy as `alertNotify.ts` — no bundled
 * audio asset, fully guarded — but uses the **Web Audio API** (a synthesised
 * `OscillatorNode` chirp), which needs no permission grant, works fully offline
 * and, unlike the Web Notifications API that `alertNotify.ts` had to abandon at
 * v3.0.3, is honoured by every engine the app ships in.
 *
 * Every entry point is wrapped so it NEVER throws into the telemetry
 * subscription: in a headless/test env (no `window`/`AudioContext`) it returns
 * silently, and any runtime failure is swallowed — the toast is the reliable
 * channel and the beep is strictly additive.
 */

import type { LiveAlert } from "@/lib/liveAlerts";

/**
 * Single lazily-created `AudioContext`, reused across every beep so we never
 * leak a fresh context per alarm (browsers cap the number of live contexts).
 * `null` until the first successful creation, or forever in a non-DOM env.
 */
let sharedContext: AudioContext | null = null;

/** Whether a usable Web Audio constructor exists in this environment. */
function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return typeof ctor === "function" ? ctor : null;
}

/**
 * Lazily get (or create) the shared {@link AudioContext}. Returns `null` when
 * Web Audio is unavailable (headless/test) or construction fails, so callers can
 * bail without a `try/catch` of their own.
 */
function getContext(): AudioContext | null {
  try {
    if (sharedContext !== null) return sharedContext;
    const Ctor = audioContextCtor();
    if (Ctor === null) return null;
    sharedContext = new Ctor();
    return sharedContext;
  } catch {
    return null;
  }
}

/** Schedule one short sine "chirp" on `ctx` with a soft attack/release. */
function scheduleBeep(
  ctx: AudioContext,
  startAt: number,
  frequency: number,
  duration: number
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  // A short ramp in/out avoids the click of a hard on/off, and the peak gain is
  // kept low (~0.15) so the alert reads as a discreet chirp, not an air-horn.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(0.15, startAt + 0.012);
  gain.gain.linearRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
  // Explicitly tear down the finished nodes rather than leaning solely on the
  // spec's auto-release. Guarded so a double-disconnect (or a missing handle in
  // an odd env) can never throw into the caller's try/catch.
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* already released */
    }
  };
}

/**
 * Play the alert beep — a two-note (~150 ms) chirp. Fully guarded: no-ops in a
 * non-DOM/test env and swallows any error so it can never disrupt the live
 * stream. Resumes the shared context first if the browser's autoplay policy left
 * it suspended (contexts created before a user gesture start `suspended`).
 */
export function playAlertSound(): void {
  try {
    const ctx = getContext();
    if (ctx === null) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* autoplay still blocked — ignore */
      });
    }
    const start = ctx.currentTime;
    scheduleBeep(ctx, start, 880, 0.075); // A5
    scheduleBeep(ctx, start + 0.09, 1174.66, 0.075); // D6 — a rising two-note cue
  } catch {
    /* best-effort — never throw into the telemetry subscription */
  }
}

/**
 * Play the alert beep for a batch of freshly-tripped alarms — but ONLY when the
 * operator has opted into sound and the master mute is off. `firedAlerts` is the
 * evaluator's trip-only list (cleared/recovered alarms are surfaced separately),
 * so a recovery never beeps. This is the single source of truth for the sound
 * gating (`soundEnabled && !muted && firedAlerts.length > 0`); the live-alert
 * host calls it verbatim at the same point it raises the toast + OS notification.
 */
export function maybePlayAlertSound(
  firedAlerts: readonly LiveAlert[],
  opts: { soundEnabled: boolean; muted: boolean }
): void {
  if (!opts.soundEnabled || opts.muted || firedAlerts.length === 0) return;
  playAlertSound();
}
