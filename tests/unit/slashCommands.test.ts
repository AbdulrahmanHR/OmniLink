import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, matchSlashCommands } from "@/lib/slashCommands";

describe("slash command registry (M23)", () => {
  it("defines explain, troubleshoot, and telemetry with full i18n keys", () => {
    expect(SLASH_COMMANDS.map((c) => c.id)).toEqual([
      "explain",
      "troubleshoot",
      "telemetry",
    ]);
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.labelKey).toMatch(/^ai\.commands\./);
      expect(cmd.descriptionKey).toMatch(/^ai\.commands\./);
      expect(cmd.promptKey).toMatch(/^ai\.commands\./);
    }
  });
});

describe("matchSlashCommands (M23)", () => {
  it("returns [] when the value does not start with a slash", () => {
    expect(matchSlashCommands("")).toEqual([]);
    expect(matchSlashCommands("hello")).toEqual([]);
    expect(matchSlashCommands("a /explain")).toEqual([]);
  });

  it("returns every command for a bare slash", () => {
    expect(matchSlashCommands("/")).toEqual([...SLASH_COMMANDS]);
  });

  it("filters by the leading token, case-insensitively", () => {
    expect(matchSlashCommands("/expl").map((c) => c.id)).toEqual(["explain"]);
    expect(matchSlashCommands("/EXPL").map((c) => c.id)).toEqual(["explain"]);
    expect(matchSlashCommands("/t").map((c) => c.id)).toEqual([
      "troubleshoot",
      "telemetry",
    ]);
  });

  it("returns [] when nothing matches the typed token", () => {
    expect(matchSlashCommands("/zzz")).toEqual([]);
  });

  it("only considers the first whitespace-delimited token", () => {
    // Once a full prompt has expanded, the first token is empty → all commands.
    expect(matchSlashCommands("/ explain this").map((c) => c.id)).toEqual([
      "explain",
      "troubleshoot",
      "telemetry",
    ]);
  });
});
