import { expect, test } from "@playwright/test";
import {
  emitTauri,
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
} from "./_helpers";

/**
 * M53 — AI-assisted wizard mode.
 *
 * Case 1: select AI mode → answer the clarifying questions → reach the suggested
 * summary → "Apply & review" hands off to the SAME static StepReview flash flow,
 * which confirms + flashes deterministically.
 *
 * Case 2: going offline degrades the AI panel to a clear fallback with a one-click
 * switch to the static wizard — no dead-end. Both surfaces pass the a11y gate.
 *
 * Drives the real wizard + assistant + knowledge stores through the Tauri mock
 * seam (like `ai-byok.spec.ts`), seeding the `ai_*` + flash handlers.
 */
test.describe("AI-assisted wizard mode", () => {
  test.use({ reducedMotion: "reduce" });

  const HANDLERS = {
    ai_has_api_key: true,
    ai_list_models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
    ai_send_message: { content: "ok", suggestion: null },
    // Flash seam: the review step's Flash button drives this deterministically.
    start_flash: null,
    derive_uid: [1, 2, 3, 4, 5, 6],
  };

  test("AI flow reaches the suggestion, then confirms via the same StepReview flash", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/flash");

    // Switch to AI-assisted mode; the AI panel replaces the static stepper.
    await page.getByTestId("wizard-mode-ai").click();
    const panel = page.getByTestId("ai-wizard-panel");
    await expect(panel).toBeVisible();

    // The clarifying surface is accessible.
    await expectNoSeriousA11y(page);

    // Answer the three clarifying questions.
    await page.getByTestId("ai-role-TX").click();
    await page.getByTestId("ai-usecase-racing").click();
    await page.getByTestId("ai-region-us").click();

    // Get the recommendation → the suggested summary card appears.
    await page.getByTestId("ai-wizard-recommend").click();
    const suggestion = page.getByTestId("ai-wizard-suggestion");
    await expect(suggestion).toBeVisible();
    // The summary is grounded in the real catalogue (a build target is shown).
    await expect(suggestion).toContainText("BETAFPV_2400_TX");
    await expectNoSeriousA11y(page);

    // Apply & review → hands off to the SAME deterministic static review step.
    await page.getByTestId("ai-wizard-apply-review").click();
    // The AI panel is gone; the static review Flash button is now the SOLE trigger.
    await expect(page.getByTestId("ai-wizard-panel")).toHaveCount(0);
    const flashButton = page.getByRole("button", { name: "Flash" });
    await expect(flashButton).toBeVisible();

    // Confirm + flash through the identical static flow.
    await flashButton.click();
    await emitTauri(page, "flash://progress", {
      stage: "write",
      percent: 100,
      etaSeconds: 0,
    });
    await emitTauri(page, "flash://done", null);
    await expect(page.getByText("Flash complete")).toBeVisible();
  });

  test("going offline degrades to the static wizard with no dead-end", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/flash");

    // Wait for the lazy wizard chunk to load WHILE online (its offline-fetch would
    // otherwise fail), then go offline before entering AI mode so the panel
    // evaluates as unavailable.
    await expect(page.getByTestId("wizard-mode-ai")).toBeVisible();
    await page.context().setOffline(true);
    await page.getByTestId("wizard-mode-ai").click();

    // The AI panel shows the fallback notice + a switch to the static wizard.
    const fallback = page.getByTestId("ai-wizard-fallback");
    await expect(fallback).toBeVisible();
    await expectNoSeriousA11y(page);

    // No dead-end: one click reaches the fully-working static wizard.
    await page.getByTestId("ai-wizard-use-static").click();
    await expect(page.getByTestId("ai-wizard-panel")).toHaveCount(0);
    // The static brand step is reachable (its instruction copy renders).
    await expect(
      page.getByText("Choose the manufacturer of the device you want to flash."),
    ).toBeVisible();
  });
});
