import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileWarning,
  FolderOpen,
  FolderSync as FolderSyncIcon,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Separator } from "@/components/ui/separator";
import { ProfileDiff } from "./ProfileDiff";
import { folderEntriesFrom, useProfilesStore } from "@/stores/profiles";
import {
  summarizeFolderSync,
  type FolderSyncEntry,
  type FolderSyncStatus,
} from "@/lib/folderSync";
import { pickSyncFolder } from "@/lib/tauri";

/**
 * Folder sync (M71, decision D37) — the zero-infrastructure replacement for the
 * cloud sync deleted at `3.0.0`.
 *
 * The user points OmniLink at a directory they already own; it becomes a plain
 * set of `.elrsp` files. If that directory happens to sit in Dropbox / Drive /
 * OneDrive / Syncthing / a git checkout, they get multi-device sync from a tool
 * they already run. There is no OmniLink server, no account and no network call
 * on this path at all.
 *
 * Deliberately, visibly MANUAL: every transfer is one click on one row. No
 * watcher, no timer, no "syncing…" that happens behind the user's back — and a
 * conflict is never resolved without them choosing.
 */

/** Badge variant per diff status. */
const STATUS_VARIANT: Record<
  FolderSyncStatus,
  "default" | "good" | "warning" | "outline"
> = {
  "local-only": "default",
  "folder-only": "outline",
  same: "good",
  conflict: "warning",
};

/** Format a ms timestamp for the active locale, or null when unknown. */
function useTimestampFormatter(): (value: number) => string | null {
  const { i18n } = useTranslation();
  return useCallback(
    (value: number) => {
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      return new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    },
    [i18n.language]
  );
}

export function FolderSync() {
  const { t } = useTranslation();
  const folderPath = useProfilesStore((s) => s.folderPath);
  const folderPhase = useProfilesStore((s) => s.folderPhase);
  const folderError = useProfilesStore((s) => s.folderError);
  const folderBusy = useProfilesStore((s) => s.folderBusy);
  const folderUnreadable = useProfilesStore((s) => s.folderUnreadable);
  const userProfiles = useProfilesStore((s) => s.userProfiles);
  const folderFiles = useProfilesStore((s) => s.folderFiles);
  const chooseFolder = useProfilesStore((s) => s.chooseFolder);
  const refreshFolder = useProfilesStore((s) => s.refreshFolder);
  const forgetFolder = useProfilesStore((s) => s.forgetFolder);
  const clearFolderError = useProfilesStore((s) => s.clearFolderError);

  /** File names the user chose to leave alone this session (Skip). */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);

  // Derived, and memoised on the two slices it depends on: a zustand v5 selector
  // must return a stable snapshot, so the diff cannot be computed inside one.
  const entries = useMemo(
    () => folderEntriesFrom(userProfiles, folderFiles),
    [userProfiles, folderFiles]
  );
  const summary = useMemo(() => summarizeFolderSync(entries), [entries]);

  const available = isTauri();
  const visible = entries.filter((entry) => !skipped.has(entry.fileName));
  const pending = visible.filter((entry) => entry.status !== "same");
  const settled = visible.filter((entry) => entry.status === "same");

  const handlePick = async () => {
    const picked = await pickSyncFolder({ title: t("folderSync.dialog.title") });
    if (picked === null) return;
    setSkipped(new Set());
    await chooseFolder(picked);
  };

  const skip = (fileName: string) =>
    setSkipped((prev) => new Set([...prev, fileName]));

  if (!available) {
    return (
      <Card data-testid="folder-sync-unavailable">
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <FolderSyncIcon className="h-4 w-4 text-primary" aria-hidden="true" />
            {t("folderSync.title")}
          </CardTitle>
          <CardDescription>{t("folderSync.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={FolderOpen}
            title={t("folderSync.unavailable.title")}
            description={t("folderSync.unavailable.description")}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="folder-sync">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-1.5">
              <FolderSyncIcon
                className="h-4 w-4 text-primary"
                aria-hidden="true"
              />
              {t("folderSync.title")}
            </CardTitle>
            <CardDescription className="mt-1">
              {t("folderSync.description")}
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={folderPath === null ? "default" : "outline"}
              size="sm"
              onClick={() => void handlePick()}
              data-testid="folder-sync-pick"
            >
              <FolderOpen />
              {folderPath === null
                ? t("folderSync.actions.choose")
                : t("folderSync.actions.change")}
            </Button>
            {folderPath !== null && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={folderPhase === "loading"}
                  onClick={() => void refreshFolder()}
                  data-testid="folder-sync-refresh"
                >
                  <RefreshCw />
                  {t("folderSync.actions.refresh")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void forgetFolder()}
                  data-testid="folder-sync-forget"
                >
                  <X />
                  {t("folderSync.actions.forget")}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* The honest mechanism, stated where the user is deciding. */}
        <p className="text-xs text-muted-foreground">
          {t("folderSync.mechanism")}
        </p>

        {folderError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
            data-testid="folder-sync-error"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">
                {t(`folderSync.errors.${folderError.code}`, {
                  defaultValue: t("folderSync.errors.io"),
                })}
              </p>
              {folderError.detail.length > 0 && (
                <p className="mt-0.5 break-words font-mono text-[11px] opacity-80">
                  {folderError.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={clearFolderError}
              aria-label={t("folderSync.actions.dismissError")}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {folderPath === null ? (
          <EmptyState
            icon={FolderOpen}
            title={t("folderSync.empty.title")}
            description={t("folderSync.empty.description")}
            action={
              <Button onClick={() => void handlePick()}>
                <FolderOpen />
                {t("folderSync.actions.choose")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface-inset/50 p-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("folderSync.folderLabel")}
                </p>
                <p
                  className="mt-0.5 break-all font-mono text-xs text-foreground"
                  data-testid="folder-sync-path"
                >
                  {folderPath}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="default">
                  {t("folderSync.summary.localOnly", {
                    count: summary["local-only"],
                  })}
                </Badge>
                <Badge variant="outline">
                  {t("folderSync.summary.folderOnly", {
                    count: summary["folder-only"],
                  })}
                </Badge>
                <Badge variant="good">
                  {t("folderSync.summary.same", { count: summary.same })}
                </Badge>
                <Badge variant="warning">
                  {t("folderSync.summary.conflict", {
                    count: summary.conflict,
                  })}
                </Badge>
              </div>
            </div>

            {folderUnreadable.length > 0 && (
              <div
                className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-status-warning"
                data-testid="folder-sync-unreadable"
              >
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <FileWarning className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("folderSync.unreadable.title")}
                </p>
                <p className="mt-0.5 text-xs">
                  {t("folderSync.unreadable.description")}
                </p>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {folderUnreadable.map((file) => (
                    <li key={file.fileName} className="font-mono text-[11px]">
                      {file.fileName}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {visible.length === 0 ? (
              <EmptyState
                icon={FolderSyncIcon}
                title={t("folderSync.nothingToDo.title")}
                description={t("folderSync.nothingToDo.description")}
              />
            ) : (
              <div className="flex flex-col gap-4">
                {pending.length > 0 && (
                  <ul
                    className="flex flex-col gap-2"
                    data-testid="folder-sync-pending"
                  >
                    {pending.map((entry) => (
                      <li key={entry.fileName}>
                        <EntryRow
                          entry={entry}
                          busy={folderBusy === entry.fileName}
                          onSkip={() => skip(entry.fileName)}
                          onRequestRemove={() =>
                            setPendingRemoval(entry.fileName)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                )}

                {settled.length > 0 && (
                  <div>
                    {pending.length > 0 && <Separator className="mb-3" />}
                    <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t("folderSync.inSyncTitle")}
                    </h3>
                    <ul
                      className="flex flex-col gap-2"
                      data-testid="folder-sync-settled"
                    >
                      {settled.map((entry) => (
                        <li key={entry.fileName}>
                          <EntryRow
                            entry={entry}
                            busy={folderBusy === entry.fileName}
                            onSkip={() => skip(entry.fileName)}
                            onRequestRemove={() =>
                              setPendingRemoval(entry.fileName)
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>

      <RemoveFromFolderDialog
        fileName={pendingRemoval}
        onClose={() => setPendingRemoval(null)}
      />
    </Card>
  );
}

/** One diff row: what differs, and the choices for it. */
function EntryRow({
  entry,
  busy,
  onSkip,
  onRequestRemove,
}: {
  entry: FolderSyncEntry;
  busy: boolean;
  onSkip: () => void;
  onRequestRemove: () => void;
}) {
  const { t } = useTranslation();
  const formatTimestamp = useTimestampFormatter();
  const pushToFolder = useProfilesStore((s) => s.pushToFolder);
  const pullFromFolder = useProfilesStore((s) => s.pullFromFolder);
  const keepBothFromFolder = useProfilesStore((s) => s.keepBothFromFolder);
  const [comparing, setComparing] = useState(false);

  const localTime = entry.local ? formatTimestamp(entry.local.doc.updatedAt) : null;
  const folderTime = entry.folder ? formatTimestamp(entry.folder.modifiedAt) : null;

  return (
    <div
      className="rounded-md border border-border bg-card p-3"
      data-testid="folder-sync-entry"
      data-status={entry.status}
      data-file={entry.fileName}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className="break-all font-mono text-sm text-foreground"
            data-testid="folder-sync-entry-name"
          >
            {entry.fileName}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge
              variant={STATUS_VARIANT[entry.status]}
              data-testid="folder-sync-entry-status"
            >
              {t(`folderSync.status.${entry.status}`)}
            </Badge>
            {localTime && (
              <span className="text-[11px] text-muted-foreground">
                {t("folderSync.side.localUpdated", { when: localTime })}
              </span>
            )}
            {folderTime && (
              <span className="text-[11px] text-muted-foreground">
                {t("folderSync.side.folderUpdated", { when: folderTime })}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {entry.status === "conflict" && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={comparing}
              onClick={() => setComparing((open) => !open)}
              data-testid="folder-sync-compare"
            >
              {comparing ? <ChevronDown /> : <ChevronRight />}
              {t("folderSync.actions.compare")}
            </Button>
          )}

          {entry.local !== null && entry.status !== "same" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void pushToFolder(entry.fileName, entry.local?.id ?? "")
              }
              data-testid="folder-sync-push"
            >
              <ArrowUpFromLine />
              {entry.status === "conflict"
                ? t("folderSync.actions.keepMine")
                : t("folderSync.actions.push")}
            </Button>
          )}

          {entry.folder !== null && entry.status !== "same" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void pullFromFolder(entry.fileName)}
              data-testid="folder-sync-pull"
            >
              <ArrowDownToLine />
              {entry.status === "conflict"
                ? t("folderSync.actions.keepTheirs")
                : t("folderSync.actions.pull")}
            </Button>
          )}

          {entry.status === "conflict" && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void keepBothFromFolder(entry.fileName)}
              data-testid="folder-sync-keep-both"
            >
              <Copy />
              {t("folderSync.actions.keepBoth")}
            </Button>
          )}

          {entry.status === "folder-only" && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onRequestRemove}
              data-testid="folder-sync-remove"
            >
              <Trash2 />
              {t("folderSync.actions.remove")}
            </Button>
          )}

          {entry.status === "same" ? (
            <span className="flex items-center gap-1 text-[11px] text-status-good">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t("folderSync.status.same")}
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSkip}
              data-testid="folder-sync-skip"
            >
              {t("folderSync.actions.skip")}
            </Button>
          )}
        </div>
      </div>

      {/* A conflict shows BOTH sides before anything is decided — the folder's
          version as the baseline, this machine's as the candidate. */}
      {comparing && entry.local && entry.folder && (
        <div className="mt-3" data-testid="folder-sync-conflict-diff">
          <p className="mb-2 text-xs text-muted-foreground">
            {t("folderSync.conflict.diffCaption")}
          </p>
          <ProfileDiff
            before={entry.folder.doc.settings}
            after={entry.local.doc.settings}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("folderSync.conflict.help")}
          </p>
        </div>
      )}
    </div>
  );
}

/** Deleting someone's file is never a one-click accident. */
function RemoveFromFolderDialog({
  fileName,
  onClose,
}: {
  fileName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const removeFromFolder = useProfilesStore((s) => s.removeFromFolder);

  return (
    <Dialog open={fileName !== null} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t("folderSync.remove.title")}</DialogTitle>
        <DialogDescription>
          {t("folderSync.remove.description", { name: fileName ?? "" })}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            if (fileName !== null) void removeFromFolder(fileName);
            onClose();
          }}
          data-testid="folder-sync-remove-confirm"
        >
          <Trash2 />
          {t("folderSync.remove.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
