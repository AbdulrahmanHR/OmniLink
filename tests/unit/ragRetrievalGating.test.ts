import { describe, expect, it } from "vitest";
import { buildIndex, type Chunk } from "@/lib/knowledge";
import { retrieveForChat } from "@/lib/ragRetrieval";

/**
 * Regression for the code-review finding on enabled-source gating (M50/M51/M52).
 *
 * Enabled-source filtering must be applied to the FULL above-threshold ranking,
 * not to a fixed top-K window. Otherwise a disabled source whose chunks fill the
 * top hits starves an enabled source whose qualifying match ranks lower —
 * producing a false "no source found" even though an enabled source can answer.
 * (Reachable in practice: an imported note chunks into many pieces that dominate
 * the ranking; disabling it must not suppress the trusted packs.)
 */

function chunk(sourceId: string, seq: number, text: string): Chunk {
  return {
    sourceId,
    sourceTitle: sourceId,
    chunkId: `${sourceId}#${seq}`,
    title: sourceId,
    text,
  };
}

describe("retrieveForChat — enabled-source gating spans the full ranking", () => {
  // A disabled source with many strongly-matching chunks that dominate the top
  // of the ranking, plus one enabled source with a single qualifying chunk that
  // ranks below them (fewer term repetitions ⇒ lower BM25 score, still cleared).
  const DISABLED: Chunk[] = Array.from({ length: 12 }, (_, i) =>
    chunk(
      "big-imported-note",
      i,
      "widget calibration procedure widget calibration procedure widget calibration procedure",
    ),
  );
  const ENABLED: Chunk[] = [
    chunk(
      "trusted-pack",
      0,
      "The widget calibration procedure for this device is documented in this note.",
    ),
  ];
  const index = buildIndex([...DISABLED, ...ENABLED]);
  const query = "widget calibration procedure";
  const enabledSourceIds = new Set(["trusted-pack"]);

  it("sanity: the disabled source dominates the unfiltered top of the ranking", () => {
    // Without gating, the top hits are all the disabled source — this is the
    // starvation setup that used to defeat a fixed-window filter.
    const res = retrieveForChat(query, { index });
    expect(res.chunks[0].sourceId).toBe("big-imported-note");
  });

  it("returns the enabled source's lower-ranked match, not a false no-source-found", () => {
    const res = retrieveForChat(query, { index, enabledSourceIds });
    expect(res.noSourceFound).toBe(false);
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);
    expect(res.chunks.every((c) => c.sourceId === "trusted-pack")).toBe(true);
  });

  it("still excludes the disabled source's chunks entirely", () => {
    const res = retrieveForChat(query, { index, enabledSourceIds });
    expect(res.chunks.some((c) => c.sourceId === "big-imported-note")).toBe(
      false,
    );
  });
});
