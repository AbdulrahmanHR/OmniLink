/**
 * Public API barrel for the trusted knowledge source model (M49, v2.4.0).
 *
 * The D16 source registry: bundled/cached source metadata (version, license,
 * trust level), a license/allowlist gate, an unsafe-content exclusion list, and
 * the D17 on-demand pack-update seam. Pure TypeScript — no Rust, no new outbound
 * data path; content is bundled and usable offline.
 */

// Types
export {
  TRUST_LEVELS,
  BUNDLED_TRUST_LEVELS,
  SOURCE_LICENSES,
  type TrustLevel,
  type SourceLicense,
  type SourceMetadata,
  type KnowledgeSource,
} from "./types";

// Registry parsing + bundled pack loading
export {
  REGISTRY_SCHEMA_VERSION,
  EXCLUSION_LIST,
  IncompatibleRegistrySchemaError,
  parseRegistry,
  parseSourceMetadata,
  filterExcluded,
  hasPackContent,
  loadSource,
  RAW_REGISTRY,
} from "./registry";

// D16 allowlist gate + composed load path
export {
  ALLOWLIST,
  isSourceAllowed,
  filterAllowed,
  loadAllowedSources,
  type AllowlistEntry,
} from "./allowlist";

// D17 on-demand pack-update seam
export {
  isTauri,
  updatePack,
  type PackUpdateStatus,
  type PackUpdateResult,
} from "./packUpdate";

// M50 — local retrieval pipeline (D15/D19). Pure BM25 over trusted-pack chunks.
export {
  RELEVANCE_THRESHOLD,
  EVAL_PASS_BAR,
  DEFAULT_TOP_K,
  MAX_EXCERPT_CHARS,
  MAX_RETRIEVED_DOCS,
  RETRIEVAL_P95_BUDGET_MS,
} from "./retrievalConsts";
export {
  chunkMarkdown,
  chunkSources,
  type Chunk,
} from "./chunk";
export {
  tokenize,
  queryTerms,
  buildIndex,
  serializeIndex,
  deserializeIndex,
  type Scorer,
  type RetrievalIndex,
  type SerializedIndex,
} from "./bm25";
export {
  retrieve,
  toRetrievedDocs,
  boundExcerpt,
  type RetrievedChunk,
  type RetrievedDoc,
  type RetrievalResult,
  type RetrieveOptions,
} from "./retrieve";
export {
  debugRetrieve,
  type RetrievalDebug,
  type ChunkDebug,
  type DebugOptions,
} from "./debug";
export {
  runEval,
  type GoldenItem,
  type EvalReport,
  type EvalCaseResult,
} from "./eval";
export { sanitizeRetrievedDocs } from "./retrievalSanitize";
export {
  loadCorpusChunks,
  getRetrievalIndex,
  sourceTrustMap,
  type SourceTrustInfo,
} from "./corpus";

// M52 — user-imported docs (D18). Local, untrusted, prompt-fenced.
export {
  MAX_IMPORTED_DOC_BYTES,
  MAX_IMPORTED_DOCS,
  ALLOWED_IMPORT_EXTENSIONS,
  IMPORT_DIALOG_EXTENSIONS,
  IMPORTED_SOURCE_PREFIX,
  isImportedSourceId,
  importedExtensionAllowed,
  byteLength,
  deriveTitle,
  generateImportedId,
  parseImportedDoc,
  type ImportedSource,
  type ImportRejectReason,
  type ImportResult,
} from "./import";
export {
  pickImportedDocPath,
  readImportedDoc,
  pathBasename,
  type ImportFileDialogLabels,
} from "./tauri";
