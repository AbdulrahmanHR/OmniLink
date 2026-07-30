# ExpressLRS — Getting Started

ExpressLRS (ELRS) is an open-source, high-performance radio control link for FPV
drones and other RC aircraft. It runs on inexpensive hardware and is optimised
for low latency and long range. A complete ELRS link has two halves: a
**transmitter (TX)** module that plugs into your radio, and a **receiver (RX)**
that lives on the aircraft.

## The two halves of a link

- **Transmitter (TX):** an external module (in the JR/Nano bay of a radio) or an
  internal module built into the radio. It broadcasts the control link.
- **Receiver (RX):** a small board on the aircraft that receives control packets
  and returns telemetry over the CRSF protocol to the flight controller.

For a link to work, the TX and RX must run **compatible firmware versions** and
use the **same frequency band** and the **same binding phrase**.

## Frequency bands

ExpressLRS ships in two radio bands, and a TX and RX must match:

- **2.4 GHz** — the most common band. Uses the global ISM band, so it works in
  most regions with minimal restriction. Supports the highest packet rates and
  the lowest latency.
- **900 MHz** — better penetration and long-range performance, at lower maximum
  packet rates. The exact sub-band and legal power depend on your regulatory
  domain.

## Regulatory domains

Legal frequencies and power limits are set by your region. ExpressLRS firmware is
built per **regulatory domain** so it only transmits where you are allowed to:

- **2.4 GHz** — `Regulatory_Domain_ISM_2400` is used worldwide.
- **900 MHz** — `Regulatory_Domain_FCC_915` (Americas, 902–928 MHz),
  `Regulatory_Domain_EU_868` (Europe, 868 MHz), and
  `Regulatory_Domain_AU_915` / `Regulatory_Domain_IN_866` for other regions.

Always flash the domain that is legal where you fly. Using the wrong domain can
break the law and will not interoperate with correctly-configured gear.

## Flashing firmware

ExpressLRS hardware is configured by flashing firmware built for your exact
target (the specific TX or RX board). OmniLink flashes ELRS firmware directly —
over USB (UART/passthrough) or over WiFi — without needing the separate
ExpressLRS Configurator. Every flash writes firmware matched to the selected
target, and a mismatched TX/RX target is blocked before any write.
