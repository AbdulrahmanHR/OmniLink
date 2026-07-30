import { expect, test, type Page } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  SYNTHETIC_RAMP_CSV,
  uploadFile,
} from "./_helpers";

/**
 * The v2.5 / **M59 predictive failsafe warning experiment**, gated behind the OFF-by-default
 * `mlLab` flag (the SAME flag M56c's lab uses — no second flag was added).
 *
 * Four things this spec must prove, and does:
 *
 *  1. **Absent when the flag is OFF.** Not disabled — *absent*. A shipped build has the flag
 *     off, so a normal user's Settings page has no predictive surface at all. Release
 *     invariant #2: a normal user sees zero change from this release.
 *
 *  2. **The null result LEADS.** The panel's headline is that the experiment did **not** meet
 *     its acceptance, with the measured 80 ms / 0 ms oracle ceiling against the 2000 ms target
 *     as the reason. A lab user must not be able to leave this panel thinking it worked.
 *
 *  3. **"Predicted" is renderably DISTINCT from "measured".** M26's `LiveAlertHost` is an
 *     assertive live region (`role="region"`, `aria-live="assertive"`) full of `role="alert"`
 *     toasts — an *alarm* about a link that is **already bad**. M59's surface is a *report* of
 *     a *forecast* about a link that is **still up**, and it must not borrow any of that
 *     urgency: `aria-live="off"`, no `role="alert"`, an explicit "Predicted · not measured"
 *     badge, and the measured path shown beside it and labelled as the shipped one. This spec
 *     pins every one of those, because "distinct" is a claim that decays silently.
 *
 *  4. **The synthetic numbers are fenced and disclaimed**, and the safety copy does not
 *     overclaim — plus zero serious/critical a11y violations on the new surface.
 */

/** Baseline IPC handlers (present so nothing on the Settings page rejects noisily). */
const HANDLERS = {
  "plugin:sql|load": "sqlite:omnilink.db",
  "plugin:sql|select": [],
  "plugin:sql|execute": [0, 0],
  "plugin:sql|close": true,
  load_profiles: [],
  ai_has_api_key: false,
};

/** Flip a dev feature flag through the dev-only Preview-features panel. */
async function enableFlag(page: Page, flag: string): Promise<void> {
  await gotoApp(page, "/settings");
  await page.getByTestId(`dev-flag-${flag}`).click();
  await expect(page.getByTestId(`dev-flag-${flag}`)).toHaveAttribute("aria-checked", "true");
}

test.describe("M59 predictive failsafe warning (mlLab flag)", () => {
  test.use({ reducedMotion: "reduce" });

  test("is ABSENT from Settings when the flag is off (the ship default)", async ({ page }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");

    // The dev panel confirms the ship default really is OFF...
    await expect(page.getByTestId("dev-flag-mlLab")).toHaveAttribute("aria-checked", "false");

    // ...and with it off the whole predictive surface does not exist. Not "present but
    // disabled" — absent from the tree.
    await expect(page.getByTestId("ml-lab-predictive")).toHaveCount(0);
    await expect(page.getByTestId("ml-lab-predictive-verdict")).toHaveCount(0);
    await expect(page.getByTestId("ml-lab-predictive-state")).toHaveCount(0);
    await expect(page.getByTestId("ml-lab-predictive-synthetic")).toHaveCount(0);
  });

  test("leads with the NULL RESULT and does not let the reader think it worked", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await enableFlag(page, "mlLab");

    const panel = page.getByTestId("ml-lab-predictive");
    await expect(panel).toBeVisible();

    // The verdict is a failure, and it is the first thing said.
    await expect(page.getByTestId("ml-lab-predictive-verdict")).toContainText(
      "did NOT meet its acceptance"
    );
    await expect(page.getByTestId("ml-lab-predictive-verdict")).toContainText("research-only");

    // ...and the reason is the measured null, not a hedge: the corpus gives zero warning in 9
    // of 17 link losses, and at most 80 ms in any of them, against a 2000 ms target.
    const reason = page.getByTestId("ml-lab-predictive-reason");
    await expect(reason).toContainText("no early-warning signal in the data");
    await expect(reason).toContainText("zero warning");

    // The ORACLE ceiling is stated as a ceiling on what is POSSIBLE — so a reader cannot
    // dismiss the null as "their model was bad".
    await expect(page.getByTestId("ml-lab-predictive-ceiling")).toContainText("80");
    await expect(page.getByTestId("ml-lab-predictive-ceiling")).toContainText("2,000");

    // The predictor's own coverage: it warned ahead of 0 of the 17 recorded link losses.
    await expect(page.getByTestId("ml-lab-predictive-coverage")).toContainText(
      "warned ahead of 0 of the 17"
    );
  });

  test("renders the PREDICTED state DISTINCTLY from a MEASURED alert", async ({ page }) => {
    await installTauriMock(page, HANDLERS);
    await enableFlag(page, "mlLab");

    // With no session open, the predictor has nothing to run over — and says so plainly rather
    // than showing an empty alarm.
    await expect(page.getByTestId("ml-lab-predictive-session-empty")).toBeVisible();

    // Load a session that actually CONTAINS a degradation ramp, so the predicted state has
    // something to render. It has to be a DRAWN one: OmniLink's real reference flights contain
    // no ramp at all — that null result is M59's headline finding — so there is no real session
    // that would make this surface appear. The panel says as much, and the next test asserts it.
    await gotoApp(page, "/analysis");
    await uploadFile(page, "logs-import-input", SYNTHETIC_RAMP_CSV);

    // Client-side nav (a router <Link>, not a reload) so the loaded session survives into
    // Settings, where the lab lives.
    await page.getByRole("link", { name: "Settings" }).click();

    const predicted = page.getByTestId("ml-lab-predictive-state");
    const measuredHost = page.getByTestId("live-alert-host");

    // Both surfaces are on the page at once — which is exactly why they must not look or sound
    // alike, and why this test exists.
    await expect(predicted).toBeVisible();
    await expect(measuredHost).toHaveCount(1);

    // The predictor genuinely fired on the ramp: a real warning is rendered, end to end,
    // through the same `evaluateRiskFrame` a live link would run through.
    const warning = page.getByTestId("ml-lab-predictive-warning").first();
    await expect(warning).toBeVisible();

    // ---- Now the distinctness, dimension by dimension. ----------------------------------

    // 1. SEMANTICS. The M26 measured host is an ASSERTIVE live region: it interrupts you. The
    //    M59 predictive surface is aria-live="off": it is a report you READ. A guess must not
    //    announce itself with the urgency of a measurement — that would be an accessibility lie
    //    as much as a safety one.
    await expect(measuredHost).toHaveAttribute("aria-live", "assertive");
    await expect(predicted).toHaveAttribute("aria-live", "off");

    // 2. It is NOT an alert. M26's toasts are role="alert"; nothing in the predictive surface is.
    await expect(predicted.locator('[role="alert"]')).toHaveCount(0);

    // 3. VOCABULARY. The surface is badged "Predicted · not measured", and the warning itself
    //    repeats the hedge rather than asserting a fact about the present.
    await expect(page.getByTestId("ml-lab-predictive-badge")).toContainText("Predicted");
    await expect(page.getByTestId("ml-lab-predictive-badge")).toContainText("not measured");
    await expect(warning).toContainText("Predicted, not measured");
    await expect(warning).toContainText("may be wrong");

    // 4. CONFIDENCE + EVIDENCE are shown, and the confidence is explicitly NOT a crash
    //    probability — the one misreading that would matter most.
    await expect(warning).toContainText("Confidence in the projection");
    await expect(warning).toContainText("NOT the probability of a crash");
    await expect(warning).toContainText("link quality");

    // 5. The MEASURED path is shown BESIDE it and named as the shipped, deterministic one that
    //    this experiment does not change, reorder, or suppress.
    const measured = page.getByTestId("ml-lab-predictive-measured");
    await expect(measured).toContainText("Measured now");
    await expect(measured).toContainText("does not change, reorder, or suppress");
  });

  test("fences the SYNTHETIC numbers and understates the safety claim", async ({ page }) => {
    await installTauriMock(page, HANDLERS);
    await enableFlag(page, "mlLab");

    // The synthetic numbers are explicitly NOT field evidence and NOT an acceptance pass, and
    // the panel says the ramps were DRAWN long enough for a 2 s warning to be possible at all.
    const synthetic = page.getByTestId("ml-lab-predictive-synthetic-warning");
    await expect(synthetic).toContainText("a generator DREW");
    await expect(synthetic).toContainText("NOT evidence");
    await expect(synthetic).toContainText("NOT an acceptance pass");

    // The false-alarm price is stated in the same breath as the lead time — including that the
    // predictor false-alarms on the deep near-misses, where the link nearly died and recovered.
    await expect(page.getByTestId("ml-lab-predictive-synthetic-fp")).toContainText(
      "false alarm"
    );
    await expect(page.getByTestId("ml-lab-predictive-synthetic-fp")).toContainText("RECOVERED");

    // SAFETY. It errs toward understatement: wrong in both directions, cannot be relied upon,
    // does not replace judgement, never writes to hardware.
    const safety = page.getByTestId("ml-lab-predictive-safety");
    await expect(safety).toContainText("can be wrong in both directions");
    await expect(safety).toContainText("cannot be relied upon");
    await expect(safety).toContainText("never changes anything on your hardware");

    // And the surface says, in the UI, that it is an unvalidated prototype that found no signal.
    const prototype = page.getByTestId("ml-lab-predictive-prototype");
    await expect(prototype).toContainText("Unvalidated prototype");
    await expect(prototype).toContainText("no early-warning signal");

    // a11y: zero serious/critical violations on the new surface.
    await expectNoSeriousA11y(page);
  });
});
