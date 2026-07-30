import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { useBridgeStore, usePassthroughStore } from "@/stores";
import { aiPreviewPayload } from "@/lib/ai";
import {
  coarseOs,
  prepareBridgeReportMarkdown,
  type BridgeReportSources,
} from "@/lib/bridgeExport";

/**
 * M66 — one-click "Copy Report" for a bridge passthrough failure. Mirrors the
 * v2.0 diagnostics copy recipe ({@link import("@/components/diagnostics/FindingsList").FindingsList}):
 * a transient `copied` state with a 1.5s reset, a `Copy`→`Check` icon swap, a
 * `data-testid`, an `aria-label`, and `navigator.clipboard?.writeText`.
 *
 * On click it assembles a {@link BridgeReportSources} snapshot from the
 * passthrough + bridge stores plus the app version/coarse OS, routes the bridge
 * context through `sanitize_context()` (via `aiPreviewPayload`) so identifiers are
 * stripped, builds paste-friendly Markdown, and copies it. Rendered only when a
 * passthrough report exists or attempts have been logged — the export is a SUPPORT
 * artifact for a failed (or completed) check, never a management surface.
 */
export function BridgeExport({ port }: { port: string }) {
  const { t } = useTranslation();
  const report = usePassthroughStore((s) => s.report);
  const error = usePassthroughStore((s) => s.error);
  const passthroughPort = usePassthroughStore((s) => s.port);
  const log = usePassthroughStore((s) => s.log);
  const classification = useBridgeStore((s) => s.classification);
  const context = useBridgeStore((s) => s.context);
  const bridgePort = useBridgeStore((s) => s.port);

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const handleCopy = useCallback(async () => {
    // Coarse environment only — no machine identifiers, guarded off-Tauri.
    const appVersion = isTauri() ? await getVersion().catch(() => null) : null;
    const os = coarseOs(
      typeof navigator !== "undefined" ? navigator.userAgent : null
    );
    const sources: BridgeReportSources = {
      generatedAt: Date.now(),
      appVersion,
      os,
      port: passthroughPort ?? bridgePort ?? port,
      report,
      error,
      classification,
      context,
    };
    const markdown = await prepareBridgeReportMarkdown(
      sources,
      (ctx) => aiPreviewPayload(ctx),
      t
    );
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) return;
    await clipboard.writeText(markdown);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [
    report,
    error,
    classification,
    context,
    passthroughPort,
    bridgePort,
    port,
    t,
  ]);

  // Only meaningful once there is a report to summarize or a logged attempt.
  if (!report && log.length === 0) return null;

  return (
    <div className="mt-3 flex justify-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="bridge-export-copy"
        onClick={() => void handleCopy()}
        aria-label={
          copied ? t("bridge.export.copied") : t("bridge.export.copyAria")
        }
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? t("bridge.export.copied") : t("bridge.export.copy")}
      </Button>
    </div>
  );
}
