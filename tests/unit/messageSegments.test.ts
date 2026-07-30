import { describe, expect, it } from "vitest";
import { parseMessageSegments } from "@/lib/messageSegments";

describe("parseMessageSegments (M23)", () => {
  it("returns a single text segment for plain prose", () => {
    expect(parseMessageSegments("hello world")).toEqual([
      { kind: "text", content: "hello world" },
    ]);
  });

  it("returns [] for empty content", () => {
    expect(parseMessageSegments("")).toEqual([]);
  });

  it("parses inline code spans", () => {
    const segs = parseMessageSegments("set `RSSI` here");
    expect(segs).toEqual([
      { kind: "text", content: "set " },
      { kind: "inlineCode", content: "RSSI" },
      { kind: "text", content: " here" },
    ]);
  });

  it("parses a fenced code block with a language", () => {
    const segs = parseMessageSegments("```bash\nelrs flash\n```");
    expect(segs).toEqual([
      { kind: "codeBlock", content: "elrs flash", lang: "bash" },
    ]);
  });

  it("parses a fenced code block without a language", () => {
    const segs = parseMessageSegments("```\nplain code\n```");
    expect(segs).toEqual([
      { kind: "codeBlock", content: "plain code", lang: undefined },
    ]);
  });

  it("parses mixed text, inline code, and fenced blocks in order", () => {
    const segs = parseMessageSegments(
      "Run `npm` then:\n```sh\nnpm run flash\n```\nDone."
    );
    expect(segs.map((s) => s.kind)).toEqual([
      "text",
      "inlineCode",
      "text",
      "codeBlock",
      "text",
    ]);
    const block = segs.find((s) => s.kind === "codeBlock");
    expect(block).toMatchObject({ content: "npm run flash", lang: "sh" });
  });

  it("treats an unterminated fence as plain text", () => {
    const segs = parseMessageSegments("before ```code without a close");
    expect(segs.some((s) => s.kind === "codeBlock")).toBe(false);
    // The opening fence is preserved verbatim as text, not parsed away.
    expect(segs.map((s) => s.content).join("")).toContain("```code without a close");
  });

  it("handles a single-line fenced span as a code block", () => {
    expect(parseMessageSegments("```inline-fence```")).toEqual([
      { kind: "codeBlock", content: "inline-fence", lang: undefined },
    ]);
  });
});
