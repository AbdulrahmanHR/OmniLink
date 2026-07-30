/**
 * BYOK AI bridge (M9-API). Typed `invoke` wrappers around the Rust `ai_*`
 * commands in `src-tauri/src/commands/ai.rs`. The real LLM HTTP call happens in
 * Rust (key stays out of the webview, FR-AI-09); this is the thin client seam.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ChatRole } from "@/stores/assistant";
import type { AIProvider, AiContextInput } from "@/lib/aiContext";

/** One conversation turn sent to the backend (mirrors Rust `ChatMessageDto`). */
export interface AiWireMessage {
  role: ChatRole;
  content: string;
}

/** Structured config suggestion (FR-AI-04) — mirrors `UserDefineSuggestion`. */
export interface UserDefineSuggestion {
  key: string;
  value: string;
  reason: string;
}

/** Reply returned by `ai_send_message` (mirrors Rust `AiReply`). */
export interface AiReply {
  content: string;
  suggestion: UserDefineSuggestion | null;
}

/** One selectable model (mirrors Rust `ModelInfo`). */
export interface AiModelInfo {
  /** Wire id passed back as the `model` arg to `ai_send_message`. */
  id: string;
  /** Friendlier display label (falls back to the id). */
  name: string;
}

// Per-config key slots (multi-config, v1.6.3): the optional `keyId` selects the
// backend `ai_keys.json` slot to store/read the API key under, so two configs of
// the SAME provider can hold DIFFERENT keys. When omitted, the backend falls
// back to keying by `provider` (back-compat with pre-multi-config keys and the
// `id === provider` migration). The adapter still resolves on `provider`.

/** Call the selected provider and return Omnia's reply. */
export function aiSendMessage(args: {
  provider: AIProvider;
  model: string;
  baseUrl?: string;
  /** Config key-slot id; defaults backend-side to `provider`. */
  keyId?: string;
  messages: AiWireMessage[];
  context?: AiContextInput;
}): Promise<AiReply> {
  return invoke<AiReply>("ai_send_message", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    keyId: args.keyId,
    messages: args.messages,
    context: args.context ?? null,
  });
}

/**
 * List the models available for a provider, fetched live by the backend using
 * the stored key (the key never leaves Rust — only model metadata comes back).
 * With no key configured for a key-required provider, the backend returns a
 * static fallback list so the dropdown is still usable. `keyId` selects which
 * config's stored key to authenticate with (defaults to the provider slot).
 */
export function aiListModels(
  provider: AIProvider,
  baseUrl?: string,
  keyId?: string
): Promise<AiModelInfo[]> {
  return invoke<AiModelInfo[]>("ai_list_models", { provider, baseUrl, keyId });
}

/**
 * Persist an API key (stored backend-side, never returned). `keyId` is the
 * config's key-slot id; when omitted the key is stored under the provider id.
 */
export function aiSetApiKey(
  provider: AIProvider,
  key: string,
  keyId?: string
): Promise<void> {
  return invoke("ai_set_api_key", { provider, key, keyId });
}

/** Remove a stored API key from the `keyId` slot (defaults to the provider). */
export function aiClearApiKey(
  provider: AIProvider,
  keyId?: string
): Promise<void> {
  return invoke("ai_clear_api_key", { provider, keyId });
}

/**
 * Wholesale-clear EVERY stored BYOK key for the "Delete all my data" erase
 * (NFR-PRIV-02): the backend deletes the `ai_keys.json` file outright (clearing
 * file-backed orphans left by the legacy multi-config migration) and best-effort
 * clears each keychain `slot` passed in (per-provider default slots + any known
 * `keyId`s). No key value is ever exposed.
 */
export function aiDeleteAllApiKeys(slots: string[]): Promise<void> {
  return invoke("delete_all_api_keys", { slots });
}

/**
 * Whether a key is stored in the `keyId` slot (boolean only — key never
 * exposed). Defaults to the provider slot when `keyId` is omitted.
 */
export function aiHasApiKey(
  provider: AIProvider,
  keyId?: string
): Promise<boolean> {
  return invoke<boolean>("ai_has_api_key", { provider, keyId });
}

/** Exact sanitized payload that would be sent (NFR-PRIV-01 preview). */
export function aiPreviewPayload(context: AiContextInput): Promise<unknown> {
  return invoke<unknown>("ai_preview_payload", { context });
}
