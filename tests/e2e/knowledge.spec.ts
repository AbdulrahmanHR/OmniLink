import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectNoSeriousA11y,
  gotoApp,
  installTauriMock,
  uploadFile,
} from "./_helpers";

/**
 * v2.4 — Knowledge Sources / Import / RAG-citation surface (real browser).
 *
 * The v2.4 knowledge stack was e2e-covered only for the AI wizard; this spec
 * drives the KNOWLEDGE surface itself through the same mocked Tauri seam the
 * other AI specs use ({@link installTauriMock}), asserting on rendered UI +
 * mocked-call effects rather than a real backend:
 *
 *  1. The Settings "Trusted knowledge sources" panel lists the bundled sources
 *     HONESTLY (trust/cached badges + the "Bundled with this release" freshness
 *     label — never a fabricated "Refreshed {date}"), and "Update all" reports
 *     the honest "already current / bundled" status (no fabricated remote sync).
 *  2. The import UI takes a local `.txt`/`.md` note that appears as an
 *     UNTRUSTED "user-provided · not official" source, and a whitespace-only file
 *     surfaces the localized empty-file error.
 *  3. Live chat: an in-corpus question renders `SourceCitations` cards grounded
 *     in a trusted source; an out-of-corpus question renders the D19 "no trusted
 *     source found" state instead of a fabricated citation.
 *  4. The per-chat "Sources for this chat" control toggles a source off for the
 *     active conversation and the switch + count reflect it.
 *
 * Citations are computed CLIENT-SIDE from local RAG retrieval over the bundled
 * ExpressLRS corpus — they do NOT come from the model reply — so the mocked
 * `ai_send_message` only needs to resolve an (arbitrary) answer; the retrieval
 * that drives the citation cards runs unchanged in the browser. The in-corpus /
 * out-of-corpus queries below are drawn from the frozen golden eval set
 * (`data/knowledge/eval/golden.json`), so the threshold decision is deterministic.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_NOTE_MD = path.join(__dirname, "fixtures", "knowledge-note.md");
const KNOWLEDGE_EMPTY_TXT = path.join(
  __dirname,
  "fixtures",
  "knowledge-empty.txt",
);

/**
 * Mocked backend AI commands. A stored key is present (`ai_has_api_key`) so the
 * BYOK send path clears its key gate, and `ai_send_message` resolves an
 * arbitrary answer — the citations beside it come from local retrieval, not this
 * reply. Mirrors `ai-byok.spec.ts` / `ai-wizard.spec.ts`.
 */
const HANDLERS = {
  ai_has_api_key: true,
  ai_list_models: [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
  ai_send_message: { content: "Here is what the sources say.", suggestion: null },
};

/** An in-corpus question (golden set) whose top trusted source is ELRS binding. */
const IN_CORPUS_QUERY = "How do I bind my receiver to my transmitter?";
/** An out-of-corpus question (golden set) that must return "no source found". */
const OUT_OF_CORPUS_QUERY = "How do I tune a six string acoustic guitar?";

/** Open Omnia's global chat launcher and wait for the panel to mount. */
async function openChat(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: /open omnia assistant/i }).click();
  // The inline provider picker proves the panel + controls mounted.
  await expect(page.getByTestId("chat-provider-select")).toBeVisible();
}

/** Type a question into the composer and send it (Enter submits). */
async function sendChat(
  page: import("@playwright/test").Page,
  query: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message Omnia" });
  await expect(composer).toBeVisible();
  await composer.fill(query);
  await composer.press("Enter");
  // The question echoes as a user bubble once the turn is accepted.
  await expect(page.getByText(query, { exact: true })).toBeVisible();
}

test.describe("Knowledge sources, import & RAG citations", () => {
  test.use({ reducedMotion: "reduce" });

  test("Settings lists bundled trusted sources honestly; Update all is honest", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");

    // The trusted-sources panel renders the bundled, allowlisted set. (The card
    // title is a styled <div>, not a heading role, so match on its text.)
    await expect(page.getByText("Trusted knowledge sources")).toBeVisible();
    await expect(page.getByText("ExpressLRS — Binding").first()).toBeVisible();

    // Honest per-source metadata: an "Official" trust badge, the offline/cached
    // badge, and the "Bundled with this release" freshness label — NOT a fake
    // "Refreshed {date}" (no real fetch has happened).
    await expect(page.getByText("Official").first()).toBeVisible();
    await expect(page.getByText("Cached · offline ready").first()).toBeVisible();
    await expect(
      page.getByText("Bundled with this release").first(),
    ).toBeVisible();
    await expect(page.getByText(/^Refreshed /)).toHaveCount(0);

    // "Update all" reports the honest transient status: every bundled source is
    // already current (no fabricated remote refresh).
    await page
      .getByRole("button", { name: "Update all knowledge sources" })
      .click();
    const status = page.getByTestId("knowledge-update-all-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("already current for this release");
    await expect(status).not.toContainText("Refreshed");
    // Still no fabricated "Refreshed {date}" anywhere after the update ran.
    await expect(page.getByText(/^Refreshed /)).toHaveCount(0);

    // The knowledge Settings surface is axe-clean.
    await expectNoSeriousA11y(page);
  });

  test("Import surfaces a user note as untrusted, and rejects an empty file", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");

    // Import panel starts empty. (Card title is a styled <div>, match on text.)
    await expect(page.getByText("Your imported notes")).toBeVisible();
    await expect(page.getByText("No imported notes")).toBeVisible();

    // Import a local .md note via the hidden file input (the browser/dev seam —
    // `setInputFiles` fires onChange directly, independent of the native picker).
    await uploadFile(page, "knowledge-import-input", KNOWLEDGE_NOTE_MD);

    // It appears as an imported source titled from its heading, marked with the
    // distinct "user-provided · not official" badge — never styled as official.
    await expect(page.getByText("ELRS Field Notes")).toBeVisible();
    await expect(
      page.getByText("User-provided · not official").first(),
    ).toBeVisible();

    // Error path: a whitespace-only file has no readable text — the localized
    // rejection shows, and the already-imported note is untouched.
    await uploadFile(page, "knowledge-import-input", KNOWLEDGE_EMPTY_TXT);
    const importError = page.getByTestId("knowledge-import-error");
    await expect(importError).toBeVisible();
    await expect(importError).toHaveText("That file has no readable text to import.");
    await expect(page.getByText("ELRS Field Notes")).toBeVisible();
  });

  test("Live chat renders RAG citation cards grounded in a trusted source", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");
    await openChat(page);

    await sendChat(page, IN_CORPUS_QUERY);

    // The assistant answer carries citations: the SourceCitations "Cited sources"
    // list renders, grounded in the ELRS binding source with an "Official" badge.
    const cited = page.getByRole("list", { name: "Cited sources" });
    await expect(cited).toBeVisible();
    await expect(cited).toContainText("ExpressLRS — Binding");
    await expect(cited.getByText("Official").first()).toBeVisible();
    // The honest "no source" state is NOT shown when a real citation exists.
    await expect(
      page.getByRole("note", { name: "No trusted source found" }),
    ).toHaveCount(0);

    // Full-page axe check while the POPULATED chat log + citation cards are
    // visible — a state the a11y-only chat scan never reaches (it never sends a
    // message). This both verifies the citation UI is clean AND proves the
    // `role="log"` message list is keyboard-focusable (`tabIndex={0}`), so the
    // scrollable populated log no longer trips `scrollable-region-focusable`.
    await expectNoSeriousA11y(page);
  });

  test("Out-of-corpus question renders the honest 'no trusted source found' state", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/settings");
    await openChat(page);

    await sendChat(page, OUT_OF_CORPUS_QUERY);

    // The D19 empty state renders instead of a fabricated citation.
    await expect(
      page.getByRole("note", { name: "No trusted source found" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Omnia has no trusted source that matches this question, so it should say so rather than answer unsupported.",
      ),
    ).toBeVisible();
    // No citation list was fabricated for an unsupported answer.
    await expect(
      page.getByRole("list", { name: "Cited sources" }),
    ).toHaveCount(0);
  });

  test("Per-chat 'Sources for this chat' toggles a source off for the chat", async ({
    page,
  }) => {
    await installTauriMock(page, HANDLERS);
    await gotoApp(page, "/");
    await openChat(page);

    // Expand the per-chat sources control; all four bundled sources start on.
    await page.getByText("Sources for this chat").click();
    await expect(page.getByText("4 of 4 on")).toBeVisible();

    // The ELRS binding source starts enabled for this (draft) conversation.
    const bindingSwitch = page.getByRole("switch", { name: /Binding/ });
    await expect(bindingSwitch).toHaveAttribute("aria-checked", "true");

    // Turn it off for THIS chat — the switch flips and the count drops by one.
    await bindingSwitch.click();
    await expect(bindingSwitch).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("3 of 4 on")).toBeVisible();
  });
});
