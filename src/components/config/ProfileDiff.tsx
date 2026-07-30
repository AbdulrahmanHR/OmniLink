import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { diffProfiles, type DiffRow, type DiffStatus } from "@/lib/profileDiff";
import {
  SETTING_FIELD_BY_KEY,
  formatSettingValue,
  type ProfileSettings,
} from "@/lib/profileSettings";

interface ProfileDiffProps {
  /** Baseline — the device's current/active config. */
  before: ProfileSettings;
  /** Candidate — the selected profile being previewed. */
  after: ProfileSettings;
}

/** Text color token per diff status. */
const statusText: Record<Exclude<DiffStatus, "unchanged">, string> = {
  changed: "text-status-warning",
  added: "text-status-good",
  removed: "text-status-critical",
};

/** Left accent + tint per diff status. */
const statusAccent: Record<Exclude<DiffStatus, "unchanged">, string> = {
  changed: "border-l-status-warning bg-status-warning/5",
  added: "border-l-status-good bg-status-good/5",
  removed: "border-l-status-critical bg-status-critical/5",
};

function ValueChip({
  text,
  unit,
  className,
}: {
  text: string;
  unit?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span className="font-mono text-sm">{text}</span>
      {/* Unit inherits the chip's (status-toned) color at full opacity — the
          former `opacity-70` dropped the small text below WCAG AA contrast on
          the tinted diff rows (axe `color-contrast`). */}
      {unit && <span className="font-mono text-xs">{unit}</span>}
    </span>
  );
}

function ChangedRow({ row }: { row: DiffRow }) {
  const { t } = useTranslation();
  const meta = SETTING_FIELD_BY_KEY[row.key];
  const status = row.status as Exclude<DiffStatus, "unchanged">;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-l-2 px-3 py-2 transition-colors",
        statusAccent[status]
      )}
    >
      <span className="text-sm text-foreground">{t(meta.labelKey)}</span>
      <div className="flex items-center gap-2">
        <ValueChip
          text={formatSettingValue(row.before, meta, t)}
          unit={row.before === undefined ? undefined : meta.unit}
          className="text-muted-foreground line-through decoration-muted-foreground/40"
        />
        <ArrowRight className={cn("h-3.5 w-3.5 shrink-0", statusText[status])} />
        <ValueChip
          text={formatSettingValue(row.after, meta, t)}
          unit={row.after === undefined ? undefined : meta.unit}
          className={cn("font-semibold", statusText[status])}
        />
      </div>
    </div>
  );
}

function UnchangedRow({ row }: { row: DiffRow }) {
  const { t } = useTranslation();
  const meta = SETTING_FIELD_BY_KEY[row.key];
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-1.5">
      <span className="text-sm text-muted-foreground">{t(meta.labelKey)}</span>
      <ValueChip
        text={formatSettingValue(row.after, meta, t)}
        unit={meta.unit}
        className="text-muted-foreground"
      />
    </div>
  );
}

/**
 * Diffs the active config (before) against the selected profile (after) and
 * renders changed rows (before → after, color-coded by status token) plus a
 * collapsible list of unchanged rows. Re-renders whenever its props change, so
 * selecting a different profile visibly updates the view.
 */
export function ProfileDiff({ before, after }: ProfileDiffProps) {
  const { t } = useTranslation();
  const [showUnchanged, setShowUnchanged] = useState(false);

  const { rows, changeCount, identical } = useMemo(
    () => diffProfiles(before, after),
    [before, after]
  );

  const changed = rows.filter((r) => r.status !== "unchanged");
  const unchanged = rows.filter((r) => r.status === "unchanged");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("profiles.diff.title")}
        </span>
        {identical ? (
          <Badge variant="good">
            <CheckCircle2 className="h-3 w-3" />
            {t("profiles.diff.noChanges")}
          </Badge>
        ) : (
          <Badge variant="warning">
            {t("profiles.diff.changeCount", { count: changeCount })}
          </Badge>
        )}
      </div>

      {identical ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-10 text-center">
          <CheckCircle2 className="h-6 w-6 text-status-good" />
          <p className="text-sm text-muted-foreground">
            {t("profiles.diff.identical")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="divide-y divide-border">
            {changed.map((row) => (
              <ChangedRow key={row.key} row={row} />
            ))}
          </div>
        </div>
      )}

      {unchanged.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => setShowUnchanged((v) => !v)}
            aria-expanded={showUnchanged}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40"
          >
            {showUnchanged ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {t("profiles.diff.unchanged", { count: unchanged.length })}
          </button>
          {showUnchanged && (
            <div className="divide-y divide-border border-t border-border">
              {unchanged.map((row) => (
                <UnchangedRow key={row.key} row={row} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
