/**
 * Signal-health score — the DL1 frozen, transparent composite (M36).
 *
 * A single 0–100 number summarising how healthy a link is, built as a
 * **link-quality-dominant** weighted sum of six clamped `[0,1]` normalizers,
 * minus a dropout penalty on failsafe frames. Every weight and domain constant
 * lives in {@link HealthScoreConfig} (defaulted by
 * {@link DEFAULT_HEALTH_SCORE_CONFIG}) so the formula is fully inspectable and
 * overridable; nothing here is hidden or magic.
 *
 * ## Why these weights (positive weights sum to 1.0)
 *  - **LQ (0.45)** dominates: link quality is the single best proxy for whether
 *    control packets are getting through.
 *  - **RSSI margin (0.25)** — headroom above the receiver floor.
 *  - **SNR (0.10)** — noise floor margin.
 *  - **Packet stability (0.08)** — neutral (1.0) per-frame; the real, jitter-aware
 *    value is computed per window in {@link computeSessionHealthScore}.
 *  - **TX headroom (0.07)** — running near max power means no margin left to push.
 *  - **RF mode (0.05)** — a lower packet rate is more robust (more energy/bit).
 *
 * A frame in dropout (LQ ≤ 0, or best RSSI at/below the floor) additionally loses
 * {@link HealthScoreConfig.dropoutPenalty} points, dragging failsafe windows to
 * near zero so the session gauge reads the loss clearly.
 *
 * ## Calibration (DL1 acceptance, M36 fixture corpus)
 * With {@link DEFAULT_HEALTH_SCORE_CONFIG} every healthy fixture's overall score
 * is ≥ 87 and every failsafe fixture has at least one window ≤ 17 (≤ 30), so the
 * score cleanly separates healthy sessions from link losses.
 *
 * ## Purity / safety
 * Pure arithmetic over channel values — no `Date.now`, no `Math.random`, no I/O,
 * and `log.gps` is never read.
 */

import type { ParsedLog } from "@/lib/blackbox";
import type { TelemetryFrame } from "@/stores/telemetry";
import { PACKET_RATES, TX_POWER_STEPS } from "@/lib/telemetry-constants";
import { RSSI_FLOOR_DBM } from "@/lib/telemetry-crsf";
import type { HealthScoreConfig } from "./types";
import {
  CHANNEL_CANDIDATES,
  clamp01,
  isFiniteNumber,
  meanFinite,
  nearestStepIndex,
  resolveChannelValues,
} from "./util";

/** Floor on a window's aggregation weight so a near-zero-LQ (failsafe) window still pulls the headline down instead of being fully discounted. */
const MIN_WINDOW_WEIGHT = 30;

/**
 * Default, frozen health-score configuration. The positive weights sum to 1.0;
 * the RSSI margin plateaus at −80 dBm (a link at/above that is not
 * signal-limited) and bottoms at the −110 dBm receiver floor.
 */
export const DEFAULT_HEALTH_SCORE_CONFIG: HealthScoreConfig = {
  weights: {
    lq: 0.45,
    rssiMargin: 0.25,
    snr: 0.1,
    packetStability: 0.08,
    txHeadroom: 0.07,
    rfMode: 0.05,
  },
  dropoutPenalty: 70,
  rssiFloorDbm: RSSI_FLOOR_DBM, // -110
  rssiGoodDbm: -80,
  snrOffsetDb: 5,
  snrSpanDb: 15,
  rfMinFactor: 0.8,
  windowSize: 12,
};

/** Best (least-negative) of two antenna RSSIs, or the floor if neither finite. */
function bestRssi(rssi1: number, rssi2: number, floor: number): number {
  const finite = [rssi1, rssi2].filter(isFiniteNumber);
  return finite.length === 0 ? floor : Math.max(...finite);
}

/**
 * RF-mode robustness factor for a packet rate: the slowest rate maps to `1.0`
 * and the fastest to {@link HealthScoreConfig.rfMinFactor}, linearly by ladder
 * index. An unknown/zero rate falls back to the midpoint.
 */
function rfModeFactor(packetRate: number, cfg: HealthScoreConfig): number {
  if (!isFiniteNumber(packetRate) || packetRate <= 0) {
    return (1 + cfg.rfMinFactor) / 2;
  }
  const idx = nearestStepIndex(packetRate, PACKET_RATES);
  const span = PACKET_RATES.length - 1;
  const frac = span <= 0 ? 0 : idx / span;
  return 1 - (1 - cfg.rfMinFactor) * frac;
}

/**
 * Score one frame given an externally-supplied packet-stability normalizer
 * (1.0 = perfectly stable). Shared by the per-frame and per-session entry points
 * so the two never drift.
 *
 * Non-finite inputs (an absent channel OR a sample gap) are treated as NEUTRAL
 * (normalizer 1.0, no penalty) rather than worst-case, so a log that is simply
 * missing the LQ/RSSI channel does not score a contradictory 0/100 with no
 * findings. Dropout is only counted from FINITE evidence — consistent with the
 * gap-safe rules, which likewise never penalise absent data.
 */
function scoreFrame(
  frame: TelemetryFrame,
  cfg: HealthScoreConfig,
  packetStability: number
): number {
  const w = cfg.weights;
  const rssiFinite = isFiniteNumber(frame.rssi1) || isFiniteNumber(frame.rssi2);
  const best = bestRssi(frame.rssi1, frame.rssi2, cfg.rssiFloorDbm);
  const lqNorm = isFiniteNumber(frame.linkQuality) ? clamp01(frame.linkQuality / 100) : 1;
  const rssiNorm = rssiFinite ? clamp01((best - cfg.rssiFloorDbm) / (cfg.rssiGoodDbm - cfg.rssiFloorDbm)) : 1;
  const snrNorm = isFiniteNumber(frame.snr) ? clamp01((frame.snr + cfg.snrOffsetDb) / cfg.snrSpanDb) : 1;
  const maxTxIdx = TX_POWER_STEPS.length - 1;
  const txIdx = isFiniteNumber(frame.txPower) ? nearestStepIndex(frame.txPower, TX_POWER_STEPS) : 0;
  const txHeadroom = maxTxIdx <= 0 ? 1 : 1 - txIdx / maxTxIdx;
  const rfFactor = rfModeFactor(frame.packetRate, cfg);
  const base =
    w.lq * lqNorm +
    w.rssiMargin * rssiNorm +
    w.snr * snrNorm +
    w.packetStability * clamp01(packetStability) +
    w.txHeadroom * txHeadroom +
    w.rfMode * rfFactor;
  let score = base * 100;
  const lqDropout = isFiniteNumber(frame.linkQuality) && frame.linkQuality <= 0;
  const rssiDropout = rssiFinite && best <= cfg.rssiFloorDbm;
  if (lqDropout || rssiDropout) score -= cfg.dropoutPenalty;
  return clamp01(score / 100) * 100;
}

/**
 * Compute a single frame's signal-health score, 0–100. Pure and deterministic.
 *
 * Packet stability is neutral (1.0) at the frame level — a single frame carries
 * no jitter information; the jitter-aware value is applied per window by
 * {@link computeSessionHealthScore}.
 */
export function computeHealthScore(frame: TelemetryFrame, config: HealthScoreConfig): number {
  return scoreFrame(frame, config, 1);
}

/** Build a minimal {@link TelemetryFrame} for sample `i` from a parsed log. */
function frameAt(
  i: number,
  rssi1: number[] | undefined,
  rssi2: number[] | undefined,
  lq: number[] | undefined,
  snr: number[] | undefined,
  tx: number[] | undefined,
  packet: number[] | undefined
): TelemetryFrame {
  // Absent channel OR a sample gap ⇒ non-finite (NaN), so `scoreFrame` treats it
  // as neutral instead of fabricating a worst-case reading.
  const get = (a: number[] | undefined): number => {
    const v = a?.[i];
    return isFiniteNumber(v) ? v : NaN;
  };
  return {
    t: i,
    rssi1: get(rssi1),
    rssi2: get(rssi2),
    linkQuality: get(lq),
    snr: get(snr),
    txPower: get(tx),
    packetRate: get(packet),
    antennas: [],
  };
}

/**
 * Score a whole session: a per-window array (driving the gauge) plus an
 * `overall` aggregate. Frames are derived from the canonical channel keys; each
 * fixed-size window gets a jitter-aware packet-stability factor (`1 −
 * changes / (samples − 1)`) applied to all its frames. `overall` is a
 * link-quality-weighted mean of the window scores with a FLOORED weight
 * ({@link MIN_WINDOW_WEIGHT}), so sustained low-LQ windows materially lower the
 * headline instead of being fully discounted by their near-zero LQ; the
 * per-window minimum still exposes the worst dip.
 *
 * An empty/zero-sample log returns `{ overall: 100, perWindow: [] }` (nothing
 * wrong was observed). Pure and deterministic.
 */
export function computeSessionHealthScore(
  log: ParsedLog,
  config: HealthScoreConfig
): { overall: number; perWindow: number[] } {
  const n = log.sampleCount;
  if (n === 0) return { overall: 100, perWindow: [] };

  const rssi1 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi1);
  const rssi2 = resolveChannelValues(log, CHANNEL_CANDIDATES.rssi2);
  const lq = resolveChannelValues(log, CHANNEL_CANDIDATES.linkQuality);
  const snr = resolveChannelValues(log, CHANNEL_CANDIDATES.snr);
  const tx = resolveChannelValues(log, CHANNEL_CANDIDATES.txPower);
  const packet = resolveChannelValues(log, CHANNEL_CANDIDATES.packetRate);
  const win = Math.max(1, Math.floor(config.windowSize));

  const perWindow: number[] = [];
  const windowLqWeight: number[] = [];

  for (let start = 0; start < n; start += win) {
    const end = Math.min(n, start + win);

    // Jitter-aware packet stability for this window.
    let prev = NaN;
    let count = 0;
    let changes = 0;
    if (packet) {
      for (let i = start; i < end; i++) {
        const v = packet[i];
        if (!isFiniteNumber(v)) continue;
        if (count > 0 && v !== prev) changes++;
        prev = v;
        count++;
      }
    }
    const packetStability = count >= 2 ? 1 - changes / (count - 1) : 1;

    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += scoreFrame(frameAt(i, rssi1, rssi2, lq, snr, tx, packet), config, packetStability);
    }
    perWindow.push(sum / (end - start));

    const lqMean = lq ? meanFinite(lq.slice(start, end), 0) : 50;
    windowLqWeight.push(Math.max(MIN_WINDOW_WEIGHT, lqMean));
  }

  const totalWeight = windowLqWeight.reduce((a, b) => a + b, 0);
  const overall =
    totalWeight > 0
      ? perWindow.reduce((acc, p, idx) => acc + p * windowLqWeight[idx], 0) / totalWeight
      : perWindow.reduce((a, b) => a + b, 0) / perWindow.length;

  return { overall, perWindow };
}
