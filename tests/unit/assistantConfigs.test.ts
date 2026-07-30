import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for the v1.7.2 keys-only BYOK store: per-provider `credentials`, the
 * remembered `{ provider, model }` `selection`, the `activeSend` send-target
 * selector, `availableProviders` chat gating, and the one-time `migrateByokState`
 * that converts BOTH legacy shapes (pre-v1.6.3 flat + v1.6.3 multi-config) into
 * the new shape WITHOUT losing a single backend key (it preserves each
 * provider's non-default key-slot id).
 *
 * `@/lib/ai` is mocked so the store's `aiSetApiKey`/`aiHasApiKey`/`aiClearApiKey`
 * calls never reach Tauri.
 */

const ai = vi.hoisted(() => ({
  aiHasApiKey: vi.fn(() => Promise.resolve(false)),
  aiClearApiKey: vi.fn(() => Promise.resolve()),
  aiSetApiKey: vi.fn(() => Promise.resolve()),
  aiSendMessage: vi.fn(() => Promise.resolve({ content: "", suggestion: null })),
}));

vi.mock("@/lib/ai", () => ({
  aiHasApiKey: ai.aiHasApiKey,
  aiClearApiKey: ai.aiClearApiKey,
  aiSetApiKey: ai.aiSetApiKey,
  aiSendMessage: ai.aiSendMessage,
}));

import {
  activeSend,
  availableProviders,
  migrateByokState,
  PROVIDERS,
  useAssistantStore,
} from "@/stores/assistant";

const s = () => useAssistantStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  ai.aiHasApiKey.mockResolvedValue(false);
  s().reset();
});

describe("migrateByokState — v1.6.3 multi-config → per-provider credentials", () => {
  it("preserves a non-default key-slot id so the stored key is NOT lost", () => {
    const state = {
      configs: {
        "cfg-xyz": {
          id: "cfg-xyz", // random id ⇒ key stored under the "cfg-xyz" slot
          label: "Work OpenAI",
          provider: "openai",
          model: "gpt-5-mini",
          baseUrl: "https://api.openai.com/v1",
        },
      },
      configOrder: ["cfg-xyz"],
      activeConfigId: "cfg-xyz",
    };
    migrateByokState(state as never);
    const migrated = state as Record<string, unknown>;
    // The credential keeps the legacy slot id, so the backend secret resolves.
    expect((migrated.credentials as Record<string, unknown>).openai).toEqual({
      keyId: "cfg-xyz",
    });
    // Default selection comes from the previously-active config.
    expect(migrated.selection).toEqual({ provider: "openai", model: "gpt-5-mini" });
    // Obsolete fields are dropped.
    expect(migrated.configs).toBeUndefined();
    expect(migrated.configOrder).toBeUndefined();
    expect(migrated.activeConfigId).toBeUndefined();
  });

  it("writes no keyId override when the slot already equals the provider id", () => {
    const state = {
      configs: {
        anthropic: {
          id: "anthropic", // == provider ⇒ key already under the provider slot
          label: "Anthropic",
          provider: "anthropic",
          model: "claude-opus-4-8",
          baseUrl: "https://api.anthropic.com",
        },
      },
      configOrder: ["anthropic"],
      activeConfigId: "anthropic",
    };
    migrateByokState(state as never);
    // No override needed (default slot resolves), so the credential is empty.
    expect((state as Record<string, never>).credentials).toEqual({ anthropic: {} });
    expect((state as Record<string, unknown>).selection).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
  });

  it("carries over a custom base URL", () => {
    const state = {
      configs: {
        ollama: {
          id: "ollama",
          label: "Ollama",
          provider: "ollama",
          model: "llama3.1",
          baseUrl: "http://192.168.1.9:11434/v1", // non-default
        },
      },
      configOrder: ["ollama"],
      activeConfigId: "ollama",
    };
    migrateByokState(state as never);
    expect((state as Record<string, never>).credentials).toEqual({
      ollama: { baseUrl: "http://192.168.1.9:11434/v1" },
    });
  });
});

describe("migrateByokState — pre-v1.6.3 flat → selection", () => {
  it("derives the selection from the last-used provider/model; keys stay under the provider slot", () => {
    const state = {
      provider: "openai",
      models: { openai: "gpt-4.1" },
      baseUrls: {},
    };
    migrateByokState(state as never);
    const migrated = state as Record<string, unknown>;
    expect(migrated.selection).toEqual({ provider: "openai", model: "gpt-4.1" });
    // No keyId overrides — flat keys already live under the provider slot.
    expect(migrated.credentials).toEqual({});
    expect(migrated.provider).toBeUndefined();
    expect(migrated.models).toBeUndefined();
  });
});

describe("migrateByokState — production rehydrate path (regression for the guard bug)", () => {
  it("STILL migrates legacy configs even when a default selection is already present", () => {
    // Reproduces the real onRehydrateStorage input: zustand shallow-merges the
    // persisted v1.6.3 blob OVER the initializer, so `selection` is the default
    // and `configs` is the legacy data. A selection-keyed guard would wrongly
    // skip this and orphan the key; the legacy-presence guard must convert it.
    const state = {
      configs: {
        "cfg-xyz": {
          id: "cfg-xyz",
          label: "Work OpenAI",
          provider: "openai",
          model: "gpt-5-mini",
          baseUrl: "https://api.openai.com/v1",
        },
      },
      configOrder: ["cfg-xyz"],
      activeConfigId: "cfg-xyz",
      // present from the store initializer default:
      selection: { provider: "anthropic", model: "claude-opus-4-8" },
      credentials: {},
    };
    migrateByokState(state as never);
    const m = state as Record<string, unknown>;
    expect((m.credentials as Record<string, unknown>).openai).toEqual({
      keyId: "cfg-xyz",
    });
    expect(m.selection).toEqual({ provider: "openai", model: "gpt-5-mini" });
    expect(m.configs).toBeUndefined();
  });

  it("falls back to the first saved config when no active config is set", () => {
    const state = {
      configs: {
        "cfg-1": {
          id: "cfg-1",
          label: "OpenAI",
          provider: "openai",
          model: "gpt-4.1",
          baseUrl: "https://api.openai.com/v1",
        },
      },
      configOrder: ["cfg-1"],
      activeConfigId: null,
      selection: { provider: "anthropic", model: "claude-opus-4-8" },
    };
    migrateByokState(state as never);
    expect((state as Record<string, unknown>).selection).toEqual({
      provider: "openai",
      model: "gpt-4.1",
    });
  });
});

describe("migrateByokState — idempotency + fresh install", () => {
  it("is a no-op once on the new shape with no legacy fields (idempotent run twice)", () => {
    const state = {
      credentials: { openai: { keyId: "cfg-xyz" } },
      selection: { provider: "openai", model: "gpt-5" },
    };
    const snapshot = JSON.parse(JSON.stringify(state));
    migrateByokState(state as never);
    migrateByokState(state as never); // run twice
    expect(state).toEqual(snapshot);
  });

  it("leaves a fresh install on the default selection", () => {
    const state = {};
    migrateByokState(state as never);
    expect((state as Record<string, unknown>).credentials).toEqual({});
    expect((state as Record<string, unknown>).selection).toEqual({
      provider: "anthropic",
      model: PROVIDERS.anthropic.models[0],
    });
  });
});

describe("activeSend selector", () => {
  it("defaults keyId to the provider and baseUrl to the registry default", () => {
    const send = activeSend({
      selection: { provider: "anthropic", model: "claude-opus-4-8" },
      credentials: {},
    });
    expect(send).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      keyId: "anthropic",
      baseUrl: PROVIDERS.anthropic.defaultBaseUrl,
    });
  });

  it("uses a credential's overridden keyId + baseUrl when present", () => {
    const send = activeSend({
      selection: { provider: "openai", model: "gpt-5" },
      credentials: { openai: { keyId: "cfg-xyz", baseUrl: "https://proxy/v1" } },
    });
    expect(send.keyId).toBe("cfg-xyz");
    expect(send.baseUrl).toBe("https://proxy/v1");
  });
});

describe("availableProviders gating", () => {
  it("always offers key-less Ollama and hides key-required providers with no key", () => {
    expect(availableProviders({})).toEqual(["ollama"]);
  });

  it("offers a key-required provider once it has a stored key", () => {
    expect(availableProviders({ openai: true })).toEqual(["openai", "ollama"]);
  });
});

describe("setApiKey / clearApiKey", () => {
  it("stores the key under the provider slot and marks the provider configured", async () => {
    await s().setApiKey("anthropic", "sk-test");
    expect(ai.aiSetApiKey).toHaveBeenCalledWith("anthropic", "sk-test", "anthropic");
    expect(s().credentials.anthropic).toEqual({});
  });

  it("reuses a migrated non-default key slot when saving a new key", async () => {
    // Simulate a migrated credential with a legacy slot id.
    useAssistantStore.setState({ credentials: { openai: { keyId: "cfg-xyz" } } });
    await s().setApiKey("openai", "sk-new");
    expect(ai.aiSetApiKey).toHaveBeenCalledWith("openai", "sk-new", "cfg-xyz");
  });

  it("records a custom base URL as an override only", async () => {
    await s().setApiKey("ollama", "", "http://host:11434/v1");
    expect(s().credentials.ollama).toEqual({ baseUrl: "http://host:11434/v1" });
  });

  it("does NOT call the backend with a blank key (a blank Save must not clear the slot)", async () => {
    await s().setApiKey("openai", "   ", "https://proxy/v1");
    expect(ai.aiSetApiKey).not.toHaveBeenCalled();
    expect(s().credentials.openai).toEqual({ baseUrl: "https://proxy/v1" });
  });

  it("clearApiKey clears the slot and drops the credential", async () => {
    useAssistantStore.setState({ credentials: { openai: { keyId: "cfg-xyz" } } });
    await s().clearApiKey("openai");
    expect(ai.aiClearApiKey).toHaveBeenCalledWith("openai", "cfg-xyz");
    expect(s().credentials.openai).toBeUndefined();
  });

  it("clearApiKey keeps a custom base-URL override (only the key is removed)", async () => {
    useAssistantStore.setState({
      credentials: { ollama: { baseUrl: "http://host:11434/v1" } },
    });
    await s().clearApiKey("ollama");
    expect(s().credentials.ollama).toEqual({ baseUrl: "http://host:11434/v1" });
  });
});

describe("selection + key status", () => {
  it("setSelection remembers the provider + model", () => {
    s().setSelection("gemini", "gemini-2.5-flash");
    expect(s().selection).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("refreshKeyedProviders marks Ollama keyed and others per the backend probe", async () => {
    ai.aiHasApiKey.mockImplementation((provider: string) =>
      Promise.resolve(provider === "openai")
    );
    await s().refreshKeyedProviders();
    expect(s().keyed.ollama).toBe(true); // key-less
    expect(s().keyed.openai).toBe(true); // probed true
    expect(s().keyed.anthropic).toBe(false);
    expect(availableProviders(s().keyed).sort()).toEqual(["ollama", "openai"]);
  });
});
