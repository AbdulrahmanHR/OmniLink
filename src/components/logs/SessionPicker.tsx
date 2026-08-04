import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Clock,
  Database,
  Download,
  Hash,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  telemetrySessionToCsv,
  type TelemetrySessionCsvRow,
} from "@/lib/telemetry-session-csv";
import { exportErrorDetail, saveExportedFile } from "@/lib/fileExport";
import {
  deleteSession,
  formatSessionDuration,
  listStoredSessions,
  loadSessionRows,
  pruneSessions,
  renameSession,
  summarizeSessions,
  type StoredSessionMeta,
} from "@/lib/sessions-db";
import { useRetentionStore } from "@/stores/retention";

interface SessionPickerProps {
  /**
   * Invoked with one recorded session's frames once loaded from SQLite — the
   * same {@link TelemetrySessionCsvRow}[] shape the OmniLink CSV import path
   * produces, so a clicked session lands in the analysis pipeline exactly like
   * an imported session CSV. The session's {@link StoredSessionMeta} is passed
   * alongside so the analysis page can attribute the loaded session's diagnostic
   * history to its device (M40 per-device trend grouping).
   */
  onSession: (rows: TelemetrySessionCsvRow[], meta: StoredSessionMeta) => void;
}

type Status = "loading" | "ready" | "error";

/**
 * A filesystem-safe timestamp stamp for an exported session's filename,
 * e.g. `2026-06-24_13-45-30` (UTC). Keeps each per-session export distinct
 * without leaking the raw session id.
 */
function fileStamp(startedAt: number): string {
  return new Date(startedAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", "_")
    .replace(/:/g, "-");
}

/**
 * Prior-OmniLink-session browser + manager (M11/M14/M24, FR-LOG-02).
 *
 * Reads the SQLite `telemetry_sessions` table via the best-effort
 * {@link listStoredSessions} read seam and lists each recorded session. Clicking
 * a row loads its frames ({@link loadSessionRows}) and hands them up via
 * `onSession` — identical to importing that session's exported CSV. Each row
 * also exports its frames to a canonical session CSV
 * ({@link telemetrySessionToCsv}), can be **renamed** (inline) or **deleted**
 * (with a confirm dialog), and a storage summary line tops the list.
 *
 * If retention is enabled (see `useRetentionStore`), a best-effort
 * {@link pruneSessions} sweep runs before each (re)list so `omnilink.db` growth
 * stays bounded. Every operation is best-effort + `isTauri()`-guarded: outside
 * Tauri (or on any DB failure) the seam yields an empty list, so this degrades
 * to an honest placeholder that points the operator at the CSV import path
 * rather than faking entries.
 */
export function SessionPicker({ onSession }: SessionPickerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<Status>("loading");
  const [sessions, setSessions] = React.useState<StoredSessionMeta[]>([]);
  // The session id whose row is currently mutating (load/export/delete/rename),
  // or null when idle. Gates every control so only one operation runs at a time.
  const [busyId, setBusyId] = React.useState<string | null>(null);
  // The session being renamed inline, plus its draft label; null = not editing.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState("");
  // The session pending a delete confirmation, or null when no dialog is open.
  const [confirmSession, setConfirmSession] =
    React.useState<StoredSessionMeta | null>(null);
  // The session id whose last load/export failed (a genuine DB read error, which
  // loadSessionRows re-throws), or null. Surfaces a transient inline error on
  // that one row instead of swapping to a blank analysis surface / downloading a
  // header-only CSV — the rest of the still-loadable list stays intact.
  const [errorId, setErrorId] = React.useState<string | null>(null);
  const errorTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flag a row's read error transiently: it auto-clears so the row stays usable
  // for a retry. A later flag resets the timer onto the newer failing row.
  const flagRowError = React.useCallback((sessionId: string) => {
    setErrorId(sessionId);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setErrorId(null), 4000);
  }, []);

  React.useEffect(
    () => () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    []
  );

  // v3.0.3: the outcome of the last CSV export, per row. Kept separate from
  // `errorId` because the two say different things — that one is a DB *read*
  // failure ("try again"), this one is where the file went, or why it didn't.
  const [exportNotice, setExportNotice] = React.useState<{
    sessionId: string;
    kind: "saved" | "failed";
    detail: string;
  } | null>(null);
  const exportTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show one export outcome transiently, mirroring {@link flagRowError}. */
  const flagExport = React.useCallback(
    (sessionId: string, kind: "saved" | "failed", detail: string) => {
      setExportNotice({ sessionId, kind, detail });
      if (exportTimer.current) clearTimeout(exportTimer.current);
      exportTimer.current = setTimeout(() => setExportNotice(null), 8000);
    },
    []
  );

  React.useEffect(
    () => () => {
      if (exportTimer.current) clearTimeout(exportTimer.current);
    },
    []
  );

  // Retention policy (M24): when enabled, prune before listing so the database
  // stays bounded. Read individually so a setter-only change can't re-run loads.
  const retentionEnabled = useRetentionStore((s) => s.enabled);
  const maxCount = useRetentionStore((s) => s.maxCount);
  const maxAgeDays = useRetentionStore((s) => s.maxAgeDays);

  // Run the optional retention sweep, then enumerate the stored sessions. Both
  // halves are best-effort/`isTauri()`-guarded internally, so this never throws
  // or blocks the UI on the offline path.
  const loadSessions = React.useCallback(async (): Promise<
    StoredSessionMeta[]
  > => {
    if (retentionEnabled) {
      await pruneSessions({ maxCount, maxAgeDays }, Date.now());
    }
    return listStoredSessions();
  }, [retentionEnabled, maxCount, maxAgeDays]);

  // Initial load (+ retention sweep), with a cancel guard for unmount/StrictMode.
  React.useEffect(() => {
    let cancelled = false;
    loadSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setStatus("ready");
      })
      .catch(() => {
        // loadSessions is best-effort and resolves to [] on failure, so this is
        // belt-and-suspenders for an unexpected synchronous rejection.
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [loadSessions]);

  // Re-list after a delete/rename (the component is mounted — the user just
  // acted), so a mutated/pruned list re-renders immediately.
  const refresh = React.useCallback(async () => {
    try {
      setSessions(await loadSessions());
    } catch {
      setStatus("error");
    }
  }, [loadSessions]);

  const busy = busyId !== null;

  const handleLoad = React.useCallback(
    async (session: StoredSessionMeta) => {
      setBusyId(session.sessionId);
      setErrorId(null);
      try {
        const rows = await loadSessionRows(session.sessionId);
        onSession(rows, session);
      } catch {
        // A genuine DB read failure (loadSessionRows re-throws): keep the picker
        // and the rest of the list rather than transitioning to a blank "1 / 0"
        // analysis surface indistinguishable from an empty recording.
        flagRowError(session.sessionId);
      } finally {
        setBusyId(null);
      }
    },
    [onSession, flagRowError]
  );

  const handleExport = React.useCallback(
    async (session: StoredSessionMeta) => {
      setBusyId(session.sessionId);
      setErrorId(null);
      setExportNotice(null);
      let rows: TelemetrySessionCsvRow[];
      try {
        // Read the frames first and let a genuine DB failure throw *before* the
        // save dialog opens, so a failed read can't produce a header-only CSV
        // that looks like a successful (but empty) export.
        rows = await loadSessionRows(session.sessionId);
      } catch {
        // Same guard as handleLoad: surface the failure inline instead of
        // silently "exporting" an empty CSV.
        flagRowError(session.sessionId);
        setBusyId(null);
        return;
      }
      try {
        // Native save dialog under Tauri (v3.0.3 — the `<a download>` this
        // replaced wrote into the process cwd on WebKitGTK); browser download
        // otherwise. A cancel says nothing; a save says where it went.
        const result = await saveExportedFile({
          contents: telemetrySessionToCsv(rows),
          defaultName: t("logs.session.exportFilename", {
            name: fileStamp(session.startedAt),
          }),
          mimeType: "text/csv",
          dialogTitle: t("logs.session.exportDialogTitle"),
          filterName: t("logs.session.exportFilterName"),
          extensions: ["csv"],
        });
        if (result.outcome === "saved") {
          flagExport(session.sessionId, "saved", result.path);
        }
      } catch (e) {
        flagExport(session.sessionId, "failed", exportErrorDetail(e));
      } finally {
        setBusyId(null);
      }
    },
    [t, flagRowError, flagExport]
  );

  // Delete the session + all its frames (best-effort), then re-list. Always
  // clears the confirm dialog whether the delete succeeds or fails.
  const handleDelete = React.useCallback(
    async (session: StoredSessionMeta) => {
      setBusyId(session.sessionId);
      setConfirmSession(null);
      try {
        await deleteSession(session.sessionId);
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh]
  );

  // Begin inline rename: seed the draft with the current label (if any).
  const startRename = React.useCallback((session: StoredSessionMeta) => {
    setEditingId(session.sessionId);
    setDraftName(session.name ?? "");
  }, []);

  const cancelRename = React.useCallback(() => {
    setEditingId(null);
    setDraftName("");
  }, []);

  // Save the draft label (empty/whitespace clears it — see renameSession), then
  // re-list so the new title renders.
  const saveRename = React.useCallback(
    async (session: StoredSessionMeta) => {
      const name = draftName;
      setEditingId(null);
      setBusyId(session.sessionId);
      try {
        await renameSession(session.sessionId, name);
        await refresh();
      } finally {
        setBusyId(null);
        setDraftName("");
      }
    },
    [draftName, refresh]
  );

  if (status === "loading") {
    return (
      <p
        className="flex items-center gap-2 text-xs text-muted-foreground"
        data-testid="logs-session-loading"
      >
        <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        {t("logs.session.loading")}
      </p>
    );
  }

  // Empty (or non-Tauri / failed best-effort load) and the unexpected error
  // path both fall back to an honest placeholder that routes to CSV import.
  if (status === "error" || sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card/40 px-6 py-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          {status === "error" ? (
            <AlertTriangle
              className="h-6 w-6 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <Database className="h-6 w-6 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {status === "error"
              ? t("logs.session.loadError")
              : t("logs.session.empty")}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("logs.session.csvHint")}
          </p>
        </div>
      </div>
    );
  }

  const summary = summarizeSessions(sessions);

  return (
    <div className="flex flex-col gap-2">
      {/* Storage summary: session count + total persisted frames (M24). */}
      <p
        className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
        data-testid="logs-session-summary"
      >
        <Database className="h-3 w-3" aria-hidden />
        {t("logs.session.summary", {
          sessions: t("logs.session.summarySessions", {
            count: summary.sessionCount,
          }),
          frames: t("logs.session.frames", { count: summary.totalFrames }),
        })}
      </p>

      <ul className="flex flex-col gap-2" data-testid="logs-session-list">
        {sessions.map((session) => {
          const target = session.targetName ?? t("logs.session.unknownTarget");
          const firmware =
            session.firmware ?? t("logs.session.unknownFirmware");
          const recordedAt = new Date(session.startedAt).toLocaleString();
          const duration = formatSessionDuration(
            session.startedAt,
            session.endedAt
          );
          const rowBusy = busyId === session.sessionId;
          const rowError = errorId === session.sessionId;
          const rowExport =
            exportNotice?.sessionId === session.sessionId ? exportNotice : null;
          const editing = editingId === session.sessionId;

          if (editing) {
            // Inline rename: replace the row's load affordance with an editable
            // field + save/cancel. Save on Enter / check; cancel on Esc / X.
            return (
              <li
                key={session.sessionId}
                className="flex items-center gap-2 rounded-lg border border-border bg-card/40 p-1 pr-2"
              >
                <Input
                  autoFocus
                  value={draftName}
                  placeholder={t("logs.session.namePlaceholder")}
                  aria-label={t("logs.session.renameAria")}
                  className="mx-1 flex-1"
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveRename(session);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  disabled={rowBusy}
                  onClick={() => void saveRename(session)}
                  aria-label={t("logs.session.renameSave")}
                >
                  <Check aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={rowBusy}
                  onClick={cancelRename}
                  aria-label={t("logs.session.renameCancel")}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          }

          return (
            <li
              key={session.sessionId}
              className="flex items-center gap-2 rounded-lg border border-border bg-card/40 p-1 pr-2"
            >
              <button
                type="button"
                onClick={() => void handleLoad(session)}
                disabled={busy}
                aria-label={t("logs.session.loadAria", {
                  target,
                  time: recordedAt,
                })}
                className="flex flex-1 flex-col gap-1 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {rowBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 motion-safe:animate-spin"
                      aria-hidden
                    />
                  )}
                  {/* A user-set name takes over as the primary title; otherwise
                      fall back to the device target/firmware line. */}
                  {session.name ? (
                    session.name
                  ) : (
                    <>
                      {target}
                      <span className="font-normal text-muted-foreground">
                        · {firmware}
                      </span>
                    </>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {/* When a name is shown above, keep the device line as context. */}
                  {session.name && (
                    <span>
                      {target} · {firmware}
                    </span>
                  )}
                  <span>
                    {t("logs.session.recorded", { time: recordedAt })}
                  </span>
                  <span className="flex items-center gap-1">
                    <Hash className="h-3 w-3" aria-hidden />
                    {t("logs.session.frames", { count: session.frameCount })}
                  </span>
                  {duration && (
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden />
                      {t("logs.session.duration", { duration })}
                    </span>
                  )}
                  {/* Transient read-failure notice (load/export): the row stays
                      clickable so the operator can retry. */}
                  {rowError && (
                    <span
                      className="flex items-center gap-1 text-destructive"
                      role="status"
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden />
                      {t("logs.session.rowError")}
                    </span>
                  )}
                  {/* Where the CSV went, or why it didn't (v3.0.3). Transient,
                      like the read-failure notice above it. */}
                  {rowExport?.kind === "saved" && (
                    <span
                      className="flex min-w-0 items-center gap-1 text-status-good"
                      role="status"
                      data-testid="session-export-saved"
                    >
                      <Check className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {t("logs.session.exportSaved", {
                          path: rowExport.detail,
                        })}
                      </span>
                    </span>
                  )}
                  {rowExport?.kind === "failed" && (
                    <span
                      className="flex min-w-0 items-center gap-1 text-destructive"
                      role="status"
                      data-testid="session-export-failed"
                    >
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {t("logs.session.exportFailed", {
                          detail: rowExport.detail,
                        })}
                      </span>
                    </span>
                  )}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                onClick={() => startRename(session)}
                aria-label={t("logs.session.renameAria")}
              >
                <Pencil aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void handleExport(session)}
                aria-label={t("logs.session.exportAria", {
                  target,
                  time: recordedAt,
                })}
              >
                <Download aria-hidden />
                {t("logs.session.export")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                onClick={() => setConfirmSession(session)}
                aria-label={t("logs.session.deleteAria", {
                  target,
                  time: recordedAt,
                })}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>

      {/* Delete confirmation: a real dialog so an accidental click can't wipe a
          recording. The dialog respects prefers-reduced-motion via its own
          motion-safe animation classes. */}
      <Dialog
        open={confirmSession !== null}
        onClose={() => setConfirmSession(null)}
      >
        <DialogHeader>
          <DialogTitle>{t("logs.session.deleteConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("logs.session.deleteConfirmBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmSession(null)}
          >
            {t("logs.session.deleteCancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (confirmSession) void handleDelete(confirmSession);
            }}
          >
            <Trash2 aria-hidden />
            {t("logs.session.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
