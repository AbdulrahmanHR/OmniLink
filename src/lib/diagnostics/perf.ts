/**
 * Frozen scan-budget constants + a shared large-session builder (M41, v2.0.2).
 *
 * The M41 launch gate formalizes what the M36 `dl3-validation.test.ts` carried as
 * a loose 2000 ms "smoke": a real performance budget for a **full v2.0 session
 * scan** — {@link import("./engine").evaluateSession} (M36) *and*
 * {@link import("./patterns").detectSessionPatterns} (M38) over a large log. This
 * module is the single source of truth for that budget and the deterministic
 * large-log builder both the perf test and any future consumer share (mirroring
 * `src/lib/knowledge/retrievalConsts.ts` + `knowledgeRetrievePerf.test.ts`).
 *
 * Pure data + a pure builder: no `Date.now`, no `Math.random`, no I/O. The same
 * `n` always yields a deeply-equal {@link ParsedLog}.
 */

import type { LogGpsFix, ParsedLog } from "@/lib/blackbox";

/**
 * Frozen p95 wall-clock budget (ms) for ONE full v2.0 session scan
 * (`evaluateSession` + `detectSessionPatterns`) over a ~50k-sample log, asserted
 * by `tests/unit/diagnostics/scan-budget.test.ts`.
 *
 * Deliberately GENEROUS versus the measured reality so the assertion pins "the
 * scan stays well-behaved" without flaking under CI/WSL2 jitter (the same
 * discipline `RETRIEVAL_P95_BUDGET_MS` documents). On the M41 reference machine
 * (WSL2 dev) a 50k-sample scan runs at a ~70 ms median / ~85 ms p95, so this
 * ~9× ceiling absorbs a heavily-loaded runner while still being orders of
 * magnitude below what an accidental O(n²) regression would cost (seconds+). The
 * companion deterministic complexity-ratio guard — `t(2N) < K·t(N)` — is what
 * actually catches a super-linear regression; this bound is the coarse backstop.
 */
export const DIAGNOSTICS_SCAN_P95_BUDGET_MS = 750;

/**
 * Multiplier `K` for the deterministic complexity guard `t(2N) < K · t(N)`.
 *
 * A linear scan doubles its cost when the input doubles (ratio ≈ 2); a quadratic
 * one quadruples it (ratio ≈ 4). `K = 3` sits between the two, so a genuinely
 * sub-quadratic scan passes with margin (measured ratio ≈ 2.0 on the reference
 * machine) while an O(n²) regression is caught — independent of absolute wall
 * clock, so it does not flake under load.
 */
export const DIAGNOSTICS_SCAN_COMPLEXITY_K = 3;

/**
 * Build a deterministic {@link ParsedLog} of `n` samples exercising BOTH the M36
 * rules and the M38 detectors, so a full-scan measurement covers real work rather
 * than an early-out.
 *
 * Seven aligned channels (`rssi1`, `rssi2`, `link_quality`, `snr`, `tx_power`,
 * `packet_rate`, `heading`) plus a small looping GPS track:
 *  - a slow sine on RSSI/LQ gives every M36 rule signal to chew on;
 *  - a periodic deep dropout (~every 2000 samples) drives repeated `lq-collapse` /
 *    `rssi-floor` findings — so M38's `repeated-lq-drops` fires (≥3 drops) and,
 *    with `tx_power` ramping into each dropout, `power-packet-link-events` too;
 *  - a swept `heading` + a bounded looping GPS track keep the heading/area
 *    detectors on the hot path (they run over the data, cheaply).
 *
 * No `Math.random`/`Date.now` — the sine + modular dropouts are fully
 * reproducible, so a re-run is deep-equal. Time axis is a synthetic 40 ms cadence.
 */
export function buildLargeSessionLog(n: number): ParsedLog {
  const rssi1 = new Array<number>(n);
  const rssi2 = new Array<number>(n);
  const linkQuality = new Array<number>(n);
  const snr = new Array<number>(n);
  const txPower = new Array<number>(n);
  const packetRate = new Array<number>(n);
  const heading = new Array<number>(n);
  const gps = new Array<LogGpsFix | null>(n);
  const time = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 240);
    // Periodic deep dropout (~every 2000 samples) exercises the LQ/RSSI rules and
    // yields ≥3 collapses so the M38 repeated-lq-drops detector fires.
    const dropout = i % 2000 < 25;
    rssi1[i] = dropout ? -108 : -62 + wave * 6;
    rssi2[i] = dropout ? -106 : -64 + wave * 5;
    linkQuality[i] = dropout ? 0 : 94 + wave * 4;
    snr[i] = dropout ? -3 : 8 + Math.sin(i / 17) * 2;
    // TX power ramps into each dropout so power-packet-link-events fires too.
    txPower[i] = dropout ? 250 : 100;
    packetRate[i] = 250;
    heading[i] = (i * 3) % 360;
    // Small looping track over ~8 cells (a flight revisiting the same field), so
    // the area detector runs without an O(n) cell-map explosion.
    const c = i % 8;
    gps[i] = { lat: 47 + c * 0.001, lon: 8 + c * 0.001 };
    time[i] = i * 40;
  }

  const channels = [
    { key: "rssi1", label: "rssi1", values: rssi1 },
    { key: "rssi2", label: "rssi2", values: rssi2 },
    { key: "link_quality", label: "link_quality", values: linkQuality },
    { key: "snr", label: "snr", values: snr },
    { key: "tx_power", label: "tx_power", values: txPower },
    { key: "packet_rate", label: "packet_rate", values: packetRate },
    { key: "heading", label: "heading", values: heading },
  ];

  return {
    source: "omnilog",
    time,
    channels,
    sampleCount: n,
    durationMs: n >= 2 ? time[n - 1] - time[0] : 0,
    gps,
  };
}
