import { afterEach, describe, expect, it } from "vitest";
import { useAlertsStore } from "@/stores/alerts";

/**
 * Alerts store — the FR-TELEM-03 `soundEnabled` UI preference. It must default
 * OFF (opt-in: an unexpected beep is intrusive), toggle/set independently of the
 * master `muted` flag, and never leak into the pure evaluator config.
 */
const store = () => useAlertsStore.getState();

afterEach(() => {
  // Restore both UI prefs so specs don't bleed into one another (or later files).
  store().setSoundEnabled(false);
  store().setMuted(false);
});

describe("alerts store — soundEnabled", () => {
  it("defaults to false (opt-in)", () => {
    expect(useAlertsStore.getInitialState().soundEnabled).toBe(false);
  });

  it("setSoundEnabled sets it explicitly", () => {
    store().setSoundEnabled(true);
    expect(store().soundEnabled).toBe(true);
    store().setSoundEnabled(false);
    expect(store().soundEnabled).toBe(false);
  });

  it("toggleSound flips it", () => {
    expect(store().soundEnabled).toBe(false);
    store().toggleSound();
    expect(store().soundEnabled).toBe(true);
    store().toggleSound();
    expect(store().soundEnabled).toBe(false);
  });

  it("is independent of the master mute", () => {
    store().setSoundEnabled(true);
    store().setMuted(true);
    expect(store().soundEnabled).toBe(true); // mute doesn't clear the preference
    expect(store().muted).toBe(true);
    store().setMuted(false);
    expect(store().soundEnabled).toBe(true);
  });
});
