import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { collectUserDataExport, wipeAllUserData } from "@/lib/userData";
import { exportErrorDetail, saveExportedFile } from "@/lib/fileExport";
import { openBackupsFolder } from "@/lib/tauri";

/**
 * Filesystem-safe UTC timestamp stamp for the export filename, e.g.
 * `2026-07-03_13-45-30`. Mirrors `SessionPicker`'s `fileStamp`.
 */
function fileStamp(now: number): string {
  return new Date(now)
    .toISOString()
    .slice(0, 19)
    .replace("T", "_")
    .replace(/:/g, "-");
}

/**
 * Privacy / Your data card (NFR-PRIV-02, GDPR-style local export + erase).
 *
 * Two actions, both 100% on-device (no server):
 *  - **Export My Data** bundles ALL local user data — the four `omnilink.db`
 *    tables, the persisted localStorage stores, and the config profiles — into a
 *    single versioned JSON file the user saves. API key VALUES are NEVER
 *    included (only which providers have a key configured); see
 *    `@/lib/userData`.
 *  - **Pre-flash backups** opens `<app_data_dir>/backups` in the OS file
 *    manager. The flash engine snapshots the connected device to an `.elrsp`
 *    there before every flash (and refuses to flash if it cannot); this is the
 *    action that makes those files reachable — they import from the Profiles
 *    page like any other `.elrsp`.
 *  - **Delete All My Data** irreversibly wipes every one of those stores plus
 *    the BYOK keys, behind a strong destructive confirm (the user must type the
 *    confirm word), then reloads so no stale in-memory state remains.
 *
 * The inventory is centralized in `@/lib/userData`, so this card can't drift
 * from what is actually exported/erased.
 */
/**
 * How the last export ended, as the card reports it. `null` before the first
 * attempt — and after a cancelled one, which is a normal outcome that must
 * leave the card exactly as it was.
 */
type ExportStatus =
  | { kind: "saved"; path: string }
  | { kind: "failed"; detail: string }
  | null;

export function PrivacyDataSettings() {
  const { t } = useTranslation();
  const [exporting, setExporting] = React.useState(false);
  const [exportStatus, setExportStatus] = React.useState<ExportStatus>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);

  // The word the user must type to arm the delete (localized so the gate stays
  // in the zero-hardcoded-strings policy).
  const confirmWord = t("settings.privacy.deleteConfirmWord");
  const armed = confirmText.trim().toUpperCase() === confirmWord.toUpperCase();

  const handleExport = React.useCallback(async () => {
    setExporting(true);
    setExportStatus(null);
    try {
      const now = Date.now();
      const bundle = await collectUserDataExport(now);
      // Under Tauri this opens a native save dialog and writes where the user
      // chose; in a plain browser it falls back to a download. Either way the
      // outcome is stated below — the shipped 3.0.3 bug was that it wasn't.
      const result = await saveExportedFile({
        contents: JSON.stringify(bundle, null, 2),
        defaultName: t("settings.privacy.exportFilename", {
          name: fileStamp(now),
        }),
        mimeType: "application/json",
        dialogTitle: t("settings.privacy.exportDialogTitle"),
        filterName: t("settings.privacy.exportFilterName"),
        extensions: ["json"],
      });
      // A cancel leaves the card untouched; only a real save announces itself.
      if (result.outcome === "saved") {
        setExportStatus({ kind: "saved", path: result.path });
      }
    } catch (e) {
      setExportStatus({ kind: "failed", detail: exportErrorDetail(e) });
    } finally {
      setExporting(false);
    }
  }, [t]);

  const handleOpenBackups = React.useCallback(async () => {
    try {
      await openBackupsFolder();
    } catch {
      // Outside Tauri (or with no desktop file manager) there is nothing to
      // open; the row stays inert rather than throwing at the user.
    }
  }, []);

  const closeConfirm = React.useCallback(() => {
    setConfirmOpen(false);
    setConfirmText("");
  }, []);

  const handleDelete = React.useCallback(async () => {
    setDeleting(true);
    try {
      await wipeAllUserData();
      // Reset to a clean state — a full reload guarantees no stale in-memory
      // Zustand state survives the wipe.
      window.location.reload();
    } catch {
      // wipeAllUserData is best-effort and shouldn't reject; guard the reload
      // path anyway so a wedged delete still clears the dialog.
      setDeleting(false);
      closeConfirm();
    }
  }, [closeConfirm]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <CardTitle>{t("settings.privacy.title")}</CardTitle>
        </div>
        <CardDescription>{t("settings.privacy.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4" data-testid="privacy-data-card">
        {/* Export */}
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label>{t("settings.privacy.exportTitle")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.privacy.exportHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            onClick={() => void handleExport()}
            disabled={exporting}
            data-testid="privacy-export-btn"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {t("settings.privacy.exportAction")}
          </Button>
        </div>

        {/* The outcome of the last export. Matches the inline status/error
            convention used by folder sync rather than inventing a toast: a
            success names the file the user now has, a failure names what went
            wrong, and a cancel renders nothing at all. */}
        {exportStatus?.kind === "saved" && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-status-good/40 bg-status-good/10 p-3"
            data-testid="privacy-export-status"
          >
            <Check
              className="mt-0.5 h-4 w-4 shrink-0 text-status-good"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-foreground">
                {t("settings.privacy.exportSavedTitle")}
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
                {exportStatus.path}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExportStatus(null)}
              aria-label={t("settings.privacy.exportDismiss")}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}

        {exportStatus?.kind === "failed" && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
            data-testid="privacy-export-error"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">
                {t("settings.privacy.exportFailedTitle")}
              </p>
              <p className="mt-0.5 break-words font-mono text-[11px] opacity-80">
                {exportStatus.detail}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExportStatus(null)}
              aria-label={t("settings.privacy.exportDismiss")}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}

        {/* Pre-flash device backups (FLASH-5). The engine writes an `.elrsp`
            snapshot of the connected device before every flash — and refuses to
            flash when it cannot. This is the action that makes that artifact
            reachable: open the folder, then import a snapshot from the Profiles
            page like any other `.elrsp`. */}
        <div className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label>{t("settings.privacy.backupsTitle")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.privacy.backupsHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            onClick={() => void handleOpenBackups()}
            data-testid="privacy-backups-btn"
          >
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("settings.privacy.backupsAction")}
          </Button>
        </div>

        {/* Delete — danger zone */}
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label className="text-destructive">
              {t("settings.privacy.deleteTitle")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t("settings.privacy.deleteHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            className="shrink-0"
            onClick={() => setConfirmOpen(true)}
            data-testid="privacy-delete-btn"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {t("settings.privacy.deleteAction")}
          </Button>
        </div>
      </CardContent>

      {/* Destructive confirmation: an explicit dialog that requires typing the
          confirm word, so an accidental click can never wipe everything. */}
      <Dialog open={confirmOpen} onClose={closeConfirm}>
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <AlertTriangle
                className="h-5 w-5 text-destructive"
                aria-hidden
              />
              {t("settings.privacy.deleteConfirmTitle")}
            </span>
          </DialogTitle>
          <DialogDescription>
            {t("settings.privacy.deleteConfirmBody")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-1">
          <Label htmlFor="privacy-delete-confirm-input">
            {t("settings.privacy.deleteConfirmPrompt", { word: confirmWord })}
          </Label>
          <Input
            id="privacy-delete-confirm-input"
            autoComplete="off"
            value={confirmText}
            placeholder={confirmWord}
            disabled={deleting}
            onChange={(e) => setConfirmText(e.target.value)}
            data-testid="privacy-delete-confirm-input"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={closeConfirm}
            disabled={deleting}
          >
            {t("settings.privacy.deleteCancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleDelete()}
            disabled={!armed || deleting}
            data-testid="privacy-delete-confirm-btn"
          >
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden />
            )}
            {t("settings.privacy.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
