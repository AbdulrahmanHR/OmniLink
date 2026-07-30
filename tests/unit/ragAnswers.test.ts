import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RAG-enabled Omnia answers (M51). Drives the assistant store's `sendMessage`
 * end-to-end through the REAL local retrieval pipeline + context assembly, with
 * only the Tauri boundary mocked (`@/lib/ai`, `@/lib/chat-db`) as the other store
 * tests do. Proves:
 *  - an in-corpus question attaches retrieved docs to the outbound context AND
 *    citations to the answer (citations are known client-side, not from the reply);
 *  - a below-threshold question ⇒ `noSourceFound`, NO retrieved docs sent, no
 *    citations on the answer;
 *  - enabled/disabled knowledge sources are respected (a disabled source is
 *    excluded from grounding; disabling all sources ⇒ no source found);
 *  - the BYOK path needs NO backend (pure store logic).
 *
 * v3.0 (M69): the flag-gated Managed answer path was deleted, so its two cases
 * went with it. BYOK is the only transport and its coverage is unchanged.
 */

const ai = vi.hoisted(() => ({
  aiHasApiKey: vi.fn(() => Promise.resolve(true)),
  aiClearApiKey: vi.fn(() => Promise.resolve()),
  aiSetApiKey: vi.fn(() => Promise.resolve()),
  aiSendMessage: vi.fn(() =>
    Promise.resolve({ content: "Here is the answer.", suggestion: null }),
  ),
}));

vi.mock("@/lib/ai", () => ({
  aiHasApiKey: ai.aiHasApiKey,
  aiClearApiKey: ai.aiClearApiKey,
  aiSetApiKey: ai.aiSetApiKey,
  aiSendMessage: ai.aiSendMessage,
}));

vi.mock("@/lib/chat-db", () => ({
  createConversation: vi.fn(() => Promise.resolve(true)),
  saveMessage: vi.fn(() => Promise.resolve()),
  deleteConversation: vi.fn(() => Promise.resolve()),
  latestConversationId: vi.fn(() => Promise.resolve(null)),
  listConversations: vi.fn(() => Promise.resolve([])),
  loadMessages: vi.fn(() => Promise.resolve([])),
}));

import { useAssistantStore, type ChatMessage } from "@/stores/assistant";
import { DRAFT_CONVERSATION_KEY, useKnowledgeStore } from "@/stores/knowledge";
import { resetFeatureFlags } from "@/lib/featureFlags";
import type { AiContextInput } from "@/lib/aiContext";

const s = () => useAssistantStore.getState();
const knowledge = () => useKnowledgeStore.getState();

/** The assistant message from the most recent turn. */
function lastAnswer(): ChatMessage {
  const msgs = s().messages;
  return msgs[msgs.length - 1];
}

/** The context that was handed to the (mocked) BYOK transport. */
function sentContext(): AiContextInput {
  const call = ai.aiSendMessage.mock.calls.at(-1)?.[0] as
    | { context: AiContextInput }
    | undefined;
  return call?.context ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  ai.aiHasApiKey.mockResolvedValue(true);
  ai.aiSendMessage.mockResolvedValue({ content: "Here is the answer.", suggestion: null });
  s().reset();
  knowledge().reset();
});

afterEach(() => {
  resetFeatureFlags();
});

describe("sendMessage — in-corpus question grounds the answer", () => {
  it("attaches retrieved docs to the context and citations to the answer", async () => {
    await s().sendMessage("What is a binding phrase?");

    // Retrieved docs are threaded into the OUTBOUND context.
    const ctx = sentContext();
    expect(ctx.retrievedDocs).toBeDefined();
    expect(ctx.retrievedDocs!.length).toBeGreaterThanOrEqual(1);
    expect(ctx.retrievedDocs![0].sourceId).toBe("elrs-binding");

    // Citations are attached to the ANSWER (client-side, not from the reply).
    const answer = lastAnswer();
    expect(answer.role).toBe("assistant");
    expect(answer.noSourceFound).toBe(false);
    expect(answer.citations?.length).toBeGreaterThanOrEqual(1);
    expect(answer.citations![0].sourceId).toBe("elrs-binding");
    // Citations carry a score (the UI shape), retrieved docs do not.
    expect(answer.citations![0]).toHaveProperty("score");
    expect(ctx.retrievedDocs![0]).not.toHaveProperty("score");
  });
});

describe("sendMessage — below-threshold question says no source found (D19)", () => {
  it("sends NO retrieved docs and marks the answer noSourceFound", async () => {
    await s().sendMessage("What is the best pizza topping to order?");

    // Nothing cleared the threshold ⇒ no retrieved docs in the payload.
    expect(sentContext().retrievedDocs).toBeUndefined();

    // The answer still sends, but is flagged and carries no citations.
    const answer = lastAnswer();
    expect(answer.role).toBe("assistant");
    expect(answer.noSourceFound).toBe(true);
    expect(answer.citations).toBeUndefined();
    // The turn still happened over the (mocked) BYOK transport.
    expect(ai.aiSendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("sendMessage — enabled/disabled sources are respected", () => {
  it("excludes a disabled source from grounding", async () => {
    // Disable in the draft bucket (no conversation yet); `sendMessage` opens the
    // conversation and promotes the choice onto it, so the first answer honors it.
    knowledge().setSourceEnabled(DRAFT_CONVERSATION_KEY, "elrs-binding", false);
    await s().sendMessage("What is a binding phrase?");

    const ctx = sentContext();
    const answer = lastAnswer();
    // The disabled source may no longer be the grounding, and never appears.
    for (const d of ctx.retrievedDocs ?? []) {
      expect(d.sourceId).not.toBe("elrs-binding");
    }
    for (const c of answer.citations ?? []) {
      expect(c.sourceId).not.toBe("elrs-binding");
    }
  });

  it("returns no source found when every source is disabled", async () => {
    for (const src of knowledge().sources) {
      knowledge().setSourceEnabled(DRAFT_CONVERSATION_KEY, src.metadata.id, false);
    }
    await s().sendMessage("What is a binding phrase?");

    expect(sentContext().retrievedDocs).toBeUndefined();
    const answer = lastAnswer();
    expect(answer.noSourceFound).toBe(true);
    expect(answer.citations).toBeUndefined();
  });

  it("abandoning a fresh chat drops draft toggles — a later send inherits nothing", async () => {
    // Disable a source in the draft bucket of a fresh chat...
    knowledge().setSourceEnabled(DRAFT_CONVERSATION_KEY, "elrs-binding", false);
    // ...then abandon that chat via "New chat" (must clear the draft).
    s().clearConversation();
    expect(
      knowledge().disabledByConversation[DRAFT_CONVERSATION_KEY],
    ).toBeUndefined();

    // The next send opens a brand-new conversation that inherits NOTHING, so the
    // once-disabled source is back in grounding — no leak across the abandoned chat.
    await s().sendMessage("What is a binding phrase?");
    const ctx = sentContext();
    expect(
      (ctx.retrievedDocs ?? []).some((d) => d.sourceId === "elrs-binding"),
    ).toBe(true);
  });
});

describe("BYOK path passes acceptance with no backend", () => {
  it("answers a cited question purely through store logic", async () => {
    // No feature flags, no Managed, only the mocked BYOK transport.
    await s().sendMessage("What packet rate should I use for freestyle?");
    const answer = lastAnswer();
    expect(answer.content).toBe("Here is the answer.");
    expect(answer.citations?.[0].sourceId).toBe("elrs-packet-rates");
    expect(ai.aiSendMessage).toHaveBeenCalledTimes(1);
  });
});

