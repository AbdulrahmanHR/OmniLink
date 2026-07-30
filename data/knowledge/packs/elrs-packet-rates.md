# ExpressLRS — Packet Rates and Telemetry

The **packet rate** is how many control packets per second the link sends. It is
the central trade-off in ExpressLRS: higher rates give lower latency, while lower
rates give more range and better penetration for the same transmit power.

## Common packet rates (2.4 GHz)

- **50 Hz** — maximum range and sensitivity, highest latency. Good for
  long-range cruising.
- **150 Hz** — a balanced all-round rate with good range.
- **250 Hz / 333 Hz Full** — lower latency for freestyle and general flying.
- **500 Hz** — low latency for racing; shorter range than the slower rates.
- **D250 / D500 / F500 / F1000** — higher-rate modes (some using the FLRC
  modulation) that push latency down further at the cost of range.

900 MHz hardware supports lower maximum rates (for example 25 Hz, 50 Hz, 100 Hz,
200 Hz) but reaches further for a given power.

## LoRa vs FLRC

- **LoRa** modulation is used for the range-oriented rates — it is very
  sensitive and penetrates obstacles well.
- **FLRC** is used for the highest rates (for example F1000) — it trades some
  sensitivity for the lowest possible latency.

## Telemetry ratio

Telemetry travels on the same link, so some downlink slots are spent sending
telemetry back instead of control updates. The **telemetry ratio** controls how
often that happens — for example `1:128` sends telemetry rarely (maximising
control throughput), while `1:2` sends it very often.

- Use **Std** (or a sparse ratio like 1:64 / 1:128) at high packet rates so
  control packets are not starved.
- A denser ratio gives smoother telemetry (RSSI, link quality, battery, GPS) at
  the cost of some control-link headroom.
- **Dynamic** telemetry lets the firmware pick the ratio automatically based on
  the packet rate.

## Choosing a rate

For most pilots: start at **250 Hz** for freestyle or **150 Hz** for range, keep
telemetry at a sparse ratio, and only move to 500 Hz+ if you specifically need
the lowest latency and accept the reduced range.
