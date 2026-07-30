import * as React from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SourceCitations } from "@/components/ai/SourceCitations";
import {
  debugRetrieve,
  getRetrievalIndex,
  retrieve,
  RELEVANCE_THRESHOLD,
  type RetrievalDebug,
  type RetrievalResult,
} from "@/lib/knowledge";

/**
 * Retrieval debug surface (M50). A local "test retrieval" box: type an
 * ExpressLRS question, run it through the SAME local BM25 pipeline the assistant
 * uses, and see (a) the citation cards that would attach to an answer and (b) a
 * per-chunk debug table (score + matched terms + why-selected). Makes the M50
 * acceptance ("the UI renders citations") demonstrable and e2e-testable, and
 * gives an evaluation surface for "why was this chunk selected?".
 *
 * Local-only — nothing is sent; the index is built from the bundled trusted
 * packs. Unobtrusive: collapsed by default behind a details/summary toggle.
 * Every string via `t()`; the query input is labelled and results are announced
 * with a labelled table + `aria-label`s.
 */

/** Format a normalized [0,1] score as a whole-percent. */
function pct(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export function RetrievalDebugPanel() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [result, setResult] = React.useState<RetrievalResult | null>(null);
  const [debug, setDebug] = React.useState<RetrievalDebug | null>(null);

  const percentFmt = React.useMemo(
    () => new Intl.NumberFormat(i18n.language, { style: "percent" }),
    [i18n.language],
  );

  const run = React.useCallback(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResult(null);
      setDebug(null);
      return;
    }
    const index = getRetrievalIndex();
    setResult(retrieve(trimmed, index));
    setDebug(debugRetrieve(trimmed, index));
  }, [query]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    run();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" aria-hidden="true" />
          <CardTitle>{t("settings.knowledge.debug.title")}</CardTitle>
        </div>
        <CardDescription>
          {t("settings.knowledge.debug.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="space-y-2">
          <Label htmlFor="retrieval-debug-query">
            {t("settings.knowledge.debug.queryLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="retrieval-debug-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.knowledge.debug.queryPlaceholder")}
              autoComplete="off"
            />
            <Button type="submit" variant="outline" size="sm">
              <Search className="h-4 w-4" aria-hidden="true" />
              {t("settings.knowledge.debug.run")}
            </Button>
          </div>
        </form>

        {result === null || debug === null ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.knowledge.debug.noQuery")}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">
                {t("settings.knowledge.debug.topScore", {
                  percent: pct(result.topScore),
                })}
              </Badge>
              <Badge variant="outline">
                {t("settings.knowledge.debug.threshold", {
                  percent: Math.round(RELEVANCE_THRESHOLD * 100),
                })}
              </Badge>
              {debug.terms.length > 0 && (
                <span>
                  {t("settings.knowledge.debug.terms", {
                    terms: debug.terms.join(", "),
                  })}
                </span>
              )}
            </div>

            <SourceCitations
              citations={result.chunks}
              noSourceFound={result.noSourceFound}
            />

            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-foreground">
                {t("settings.knowledge.debug.tableToggle")}
              </summary>
              <div className="overflow-x-auto px-3 pb-3">
                <table className="w-full text-left text-xs">
                  <caption className="sr-only">
                    {t("settings.knowledge.debug.tableCaption")}
                  </caption>
                  <thead>
                    <tr className="text-muted-foreground">
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t("settings.knowledge.debug.colChunk")}
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t("settings.knowledge.debug.colScore")}
                      </th>
                      <th scope="col" className="py-1 pr-3 font-medium">
                        {t("settings.knowledge.debug.colTerms")}
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        {t("settings.knowledge.debug.colSelected")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {debug.chunks.map((c) => (
                      <tr key={c.chunkId} className="border-t border-border/50">
                        <th
                          scope="row"
                          className="py-1 pr-3 font-normal text-foreground"
                        >
                          {c.chunkId}
                        </th>
                        <td className="py-1 pr-3 tabular-nums">
                          {percentFmt.format(c.score)}
                        </td>
                        <td className="py-1 pr-3">
                          {c.matchedTerms.join(" ") || "—"}
                        </td>
                        <td className="py-1">
                          {c.selected ? (
                            <Badge variant="good">
                              {t("settings.knowledge.debug.selected")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("settings.knowledge.debug.belowThreshold")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
