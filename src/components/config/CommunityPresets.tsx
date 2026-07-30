import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Search, Cpu } from "lucide-react";
import {
  COMMUNITY_PRESETS,
  searchPresets,
  type CommunityPreset,
} from "@/lib/communityPresets";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

interface CommunityPresetsProps {
  /** Open the import preview for the given preset id (wired by the page). */
  onImport: (presetId: string) => void;
}

/**
 * Read-only community preset browser (FR-CFG-04). Search filters the bundled
 * catalog; each entry can be imported into the user's saved profiles via the
 * shared import-preview flow. Intentionally carries NO upload / account / edit /
 * network affordance — the catalog is static and bundled.
 */
export function CommunityPresets({ onImport }: CommunityPresetsProps) {
  const { t } = useTranslation();
  const searchId = useId();
  const [query, setQuery] = useState("");

  const results = useMemo(
    () => searchPresets(COMMUNITY_PRESETS, query),
    [query]
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          {t("profiles.community.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("profiles.community.description")}
        </p>
      </div>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("profiles.community.searchPlaceholder")}
          aria-label={t("profiles.community.searchAria")}
          className="pl-9"
        />
      </div>

      {results.length === 0 ? (
        <EmptyState
          icon={Search}
          title={t("profiles.community.empty.title")}
          description={t("profiles.community.empty.description")}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {results.map((preset) => (
            <li key={preset.id}>
              <PresetRow preset={preset} onImport={onImport} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PresetRow({
  preset,
  onImport,
}: {
  preset: CommunityPreset;
  onImport: (presetId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {preset.name}
            </span>
            <Badge variant="default">
              {t(`profiles.community.categories.${preset.category}`)}
            </Badge>
          </div>

          <p className="mt-1 text-sm text-muted-foreground">
            {preset.description}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {preset.firmwareVersion && (
              <Badge variant="outline">
                <Cpu className="h-3 w-3" aria-hidden="true" />
                {preset.firmwareVersion}
              </Badge>
            )}
            {preset.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <Button size="sm" onClick={() => onImport(preset.id)}>
          <Download />
          {t("profiles.community.import")}
        </Button>
      </CardContent>
    </Card>
  );
}
