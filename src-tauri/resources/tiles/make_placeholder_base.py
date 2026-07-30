#!/usr/bin/env python3
"""Generate the placeholder offline base tile pack (`base-world.ompack`).

M12 SCAFFOLD — IMPORTANT
========================
This produces a *small placeholder* base set: a handful of low-zoom tiles
(z0..z2) that are all a single solid Signal-Lab-neutral colour. It proves the
`.ompack` container format + the `omnitiles://` serve path end to end with real
bytes, but it is **not real geography**.

A real production build replaces this step: render the actual ~50 MB low-zoom
worldwide raster set (z0..z5) and pack it with the same container format
(`OMPACK01` magic + JSON directory + concatenated PNG blob — see
`src-tauri/src/commands/tiles.rs`). Nothing else changes: drop the real
`base-world.ompack` in this directory and the installer bundles it.

No third-party deps — pure stdlib (zlib + struct), so it runs anywhere.
"""

import json
import os
import struct
import zlib

TILE_SIZE = 256
# Solid neutral fill (approx the dark Signal Lab --muted background), RGB.
FILL = (15, 20, 33)


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def solid_png(width: int, height: int, rgb) -> bytes:
    """A valid solid-colour RGB PNG, built by hand (no PIL)."""
    raw = bytearray()
    row = bytes(rgb) * width
    for _ in range(height):
        raw.append(0)  # filter type 0 (None) per scanline
        raw.extend(row)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def build_ompack(out_path: str, max_zoom: int = 2) -> None:
    tile = solid_png(TILE_SIZE, TILE_SIZE, FILL)
    directory = {}
    blob = bytearray()
    for z in range(0, max_zoom + 1):
        n = 2**z
        for x in range(n):
            for y in range(n):
                offset = len(blob)
                directory[f"{z}/{x}/{y}"] = [offset, len(tile)]
                blob.extend(tile)

    dir_json = json.dumps(directory, separators=(",", ":")).encode("utf-8")
    with open(out_path, "wb") as f:
        f.write(b"OMPACK01")
        f.write(struct.pack("<I", len(dir_json)))
        f.write(dir_json)
        f.write(blob)
    print(
        f"wrote {out_path}: {len(directory)} tiles (z0..z{max_zoom}), "
        f"{os.path.getsize(out_path)} bytes [PLACEHOLDER — solid colour]"
    )


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    build_ompack(os.path.join(here, "base-world.ompack"))
