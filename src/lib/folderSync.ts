import { serializeElrsp, type ElrspDocument } from "./elrsp";

/**
 * Folder sync — the PURE model (M71, decision D37).
 *
 * The zero-infrastructure replacement for the cloud sync deleted at `3.0.0`:
 * the user picks a directory, OmniLink mirrors its profile set into it as plain
 * `.elrsp` files. If that directory happens to live in Dropbox / Drive /
 * OneDrive / Syncthing / a git checkout, the user gets multi-device sync from a
 * tool they already run — and the project pays for nothing.
 *
 * There is **no index, no manifest, no database and no id**: the file name *is*
 * the identity, so the folder stays legible in a file manager. That legibility
 * is the feature, and it is why this module compares by file name.
 *
 * Everything here is PURE: no I/O, no clock, no `invoke`, no network — the
 * filesystem lives in `folder_sync` (`src-tauri/src/commands/config.rs`) behind
 * the typed wrappers in `lib/tauri.ts`, and the sync itself is always driven by
 * an explicit user action (no watcher, no timer, no auto-sync).
 */

/** Extension of every file folder sync reads or writes. */
export const PROFILE_FILE_EXT = ".elrsp";

/**
 * Max file-name length in BYTES, mirroring `MAX_NAME_BYTES` in the Rust guard.
 * Names are generated here, so this side truncates and that side refuses.
 */
export const MAX_FILE_NAME_BYTES = 128;

/**
 * Characters that can never appear in a profile file name — mirroring
 * `FORBIDDEN_CHARS` in the Rust guard. `\` and `:` are inert on Linux but turn
 * `..\x.elrsp` and `C:x.elrsp` into paths outside the folder on Windows, and a
 * synced folder is read on machines other than the one that wrote it.
 */
const FORBIDDEN_CHARS = /[/\\:<>"|?*]/;

/** {@link FORBIDDEN_CHARS} as a replace-all pattern (kept separate: a `g` regex
 * carries `lastIndex` state and must never be shared with `.test()`). */
const FORBIDDEN_CHARS_GLOBAL = /[/\\:<>"|?*]/g;

/** Windows reserved device names — `CON.elrsp` names a device, not a file. */
const RESERVED_STEMS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Name used when a profile's name sanitises away to nothing. */
const FALLBACK_STEM = "profile";

/** How one entry differs between the local library and the folder. */
export type FolderSyncStatus =
  /** Present locally, absent from the folder. */
  | "local-only"
  /** Present in the folder, absent locally. */
  | "folder-only"
  /** Present on both sides with identical content. */
  | "same"
  /** Present on both sides with DIFFERENT content — needs a decision. */
  | "conflict";

/** The local side of one entry. */
export interface LocalProfileSide {
  /** Profile id in `stores/profiles.ts` (local only — never written to disk). */
  id: string;
  /** Resolved profile name (i18n keys already resolved by the caller). */
  name: string;
  /** The document that would be written if this side is pushed. */
  doc: ElrspDocument;
}

/** The folder side of one entry. */
export interface FolderFileSide {
  /** File name including the extension. */
  fileName: string;
  /** The parsed (and, where needed, migrated) document. */
  doc: ElrspDocument;
  /** Last-modified time of the file (ms since epoch), 0 when unknown. */
  modifiedAt: number;
}

/** One row of the four-way diff. Exactly one side may be null, never both. */
export interface FolderSyncEntry {
  /** The file name both sides are keyed by. */
  fileName: string;
  status: FolderSyncStatus;
  local: LocalProfileSide | null;
  folder: FolderFileSide | null;
}

/** Byte length of a string as UTF-8 (file names are byte-limited on disk). */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Truncate to at most `max` UTF-8 bytes without splitting a code point. */
function truncateBytes(value: string, max: number): string {
  if (byteLength(value) <= max) return value;
  let out = "";
  for (const ch of value) {
    if (byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * Turn a profile name into a legible, portable `.elrsp` file name.
 *
 * Deliberately conservative — the folder is read on other machines and by
 * humans, so the result must be safe on Windows, macOS and Linux alike and must
 * still look like the profile it came from. Every rule here has a matching
 * refusal in the Rust guard (`validate_file_name`); this side generates, that
 * side verifies, and `folderSync.test.ts` pins that the two agree.
 */
export function profileFileName(name: string): string {
  let stem = name
    // A profile literally named "Race.elrsp" must not become "Race.elrsp.elrsp".
    .replace(/\.elrsp$/i, "")
    .replace(FORBIDDEN_CHARS_GLOBAL, "-")
    // eslint-disable-next-line no-control-regex -- control chars are not names
    .replace(/[\u0000-\u001F\u007F]/g, "-")
    // `..` is refused outright by the Rust guard (it is how a name escapes a
    // directory), so runs of dots collapse to a single separator.
    .replace(/\.{2,}/g, "-")
    // …and a run of substituted separators reads as one.
    .replace(/-{2,}/g, "-")
    // Collapse whitespace runs so the file name reads as one line.
    .replace(/\s+/g, " ")
    .trim();

  // Leading dots would make it a hidden file (and `.elrsp` a nameless one).
  stem = stem.replace(/^\.+/, "").trim();
  // Windows silently trims trailing dots/spaces, which would alias two files.
  stem = stem.replace(/[.\s]+$/, "");

  stem = truncateBytes(stem, MAX_FILE_NAME_BYTES - byteLength(PROFILE_FILE_EXT));
  // Truncation can re-expose a trailing dot/space.
  stem = stem.replace(/[.\s]+$/, "");

  if (stem.length === 0) stem = FALLBACK_STEM;

  // A reserved device name is prefixed rather than replaced, so the profile is
  // still recognisable in the folder.
  const head = (stem.split(".")[0] ?? stem).toUpperCase();
  if (RESERVED_STEMS.has(head)) stem = `_${stem}`;

  return `${stem}${PROFILE_FILE_EXT}`;
}

/**
 * Mirror of the Rust `validate_file_name` guard, used to filter what the folder
 * hands back and to prove (in tests) that {@link profileFileName} can never
 * produce a name the backend would refuse.
 */
export function isValidProfileFileName(fileName: string): boolean {
  if (fileName.length === 0) return false;
  if (byteLength(fileName) > MAX_FILE_NAME_BYTES) return false;
  if (fileName.includes("..")) return false;
  if (FORBIDDEN_CHARS.test(fileName)) return false;
  // eslint-disable-next-line no-control-regex -- mirroring the Rust guard
  if (/[\u0000-\u001F\u007F]/.test(fileName)) return false;
  if (fileName.startsWith(".")) return false;
  if (!fileName.endsWith(PROFILE_FILE_EXT)) return false;

  const stem = fileName.slice(0, -PROFILE_FILE_EXT.length);
  if (stem.length === 0) return false;
  if (/[.\s]$/.test(stem)) return false;
  const head = (stem.split(".")[0] ?? stem).toUpperCase();
  return !RESERVED_STEMS.has(head);
}

/**
 * Content identity of a document, ignoring `updatedAt`.
 *
 * Reuses {@link serializeElrsp}, so the fingerprint is exactly the bytes that
 * would land on disk with the timestamp zeroed — there is no second
 * serialisation of the format anywhere. Two machines that saved the same
 * profile at different moments are therefore `same`, not a conflict; the
 * timestamps are still shown to the user for a conflict they DO have.
 */
export function contentFingerprint(doc: ElrspDocument): string {
  return serializeElrsp({ ...doc, updatedAt: 0 });
}

/** Whether two documents carry the same content (timestamp excluded). */
export function sameContent(a: ElrspDocument, b: ElrspDocument): boolean {
  return contentFingerprint(a) === contentFingerprint(b);
}

/** Comparison key: file names collide case-insensitively on Windows/macOS. */
function fileKey(fileName: string): string {
  return fileName.toLowerCase();
}

/**
 * Pick the first free `<stem> (n)<ext>` variant of `fileName`.
 *
 * This is the "keep both" filename: no machine name, no timestamp, no id — just
 * the next number, which is what a person would do by hand.
 */
export function keepBothFileName(
  fileName: string,
  taken: Iterable<string>
): string {
  const used = new Set([...taken].map(fileKey));
  const base = fileName.endsWith(PROFILE_FILE_EXT)
    ? fileName.slice(0, -PROFILE_FILE_EXT.length)
    : fileName;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = profileFileName(`${base} (${n})`);
    if (!used.has(fileKey(candidate))) return candidate;
  }
  // Unreachable in practice (999 same-named profiles); stay deterministic.
  return profileFileName(`${base} (1000)`);
}

/** The `keepBothFileName` rule applied to a profile NAME (no extension). */
export function keepBothProfileName(
  name: string,
  taken: Iterable<string>
): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${name} (1000)`;
}

/**
 * Assign each local profile the file name it would occupy in the folder,
 * resolving collisions deterministically in input order (`Race.elrsp`,
 * `Race (2).elrsp`, …). Two local profiles CAN share a name, and a
 * case-insensitive filesystem would otherwise silently merge them.
 */
export function assignFileNames(
  profiles: readonly LocalProfileSide[]
): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const profile of profiles) {
    let fileName = profileFileName(profile.name);
    if (used.has(fileKey(fileName))) {
      fileName = keepBothFileName(fileName, used);
    }
    used.add(fileKey(fileName));
    assigned.set(profile.id, fileName);
  }
  return assigned;
}

/**
 * Diff the local profile set against the folder's, classifying every entry.
 *
 * Pure and total: every local profile and every folder file appears exactly
 * once in the result, so nothing can be lost by omission. Sorted by file name
 * so the UI order is stable across refreshes.
 */
export function diffFolderSync(
  localProfiles: readonly LocalProfileSide[],
  folderFiles: readonly FolderFileSide[]
): FolderSyncEntry[] {
  const fileNames = assignFileNames(localProfiles);
  const byKey = new Map<string, FolderSyncEntry>();

  for (const local of localProfiles) {
    const fileName = fileNames.get(local.id) ?? profileFileName(local.name);
    byKey.set(fileKey(fileName), {
      fileName,
      status: "local-only",
      local,
      folder: null,
    });
  }

  for (const folder of folderFiles) {
    const key = fileKey(folder.fileName);
    const existing = byKey.get(key);
    if (!existing || !existing.local) {
      byKey.set(key, {
        fileName: folder.fileName,
        status: "folder-only",
        local: null,
        folder,
      });
      continue;
    }
    byKey.set(key, {
      // The folder's spelling wins for display: it is what is on disk.
      fileName: folder.fileName,
      status: sameContent(existing.local.doc, folder.doc) ? "same" : "conflict",
      local: existing.local,
      folder,
    });
  }

  return [...byKey.values()].sort((a, b) =>
    fileKey(a.fileName) < fileKey(b.fileName)
      ? -1
      : fileKey(a.fileName) > fileKey(b.fileName)
        ? 1
        : 0
  );
}

/** Per-status counts for the summary line. */
export type FolderSyncSummary = Record<FolderSyncStatus, number>;

/** Count entries by status (all four keys always present). */
export function summarizeFolderSync(
  entries: readonly FolderSyncEntry[]
): FolderSyncSummary {
  const summary: FolderSyncSummary = {
    "local-only": 0,
    "folder-only": 0,
    same: 0,
    conflict: 0,
  };
  for (const entry of entries) summary[entry.status] += 1;
  return summary;
}

/** Whether an entry needs a decision from the user (i.e. is not settled). */
export function isActionable(entry: FolderSyncEntry): boolean {
  return entry.status !== "same";
}

/**
 * Split a backend folder-sync error (`"<code>: <detail>"`, produced by
 * `FolderSyncError` in `commands/config.rs`) into a localisable code and the
 * raw detail. An unrecognised shape degrades to the generic `io` code with the
 * whole message as the detail — never swallowed, never guessed at.
 */
export const FOLDER_SYNC_ERROR_CODES = [
  "not-granted",
  "not-a-directory",
  "invalid-name",
  "outside-root",
  "too-large",
  "not-a-file",
  "not-utf8",
  "io",
] as const;

export type FolderSyncErrorCode = (typeof FOLDER_SYNC_ERROR_CODES)[number];

export interface ParsedFolderSyncError {
  code: FolderSyncErrorCode;
  detail: string;
}

/** Parse the `"<code>: <detail>"` contract from the Rust side. */
export function parseFolderSyncError(message: string): ParsedFolderSyncError {
  const separator = message.indexOf(":");
  if (separator > 0) {
    const code = message.slice(0, separator).trim();
    if ((FOLDER_SYNC_ERROR_CODES as readonly string[]).includes(code)) {
      return {
        code: code as FolderSyncErrorCode,
        detail: message.slice(separator + 1).trim(),
      };
    }
  }
  return { code: "io", detail: message };
}
