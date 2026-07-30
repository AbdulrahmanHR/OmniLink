# ExpressLRS — Binding

Binding is the step that pairs one receiver to one transmitter so the receiver
only accepts packets from your radio. ExpressLRS supports two binding methods: a
**binding phrase** (recommended) and traditional **manual binding**.

## Binding phrase (recommended)

A binding phrase is a secret word or sentence you set in the firmware for both
the TX and the RX. ExpressLRS hashes the phrase into a unique link identity (the
UID), so any TX and RX flashed with the **same phrase are automatically bound**
— no button presses required.

- Choose a phrase that is memorable but not trivially guessable.
- Flash the **identical** phrase to every TX and RX you want on the same link.
- Changing the phrase later requires re-flashing the affected devices.

Because the phrase never leaves your own equipment and is only stored as a hash,
it is treated as a **private secret**. Tools should never transmit or log a
binding phrase.

## Manual (traditional) binding

If no binding phrase is set, ExpressLRS falls back to manual binding:

1. Power on the receiver. On first boot (or after a bind command) it enters
   **bind mode**, indicated by a fast-blinking LED.
2. Put the transmitter into bind mode from the radio's ExpressLRS Lua script or
   the module menu.
3. The devices exchange identity and the LED goes solid once bound.

Manual binding is useful for a quick pairing, but a binding phrase is more
robust: it survives re-flashes and avoids accidental cross-binding at a busy
field.

## Verifying a bind

A bound link shows a solid receiver LED and live telemetry (link quality, RSSI)
flowing back to the radio and flight controller. If the LED keeps blinking, the
phrases differ, the bands differ, or the firmware versions are incompatible.
