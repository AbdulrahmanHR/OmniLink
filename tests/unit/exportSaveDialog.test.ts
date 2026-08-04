import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every "export" in this app must reach a file the user chose (v3.0.3 defect 1).
 *
 * The three export actions — Settings → "Export my data", a recorded session's
 * CSV, and a profile's `.elrsp` — were all written with the **browser** idiom:
 * build a `Blob`, mint an object URL, and click a synthetic `<a download>`.
 * Chromium honours that with its own download manager. **WebKitGTK does not.**
 * Observed in the packaged AppImage on WebKitGTK 2.52.3, the bundle was written
 * to the process's current working directory — no save dialog, no confirmation,
 * no reveal-in-folder. On an installed app that cwd is typically `/` or `$HOME`,
 * so the file the user asked for simply vanished; on an unwritable cwd it would
 * have failed with nothing said at all.
 *
 * Two things are pinned here:
 *
 *  1. **The idiom lives in exactly one file.** `src/lib/fileExport.ts` is the
 *     single seam that decides between the native save dialog (Tauri) and the
 *     anchor download (a plain browser, which is what the Playwright suite
 *     runs). Any *other* source file reaching for `URL.createObjectURL` or an
 *     `a.download =` assignment is the defect coming back, in a place nobody
 *     will retest on WebKitGTK.
 *  2. **The seam behaves.** Under Tauri it goes through the native dialog and
 *     answers with the resolved path, a cancel or a real error — never silence.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "../../src");

/** The one module allowed to contain the browser download idiom. */
const SEAM = "lib/fileExport.ts";

/** Every `.ts`/`.tsx` file under `src/`, as paths relative to `src/`. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...sourceFiles(abs, rel));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

/** Files whose text matches `pattern`, as relative paths. */
function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SRC_DIR).filter((rel) =>
    pattern.test(readFileSync(path.join(SRC_DIR, rel), "utf8"))
  );
}

describe("the browser download idiom is confined to the export seam", () => {
  it("only the seam mints an object URL", () => {
    expect(filesMatching(/URL\.createObjectURL/)).toEqual([SEAM]);
  });

  it("only the seam clicks a synthetic <a download>", () => {
    expect(filesMatching(/\.download\s*=/)).toEqual([SEAM]);
  });
});

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

const tauriHost = vi.hoisted(() => ({ on: false }));
const saveExportFile = vi.hoisted(() =>
  vi.fn<(request: unknown) => Promise<string | null>>()
);

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauriHost.on,
}));

vi.mock("@/lib/tauri", () => ({ saveExportFile }));

/** The spec every call site fills in; values here are arbitrary but complete. */
const SPEC = {
  contents: '{"hello":"world"}',
  defaultName: "omnilink-data-export-2026-08-04_12-00-00.json",
  mimeType: "application/json",
  dialogTitle: "Save your data export",
  filterName: "JSON file",
  extensions: ["json"],
} as const;

/** Recorded `<a>` clicks + object-URL churn from the browser fallback. */
interface AnchorLog {
  clicks: { href: string; download: string }[];
  created: number;
  revoked: string[];
}

describe("saveExportedFile", () => {
  let log: AnchorLog;
  const realDocument = (globalThis as { document?: unknown }).document;
  const realUrl = globalThis.URL as unknown as Record<string, unknown>;
  const realCreate = realUrl.createObjectURL;
  const realRevoke = realUrl.revokeObjectURL;

  beforeEach(() => {
    vi.resetModules();
    saveExportFile.mockReset();
    tauriHost.on = false;
    log = { clicks: [], created: 0, revoked: [] };

    // A minimal DOM stand-in: these unit tests run in the `node` environment
    // (vitest.config.ts), so the browser fallback needs one to touch at all —
    // and a Tauri-path test that accidentally hits the fallback shows up here.
    (globalThis as { document?: unknown }).document = {
      createElement: () => {
        const a = { href: "", download: "", click: () => log.clicks.push({ href: a.href, download: a.download }) };
        return a;
      },
    };
    realUrl.createObjectURL = () => `blob:omnilink/${++log.created}`;
    realUrl.revokeObjectURL = (url: string) => log.revoked.push(url);
  });

  afterEach(() => {
    if (realDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = realDocument;
    }
    realUrl.createObjectURL = realCreate;
    realUrl.revokeObjectURL = realRevoke;
  });

  it("under Tauri, saves through the native dialog and reports the path", async () => {
    tauriHost.on = true;
    saveExportFile.mockResolvedValue("/home/pilot/Documents/export.json");

    const { saveExportedFile } = await import("@/lib/fileExport");
    const result = await saveExportedFile(SPEC);

    expect(result).toEqual({
      outcome: "saved",
      path: "/home/pilot/Documents/export.json",
    });
    expect(saveExportFile).toHaveBeenCalledWith({
      title: SPEC.dialogTitle,
      defaultName: SPEC.defaultName,
      filterName: SPEC.filterName,
      extensions: ["json"],
      contents: SPEC.contents,
    });
    // The defect in one assertion: on the desktop the file must NOT be written
    // by clicking an anchor, because WebKitGTK drops it in the process cwd.
    expect(log.clicks).toEqual([]);
    expect(log.created).toBe(0);
  });

  it("treats a dismissed dialog as a clean cancel", async () => {
    tauriHost.on = true;
    saveExportFile.mockResolvedValue(null);

    const { saveExportedFile } = await import("@/lib/fileExport");
    expect(await saveExportedFile(SPEC)).toEqual({ outcome: "cancelled" });
    expect(log.clicks).toEqual([]);
  });

  it("propagates a backend write failure instead of swallowing it", async () => {
    tauriHost.on = true;
    saveExportFile.mockRejectedValue("Permission denied (os error 13)");

    const { saveExportedFile } = await import("@/lib/fileExport");
    await expect(saveExportedFile(SPEC)).rejects.toBeTruthy();
  });

  it("outside Tauri, falls back to the browser download", async () => {
    const { saveExportedFile } = await import("@/lib/fileExport");
    const result = await saveExportedFile(SPEC);

    expect(result).toEqual({ outcome: "downloaded" });
    expect(saveExportFile).not.toHaveBeenCalled();
    expect(log.clicks).toEqual([
      { href: "blob:omnilink/1", download: SPEC.defaultName },
    ]);
  });
});
