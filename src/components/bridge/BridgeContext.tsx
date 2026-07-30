import { useTranslation } from "react-i18next";
import { CircuitBoard, Cable, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useBridgeStore } from "@/stores";
import {
  bridgeFamilyLabelKey,
  bridgePortFunctionLabelKey,
  isBridgeContextEmpty,
} from "@/lib/bridge";

/**
 * The READ-ONLY controller-context surface (M65). DISPLAY-ONLY: it shows ONLY the
 * fields relevant to ELRS passthrough troubleshooting — FC family, FC/firmware and
 * API version, and coarse serial-port metadata (which UART is a serial-RX port) —
 * fetched over read-only MSP GET queries.
 *
 * There is NOTHING here that edits controller configuration: no inputs that write
 * to the flight controller, no settings, no "Controllers" management. The only
 * action is a read-only re-fetch. When no context is available (no controller
 * answered, or the serial config was unparseable) it renders the shared
 * {@link EmptyState} "Not enough controller context".
 */
export function BridgeContext({ port }: { port: string }) {
  const { t } = useTranslation();
  const { context, contextStatus, fetchContext } = useBridgeStore();

  const isFetching = contextStatus === "fetching";
  const showEmpty = isBridgeContextEmpty(context);

  return (
    <section
      data-testid="bridge-context"
      aria-label={t("bridge.context.a11y.surface")}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <CircuitBoard className="h-3.5 w-3.5" aria-hidden="true" />
          {t("bridge.context.title")}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void fetchContext(port)}
          disabled={isFetching}
          aria-label={t("bridge.context.a11y.fetch", { port })}
        >
          {isFetching ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t("bridge.context.fetching")}
            </>
          ) : (
            <>
              <CircuitBoard aria-hidden="true" />
              {t("bridge.context.fetch")}
            </>
          )}
        </Button>
      </div>

      {showEmpty || !context ? (
        <EmptyState
          icon={CircuitBoard}
          title={t("bridge.context.empty")}
          description={t("bridge.context.emptyHint")}
          className="py-10"
        />
      ) : (
        <dl
          data-testid="bridge-context-fields"
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
        >
          <dt className="text-muted-foreground">{t("bridge.context.family")}</dt>
          <dd className="font-medium text-foreground">
            {t(bridgeFamilyLabelKey(context.family))}
            {context.fcVariant ? (
              <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                {context.fcVariant}
              </span>
            ) : null}
          </dd>

          {context.fcVersion ? (
            <>
              <dt className="text-muted-foreground">
                {t("bridge.context.version")}
              </dt>
              <dd className="font-mono text-foreground">{context.fcVersion}</dd>
            </>
          ) : null}

          {context.apiVersion ? (
            <>
              <dt className="text-muted-foreground">
                {t("bridge.context.apiVersion")}
              </dt>
              <dd className="font-mono text-foreground">{context.apiVersion}</dd>
            </>
          ) : null}

          <dt className="text-muted-foreground">
            {t("bridge.context.serialPorts")}
          </dt>
          <dd className="text-foreground">
            {context.serialPorts.length === 0 ? (
              <span className="text-muted-foreground">
                {t("bridge.context.noSerialPorts")}
              </span>
            ) : (
              <ul
                data-testid="bridge-context-ports"
                aria-label={t("bridge.context.a11y.serialPorts")}
                className="flex flex-col gap-0.5"
              >
                {context.serialPorts.map((p, i) => {
                  const fnKey = bridgePortFunctionLabelKey(p.function);
                  return (
                    <li
                      key={`${p.identifier}-${i}`}
                      className="flex items-center gap-1.5"
                    >
                      <Cable
                        className="h-3 w-3 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="font-mono">{p.identifier}</span>
                      {fnKey ? (
                        <span className="rounded border border-current px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t(fnKey)}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
        </dl>
      )}
    </section>
  );
}
