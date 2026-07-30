import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { DiagnosticsAiContext } from "@/lib/aiContext";

/**
 * M39a — the assistant store's one-shot diagnostic evidence (`pendingDiagnostics`).
 *
 * Proves: `setPendingDiagnostics` stages it; a `sendMessage` folds it into the built
 * AI context passed to `aiSendMessage`, then CLEARS it (one-shot, so it only rides
 * the turn it was attached to); and — the graceful BYOK no-key path — with no key
 * `sendMessage` posts the `ai.noKeyConfigured` bubble, never calls the provider, and
 * STILL clears the pending evidence (a later turn can't inherit it).
 *
 * Tauri is mocked OFF and `@/lib/ai` / `@/lib/chat-db` / `@/lib/ragRetrieval` are
 * mocked so the real store runs headlessly with no network/persistence.
 */

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(() => Promise.reject(new Error("no tauri in test"))),
}));

const ai = vi.hoisted(() => ({
  aiHasApiKey: vi.fn(() => Promise.resolve(true)),
  aiClearApiKey: vi.fn(() => Promise.resolve()),
  aiSetApiKey: vi.fn(() => Promise.resolve()),
  aiSendMessage: vi.fn(() => Promise.resolve({ content: "ok", suggestion: null })),
}));

vi.mock("@/lib/ai", () => ({
  aiHasApiKey: ai.aiHasApiKey,
  aiClearApiKey: ai.aiClearApiKey,
  aiSetApiKey: ai.aiSetApiKey,
  aiSendMessage: ai.aiSendMessage,
}));

// Persistence is out of scope here — no-op the chat-db seam.
vi.mock("@/lib/chat-db", () => ({
  createConversation: vi.fn(() => Promise.resolve()),
  deleteConversation: vi.fn(() => Promise.resolve()),
  latestConversationId: vi.fn(() => Promise.resolve(null)),
  listConversations: vi.fn(() => Promise.resolve([])),
  loadMessages: vi.fn(() => Promise.resolve([])),
  saveMessage: vi.fn(() => Promise.resolve()),
}));

// Retrieval is orthogonal to the diagnostics evidence — return an empty result so
// the built context carries only what this test attaches.
vi.mock("@/lib/ragRetrieval", () => ({
  retrieveForChat: vi.fn(() => ({ docs: [], chunks: [], noSourceFound: false })),
}));

import { useAssistantStore } from "@/stores/assistant";

const s = () => useAssistantStore.getState();

const diagnostics: DiagnosticsAiContext = {
  scope: "finding",
  findings: [
    {
      ruleId: "lq-collapse",
      category: "link",
      severity: "critical",
      confidence: 0.9,
      startSec: 12.4,
      endSec: 15,
      detail: { from: 95, to: 8 },
    },
  ],
  patterns: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  ai.aiHasApiKey.mockResolvedValue(true);
  ai.aiSendMessage.mockResolvedValue({ content: "ok", suggestion: null });
  s().reset();
});

afterEach(() => {
  s().reset();
});

describe("setPendingDiagnostics", () => {
  it("stages and clears the one-shot evidence", () => {
    expect(s().pendingDiagnostics).toBeNull();
    s().setPendingDiagnostics(diagnostics);
    expect(s().pendingDiagnostics).toEqual(diagnostics);
    s().setPendingDiagnostics(null);
    expect(s().pendingDiagnostics).toBeNull();
  });

  it("detaches staged evidence when the composer is cleared (empty draft)", () => {
    s().setPendingDiagnostics(diagnostics);
    // A non-empty draft (the prefill) keeps the staged evidence.
    s().setDraft("Explain this finding");
    expect(s().pendingDiagnostics).toEqual(diagnostics);
    // Clearing the composer (or a whitespace-only draft) detaches it.
    s().setDraft("   ");
    expect(s().pendingDiagnostics).toBeNull();
  });
});

describe("sendMessage folds in the pending diagnostics then clears it (one-shot)", () => {
  it("attaches the aggregate to the AI context passed to the provider", async () => {
    s().setPendingDiagnostics(diagnostics);
    await s().sendMessage("Explain this finding");

    expect(ai.aiSendMessage).toHaveBeenCalledTimes(1);
    const context = ai.aiSendMessage.mock.calls[0][0].context;
    expect(context.diagnostics).toBeDefined();
    expect(context.diagnostics.scope).toBe("finding");
    expect(context.diagnostics.findings[0].ruleId).toBe("lq-collapse");

    // One-shot: cleared after the send it rode on.
    expect(s().pendingDiagnostics).toBeNull();
  });

  it("does not leak into a following turn (the second send carries no diagnostics)", async () => {
    s().setPendingDiagnostics(diagnostics);
    await s().sendMessage("Explain this finding");
    await s().sendMessage("A follow-up question");

    expect(ai.aiSendMessage).toHaveBeenCalledTimes(2);
    const secondContext = ai.aiSendMessage.mock.calls[1][0].context;
    expect(secondContext.diagnostics).toBeUndefined();
  });

  it("captures the evidence synchronously so a concurrent composer clear can't drop it", async () => {
    // Mimic ChatInput.submit(): call sendMessage, then SYNCHRONOUSLY clear the draft
    // (which detaches staged evidence) before the async send folds the context in.
    s().setPendingDiagnostics(diagnostics);
    const pending = s().sendMessage("Explain this finding");
    s().setDraft(""); // would clear pendingDiagnostics — but it was already captured
    await pending;

    expect(ai.aiSendMessage).toHaveBeenCalledTimes(1);
    expect(ai.aiSendMessage.mock.calls[0][0].context.diagnostics).toBeDefined();
  });
});

describe("graceful BYOK no-key path still clears the one-shot", () => {
  it("posts ai.noKeyConfigured, never calls the provider, and clears pendingDiagnostics", async () => {
    ai.aiHasApiKey.mockResolvedValue(false); // selected provider needs a key, has none
    s().setPendingDiagnostics(diagnostics);

    await s().sendMessage("Explain this finding");

    const messages = s().messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe(i18n.t("ai.noKeyConfigured"));
    // No fabricated answer — the provider is never hit.
    expect(ai.aiSendMessage).not.toHaveBeenCalled();
    // The one-shot evidence is consumed even here, so a later turn can't inherit it.
    expect(s().pendingDiagnostics).toBeNull();
  });
});
