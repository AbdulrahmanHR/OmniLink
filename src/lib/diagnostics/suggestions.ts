/**
 * Pure conservative setup-suggestion rules (M40, v2.0.2).
 *
 * Maps the per-device {@link TrendReport} signals into a short list of practical,
 * conservative setup suggestions — antenna checks, telemetry-interval review,
 * packet-rate reconsideration, power-setting review, and wiring/power suspicion
 * (the five doc-mandated rules). Each suggestion carries a **confidence** that
 * clearly separates `measured` / `likely` / `worthChecking`, so the UI never
 * overstates a hunch.
 *
 * ## No contradiction with the M38 pattern guidance
 * Every trigger is chosen so a suggestion never contradicts the corresponding M38
 * pattern's "what to check first" copy shown on the same screen:
 *  - `gps-area-degradation` is ENVIRONMENTAL (its guidance is "note the location and
 *    avoid it") — it triggers NO setup suggestion, though it still appears in the
 *    trend card's repeated-events list;
 *  - `repeated-lq-drops` alone is "range or obstruction" — it does NOT imply wiring;
 *  - `wiring-power-suspicion` fires only on the intermittent-connection signature:
 *    `rssi-floor` AND `lq-collapse` both recurring on the device (the loose-antenna
 *    / wiring / power class the DL2 corpus models).
 *
 * ## Honest-mock contract
 * A suggestion is only ever derived from a real recurring trend: nothing fires
 * unless the underlying signal recurs in at least {@link MIN_SUGGESTION_SESSIONS}
 * of the device's sessions. There is no invented advice — an empty/quiet trend
 * report yields no suggestions.
 *
 * Everything here is **pure/deterministic** — no `Date.now`, no `Math.random`, no
 * I/O. `detail` carries non-identifying numbers only.
 */

import type { DeviceTrend, TrendReport } from "./trends";

/** Kebab id → camelCase i18n segment (`"antenna-check"` → `"antennaCheck"`). */
function camelId(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Confidence tiers, weakest→strongest are `worthChecking`→`measured`. */
export type SuggestionConfidence = "measured" | "likely" | "worthChecking";

/** The five conservative suggestion kinds (doc §M40). */
export type SuggestionId =
  | "antenna-check"
  | "telemetry-interval-review"
  | "packet-rate-reconsideration"
  | "power-setting-review"
  | "wiring-power-suspicion";

/** One derived, conservative setup suggestion for a device. */
export interface SetupSuggestion {
  /** Which suggestion this is. */
  id: SuggestionId;
  /** The device it applies to, or `null` for the unknown-device bucket. */
  deviceKey: string | null;
  /** How strongly the evidence supports it. */
  confidence: SuggestionConfidence;
  /** i18n key for the title (`diagnostics.suggestion.<camelId>.title`). */
  titleKey: string;
  /** i18n key for the body (rendered with `detail`). */
  bodyKey: string;
  /** Non-identifying interpolation values only (`{sessions, ofSessions}`). */
  detail: Record<string, number>;
}

/** Minimum sessions a signal must recur in before a suggestion fires (≥2). */
export const MIN_SUGGESTION_SESSIONS = 2;

/** Tunable knobs for {@link deriveSuggestions}. */
export interface SuggestionsConfig {
  /** Minimum sessions a signal must recur in before a suggestion fires. */
  minSessions: number;
}

/** Default suggestion thresholds. */
export const DEFAULT_SUGGESTIONS_CONFIG: SuggestionsConfig = {
  minSessions: MIN_SUGGESTION_SESSIONS,
};

/** Sort rank for a confidence tier (measured strongest). */
const CONFIDENCE_RANK: Record<SuggestionConfidence, number> = {
  measured: 0,
  likely: 1,
  worthChecking: 2,
};

/**
 * Conservative confidence bucketing from a signal's recurrence.
 *
 * A signal seen in exactly the {@link MIN_SUGGESTION_SESSIONS} bare-minimum
 * sessions is always the weakest, `worthChecking`. Above that, the fraction of the
 * device's sessions it recurs in decides: `measured` at ≥⅔, `likely` at ≥½ (but
 * <⅔), else `worthChecking`.
 */
function confidenceFor(
  sessions: number,
  total: number,
  minSessions: number
): SuggestionConfidence {
  if (sessions <= minSessions) return "worthChecking";
  const frac = total > 0 ? sessions / total : 0;
  if (frac >= 2 / 3) return "measured";
  if (frac >= 1 / 2) return "likely";
  return "worthChecking";
}

/** The weaker (higher-rank) of two confidence tiers. */
function weaker(a: SuggestionConfidence, b: SuggestionConfidence): SuggestionConfidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

/** Apply an optional confidence ceiling to a computed confidence. */
function capConfidence(
  conf: SuggestionConfidence,
  cap: SuggestionConfidence | undefined
): SuggestionConfidence {
  return cap === undefined ? conf : weaker(conf, cap);
}

/** A raw suggestion candidate before per-(device,id) resolution. */
interface Candidate {
  id: SuggestionId;
  sessions: number;
  /** Upper bound on this candidate's confidence (a correlation, not a measurement). */
  cap?: SuggestionConfidence;
  /** i18n body override (defaults to `diagnostics.suggestion.<camelId>.body`). */
  bodyKey?: string;
}

/** A candidate resolved to a concrete confidence for dedupe. */
interface Resolved {
  sessions: number;
  confidence: SuggestionConfidence;
  bodyKey?: string;
  /** A direct signal (uncapped) beats a correlation on an otherwise exact tie. */
  direct: boolean;
}

/** Is `a` a strictly stronger resolution than the incumbent `b`? */
function isStronger(a: Resolved, b: Resolved): boolean {
  const ra = CONFIDENCE_RANK[a.confidence];
  const rb = CONFIDENCE_RANK[b.confidence];
  if (ra !== rb) return ra < rb;
  if (a.sessions !== b.sessions) return a.sessions > b.sessions;
  return a.direct && !b.direct;
}

/**
 * Derive conservative setup suggestions from a {@link TrendReport} — PURE.
 *
 * Per device, recurring rule/pattern signals (and weak RF modes) map onto the five
 * suggestion kinds; for each `(deviceKey, id)` the strongest resolution wins
 * (highest confidence, then most sessions, then a direct signal over a correlation).
 * Only signals recurring in ≥`minSessions` sessions qualify. The result is deduped
 * and sorted deterministically: confidence (measured→likely→worthChecking), then id,
 * then deviceKey (null last).
 */
export function deriveSuggestions(
  trends: TrendReport,
  config: SuggestionsConfig = DEFAULT_SUGGESTIONS_CONFIG
): SetupSuggestion[] {
  const out: SetupSuggestion[] = [];

  for (const device of trends.devices) {
    const candidates = collectCandidates(device, config.minSessions);
    // Resolve each candidate to a confidence (applying its ceiling), then keep the
    // strongest per id.
    const best = new Map<SuggestionId, Resolved>();
    for (const c of candidates) {
      const resolved: Resolved = {
        sessions: c.sessions,
        confidence: capConfidence(
          confidenceFor(c.sessions, device.sessionCount, config.minSessions),
          c.cap
        ),
        bodyKey: c.bodyKey,
        direct: c.cap === undefined,
      };
      const prev = best.get(c.id);
      if (!prev || isStronger(resolved, prev)) best.set(c.id, resolved);
    }
    for (const [id, r] of best) {
      const camel = camelId(id);
      out.push({
        id,
        deviceKey: device.deviceKey,
        confidence: r.confidence,
        titleKey: `diagnostics.suggestion.${camel}.title`,
        bodyKey: r.bodyKey ?? `diagnostics.suggestion.${camel}.body`,
        detail: { sessions: r.sessions, ofSessions: device.sessionCount },
      });
    }
  }

  return out.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      a.id.localeCompare(b.id) ||
      compareDeviceKey(a.deviceKey, b.deviceKey)
  );
}

/** The maximum of the defined values, or `undefined` when none are defined. */
function maxDefined(...vals: Array<number | undefined>): number | undefined {
  const present = vals.filter((n): n is number => n !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

/** Collect the raw suggestion candidates for one device from its trend signals. */
function collectCandidates(device: DeviceTrend, minSessions: number): Candidate[] {
  const ruleSessions = new Map<string, number>();
  const patternSessions = new Map<string, number>();
  for (const ev of device.repeatedEvents) {
    if (ev.sessions < minSessions) continue;
    (ev.kind === "rule" ? ruleSessions : patternSessions).set(ev.id, ev.sessions);
  }
  const rule = (id: string): number | undefined => ruleSessions.get(id);
  const pattern = (id: string): number | undefined => patternSessions.get(id);

  const candidates: Candidate[] = [];

  // Antenna: direction-correlated null OR a recurring RSSI floor.
  const antenna = maxDefined(pattern("heading-degradation"), rule("rssi-floor"));
  if (antenna !== undefined) candidates.push({ id: "antenna-check", sessions: antenna });

  // Packet instability is a DIRECT signal → telemetry-interval review + a packet-rate
  // rethink, both able to reach higher confidence.
  const packetInstability = rule("packet-instability");
  if (packetInstability !== undefined) {
    candidates.push({ id: "telemetry-interval-review", sessions: packetInstability });
    candidates.push({ id: "packet-rate-reconsideration", sessions: packetInstability });
  }

  // A weak RF mode is a CORRELATION (low composite health at a packet rate), not a
  // measurement of the rate itself — cap it at worthChecking with correlation-worded
  // copy so it can never outrank the direct packet-instability signal.
  const weakRf = device.weakRfModes
    .filter((m) => m.sessions >= minSessions)
    .reduce<number | undefined>(
      (max, m) => (max === undefined ? m.sessions : Math.max(max, m.sessions)),
      undefined
    );
  if (weakRf !== undefined) {
    candidates.push({
      id: "packet-rate-reconsideration",
      sessions: weakRf,
      cap: "worthChecking",
      bodyKey: "diagnostics.suggestion.packetRateReconsideration.bodyWeakRf",
    });
  }

  // Power: recurring TX-power saturation.
  const power = rule("tx-power-saturation");
  if (power !== undefined) candidates.push({ id: "power-setting-review", sessions: power });

  // Wiring/power suspicion: ONLY the intermittent-connection signature — rssi-floor
  // AND lq-collapse both recurring on this device. gps-area-degradation is
  // environmental and repeated-lq-drops alone is range/obstruction — neither implies
  // wiring, so neither triggers this (matching the M38 patternCheck guidance).
  const rf = rule("rssi-floor");
  const lq = rule("lq-collapse");
  if (rf !== undefined && lq !== undefined) {
    candidates.push({ id: "wiring-power-suspicion", sessions: Math.min(rf, lq) });
  }

  return candidates;
}

/** Order device keys ascending with a `null` key last. */
function compareDeviceKey(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}
