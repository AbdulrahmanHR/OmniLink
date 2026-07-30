import { useTranslation } from "react-i18next";
import { FlagOff, MapPin, MapPinned, Pause, Play, Square } from "lucide-react";
import type { ParsedLog } from "@/lib/blackbox";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useSessionStore, type SessionSpeed } from "@/stores/session";
import { cn } from "@/lib/utils";

/** The four selectable playback-speed multipliers. */
const SPEEDS: readonly SessionSpeed[] = [0.5, 1, 2, 4];

/** Seconds (relative to session start) for a sample index, formatted to 0.1s. */
function relSeconds(log: ParsedLog, index: number): string {
  const t0 = log.time[0] ?? 0;
  const ms = (log.time[index] ?? t0) - t0;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface SessionTransportProps {
  log: ParsedLog;
}

/**
 * Unified transport + scrubber for the Session Analysis page (v1.7.0).
 *
 * The ONE control over the single {@link useSessionStore} position index,
 * merging the former replay TransportControls (play/pause, stop, speed) and the
 * Logs LogScrubber (the scrub slider + mark-range) into a single bar. Dragging
 * the slider scrubs (`mode === "scrub"`); pressing play makes the same index
 * advance (`mode === "play"`). Both interaction modes drive the very same index,
 * so the dashboard gauges, the timeline charts, the flight-path map, and the
 * anomaly list all follow it in lockstep.
 */
export function SessionTransport({ log }: SessionTransportProps) {
  const { t } = useTranslation();
  const positionIndex = useSessionStore((s) => s.positionIndex);
  const mode = useSessionStore((s) => s.mode);
  const speed = useSessionStore((s) => s.speed);
  const selectionStart = useSessionStore((s) => s.selectionStart);
  const selectionEnd = useSessionStore((s) => s.selectionEnd);
  const seek = useSessionStore((s) => s.seek);
  const play = useSessionStore((s) => s.play);
  const pause = useSessionStore((s) => s.pause);
  const setSpeed = useSessionStore((s) => s.setSpeed);
  const markSelectionStart = useSessionStore((s) => s.markSelectionStart);
  const markSelectionEnd = useSessionStore((s) => s.markSelectionEnd);
  const clearSelection = useSessionStore((s) => s.clearSelection);

  const total = log.sampleCount;
  const last = Math.max(0, total - 1);
  const isPlaying = mode === "play";
  const atEnd = !isPlaying && positionIndex === last && total > 1;
  const hasSelection = selectionStart !== null || selectionEnd !== null;

  return (
    <Card data-testid="logs-scrubber">
      <CardHeader>
        <CardTitle>{t("simulator.transport.title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant={isPlaying ? "secondary" : "default"}
            disabled={total <= 1}
            aria-label={
              isPlaying
                ? t("simulator.transport.pause")
                : t("simulator.transport.play")
            }
            data-testid="simulator-playpause"
            onClick={() => (isPlaying ? pause() : play())}
          >
            {isPlaying ? <Pause aria-hidden /> : <Play aria-hidden />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={t("simulator.transport.stop")}
            title={t("simulator.transport.stop")}
            data-testid="simulator-stop"
            // Transport stop = halt-and-rewind: pause playback and return to the
            // first sample, keeping the session loaded (log stays non-null) and
            // the marked selection intact. Full teardown lives on the header
            // "Load another" control, not on this adjacent Square button.
            onClick={() => {
              pause();
              seek(0);
            }}
          >
            <Square aria-hidden />
          </Button>
          <div className="ml-1 flex flex-col">
            <span className="text-xs font-medium text-foreground tabular-nums">
              {t("simulator.transport.frame", {
                current: positionIndex + 1,
                total,
              })}
              <span className="ml-2 font-normal text-muted-foreground">
                {relSeconds(log, positionIndex)}
              </span>
            </span>
            {atEnd && (
              <span className="text-xs text-muted-foreground">
                {t("simulator.transport.endReached")}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="logs-scrubber-input" className="sr-only">
            {t("logs.scrubber.label")}
          </Label>
          <input
            id="logs-scrubber-input"
            data-testid="logs-scrubber-input"
            type="range"
            min={0}
            max={last}
            step={1}
            value={positionIndex}
            disabled={total <= 1}
            aria-label={t("logs.scrubber.label")}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="group"
            aria-label={t("simulator.transport.speed")}
            className="flex items-center gap-1"
          >
            <span className="mr-1 text-xs text-muted-foreground">
              {t("simulator.transport.speed")}
            </span>
            {SPEEDS.map((s) => {
              const active = s === speed;
              return (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  aria-pressed={active}
                  onClick={() => setSpeed(s)}
                  className={cn("tabular-nums", active && "font-semibold")}
                >
                  {t("simulator.transport.speedValue", { value: s })}
                </Button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={markSelectionStart}
            >
              <MapPin aria-hidden />
              {t("logs.scrubber.markStart")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={markSelectionEnd}
            >
              <MapPinned aria-hidden />
              {t("logs.scrubber.markEnd")}
            </Button>
            {hasSelection && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearSelection}
              >
                <FlagOff aria-hidden />
                {t("logs.scrubber.clear")}
              </Button>
            )}
          </div>
        </div>

        <p className="font-mono text-xs text-muted-foreground">
          {selectionStart !== null && selectionEnd !== null
            ? t("logs.scrubber.selection", {
                start: selectionStart,
                end: selectionEnd,
                startTime: relSeconds(log, selectionStart),
                endTime: relSeconds(log, selectionEnd),
              })
            : t("logs.scrubber.noSelection")}
        </p>
      </CardContent>
    </Card>
  );
}
