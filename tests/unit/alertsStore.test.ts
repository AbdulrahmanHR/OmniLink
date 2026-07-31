import { afterEach, describe, expect, it } from "vitest";
import { useAlertsStore } from "@/stores/alerts";

/**
 * Alerts store — the two opt-in UI preferences that sit beside the master mute.
 *
 *  - `soundEnabled` (FR-TELEM-03): an unexpected beep is intrusive, so it is
 *    opt-in and defaults OFF.
 *  - `osNotifyEnabled` (v3.0.3): a desktop popup is *more* intrusive than the
 *    beep — it paints over whatever app the operator is actually in — so it is
 *    opt-in on the same terms. This flag is not a mirror of an OS grant: the
 *    Tauri notification plugin's desktop backend returns `Granted`
 *    unconditionally, so if the app did not own the gate there would be none,
 *    and every scrubbed log frame would raise real system notifications.
 *
 * Both must default OFF, toggle/set independently of the master `muted` flag,
 * and never leak into the pure evaluator config.
 */
const store = () => useAlertsStore.getState();

afterEach(() => {
  // Restore every UI pref so specs don't bleed into one another (or later files).
  store().setSoundEnabled(false);
  store().setOsNotifyEnabled(false);
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

describe("alerts store — osNotifyEnabled", () => {
  it("defaults to false (opt-in — the app owns the consent gate, not the OS)", () => {
    // The regression this pins: the v3.0.3 plugin migration made
    // `permission_state()` answer `Granted` unconditionally on desktop, so for
    // one commit OS notifications fired with no opt-in anywhere. Nothing but
    // this initializer stands between a fresh install and a system popup.
    expect(useAlertsStore.getInitialState().osNotifyEnabled).toBe(false);
  });

  it("setOsNotifyEnabled sets it explicitly", () => {
    store().setOsNotifyEnabled(true);
    expect(store().osNotifyEnabled).toBe(true);
    store().setOsNotifyEnabled(false);
    expect(store().osNotifyEnabled).toBe(false);
  });

  it("toggleOsNotify flips it", () => {
    expect(store().osNotifyEnabled).toBe(false);
    store().toggleOsNotify();
    expect(store().osNotifyEnabled).toBe(true);
    store().toggleOsNotify();
    expect(store().osNotifyEnabled).toBe(false);
  });

  it("is independent of the master mute", () => {
    store().setOsNotifyEnabled(true);
    store().setMuted(true);
    expect(store().osNotifyEnabled).toBe(true); // mute doesn't clear the preference
    expect(store().muted).toBe(true);
    store().setMuted(false);
    expect(store().osNotifyEnabled).toBe(true);
  });

  it("is independent of the audio-alert opt-in", () => {
    // Two separate channels, two separate consents: opting into a beep must not
    // silently opt the operator into desktop popups (or the reverse).
    store().setSoundEnabled(true);
    expect(store().osNotifyEnabled).toBe(false);
    store().setOsNotifyEnabled(true);
    store().setSoundEnabled(false);
    expect(store().osNotifyEnabled).toBe(true);
  });
});
