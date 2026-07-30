import { MapPin, Satellite } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { gpsHasFix } from "@/lib/telemetry-crsf";
import type { GpsReading } from "@/stores/telemetry";

/** Pre-translated labels for the GPS readout (i18n stays in the page). */
export interface GpsReadoutLabels {
  title: string;
  latitude: string;
  longitude: string;
  satellites: string;
  altitude: string;
  groundSpeed: string;
  heading: string;
  /** Shown when the device reports no GPS module at all. */
  noModule: string;
  /** Shown when a GPS module is present but has not locked a fix yet. */
  noFix: string;
}

interface GpsReadoutProps {
  /** Latest decoded GPS fix, or `null` when the device has no GPS. */
  gps: GpsReading | null;
  labels: GpsReadoutLabels;
}

/** A single label/value pair inside the readout grid. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-sm tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

/**
 * GPS metric readout for the telemetry dashboard (M11).
 *
 * Degrades gracefully: with no GPS module the card shows a muted hint instead
 * of a bogus `0,0`; with a module present but no lock yet it shows the satellite
 * count and an "acquiring" note in place of coordinates.
 */
export function GpsReadout({ gps, labels }: GpsReadoutProps) {
  const hasFix = gpsHasFix(gps);

  return (
    <Card className="flex flex-col gap-2 p-4">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <MapPin
            className={
              hasFix
                ? "h-4 w-4 text-status-good"
                : "h-4 w-4 text-muted-foreground"
            }
          />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!gps ? (
          <p className="text-sm text-muted-foreground">{labels.noModule}</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Field
              label={labels.latitude}
              value={hasFix ? gps.latitude.toFixed(6) + "°" : labels.noFix}
            />
            <Field
              label={labels.longitude}
              value={hasFix ? gps.longitude.toFixed(6) + "°" : labels.noFix}
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {labels.satellites}
              </span>
              <span className="flex items-center gap-1 font-mono text-sm tabular-nums text-foreground">
                <Satellite className="h-3.5 w-3.5 text-muted-foreground" />
                {gps.satellites}
              </span>
            </div>
            {hasFix && (
              <>
                <Field
                  label={labels.altitude}
                  value={`${gps.altitude.toFixed(0)} m`}
                />
                <Field
                  label={labels.groundSpeed}
                  value={`${gps.groundSpeed.toFixed(1)} km/h`}
                />
                <Field
                  label={labels.heading}
                  value={`${gps.heading.toFixed(0)}°`}
                />
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
