import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, FileSearch, ShieldAlert, ShieldCheck, SearchX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  isImportedSourceId,
  sourceTrustMap,
  type RetrievedChunk,
  type TrustLevel,
} from "@/lib/knowledge";

/**
 * RAG citation cards (M50). Renders the sources retrieved for an answer: per
 * source → title, a short excerpt, a relevance/confidence score, and a
 * trust-level badge (official vs OmniLink notes, reusing M49 trust metadata).
 * When `noSourceFound`, renders the D19 "no trusted source found" state instead
 * of a fabricated citation.
 *
 * Presentational + a11y-clean: a labelled list (`role="list"`), each card a
 * `role="listitem"` with `role="note"`; icons are `aria-hidden` and the score is
 * announced via an `aria-label`. Every string goes through `t()`.
 *
 * Wired into live chat answers by M51 (assistant responses render their trusted
 * sources through this component); also mountable standalone on the retrieval
 * debug surface, where the M50 acceptance is demonstrable.
 */

/** i18n key for a source's trust level (incl. the M52 user-imported label). */
function trustLabelKey(trustLevel: TrustLevel): string {
  switch (trustLevel) {
    case "official":
      return "ai.rag.trust.official";
    case "omnilink-notes":
      return "ai.rag.trust.omnilinkNotes";
    case "user-imported":
      return "knowledge.import.untrustedLabel";
  }
}

/** Badge variant per trust level — imported is WARNING, never a trusted style. */
function trustBadgeVariant(trustLevel: TrustLevel): "good" | "default" | "warning" {
  if (trustLevel === "official") return "good";
  if (trustLevel === "user-imported") return "warning";
  return "default";
}

/** Format a normalized [0,1] score as a whole-percent for display. */
function toPercent(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

export interface SourceCitationsProps {
  citations: RetrievedChunk[];
  noSourceFound?: boolean;
}

export function SourceCitations({
  citations,
  noSourceFound = false,
}: SourceCitationsProps) {
  const { t } = useTranslation();
  // Trust/title metadata is derived once from the allowlisted registry (M49).
  const trust = React.useMemo(() => sourceTrustMap(), []);

  if (noSourceFound || citations.length === 0) {
    return (
      <div
        role="note"
        aria-label={t("ai.rag.noSource.title")}
        className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
      >
        <SearchX
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">
            {t("ai.rag.noSource.title")}
          </span>
          <span>{t("ai.rag.noSource.description")}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <FileSearch className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
        {t("ai.rag.title")}
      </span>
      <ul
        role="list"
        aria-label={t("ai.rag.listLabel")}
        className="flex flex-col gap-1.5"
      >
        {citations.map((c) => {
          const info = trust[c.sourceId];
          // A cited IMPORTED source is ALWAYS labeled user-imported (it is not in
          // the trusted registry map) — never falls through to a trusted default.
          const trustLevel: TrustLevel = isImportedSourceId(c.sourceId)
            ? "user-imported"
            : (info?.trustLevel ?? "omnilink-notes");
          const isImported = trustLevel === "user-imported";
          const percent = toPercent(c.score);
          return (
            <li key={c.chunkId} role="listitem">
              <div
                role="note"
                aria-label={t("ai.rag.sourceLabel", { title: c.sourceTitle })}
                className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground"
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <BookOpen
                    className="h-3.5 w-3.5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <span className="font-medium text-foreground">
                    {c.sourceTitle}
                  </span>
                  <Badge
                    variant={trustBadgeVariant(trustLevel)}
                    title={
                      isImported ? t("knowledge.import.untrustedAria") : undefined
                    }
                  >
                    {isImported ? (
                      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                    )}
                    {t(trustLabelKey(trustLevel))}
                  </Badge>
                  <Badge
                    variant="outline"
                    aria-label={t("ai.rag.confidenceAria", { percent })}
                  >
                    {t("ai.rag.confidence", { percent })}
                  </Badge>
                </span>
                <span className="italic">{c.excerpt}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
