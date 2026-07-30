import * as React from "react";
import { useTranslation } from "react-i18next";
import { FileText, FileUp, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useKnowledgeStore } from "@/stores";
import {
  isTauri,
  MAX_IMPORTED_DOCS,
  pathBasename,
  pickImportedDocPath,
  readImportedDoc,
  type ImportedSource,
  type ImportRejectReason,
} from "@/lib/knowledge";

/** All the ways an import can fail — a store reject reason, or a read failure. */
type ImportError = ImportRejectReason | "read";

/** i18n key for an import error. */
function errorKey(reason: ImportError): string {
  switch (reason) {
    case "extension":
      return "settings.knowledge.import.errors.extension";
    case "too-large":
      return "settings.knowledge.import.errors.tooLarge";
    case "empty":
      return "settings.knowledge.import.errors.empty";
    case "limit":
      return "settings.knowledge.import.errors.limit";
    case "read":
      return "settings.knowledge.import.errors.read";
  }
}

/**
 * The "user-provided · not official" badge (M52). Deliberately styled with the
 * WARNING variant + a shield-alert icon so it can NEVER be mistaken for a trusted
 * source's `good`/`default` badge. The label is a translated string.
 */
function UntrustedBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="warning" title={t("knowledge.import.untrustedAria")}>
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {t("knowledge.import.untrustedLabel")}
    </Badge>
  );
}

/**
 * One imported-source row: title + untrusted badge + delete. Enable/disable is
 * NOT here — it became per-conversation (M52 per-chat) and lives in the chat's
 * "Sources for this chat" control; this Settings panel manages the library
 * (import/remove) globally.
 */
function ImportedRow({ source }: { source: ImportedSource }) {
  const { t } = useTranslation();
  const deleteImportedSource = useKnowledgeStore((s) => s.deleteImportedSource);

  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{source.title}</span>
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <UntrustedBadge />
            <Badge variant="outline">
              {t("settings.knowledge.import.sections", {
                count: source.chunks.length,
              })}
            </Badge>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t("settings.knowledge.import.deleteAria", {
            title: source.title,
          })}
          onClick={() => deleteImportedSource(source.id)}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/**
 * User-imported docs panel (M52, D18). Import a LOCAL `.txt`/`.md` note, list
 * each imported source with a clearly-distinct **user-provided · not official**
 * badge (never styled like a trusted source) and a delete button. Everything is
 * offline + account-free: files are read via the
 * native `knowledge_read_doc` seam (or the browser File API in dev) and NEVER
 * uploaded.
 *
 * Imported docs join the SAME retrieval index + `<retrieved_docs untrusted>`
 * fence as trusted packs, so nothing an imported doc says can escalate its trust
 * or change hardware config. Every string goes through `t()`; icon-only controls
 * carry `aria-label`s.
 *
 * This panel manages the library globally (import / remove). Enabling or
 * disabling a source for grounding is per-conversation (M52 per-chat) and lives
 * in the chat's "Sources for this chat" control, not here.
 */
export function ImportPanel() {
  const { t } = useTranslation();
  const importedSources = useKnowledgeStore((s) => s.importedSources);
  const importDoc = useKnowledgeStore((s) => s.importDoc);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ImportError | null>(null);

  const atLimit = importedSources.length >= MAX_IMPORTED_DOCS;

  const applyImport = React.useCallback(
    (fileName: string, content: string) => {
      const result = importDoc(fileName, content);
      setError(result.ok ? null : result.reason);
    },
    [importDoc],
  );

  // Native pick (Tauri) vs. hidden <input type=file> (browser/dev).
  const onImportClick = React.useCallback(async () => {
    setError(null);
    if (!isTauri()) {
      inputRef.current?.click();
      return;
    }
    setBusy(true);
    try {
      const path = await pickImportedDocPath({
        title: t("settings.knowledge.import.dialogTitle"),
        filterName: t("settings.knowledge.import.dialogFilter"),
      });
      if (path === null) return; // cancelled
      const content = await readImportedDoc(path);
      applyImport(pathBasename(path), content);
    } catch {
      setError("read");
    } finally {
      setBusy(false);
    }
  }, [applyImport, t]);

  // Browser/dev fallback: read the picked File with the File API.
  const onInputChange = React.useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-picking the same file fires onChange again.
      e.target.value = "";
      if (!file) return;
      setError(null);
      setBusy(true);
      try {
        const content = await file.text();
        applyImport(file.name, content);
      } catch {
        setError("read");
      } finally {
        setBusy(false);
      }
    },
    [applyImport],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileUp className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle>{t("settings.knowledge.import.title")}</CardTitle>
        </div>
        <CardDescription>
          {t("settings.knowledge.import.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("settings.knowledge.import.addAria")}
            disabled={busy || atLimit}
            onClick={() => void onImportClick()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <FileUp className="h-4 w-4" aria-hidden="true" />
            )}
            {busy
              ? t("settings.knowledge.import.adding")
              : t("settings.knowledge.import.add")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("settings.knowledge.import.hint", { max: MAX_IMPORTED_DOCS })}
          </p>
          {/* Hidden native input for the browser/dev path. */}
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="sr-only"
            onChange={(e) => void onInputChange(e)}
            data-testid="knowledge-import-input"
            aria-hidden
            tabIndex={-1}
          />
        </div>

        {atLimit && (
          <p className="text-xs text-status-warning" role="status">
            {t("settings.knowledge.import.atLimit", { max: MAX_IMPORTED_DOCS })}
          </p>
        )}

        {error && (
          <p
            className="text-xs text-status-critical"
            role="alert"
            data-testid="knowledge-import-error"
          >
            {t(errorKey(error), { max: MAX_IMPORTED_DOCS })}
          </p>
        )}

        {importedSources.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t("settings.knowledge.import.empty.title")}
            description={t("settings.knowledge.import.empty.description")}
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {t("settings.knowledge.import.perChatHint")}
            </p>
            <ul className="flex flex-col gap-3">
              {importedSources.map((source) => (
                <ImportedRow key={source.id} source={source} />
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
