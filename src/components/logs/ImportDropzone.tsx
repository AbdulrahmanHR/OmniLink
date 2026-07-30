import * as React from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Event as TauriEvent, UnlistenFn } from "@tauri-apps/api/event";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { AlertTriangle, FileUp, Loader2, Upload, X } from "lucide-react";
import { parseBlackboxCsv, type ParsedLog } from "@/lib/blackbox";
import { parseOmniLogCsv } from "@/lib/omnilog";
import { TELEMETRY_CSV_COLUMNS } from "@/lib/telemetry-session-csv";
import {
  cancelBlackboxDecode,
  decodeBlackboxLog,
  onLogDecodeDone,
  onLogDecodeError,
  onLogDecodeProgress,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** True when running inside the Tauri runtime (native app), false in a browser. */
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Sniff a CSV's source from its header row. An OmniLink session export's header
 * is *exactly* the M11 {@link TELEMETRY_CSV_COLUMNS}; anything else is treated as
 * a Betaflight blackbox export (parsing there is column-tolerant).
 */
function parseCsvText(csv: string): ParsedLog {
  const firstLine = csv.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const header = firstLine.split(",").map((c) => c.trim());
  const isOmniLog =
    header.length === TELEMETRY_CSV_COLUMNS.length &&
    TELEMETRY_CSV_COLUMNS.every((col, i) => header[i] === col);
  return isOmniLog ? parseOmniLogCsv(csv) : parseBlackboxCsv(csv);
}

interface ImportDropzoneProps {
  /** Invoked with the normalized log once a `.csv` or decoded `.bbl` is parsed. */
  onLogLoaded: (log: ParsedLog) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "decoding"; percent: number; stage?: string }
  | { kind: "error"; messageKey: string; detail?: string };

/**
 * Flight-log import surface (M14, FR-LOG-01/02).
 *
 * Two on-ramps, both dependency-free:
 *  - **`.csv`** (OmniLink session export or Betaflight blackbox CSV) is read with
 *    the browser File API (`File.text()`) from either the Browse button or an
 *    HTML5 drop, then sniffed + parsed locally. Works in browser dev and native.
 *  - **`.bbl`** needs an on-disk path for the Rust decoder, which the File API
 *    cannot supply. So `.bbl` is accepted only via a *native* Tauri drag-drop
 *    (`onDragDropEvent` exposes absolute `paths`); the path is handed to
 *    {@link decodeBlackboxLog} and progress/outcome arrive on `logs://*`. The
 *    decoded CSV text comes back inline and is parsed with {@link parseBlackboxCsv}.
 *
 * Decode errors surface as a themed, translated message.
 */
export function ImportDropzone({ onLogLoaded }: ImportDropzoneProps) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });
  const [dragActive, setDragActive] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  // Active `logs://*` unlisten fns for the in-flight decode, cleared on
  // completion/unmount so a finished decode leaves no dangling listeners.
  const decodeUnlistenRef = React.useRef<UnlistenFn[]>([]);

  const teardownDecodeListeners = React.useCallback(() => {
    for (const un of decodeUnlistenRef.current) un();
    decodeUnlistenRef.current = [];
  }, []);

  const startBblDecode = React.useCallback(
    async (path: string) => {
      teardownDecodeListeners();
      setStatus({ kind: "decoding", percent: 0 });
      // Subscribe before invoking so no early event is missed.
      const unlisteners = await Promise.all([
        onLogDecodeProgress((p) =>
          setStatus({ kind: "decoding", percent: p.percent, stage: p.stage })
        ),
        onLogDecodeDone((p) => {
          teardownDecodeListeners();
          try {
            onLogLoaded(parseBlackboxCsv(p.csv));
            setStatus({ kind: "idle" });
          } catch {
            setStatus({ kind: "error", messageKey: "logs.errors.parse" });
          }
        }),
        onLogDecodeError((e) => {
          // A superseded decode (a second `.bbl` dropped mid-flight) makes the
          // backend cancel+join the prior worker, whose `cancelled` error lands
          // on these — the *new* decode's — live listeners. Ignore it: the
          // user-initiated cancel path (`cancelDecode`) tears down its own
          // listeners synchronously, so a `cancelled` reaching a live listener
          // is always a superseded prior decode, never this one. Surfacing it
          // would show a spurious "cancelled by user" error and drop the new
          // decode's `logs://done` result.
          if (e.category === "cancelled") return;
          teardownDecodeListeners();
          setStatus({
            kind: "error",
            // A decode refused for being too large carries its own copy; every
            // other decode failure falls back to the generic message. (Other
            // summaryKeys have no `logs.errors.*` entry, so rendering them
            // verbatim through `t()` would leak a raw key to the user.)
            messageKey:
              e.summaryKey === "decodedLogTooLarge"
                ? "logs.errors.decodedLogTooLarge"
                : "logs.errors.decode",
            detail: e.detail,
          });
        }),
      ]);
      decodeUnlistenRef.current = unlisteners;
      try {
        await decodeBlackboxLog(path);
      } catch {
        teardownDecodeListeners();
        setStatus({ kind: "error", messageKey: "logs.errors.decode" });
      }
    },
    [onLogLoaded, teardownDecodeListeners]
  );

  const handleCsvFile = React.useCallback(
    async (file: File) => {
      setStatus({ kind: "reading" });
      try {
        const text = await file.text();
        onLogLoaded(parseCsvText(text));
        setStatus({ kind: "idle" });
      } catch {
        setStatus({ kind: "error", messageKey: "logs.errors.read" });
      }
    },
    [onLogLoaded]
  );

  /** Route a File-API file by extension (only `.csv` is readable this way). */
  const handlePickedFile = React.useCallback(
    (file: File) => {
      const name = file.name.toLowerCase();
      if (name.endsWith(".csv")) {
        void handleCsvFile(file);
      } else if (name.endsWith(".bbl")) {
        // A File from the picker/HTML drop carries no on-disk path, which the
        // Rust decoder requires — instruct the user to drag it onto the window.
        setStatus({ kind: "error", messageKey: "logs.errors.bblNeedsDrop" });
      } else {
        setStatus({ kind: "error", messageKey: "logs.errors.unsupported" });
      }
    },
    [handleCsvFile]
  );

  // Native Tauri drag-drop: the only seam that exposes an absolute path, so it
  // drives `.bbl` decoding. (`.csv` would also yield a path here, but without an
  // fs plugin its bytes can't be read — those go through the File-API Browse
  // button / HTML drop instead.)
  React.useEffect(() => {
    if (!isTauri) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event: TauriEvent<DragDropEvent>) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        // type === "drop"
        setDragActive(false);
        const bbl = payload.paths.find((p) => p.toLowerCase().endsWith(".bbl"));
        if (bbl) {
          void startBblDecode(bbl);
          return;
        }
        const csv = payload.paths.find((p) => p.toLowerCase().endsWith(".csv"));
        if (csv) {
          // Native drop gives a path but no readable bytes (no fs plugin).
          setStatus({ kind: "error", messageKey: "logs.errors.csvUseBrowse" });
        } else {
          setStatus({ kind: "error", messageKey: "logs.errors.unsupported" });
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [startBblDecode]);

  // Drop the decode listeners if the component unmounts mid-decode.
  React.useEffect(() => teardownDecodeListeners, [teardownDecodeListeners]);

  const onHtmlDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) handlePickedFile(file);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePickedFile(file);
    e.target.value = "";
  };

  const cancelDecode = () => {
    void cancelBlackboxDecode();
    teardownDecodeListeners();
    setStatus({ kind: "idle" });
  };

  const decoding = status.kind === "decoding";
  const reading = status.kind === "reading";

  return (
    <div className="flex flex-col gap-3">
      {/*
        Non-interactive drop surface: intentionally NOT a focusable/announced button.
        Making it `role="button" tabIndex={0}` while it contains the real Browse
        `<button>` would nest a focusable control inside another (axe
        `nested-interactive`, a WCAG/ARIA violation). Keyboard users activate via the
        inner Browse button — the sole focusable control — which is the correct
        accessible pattern. The div keeps drag-and-drop plus a convenience
        click-to-browse for pointer users; `aria-label` on a plain div is ignored by
        assistive tech (harmless).
      */}
      <div
        data-testid="logs-import-dropzone"
        aria-label={t("logs.import.dropzone")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onHtmlDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-card/40 px-6 py-10 text-center transition-colors",
          dragActive && "border-primary bg-primary/5"
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Upload className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t("logs.import.dropzone")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("logs.import.hint")}
          </p>
          {isTauri && (
            <p className="text-xs text-muted-foreground">
              {t("logs.import.bbl")}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
          disabled={decoding || reading}
        >
          <FileUp aria-hidden />
          {t("logs.import.browse")}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.bbl"
          className="sr-only"
          onChange={onInputChange}
          data-testid="logs-import-input"
          aria-hidden
          tabIndex={-1}
        />
      </div>

      {reading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
          {t("logs.import.reading")}
        </p>
      )}

      {decoding && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2
                className="h-4 w-4 motion-safe:animate-spin"
                aria-hidden
              />
              {t("logs.import.decoding", {
                percent: Math.round(status.percent),
              })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelDecode}
            >
              <X aria-hidden />
              {t("logs.import.cancel")}
            </Button>
          </div>
          <Progress value={status.percent} />
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-0.5">
            <p className="font-medium">{t(status.messageKey)}</p>
            {status.detail && (
              <p className="text-destructive/80">{status.detail}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
