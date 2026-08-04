/**
 * The one place OmniLink turns a document into a file on disk (v3.0.3).
 *
 * ## The defect this exists to fix
 *
 * All three export actions — Settings → "Export my data", a recorded session's
 * CSV, and a profile's `.elrsp` — were written with the browser idiom: build a
 * `Blob`, mint an object URL, click a synthetic `<a download>`. Chromium hands
 * that to its download manager, which is why it looked right in the dev server
 * and in the Playwright suite. **The shipped webview is not Chromium.** On
 * WebKitGTK 2.52.3 the packaged AppImage wrote the file into the process's
 * current working directory: no save dialog, no confirmation, no
 * reveal-in-folder. On an installed app that cwd is `/` or `$HOME`, so the
 * export the user asked for simply was not where they looked — and on an
 * unwritable cwd it would have failed silently.
 *
 * ## The two paths
 *
 * - **Under Tauri** the destination is the user's: {@link saveExportFile} shows
 *   a native save dialog and writes the file backend-side, answering with the
 *   resolved path (which the caller must show), `null` for a cancel, or a
 *   rejection carrying the real failure. No path is guessed and no outcome is
 *   silent.
 * - **In a plain browser** — `npm run dev` in a tab, and the Playwright E2E
 *   suite, which runs the web build — the anchor download is still the only
 *   mechanism there is, and it works correctly there. It stays, confined to
 *   this module: `tests/unit/exportSaveDialog.test.ts` fails if the idiom
 *   reappears anywhere else in `src/`.
 */

import { isTauri } from "@tauri-apps/api/core";
import { saveExportFile } from "@/lib/tauri";

/** What a document to be exported is, independent of how it gets written. */
export interface ExportFileSpec {
  /** The document itself, UTF-8 text. */
  readonly contents: string;
  /** Suggested file name, already localized and stamped. */
  readonly defaultName: string;
  /** MIME type for the browser fallback's `Blob`. */
  readonly mimeType: string;
  /** Native save-dialog title, already localized. */
  readonly dialogTitle: string;
  /** Localized name of the file-type filter, e.g. "JSON file". */
  readonly filterName: string;
  /** Extensions for that filter, without dots, e.g. `["json"]`. */
  readonly extensions: readonly string[];
}

/**
 * How an export ended. Three outcomes, all of which the UI must be able to tell
 * apart — a cancel is not a failure, and a failure is never silence.
 */
export type ExportOutcome =
  /** Written to a file the user chose. `path` is worth showing them. */
  | { readonly outcome: "saved"; readonly path: string }
  /** Handed to the browser's download machinery (non-Tauri hosts only). */
  | { readonly outcome: "downloaded" }
  /** The user dismissed the save dialog. Nothing was written. */
  | { readonly outcome: "cancelled" };

/**
 * Hand `spec` to the browser's download machinery. Only reachable outside
 * Tauri; see the module doc for why it must not be used on the desktop.
 */
function downloadInBrowser(spec: ExportFileSpec): void {
  const blob = new Blob([spec.contents], { type: spec.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = spec.defaultName;
  anchor.click();
  // Defer the revoke so the browser can't race it against the download start
  // (revoking synchronously can cancel an in-flight download).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Save an exported document, natively where that is possible.
 *
 * Rejects only on a genuine write failure — the caller is expected to catch and
 * show it. A cancelled dialog resolves to `{ outcome: "cancelled" }`.
 */
export async function saveExportedFile(
  spec: ExportFileSpec
): Promise<ExportOutcome> {
  if (isTauri()) {
    const path = await saveExportFile({
      title: spec.dialogTitle,
      defaultName: spec.defaultName,
      filterName: spec.filterName,
      extensions: [...spec.extensions],
      contents: spec.contents,
    });
    return path ? { outcome: "saved", path } : { outcome: "cancelled" };
  }
  downloadInBrowser(spec);
  return { outcome: "downloaded" };
}

/**
 * Normalize a thrown export failure into a displayable one-line detail. Tauri
 * command rejections arrive as plain strings (the `Err(String)` from Rust), a
 * browser failure as an `Error`.
 */
export function exportErrorDetail(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
