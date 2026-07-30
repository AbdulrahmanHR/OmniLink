import { useTranslation } from "react-i18next";
import { CircuitBoard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  bridgeFamilyLabelKey,
  isBridgeCandidate,
  isLabeledBridge,
} from "@/lib/bridge";
import type { BridgeClassificationDto } from "@/lib/tauri";

/**
 * The "Flight Controller Bridge" label (M63) — UNMISTAKABLY distinct from a
 * direct ELRS device, a WiFi ELRS device and a Backpack device. It uses the
 * {@link Badge} primitive with a dedicated `CircuitBoard` icon (used by no other
 * device kind) and a distinct violet tint, and renders the FC family
 * (Betaflight / iNav / Unsupported bridge) plus the raw FC variant id.
 *
 * The flight controller is a passthrough bridge ENDPOINT only, never a managed
 * device — this label never implies it is connected/managed like an ELRS device.
 *
 * Renders `null` for a `notAController` classification (the caller shows recovery
 * guidance instead).
 */
export function BridgeLabel({
  classification,
}: {
  classification: BridgeClassificationDto;
}) {
  const { t } = useTranslation();

  // A non-controller is not labeled — the caller shows recovery guidance instead.
  // The shared predicate (see `@/lib/bridge`) also narrows away `notAController`.
  if (!isLabeledBridge(classification)) return null;

  const isSupported = isBridgeCandidate(classification);
  const family = isSupported ? classification.family : "unknown";
  const familyLabel = t(bridgeFamilyLabelKey(family));
  // The raw 4-char FC id ("BTFL"/"INAV", or the unsupported variant from `reason`).
  const variantId =
    classification.kind === "bridge"
      ? classification.fcVariant
      : classification.reason;
  const fcVersion =
    classification.kind === "bridge" ? classification.fcVersion : null;

  return (
    <Badge
      variant={isSupported ? "outline" : "warning"}
      data-testid="bridge-label"
      className={cn(
        "whitespace-nowrap",
        // Distinct violet tint for a supported bridge — not green (ELRS/mDNS),
        // amber (WiFi AP), red, or copper (Backpack/primary). Unsupported uses
        // the shared `warning` variant.
        isSupported &&
          "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400"
      )}
      aria-label={t("bridge.a11y.label", {
        family: familyLabel,
        id: variantId,
      })}
    >
      <CircuitBoard className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="font-medium">{t("bridge.label")}</span>
      <span
        data-testid="bridge-family"
        className="rounded border border-current px-1 py-0 text-[10px] font-semibold uppercase tracking-wide"
      >
        {familyLabel}
      </span>
      {variantId ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {variantId}
        </span>
      ) : null}
      {fcVersion ? (
        <span className="text-[10px] text-muted-foreground">v{fcVersion}</span>
      ) : null}
    </Badge>
  );
}
