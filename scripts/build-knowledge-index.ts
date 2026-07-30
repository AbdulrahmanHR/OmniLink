/**
 * Offline knowledge-index build script (M50, D15).
 *
 * Generates the retrieval index artifact `data/knowledge/index.json` at build
 * time — NO live cloud, NO ML model, pure lexical BM25. Reads the trusted-pack
 * registry + Markdown from disk (fs, NOT the vite glob, so it runs under plain
 * `vite-node`), chunks and indexes them via the SAME pure `chunk`/`bm25` modules
 * the app uses, and writes the deterministic serialized form.
 *
 * Run: `npm run build:knowledge-index`.
 *
 * The app (`corpus.ts::getRetrievalIndex`) rebuilds the identical index from the
 * bundled chunks at runtime; `knowledgeRetrieveIndex.test.ts` asserts the
 * committed artifact is byte-identical to that runtime build, so this artifact
 * can never silently drift from the shipped corpus.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkMarkdown } from "../src/lib/knowledge/chunk";
import { buildIndex, serializeIndex } from "../src/lib/knowledge/bm25";
import type { Chunk } from "../src/lib/knowledge/chunk";

const HERE = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(HERE, "..", "data", "knowledge");

interface RegistrySource {
  id: string;
  title: string;
  path: string;
}

function loadChunks(): Chunk[] {
  const registryRaw = readFileSync(
    join(KNOWLEDGE_DIR, "registry.json"),
    "utf8",
  );
  const registry = JSON.parse(registryRaw) as { sources?: RegistrySource[] };
  const sources = registry.sources ?? [];

  const chunks: Chunk[] = [];
  for (const source of sources) {
    if (
      typeof source.id !== "string" ||
      typeof source.title !== "string" ||
      typeof source.path !== "string"
    ) {
      continue;
    }
    let content: string;
    try {
      content = readFileSync(join(KNOWLEDGE_DIR, source.path), "utf8");
    } catch {
      // A registry entry with no readable pack is skipped (matches the app's
      // "load with empty content" behaviour — no chunks contributed).
      continue;
    }
    chunks.push(...chunkMarkdown(source.id, source.title, content));
  }
  return chunks;
}

function main(): void {
  const chunks = loadChunks();
  const index = buildIndex(chunks);
  const serialized = serializeIndex(index);
  const outPath = join(KNOWLEDGE_DIR, "index.json");
  writeFileSync(outPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${outPath} (${serialized.chunks.length} chunks, scorer=${serialized.scorer}).\n`,
  );
}

main();
