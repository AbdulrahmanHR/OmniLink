/**
 * Tauri seam for user-imported docs (M52, D18).
 *
 * The ONLY new IPC this milestone adds: a LOCAL text-file read with a hard byte
 * cap. It NEVER uploads — imported docs stay on the machine. Mirrors the
 * firmware-picker seam (`pickLocalFirmwareFile` in `src/lib/tauri.ts`): a native
 * file dialog to pick a path, then an `invoke` to read it. Guarded by
 * {@link isTauri}; the browser/dev path uses the File API instead (handled by
 * the caller — `ImportPanel`'s hidden `<input type="file">`).
 */

import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { IMPORT_DIALOG_EXTENSIONS } from "./import";
import { isTauri } from "./packUpdate";

export { isTauri };

/** Localized labels for the native import dialog. */
export interface ImportFileDialogLabels {
  /** Dialog window title. */
  title: string;
  /** Display name for the `.txt`/`.md` filter group. */
  filterName: string;
}

/**
 * Open the native file dialog to pick ONE local `.txt`/`.md` note. Resolves to
 * the chosen absolute path, or `null` on cancel. Restricted to the import
 * extensions, single-select. Tauri-only (the browser path uses `<input file>`).
 */
export async function pickImportedDocPath(
  labels: ImportFileDialogLabels,
): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    title: labels.title,
    filters: [{ name: labels.filterName, extensions: [...IMPORT_DIALOG_EXTENSIONS] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Read a LOCAL text file via the Rust `knowledge_read_doc` command (Tauri only).
 * The command validates the extension, enforces the byte cap, and returns UTF-8
 * text — it never uploads anything. Rejects if the path is invalid/oversize.
 */
export async function readImportedDoc(path: string): Promise<string> {
  return invoke<string>("knowledge_read_doc", { path });
}

/** Basename of a path (posix or windows separators) — the picked file's name. */
export function pathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
