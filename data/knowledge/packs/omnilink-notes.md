# OmniLink Curated Notes — Power, Antennas, and Dropouts

These are OmniLink's own field-tested notes for tuning an ExpressLRS link. They
summarise practical guidance and are not a substitute for the official
ExpressLRS documentation.

## TX power

Transmit power is set in steps (for example 10 mW, 25 mW, 50 mW, 100 mW, 250 mW,
500 mW, 1000 mW, 2000 mW), subject to what your hardware and regulatory domain
allow.

- More power extends range but increases heat and current draw, and can raise
  your RF noise floor at the field.
- **Dynamic power** raises output only when the link needs it (as link quality
  or RSSI drops) and backs off when the signal is strong — this is the
  recommended default for most flying.
- Do not fly at maximum power indoors or in a crowded pit; it can desensitise
  nearby receivers.

## Antennas and mounting

- Keep the receiver antenna tip away from carbon frame, motors, and the battery,
  and avoid coiling the coax.
- For a diversity receiver, mount the two antennas at roughly 90° to each other
  so at least one keeps a good angle in any orientation.
- A damaged or pinched antenna is a common cause of unexpectedly short range.

## Diagnosing dropouts

When a link drops out, check these in order:

1. **Link quality (LQ) and RSSI** — a falling LQ before the dropout points to a
   range or antenna problem, not radio interference.
2. **Packet rate vs range** — if dropouts start at distance, lower the packet
   rate (for example 500 Hz → 150 Hz) for more sensitivity.
3. **Power and dynamic power** — confirm dynamic power is enabled and the
   maximum step is allowed by your hardware.
4. **Antenna condition and mounting** — inspect for damage and reposition away
   from noise sources.
5. **Firmware match** — confirm the TX and RX run compatible firmware and the
   same regulatory domain.

## Failsafe

Always configure a sane failsafe on the receiver so the aircraft behaves safely
if the link is lost. Failsafe behaviour is a safety-critical setting and is set
deliberately by the pilot — it is never changed automatically.
