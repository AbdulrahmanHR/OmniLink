/**
 * Markdown-aware chunker for the local retrieval pipeline (M50, D15).
 *
 * Splits a trusted pack's Markdown prose into heading/paragraph-aware
 * {@link Chunk}s of a sane token-ish size, with STABLE, deterministic chunk ids.
 * A chunk never crosses a heading boundary, so its `title` is an accurate
 * section label for citations, and each chunk is a small FRACTION of the
 * document — the substrate for "cite a snippet, never the whole doc".
 *
 * Pure and dependency-free (no vite glob, no I/O), so the offline build script
 * (`scripts/build-knowledge-index.ts`) and the app both call it and get the
 * identical result. The app-facing loader that reads bundled packs lives in
 * `corpus.ts`.
 */

import type { KnowledgeSource } from "./types";

/** One retrievable unit of a trusted source. */
export interface Chunk {
  /** Owning source id (the registry/allowlist key, e.g. `elrs-binding`). */
  sourceId: string;
  /** Owning source's human title (for citation display). */
  sourceTitle: string;
  /** Stable, deterministic id: `${sourceId}#${n}` (0-based within the source). */
  chunkId: string;
  /** Nearest section heading (falls back to the source title). */
  title: string;
  /** The chunk's prose (a bounded slice of the source, never the whole doc). */
  text: string;
}

/**
 * Target upper bound (characters) for a chunk's accumulated prose. A section
 * longer than this splits into multiple chunks that share the heading. A single
 * indivisible block may exceed it; the citation excerpt is bounded separately.
 */
const MAX_CHUNK_CHARS = 600;

/** True for a Markdown ATX heading line (`#`..`######`). */
function parseHeading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line.trim());
  if (m === null) return null;
  return { level: m[1].length, text: m[2].trim() };
}

/**
 * Chunk one source's Markdown into {@link Chunk}s. Deterministic: same content
 * ⇒ same chunks and same ids. Blank lines separate blocks (paragraphs/lists);
 * a heading both re-labels subsequent chunks and forces a chunk boundary.
 */
export function chunkMarkdown(
  sourceId: string,
  sourceTitle: string,
  content: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let seq = 0;

  // The heading a NEW chunk will be labelled with, and the heading the CURRENT
  // buffer was opened under.
  let currentHeading = sourceTitle;
  let bufferHeading = sourceTitle;
  let buffer = "";
  let block: string[] = [];

  const flush = (): void => {
    const text = buffer.trim();
    buffer = "";
    if (text.length === 0) return;
    chunks.push({
      sourceId,
      sourceTitle,
      chunkId: `${sourceId}#${seq}`,
      title: bufferHeading,
      text,
    });
    seq += 1;
  };

  const endBlock = (): void => {
    if (block.length === 0) return;
    const blockText = block.join("\n");
    block = [];
    if (buffer.length === 0) {
      bufferHeading = currentHeading;
      buffer = blockText;
      return;
    }
    // Adding this block would overflow the target size ⇒ flush and start fresh.
    if (buffer.length + 1 + blockText.length > MAX_CHUNK_CHARS) {
      flush();
      bufferHeading = currentHeading;
      buffer = blockText;
      return;
    }
    buffer = `${buffer}\n${blockText}`;
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = parseHeading(line);
    if (heading !== null) {
      endBlock();
      flush(); // a heading closes the current section's chunk
      currentHeading = heading.text;
      bufferHeading = heading.text;
      continue;
    }
    if (line.trim() === "") {
      endBlock();
      continue;
    }
    block.push(line.trim());
  }
  endBlock();
  flush();

  return chunks;
}

/**
 * Chunk every loaded {@link KnowledgeSource} (skipping any with empty content).
 * The order follows the source list, so chunk ids are stable across runs.
 */
export function chunkSources(sources: readonly KnowledgeSource[]): Chunk[] {
  const out: Chunk[] = [];
  for (const source of sources) {
    if (source.content.trim().length === 0) continue;
    out.push(
      ...chunkMarkdown(source.metadata.id, source.metadata.title, source.content),
    );
  }
  return out;
}
