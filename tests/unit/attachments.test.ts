import { describe, expect, it } from "vitest";
import { ATTACHMENT_CHAR_CAP, formatAttachment } from "@/lib/attachments";

describe("formatAttachment (M23)", () => {
  it("wraps content in a labelled, delimited block", () => {
    const out = formatAttachment("debug.log", "line one\nline two");
    expect(out).toContain("--- attachment: debug.log ---");
    expect(out).toContain("line one\nline two");
    expect(out).toContain("--- end attachment ---");
    expect(out).not.toMatch(/truncated/);
  });

  it("falls back to a generic name for empty/whitespace names", () => {
    expect(formatAttachment("   ", "x")).toContain("--- attachment: attachment ---");
  });

  it("truncates content beyond the cap and notes it", () => {
    const out = formatAttachment("big.csv", "a".repeat(50), 10);
    // Body capped to 10 chars, plus a truncation note (so length > 10 overall).
    expect(out).toContain("a".repeat(10));
    expect(out).not.toContain("a".repeat(11));
    expect(out).toMatch(/truncated to 10 characters/);
  });

  it("does not note truncation when content fits exactly at the cap", () => {
    const out = formatAttachment("f.txt", "abcde", 5);
    expect(out).toContain("abcde");
    expect(out).not.toMatch(/truncated/);
  });

  it("treats a zero/negative cap as empty body, still well-formed", () => {
    const out = formatAttachment("f.txt", "abc", 0);
    expect(out).toContain("--- attachment: f.txt ---");
    expect(out).toMatch(/truncated to 0 characters/);
  });

  it("exposes a sane default character cap", () => {
    expect(ATTACHMENT_CHAR_CAP).toBe(8000);
  });
});
