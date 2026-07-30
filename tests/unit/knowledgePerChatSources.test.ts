import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_CONVERSATION_KEY,
  migrateKnowledgePersisted,
  selectEnabledSourceIds,
  selectEnabledSourceIdsFor,
  selectRetrievalIndex,
  useKnowledgeStore,
} from "@/stores/knowledge";
import { retrieveForChat } from "@/lib/ragRetrieval";

/**
 * Per-conversation ("per-chat") source enable/disable (M52 fix). Proves the
 * enable/disable of knowledge sources is scoped to a single conversation:
 *  - `selectEnabledSourceIdsFor` returns a conversation's enabled set (a source
 *    is enabled unless THAT conversation disabled it); `null` ⇒ all enabled;
 *  - `setSourceEnabled` writes only the target conversation's disabled set, so
 *    two conversations keep INDEPENDENT choices;
 *  - retrieval honors the active conversation's set (a source disabled in one
 *    chat still grounds answers in another);
 *  - the draft bucket promotes onto a freshly-opened conversation;
 *  - the v1→v2 persist migration drops the legacy global disable map.
 */

const store = () => useKnowledgeStore.getState();

// A note with coined, out-of-corpus terms so its retrieval is unambiguous.
const ZORP_MD =
  "# Zorptastic\n\nThe zorptastic widget calibration procedure resets the flux capacitor.";
const QUERY = "zorptastic widget calibration";

beforeEach(() => {
  store().reset();
});

describe("selectEnabledSourceIdsFor — conversation scoping", () => {
  it("null conversation ⇒ every source enabled (the all-on baseline)", () => {
    const s = store();
    const all = selectEnabledSourceIdsFor(s, null);
    expect(all.size).toBe(s.sources.length);
    for (const src of s.sources) expect(all.has(src.metadata.id)).toBe(true);
    // The convenience `selectEnabledSourceIds` is exactly the null scope.
    expect([...selectEnabledSourceIds(s)].sort()).toEqual([...all].sort());
  });

  it("a source is enabled unless THAT conversation disabled it", () => {
    const id = store().sources[0].metadata.id;
    store().setSourceEnabled("c-1", id, false);
    const s = store();
    expect(selectEnabledSourceIdsFor(s, "c-1").has(id)).toBe(false);
    // Untouched conversation (and a brand-new one) keep the source enabled.
    expect(selectEnabledSourceIdsFor(s, "c-2").has(id)).toBe(true);
    expect(selectEnabledSourceIdsFor(s, "c-new").has(id)).toBe(true);
  });

  it("re-enabling prunes the conversation's disabled entry", () => {
    const id = store().sources[0].metadata.id;
    store().setSourceEnabled("c-1", id, false);
    expect(store().disabledByConversation["c-1"]).toEqual({ [id]: true });
    store().setSourceEnabled("c-1", id, true);
    // The now-empty bucket is pruned so it reads identically to "all enabled".
    expect(store().disabledByConversation["c-1"]).toBeUndefined();
    expect(selectEnabledSourceIdsFor(store(), "c-1").has(id)).toBe(true);
  });
});

describe("two conversations keep independent disabled sets", () => {
  it("disabling a source in one chat does not affect another", () => {
    const a = store().sources[0].metadata.id;
    const b = store().sources[1].metadata.id;
    store().setSourceEnabled("chat-A", a, false);
    store().setSourceEnabled("chat-B", b, false);
    const s = store();

    const enabledA = selectEnabledSourceIdsFor(s, "chat-A");
    const enabledB = selectEnabledSourceIdsFor(s, "chat-B");
    expect(enabledA.has(a)).toBe(false);
    expect(enabledA.has(b)).toBe(true);
    expect(enabledB.has(b)).toBe(false);
    expect(enabledB.has(a)).toBe(true);
  });
});

describe("retrieval respects the active conversation's set", () => {
  it("excludes an imported source only in the chat that disabled it", () => {
    store().importDoc("zorp.md", ZORP_MD);
    const id = store().importedSources[0].id;
    store().setSourceEnabled("chat-A", id, false);
    const s = store();
    const index = selectRetrievalIndex(s);

    // chat-A disabled it ⇒ absent from grounding there.
    const inA = retrieveForChat(QUERY, {
      enabledSourceIds: selectEnabledSourceIdsFor(s, "chat-A"),
      index,
    });
    expect(inA.chunks.some((c) => c.sourceId === id)).toBe(false);

    // chat-B never disabled it ⇒ it still grounds answers there.
    const inB = retrieveForChat(QUERY, {
      enabledSourceIds: selectEnabledSourceIdsFor(s, "chat-B"),
      index,
    });
    expect(inB.chunks.some((c) => c.sourceId === id)).toBe(true);
  });
});

describe("draft bucket promotes onto a freshly-opened conversation", () => {
  it("carries pre-send toggles onto the new conversation and consumes the draft", () => {
    const id = store().sources[0].metadata.id;
    // Toggle before any conversation exists → lands in the draft bucket.
    store().setSourceEnabled(DRAFT_CONVERSATION_KEY, id, false);
    expect(store().disabledByConversation[DRAFT_CONVERSATION_KEY]).toEqual({
      [id]: true,
    });

    store().promoteDraftSources("c-fresh");
    const s = store();
    // The draft is consumed and its choice now lives under the real conversation.
    expect(s.disabledByConversation[DRAFT_CONVERSATION_KEY]).toBeUndefined();
    expect(selectEnabledSourceIdsFor(s, "c-fresh").has(id)).toBe(false);
  });

  it("promoting an empty draft is a no-op", () => {
    store().promoteDraftSources("c-fresh");
    expect(store().disabledByConversation).toEqual({});
  });
});

describe("abandoning a fresh chat clears the draft (no leak across chats)", () => {
  it("clearDraftSources drops the draft so a later fresh chat + send inherit nothing", () => {
    const id = store().sources[0].metadata.id;
    // Toggle in a fresh chat (draft bucket), then abandon that chat.
    store().setSourceEnabled(DRAFT_CONVERSATION_KEY, id, false);
    store().clearDraftSources();

    // The draft is gone; the fresh-chat (draft-keyed) scope is all-enabled again.
    expect(store().disabledByConversation[DRAFT_CONVERSATION_KEY]).toBeUndefined();
    expect(selectEnabledSourceIdsFor(store(), DRAFT_CONVERSATION_KEY).has(id)).toBe(
      true,
    );

    // A subsequent fresh chat's first turn promotes NOTHING onto the new conv.
    store().promoteDraftSources("c-after-abandon");
    expect(store().disabledByConversation["c-after-abandon"]).toBeUndefined();
    expect(selectEnabledSourceIdsFor(store(), "c-after-abandon").has(id)).toBe(true);
  });

  it("clearDraftSources is a no-op when there is no draft", () => {
    store().clearDraftSources();
    expect(store().disabledByConversation).toEqual({});
  });
});

describe("delete clears a source's per-chat toggles across all conversations", () => {
  it("drops the deleted imported id from every conversation bucket", () => {
    store().importDoc("zorp.md", ZORP_MD);
    const id = store().importedSources[0].id;
    store().setSourceEnabled("chat-A", id, false);
    store().setSourceEnabled("chat-B", id, false);
    store().deleteImportedSource(id);
    const s = store();
    expect(s.disabledByConversation["chat-A"]).toBeUndefined();
    expect(s.disabledByConversation["chat-B"]).toBeUndefined();
  });
});

describe("persist migration v1 → v2 drops the global disable map", () => {
  it("replaces the legacy global disabledSources with an empty per-conversation map", () => {
    const migrated = migrateKnowledgePersisted(
      {
        lastUpdated: {},
        disabledSources: { "elrs-docs": true as const },
        importedSources: [],
      },
      1,
    );
    expect(migrated.disabledByConversation).toEqual({});
    expect(
      (migrated as { disabledSources?: unknown }).disabledSources,
    ).toBeUndefined();
  });
});
