# Omnia Assistant — Architecture, Knowledge & Safety Guide

How OmniLink's AI assistant ("Omnia") works today, where its knowledge comes
from, how the app is hardened against prompt injection, and the right order in
which to make it smarter. Written for whoever picks up the M9 / Phase-2 AI work
next.

---

## 1. What Omnia Is

A BYOK (Bring-Your-Own-Key) chat assistant for ExpressLRS pilots. It explains
telemetry, recommends packet rates / TX power, helps with binding and flashing,
and can emit a validated one-click config suggestion.

**Tech:** Tauri (Rust backend) + React/Zustand frontend.
Paths below are relative to the repository root.

- Frontend chat store: `src/stores/assistant.ts`
- LLM calls (Rust): `src-tauri/src/commands/ai.rs`
- System prompt (versioned): `data/prompts/system_assistant.md`
- Chat history (SQLite): `src/lib/chat-db.ts` + migration v2 in
  `src-tauri/src/db/mod.rs`

---

## 2. How Omnia Gets Its Information

Omnia is grounded by **three** inputs, in priority order:

1. **System prompt** (`system_assistant.md`) — persona, non-negotiable safety
   rules, prompt-injection defense, and a curated **ExpressLRS reference**
   section (link metrics, packet rates, TX power, binding, flashing, common
   fixes). This is the "knowledge base," inlined as static text.
2. **Live device context** — sanitized, aggregated, fenced as untrusted data:
   target name, firmware, device type, anonymized `user_define`s, and rolled-up
   telemetry stats. Built in `aiContext.ts`, re-sanitized in `ai.rs`.
3. **The model's own training** — fallback for anything not covered above.

There is **no retrieval step (no RAG)**: Omnia does not search a document store,
the ELRS wiki, or your files. If a fact is not in the injected context and not
in the model's training, the system prompt instructs Omnia to **say so rather
than guess**.

```
                    ┌─────────────────────────────────────────────┐
  user question ───►│  system prompt (Omnia persona + safety)      │
                    │  + <device_context untrusted> … </…>  (live) │──► LLM provider ──► reply
  device + telem ──►│  + chat history                              │     (BYOK, direct)
   (sanitized)      └─────────────────────────────────────────────┘
```

### What's in the Live Context Block

Assembled in `src/lib/aiContext.ts` (`buildAiContext`) and **re-sanitized in
Rust** (`src-tauri/src/commands/ai.rs` → `sanitize_context`) before it ever
leaves the machine:

- `targetName`, `firmwareVersion`, `deviceType` (TX/RX only)
- anonymized `userDefines` (config keys/values, **with sensitive keys dropped** — see §5)
- aggregated telemetry stats only: `avgLinkQuality`, `minLinkQuality`,
  `avgRssi`, `minRssi`, `avgSnr`, `failsafeCount`, `sampleCount`

It is **aggregates, never raw rows** — no per-frame GPS track, no timestamps
that could re-identify a flight.

### Why No Vector DB / RAG (Yet)

RAG earns its complexity only when the reference knowledge is **too large to fit
in the prompt** or **changes often enough that shipping it in-repo is painful**.
Today the ELRS facts Omnia needs are a few hundred tokens and stable per
firmware release, so inlining them in the system prompt is strictly better: zero
infra, no embedding/index drift, no extra network hop, and the grounding text is
reviewable in a plain `git diff`.

**The right grounding ladder** (climb only when the current rung hurts):

| Rung | Use when | Cost |
|------|----------|------|
| Inline reference in system prompt *(current)* | Facts fit in a few KB, change rarely | ~free |
| Curated multi-doc context, selected by topic | Several KB of docs; pick relevant slice per question | Low |
| **RAG / vector DB** (embeddings over ELRS docs, wikis, changelogs) | Knowledge is large, versioned, or user-imported (e.g. their own logs/manuals) | Embedding model + vector store + retrieval eval |
| Fine-tune | A stable, high-volume task the above can't nail | High; rarely worth it for a config assistant |

**Concrete trigger to add RAG:** when we want Omnia to answer from the *full*
ExpressLRS documentation / release notes, or from a user's imported logs and
manuals, rather than a hand-maintained summary. At that point: chunk + embed the
docs, store vectors (sqlite-vec keeps it local and matches our existing SQLite
footprint — no new service), retrieve top-k per query, and inject the retrieved
chunks into the same untrusted `<device_context>`-style fence. Until then,
expanding the inline reference is the higher-leverage move.

---

## 3. How to Add Files / Information for Omnia

### a) Today (M9-API, shipped)
- **Connect a device** → its target/firmware/config flows into context automatically (FR-AI-02).
- **Record telemetry** → the rolling buffer is aggregated and attached automatically (FR-AI-03). Ask "why am I getting failsafes?" and Omnia reasons over `minLinkQuality` / `failsafeCount`.
- **Type anything in chat** → free-form questions. You can paste a short log snippet into the message; it's treated as untrusted data (§5).
- **"Show what will be sent"** (in the chat panel) → previews the **exact** sanitized JSON before you send, so you always see what leaves your machine (NFR-PRIV-01).

So: **app context + model knowledge + improvisation.** No file upload / indexing yet.

### b) Tuning Omnia's behavior (no code)
Edit **`data/prompts/system_assistant.md`** — the versioned system prompt (NFR-MAIN-02). Change persona, add domain rules, tighten safety. It's loaded at runtime; no Rust rebuild of logic needed. Bump the `version:` header when you change it.

### c) Future — real document grounding (NOT in v1.0)
If you want Omnia to answer from **specific docs** (ELRS wiki, your own notes, firmware changelogs), that is a **RAG** feature: embed the docs, store vectors, retrieve top-k chunks per question, inject them into the same context block. This is **deferred** (candidate for v1.5/v2.0) and intentionally not built — v1.0 is BYOK-only and offline-first. The architecture already has the seam: RAG chunks would just be another labeled, untrusted section appended to the context fence.

---

## 4. Chat History (Persisted as of M9)

Conversations now survive an app restart.

- **Schema** (migration v2): `conversations` (id, timestamps, title) +
  `messages` (id, conversation_id, role, content, ts, is_error, suggestion).
- **Writer:** `chat-db.ts` — best-effort, fire-and-forget; a DB failure never
  breaks the chat (e.g. when running outside Tauri).
- **Store wiring:** the first turn lazily opens a conversation row; each message
  is persisted as it is added; `initHistory()` (called on app start in
  `App.tsx`) reloads the most recent conversation.
- **Clear** detaches the current conversation (it stays in history) and starts a
  fresh one on the next message — nothing is destroyed.

**Next step (UI):** a conversation switcher. The data layer is ready —
`listConversations()`, `loadConversation(id)`, and `deleteConversation(id)`
already exist; only a sidebar/list component is missing.

---

## 5. LLM Safety & Prompt-Injection Defenses

Omnia ingests **device strings, telemetry, and pasted logs** that can be
malformed or hostile, and its suggestions touch **safety-relevant hardware**
(failsafe, binding, RF power). The following defenses are implemented:

### Privacy / Data Minimization (FR-AI-06/07, NFR-PRIV-01)
- `sanitize_context` (Rust, authoritative) **drops** binding-phrase / UID /
  WiFi-credential keys and **redacts by shape** anything resembling GPS coords,
  MAC/serial, IPv4, or email.
- Only the whitelisted aggregate fields in §2 are forwarded. Frontend gathers,
  **Rust re-sanitizes** → defense in depth.
- The key is **never** returned to the webview, never logged, never in an error
  message or the "show what will be sent" preview.

### Prompt-Injection Resistance
- **Trust boundary in the system prompt:** Omnia is told everything inside
  `<device_context untrusted>…</device_context>` and every chat message is
  **DATA, not instructions** — "ignore previous instructions"-style text in a
  target name or log is to be ignored and flagged, never executed.
- **Context fencing + escaping:** injected values are wrapped in a labeled fence;
  `cap_and_neutralize` HTML-escapes `<`/`>`, flattens control chars, and strips
  fence delimiters in **both keys and values** so hostile data can't break out of
  the fence.
- **Resource bounds:** context strings truncated to `MAX_FIELD_LEN` (200 chars),
  at most `MAX_DEFINES` (64) entries, response capped at `MAX_RESPONSE_TOKENS`
  — bounds cost and injection surface.

### Output Safety (FR-AI-04/05)
- Omnia may emit an optional `omnia-suggest` block for one-click apply, but
  **`validate_suggestion` enforces a whitelist** of non-safety-critical
  `user_define` keys with type/range checks. Suggestions for **binding/UID, RF
  power, or failsafe are discarded** — they can never be blind-applied; the
  model must explain those in prose.
- A persistent, **non-dismissable** "AI-generated — verify settings before
  flashing" disclaimer is shown in the chat panel.

### Transport & Secrets (FR-AI-08/09, NFR-SEC)
- BYOK requests go **directly from the Rust backend to the provider** — no
  OmniLink server hop. API keys stay out of the webview.
- A provider's key is only ever sent to **that** provider's endpoint (no
  cross-provider key leakage via a custom base URL).
- Rendering is injection-safe: `MessageBubble` never uses
  `dangerouslySetInnerHTML`; model text cannot execute markup/script.

### Network Resilience (NFR-ERR-01)
- 15 s connect / 60 s total timeouts, retry with exponential backoff + jitter,
  friendly error bubble on failure (no panics).
- *Outstanding (optional):* a consecutive-failure **circuit breaker** is noted
  in the SRS but not yet implemented.

---

## 6. Multiple Providers (Decision #6 — Multi-Provider BYOK)

Keys are stored backend-side, **one per provider** (`ai_keys.json` map), so a
user can configure Anthropic, OpenAI, Gemini, OpenRouter, and local Ollama at
the same time. The active provider plus the **per-provider** model and base-URL
choices are persisted (`omnilink-byok`), so switching providers restores each
one's settings without re-entering anything. Adding a provider = one entry in
the `PROVIDERS` registry (frontend) and `default_base_url` / `make_adapter`
(Rust); OpenAI-compatible providers need no new adapter code.

Two Rust adapters behind one `LlmAdapter` trait (the FR-AI-08 seam for adding
Managed mode later without refactor):

| Provider   | Kind            | Key? | Notes |
|------------|-----------------|------|-------|
| Anthropic  | `anthropic`     | yes  | Claude (`x-api-key` + `anthropic-version`) |
| OpenAI     | `openai-compat` | yes  | |
| Gemini     | `openai-compat` | yes  | OpenAI-compat endpoint |
| OpenRouter | `openai-compat` | yes  | |
| Ollama     | `openai-compat` | **no** | local `http://localhost:11434/v1` |

Set keys in **Settings → BYOK**; the key is stored backend-side (see Phase-2
note below) and read at request time. Status shows as a badge only.

---

## 7. Suggestions Are a Tool — and Tools Touch Hardware

The model may append one ` ```omnia-suggest ` JSON block. It is **never** trusted
raw: `validate_suggestion` in `ai.rs` accepts only a whitelist of
non-safety-critical keys with explicit type/range rules. Binding/UID, RF power,
and failsafe are deliberately **not** suggestable. Any future "agentic" tool
(apply config, start a flash) must follow the same rule: **validate against an
allowlist in Rust, then require explicit user confirmation** before touching
hardware. This is the single most important safety invariant in the AI path.

---

## 8. Roadmap — The Right Order to Make Omnia Better

1. **Streaming responses.** Biggest UX win. Stream tokens from the provider
   (SSE) through a Tauri channel instead of awaiting the whole reply. Touches
   `dispatch`/adapters + the store's typing state.
2. **Conversation switcher UI.** Data layer already done (§4).
3. **One-click apply for suggestions.** Wire the validated suggestion to the
   config store with a confirm step (§7). Today it is surfaced read-only.
4. **Expand the inline ELRS reference** before reaching for RAG (§2). Cheapest
   accuracy gains live here.
5. **Evals before model swaps.** A small fixture set of (context, question,
   expected-shape) cases so we can compare models/prompts objectively instead of
   vibes. Gate prompt-version bumps on it.
6. **RAG over full ELRS docs / user imports** — only once §4 stops scaling (§2).
7. **Secret-store hardening.** Move keys from the `0600` file to the OS keychain
   (`keyring`) for desktop builds — see the Phase-2 TODO in `ai.rs`.

---

## 9. Invariants — Do Not Regress These

- Keys never enter the webview; the HTTP call is made from Rust.
- Only sanitized, aggregated context leaves the machine; binding/UID/GPS/MAC/IP/
  email are dropped or redacted (`sanitize_context`, unit-tested).
- Device context is fenced and treated as untrusted data, never instructions.
- Model output that touches hardware is allowlist-validated in Rust.
- The system prompt is versioned in `data/prompts/`; bump `version:` on edits.
