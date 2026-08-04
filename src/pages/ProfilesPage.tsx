import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Download,
  Layers,
  Pencil,
  Plus,
  Save,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useDeviceStore, useProfilesStore } from "@/stores";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CommunityPresets,
  FolderSync,
  MigratedBadge,
  ProfileDiff,
  ProfileList,
  SettingsTable,
} from "@/components/config";
import { profileDescription, profileName } from "@/lib/profileLabels";
import {
  firmwareCompat,
  migrateElrsp,
  profileToElrsp,
  serializeElrsp,
  type ElrspDocument,
} from "@/lib/elrsp";
import { loadCommunityPresetForImport } from "@/lib/communityPresets";
import { exportErrorDetail, saveExportedFile } from "@/lib/fileExport";
import type { ProfileSettings } from "@/lib/profileSettings";

type DialogMode = "save" | "rename" | null;
/** M71 adds the "folder" tab — the user-owned folder sync surface. */
type ProfilesTab = "saved" | "community" | "folder";

/** A staged import: the candidate document plus whether it was schema-migrated. */
interface ImportPreview {
  doc: ElrspDocument;
  migrated: boolean;
}

/**
 * How the last `.elrsp` export ended. `null` before the first attempt — and
 * after a cancelled save dialog, which must leave the page exactly as it was.
 */
type ExportStatus =
  | { kind: "saved"; path: string }
  | { kind: "failed"; detail: string }
  | null;

function ProfileFormDialog({
  mode,
  initialName,
  initialDescription,
  onSubmit,
  onClose,
}: {
  mode: DialogMode;
  initialName: string;
  initialDescription: string;
  onSubmit: (name: string, description: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const descId = useId();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

  const trimmed = name.trim();
  const isSave = mode === "save";

  return (
    <Dialog open={mode !== null} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>
          {isSave ? t("profiles.dialog.saveTitle") : t("profiles.dialog.renameTitle")}
        </DialogTitle>
        <DialogDescription>
          {isSave
            ? t("profiles.dialog.saveDescription")
            : t("profiles.dialog.renameDescription")}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
            {t("profiles.dialog.nameLabel")}
          </label>
          {/* No autoFocus: the Dialog's focus trap (useFocusTrap) owns initial
              focus and moves it to this first field on open — autofocusing here
              would pre-empt the trap's trigger capture and break focus restore. */}
          <Input
            id={nameId}
            value={name}
            placeholder={t("profiles.dialog.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={descId} className="text-xs font-medium text-muted-foreground">
            {t("profiles.dialog.descriptionLabel")}
          </label>
          <Input
            id={descId}
            value={description}
            placeholder={t("profiles.dialog.descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={trimmed.length === 0}
          onClick={() => onSubmit(trimmed, description.trim())}
        >
          <Check />
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Import preview shared by file-import and community-import. Reuses the
 * FR-CFG-05 {@link ProfileDiff} (never a second differ) to show the candidate
 * profile against the current configuration, surfaces a {@link MigratedBadge}
 * for upgraded docs, and warns — never blocks — on a firmware mismatch.
 */
function ImportPreviewDialog({
  preview,
  activeSettings,
  deviceFw,
  onConfirm,
  onClose,
}: {
  preview: ImportPreview | null;
  activeSettings: ProfileSettings;
  /** `null` = connected but the device reported no version ⇒ no warning. */
  deviceFw: string | null | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  // No live device — or a device that reported no version at all — yields
  // "unknown" → no warning; only a known mismatch warns.
  const firmwareWarn =
    preview !== null &&
    firmwareCompat(preview.doc.firmwareVersion, deviceFw) === "warn";

  return (
    <Dialog open={preview !== null} onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t("profiles.import.title")}</DialogTitle>
        <DialogDescription>{t("profiles.import.description")}</DialogDescription>
      </DialogHeader>

      {preview && (
        <div className="flex flex-col gap-4">
          {preview.migrated && (
            <div>
              <MigratedBadge />
            </div>
          )}

          {firmwareWarn && (
            <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-status-warning">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="text-xs font-semibold">
                  {t("profiles.firmwareWarn.title")}
                </p>
                <p className="mt-0.5 text-xs">
                  {t("profiles.firmwareWarn.description", {
                    profileFw: preview.doc.firmwareVersion ?? "",
                    deviceFw: deviceFw ?? "",
                  })}
                </p>
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("profiles.import.previewTitle")}
            </p>
            <ProfileDiff before={activeSettings} after={preview.doc.settings} />
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("profiles.import.cancel")}
        </Button>
        <Button onClick={onConfirm}>
          <Check />
          {t("profiles.import.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function ProfilesPage() {
  const { t } = useTranslation();

  const profiles = useProfilesStore((s) => s.profiles);
  const activeSettings = useProfilesStore((s) => s.activeSettings);
  const selectedId = useProfilesStore((s) => s.selectedId);
  const appliedId = useProfilesStore((s) => s.appliedId);
  const selectProfile = useProfilesStore((s) => s.selectProfile);
  const applyProfile = useProfilesStore((s) => s.applyProfile);
  const saveCurrentAsProfile = useProfilesStore((s) => s.saveCurrentAsProfile);
  const deleteProfile = useProfilesStore((s) => s.deleteProfile);
  const renameProfile = useProfilesStore((s) => s.renameProfile);
  const persistError = useProfilesStore((s) => s.persistError);
  const clearPersistError = useProfilesStore((s) => s.clearPersistError);

  // Firmware of the connected device (if any) for the import compat check.
  const deviceFw = useDeviceStore((s) => s.device?.firmwareVersion);

  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [tab, setTab] = useState<ProfilesTab>("saved");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatus>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? null,
    [profiles, selectedId]
  );

  const isApplied = selected !== null && selected.id === appliedId;

  /** Stage a parsed document into the shared import preview dialog. */
  const handleImportPreview = (doc: ElrspDocument, migrated: boolean) => {
    setImportError(null);
    setImportPreview({ doc, migrated });
  };

  /** Community-import path: resolve the raw preset and open the same preview. */
  const handleImportPreset = (presetId: string) => {
    const { doc, migrated } = loadCommunityPresetForImport(presetId);
    handleImportPreview(doc, migrated);
  };

  /** File-import path: read + migrate the chosen `.elrsp`, then open the preview. */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires `change` again.
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const { doc, migrated } = migrateElrsp(JSON.parse(text));
      handleImportPreview(doc, migrated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An unknown future schema version is a distinct, friendlier message.
      setImportError(
        message.includes("unsupported schema version")
          ? t("profiles.import.unsupportedVersion")
          : t("profiles.import.parseError", { message })
      );
    }
  };

  /** Confirm the staged import: persist via the store, then jump to it. */
  const handleConfirmImport = () => {
    if (!importPreview) return;
    const id = useProfilesStore.getState().importProfile(importPreview.doc);
    setImportPreview(null);
    setTab("saved");
    selectProfile(id);
  };

  /**
   * Export the selected profile as an `.elrsp` file — through the native save
   * dialog under Tauri (v3.0.3: the `<a download>` this replaced landed in the
   * process cwd on WebKitGTK), falling back to a browser download elsewhere.
   * The outcome is always stated; a cancel states nothing, which is correct.
   */
  const handleExport = async () => {
    if (!selected) return;
    setExportStatus(null);
    try {
      const result = await saveExportedFile({
        contents: serializeElrsp(profileToElrsp(selected, t)),
        defaultName: t("profiles.export.filename", {
          name: profileName(selected, t),
        }),
        mimeType: "application/json",
        dialogTitle: t("profiles.export.dialogTitle"),
        filterName: t("profiles.export.filterName"),
        extensions: ["elrsp"],
      });
      if (result.outcome === "saved") {
        setExportStatus({ kind: "saved", path: result.path });
      }
    } catch (e) {
      setExportStatus({ kind: "failed", detail: exportErrorDetail(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* A genuine disk write/delete failure (never the non-Tauri case). */}
      {persistError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="flex-1 text-xs">{t(persistError)}</p>
          <button
            type="button"
            onClick={clearPersistError}
            aria-label={t("profiles.errors.dismiss")}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-foreground">
          {t("profiles.title")}
        </h1>

        <div className="flex items-center gap-3">
          {/* Segmented control: Saved vs Community */}
          <div
            role="tablist"
            aria-label={t("profiles.title")}
            className="inline-flex rounded-md border border-border bg-muted p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "saved"}
              onClick={() => setTab("saved")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                tab === "saved"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("profiles.tabs.saved")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "community"}
              onClick={() => setTab("community")}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                tab === "community"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("profiles.tabs.community")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "folder"}
              onClick={() => setTab("folder")}
              data-testid="profiles-tab-folder"
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                tab === "folder"
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("profiles.tabs.folder")}
            </button>
          </div>

          {/* Import a profile from an .elrsp file */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload />
            {t("profiles.import.button")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".elrsp,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      {importError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="text-xs">{importError}</p>
        </div>
      )}

      {/* Where the `.elrsp` went, or why it didn't (v3.0.3). Same inline
          status/error convention as the import error above and folder sync. */}
      {exportStatus?.kind === "saved" && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-good/40 bg-status-good/10 p-3"
          data-testid="profiles-export-status"
        >
          <Check
            className="mt-0.5 h-4 w-4 shrink-0 text-status-good"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">
              {t("profiles.export.savedTitle")}
            </p>
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {exportStatus.path}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExportStatus(null)}
            aria-label={t("profiles.export.dismiss")}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {exportStatus?.kind === "failed" && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
          data-testid="profiles-export-error"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">
              {t("profiles.export.failedTitle")}
            </p>
            <p className="mt-0.5 break-words font-mono text-[11px] opacity-80">
              {exportStatus.detail}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExportStatus(null)}
            aria-label={t("profiles.export.dismiss")}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {tab === "community" && (
        <CommunityPresets onImport={handleImportPreset} />
      )}

      {/* M71: opt-in, entirely inert until the user picks a folder. */}
      {tab === "folder" && <FolderSync />}

      <div
        className={`grid grid-cols-1 gap-4 lg:grid-cols-3 ${
          tab !== "saved" ? "hidden" : ""
        }`}
      >
        {/* Left: profile list */}
        <Card className="lg:col-span-1">
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-primary" />
              {t("profiles.list.title")}
            </CardTitle>
            <Button size="sm" onClick={() => setDialogMode("save")}>
              <Plus />
              {t("profiles.actions.saveAs")}
            </Button>
          </CardHeader>
          <CardContent>
            <ProfileList
              profiles={profiles}
              selectedId={selectedId}
              appliedId={appliedId}
              onSelect={selectProfile}
            />
          </CardContent>
        </Card>

        {/* Right: detail + diff */}
        <div className="lg:col-span-2">
          {selected ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      {profileName(selected, t)}
                    </CardTitle>
                    {profileDescription(selected, t) && (
                      <CardDescription className="mt-1">
                        {profileDescription(selected, t)}
                      </CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={isApplied}
                      onClick={() => applyProfile(selected.id)}
                    >
                      <Check />
                      {isApplied
                        ? t("profiles.actions.applied")
                        : t("profiles.actions.apply")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleExport()}
                      data-testid="profiles-export-btn"
                    >
                      <Download />
                      {t("profiles.export.button")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={selected.builtin}
                      onClick={() => setDialogMode("rename")}
                    >
                      <Pencil />
                      {t("profiles.actions.rename")}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={selected.builtin}
                      onClick={() => deleteProfile(selected.id)}
                    >
                      <Trash2 />
                      {t("profiles.actions.delete")}
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="flex flex-col gap-5">
                {/* Diff vs current device config — THE key view */}
                <div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t("profiles.diff.subtitle")}
                  </p>
                  <ProfileDiff before={activeSettings} after={selected.settings} />
                </div>

                <Separator />

                {/* Full settings of the selected profile */}
                <div>
                  <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {t("profiles.settings.title")}
                  </h3>
                  <SettingsTable settings={selected.settings} />
                </div>
              </CardContent>
            </Card>
          ) : (
            <EmptyState
              icon={Save}
              title={t("profiles.empty.title")}
              description={t("profiles.empty.description")}
              className="h-full"
            />
          )}
        </div>
      </div>

      <ProfileFormDialog
        // Remount per open so the form re-seeds from the current target.
        key={`${dialogMode}-${selectedId ?? "none"}`}
        mode={dialogMode}
        initialName={
          dialogMode === "rename" && selected ? profileName(selected, t) : ""
        }
        initialDescription={
          dialogMode === "rename" && selected
            ? profileDescription(selected, t)
            : ""
        }
        onClose={() => setDialogMode(null)}
        onSubmit={(name, description) => {
          if (dialogMode === "save") {
            saveCurrentAsProfile(name, description || undefined);
          } else if (dialogMode === "rename" && selected) {
            renameProfile(selected.id, name, description || undefined);
          }
          setDialogMode(null);
        }}
      />

      <ImportPreviewDialog
        preview={importPreview}
        activeSettings={activeSettings}
        deviceFw={deviceFw}
        onConfirm={handleConfirmImport}
        onClose={() => setImportPreview(null)}
      />

    </div>
  );
}
