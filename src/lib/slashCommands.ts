/**
 * Slash-command registry for the Omnia composer (M23).
 *
 * Pure + dependency-free so the matcher can be unit-tested without dragging in
 * React or i18n. The visible label/description and the expanded prompt are all
 * i18n keys, resolved at render time by the composer — this module only owns
 * the command list and the (pure) filtering logic.
 */

/** A power-user slash command surfaced in the composer's command menu. */
export interface SlashCommand {
  /** Stable id; also the token typed after the leading slash (e.g. `explain`). */
  id: string;
  /** i18n key for the menu entry's short label. */
  labelKey: string;
  /** i18n key for the menu entry's one-line description. */
  descriptionKey: string;
  /** i18n key for the prompt text expanded into the textarea on accept. */
  promptKey: string;
}

/**
 * Available commands, in menu order. The prompt is a *prefix* the user finishes
 * typing — accepting a command never auto-sends (see `ChatInput`).
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "explain",
    labelKey: "ai.commands.explain.label",
    descriptionKey: "ai.commands.explain.description",
    promptKey: "ai.commands.explain.prompt",
  },
  {
    id: "troubleshoot",
    labelKey: "ai.commands.troubleshoot.label",
    descriptionKey: "ai.commands.troubleshoot.description",
    promptKey: "ai.commands.troubleshoot.prompt",
  },
  {
    id: "telemetry",
    labelKey: "ai.commands.telemetry.label",
    descriptionKey: "ai.commands.telemetry.description",
    promptKey: "ai.commands.telemetry.prompt",
  },
];

/**
 * Match the typed composer value against the command registry. Pure.
 *
 * - Returns `[]` when the value does not start with `/`.
 * - Returns every command for a bare `/`.
 * - Otherwise filters by the leading token (case-insensitive prefix), e.g.
 *   `/expl` → just `/explain`.
 *
 * Only the first whitespace-delimited token acts as the filter, so once a
 * command has been expanded into a full prompt the menu naturally goes empty.
 */
export function matchSlashCommands(value: string): SlashCommand[] {
  if (!value.startsWith("/")) return [];
  const token = value.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (token.length === 0) return [...SLASH_COMMANDS];
  return SLASH_COMMANDS.filter((c) => c.id.startsWith(token));
}
