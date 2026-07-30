import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveAlert } from "@/lib/liveAlerts";

/**
 * Optional audio alert (FR-TELEM-03). `@/lib/alertSound` mirrors the
 * `@/lib/alertNotify` philosophy — zero dependency, no bundled asset, fully
 * guarded — so these specs prove two things:
 *  - it NEVER throws in a headless/test env (no `window` / no `AudioContext`),
 *    exactly like the OS-notify helper; and
 *  - when a Web Audio context IS available it drives the oscillator path, reuses
 *    a SINGLE shared context across beeps (no per-beep leak), resumes a suspended
 *    context, and — via `maybePlayAlertSound` — beeps ONLY when
 *    `soundEnabled && !muted` with at least one freshly-tripped alarm.
 *
 * The module caches a lazily-created `AudioContext` at module scope, so every
 * spec starts from a fresh module (`vi.resetModules()` + dynamic import) and
 * installs/removes its own `window` to keep the guard states isolated.
 */

/** One placeholder tripped alarm — only its presence/count matters to the gate. */
const firedOne = [{ kind: "signalLoss" }] as unknown as LiveAlert[];
const firedNone: LiveAlert[] = [];

/** Build a recording mock `AudioContext` constructor and its call ledger. */
function makeMockAudio(initialState: "running" | "suspended" = "running") {
  const oscillators: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const ledger = { contexts: 0 };
  const resume = vi.fn(() => Promise.resolve());

  class MockAudioContext {
    state = initialState;
    currentTime = 0;
    destination = {};
    resume = resume;
    constructor() {
      ledger.contexts += 1;
    }
    createOscillator() {
      const osc = {
        type: "",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
    }
  }

  return { MockAudioContext, oscillators, ledger, resume };
}

/** Install a mock Web Audio API on a global `window` for the current spec. */
function installWindow(ctor: unknown): void {
  (globalThis as unknown as { window?: unknown }).window = { AudioContext: ctor };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("playAlertSound — guarded / headless", () => {
  it("no-ops (never throws) when window is absent", async () => {
    // Node test env: no `window` at all — must return silently.
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    const { playAlertSound } = await import("@/lib/alertSound");
    expect(() => playAlertSound()).not.toThrow();
  });

  it("no-ops when window exists but has no AudioContext constructor", async () => {
    (globalThis as unknown as { window?: unknown }).window = {};
    const { playAlertSound } = await import("@/lib/alertSound");
    expect(() => playAlertSound()).not.toThrow();
  });
});

describe("playAlertSound — Web Audio path", () => {
  it("drives the oscillator path when an AudioContext is available", async () => {
    const { MockAudioContext, oscillators, ledger } = makeMockAudio();
    installWindow(MockAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");

    playAlertSound();

    expect(ledger.contexts).toBe(1);
    // A ~150ms two-note chirp → two oscillators, each started and stopped.
    expect(oscillators).toHaveLength(2);
    for (const osc of oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("reuses a SINGLE shared AudioContext across repeated beeps", async () => {
    const { MockAudioContext, oscillators, ledger } = makeMockAudio();
    installWindow(MockAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");

    playAlertSound();
    playAlertSound();
    playAlertSound();

    // One context total (no per-beep leak); each beep adds its two oscillators.
    expect(ledger.contexts).toBe(1);
    expect(oscillators).toHaveLength(6);
  });

  it("resumes a suspended context (autoplay policy)", async () => {
    const { MockAudioContext, resume } = makeMockAudio("suspended");
    installWindow(MockAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");

    playAlertSound();

    expect(resume).toHaveBeenCalled();
  });

  it("swallows a REJECTED resume() (autoplay blocked — the common case)", async () => {
    // A suspended context whose resume() rejects (no user gesture yet) is the
    // COMMON real-browser path. The `.catch` on resume must swallow it: no throw
    // and no unhandled rejection, and the oscillator path still runs. Uses a
    // bespoke mock so `resume` is a genuine instance method (a class *field* set
    // to a closure would be shadowed by any prototype override — the trap here).
    const oscillators: number[] = [];
    const rejectingResume = vi.fn(() => Promise.reject(new Error("autoplay blocked")));
    class RejectingResumeAudioContext {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume = rejectingResume;
      createOscillator() {
        oscillators.push(1);
        return { type: "", frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn() };
      }
    }

    // Fail the test loudly if the rejection ever escapes to the process.
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    installWindow(RejectingResumeAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");

    expect(() => playAlertSound()).not.toThrow();
    expect(rejectingResume).toHaveBeenCalled();
    // The beep still schedules despite the failed resume.
    expect(oscillators).toHaveLength(2);

    // Let the rejected microtask settle, then confirm nothing surfaced.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("does NOT resume an already-running context", async () => {
    const { MockAudioContext, resume } = makeMockAudio("running");
    installWindow(MockAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");

    playAlertSound();

    expect(resume).not.toHaveBeenCalled();
  });

  it("swallows an error thrown mid-beep (never disrupts the stream)", async () => {
    class ThrowingAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = vi.fn();
      createOscillator(): never {
        throw new Error("boom");
      }
      createGain() {
        return { gain: {}, connect: vi.fn() };
      }
    }
    installWindow(ThrowingAudioContext);
    const { playAlertSound } = await import("@/lib/alertSound");
    expect(() => playAlertSound()).not.toThrow();
  });
});

describe("maybePlayAlertSound — gating (soundEnabled && !muted, trip-only)", () => {
  /** Beep count == oscillators length / 2 (two per beep); 0 == silent. */
  async function run(
    firedAlerts: LiveAlert[],
    opts: { soundEnabled: boolean; muted: boolean }
  ): Promise<number> {
    const { MockAudioContext, oscillators } = makeMockAudio();
    installWindow(MockAudioContext);
    const { maybePlayAlertSound } = await import("@/lib/alertSound");
    maybePlayAlertSound(firedAlerts, opts);
    return oscillators.length;
  }

  it("plays when soundEnabled && !muted && an alarm tripped", async () => {
    expect(await run(firedOne, { soundEnabled: true, muted: false })).toBe(2);
  });

  it("is silent when sound is disabled (default off)", async () => {
    expect(await run(firedOne, { soundEnabled: false, muted: false })).toBe(0);
  });

  it("is silent when muted, even with sound enabled", async () => {
    expect(await run(firedOne, { soundEnabled: true, muted: true })).toBe(0);
  });

  it("is silent when no alarm tripped (recovery/clear never beeps)", async () => {
    expect(await run(firedNone, { soundEnabled: true, muted: false })).toBe(0);
  });

  it("never throws when firing headless (no window)", async () => {
    const { maybePlayAlertSound } = await import("@/lib/alertSound");
    expect(() =>
      maybePlayAlertSound(firedOne, { soundEnabled: true, muted: false })
    ).not.toThrow();
  });
});
