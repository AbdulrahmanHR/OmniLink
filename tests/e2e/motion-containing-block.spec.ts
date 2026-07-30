import { expect, test } from "@playwright/test";
import { gotoApp, installTauriMock } from "./_helpers";

/**
 * v2.5.0 regression gate — a settled CSS transform on <Card> must never capture
 * the app's fixed-position modals.
 *
 * The Signal Lab entrance animation (`motion-safe:animate-signal-rise`) puts
 * a transform on EVERY Card. A transform of any kind — including the identity
 * `translateY(0)` — makes the element a containing block for `position: fixed`
 * descendants (CSS Transforms L1 §3). Dialog and Sheet are NOT portalled, and
 * two of them render inside a Card (PrivacyDataSettings' erase-all confirm, and
 * DiagnosticSettings' sheet on TelemetryPage). With a forwards fill, the erase
 * dialog would be confined to the Privacy card's ~600x300 box: the backdrop
 * would dim only that card and the focus-trapped panel would centre inside it.
 *
 * The fix is in src/index.css: the keyframe settles on `transform: none` and the
 * utility fills `backwards`, so no transform survives the animation.
 *
 * CRITICALLY, this spec runs with `reducedMotion: "no-preference"`. Every other
 * e2e spec forces `reduce`, where `motion-safe:` never matches and the transform
 * never applies — which is exactly why the suite could not see this bug. Do not
 * "fix" a failure here by switching this file to `reduce`.
 */
test.use({ reducedMotion: "no-preference" });

const HANDLERS = {
  "plugin:sql|load": "sqlite:omnilink.db",
  "plugin:sql|select": [],
  "plugin:sql|execute": [0, 0],
  "plugin:sql|close": true,
  load_profiles: [],
  ai_has_api_key: false,
};

test.describe("Card entrance animation does not trap fixed-position modals", () => {
  test("the erase-data dialog anchors to the viewport, not to its Card", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");

    // The settings cards mount from a lazily-loaded route chunk, so wait for one
    // of them before timing anything.
    await expect(page.getByTestId("privacy-delete-btn")).toBeVisible();

    // Then wait until no rise is still running. A non-filling animation is
    // dropped from getAnimations() once it completes, so "none left" IS "all
    // finished". (Only rises are considered — the decorative glow/ping pulses
    // are infinite and would never satisfy this.)
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .filter((a) => (a as CSSAnimation).animationName === "signal-rise")
        .every((a) => a.playState === "finished")
    );

    // Root cause: no Card may retain a transform once the animation has settled.
    const cardTransforms = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".bg-card")]
        .map((el) => ({
          cls: el.className,
          transform: getComputedStyle(el).transform,
        }))
        .filter((x) => x.transform !== "none")
    );
    expect(
      cardTransforms,
      "a settled Card kept a transform — it will capture fixed descendants"
    ).toEqual([]);

    // Symptom: the dialog must fill the viewport, not its Card ancestor's box.
    await page.getByTestId("privacy-delete-btn").click();
    const panel = page.getByRole("dialog");
    await expect(panel).toBeVisible();

    const overlay = page.locator('div[role="presentation"]').filter({
      has: page.getByRole("dialog"),
    });
    const box = await overlay.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(Math.round(box!.width)).toBe(viewport!.width);
    expect(Math.round(box!.height)).toBe(viewport!.height);
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.y)).toBe(0);
  });
});
