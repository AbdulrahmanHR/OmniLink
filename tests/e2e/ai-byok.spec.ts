import { expect, test } from "@playwright/test";
import { expectNoSeriousA11y, gotoApp, installTauriMock } from "./_helpers";

/**
 * v1.7.2 — keys-only Settings + chat provider→model selection (remembered).
 *
 * Drives the real BYOK stores through the Tauri mock: a key is assigned in
 * Settings (credentials only — no model field there), then the chat picks a
 * provider + model, and that choice survives a full reload.
 */
test.describe("BYOK keys-only + remembered chat selection", () => {
  test.use({ reducedMotion: "reduce" });

  test("assign a key in Settings, pick provider+model in chat, survive reload", async ({
    page,
  }) => {
    // Mocked backend AI commands: key probes succeed, models come live, sends ok.
    await installTauriMock(page, {
      ai_set_api_key: null,
      ai_has_api_key: true,
      ai_list_models: [
        { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
      ai_send_message: { content: "ok", suggestion: null },
    });

    // --- Settings: assign a provider key (NO model field here) ---------------
    await gotoApp(page, "/settings");
    await expect(page.getByTestId("ai-settings-card")).toBeVisible();
    // There is no model picker in Settings — only per-provider credentials.
    await expect(page.getByTestId("ai-key-row-anthropic")).toBeVisible();
    await page.getByTestId("ai-key-input-anthropic").fill("sk-test-key");
    await page.getByTestId("ai-key-save-anthropic").click();

    // --- Chat: pick provider then model -------------------------------------
    await page.getByRole("button", { name: /open omnia assistant/i }).click();
    const providerSelect = page.getByTestId("chat-provider-select");
    const modelSelect = page.getByTestId("chat-model-select");
    await expect(providerSelect).toBeVisible();
    await providerSelect.selectOption("anthropic");
    await modelSelect.selectOption("claude-sonnet-4-6");
    await expect(providerSelect).toHaveValue("anthropic");
    await expect(modelSelect).toHaveValue("claude-sonnet-4-6");

    // Open chat panel is accessible.
    await expectNoSeriousA11y(page);

    // --- Reload: the remembered {provider, model} selection persists ---------
    await page.reload();
    await page.getByRole("button", { name: /open omnia assistant/i }).click();
    await expect(page.getByTestId("chat-provider-select")).toHaveValue("anthropic");
    await expect(page.getByTestId("chat-model-select")).toHaveValue(
      "claude-sonnet-4-6"
    );
  });
});
