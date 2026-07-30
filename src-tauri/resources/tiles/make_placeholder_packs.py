#!/usr/bin/env python3
"""Generate the placeholder regional offline tile packs (`packs/*.ompack`).

M12 SCAFFOLD — IMPORTANT
========================
This produces *small placeholder* regional packs — one `.ompack` per downloadable
pack id in `tile-packs.json` (`europe-west`, `north-america-us`, `asia-east`,
`oceania-au`). Each is a handful of solid-colour tiles covering a tiny slippy-map
neighbourhood around the region, across its manifest zoom band (z6..z12). Exactly
like `make_placeholder_base.py`, this proves the `.ompack` container + the
download + `omnitiles://` serve path end to end with REAL bytes — it is **not
real geography**.

Why bundle these instead of hosting them? v1.6 ships with no tile CDN, so the
downloadable packs are sourced LOCALLY from the installer's bundled resources via
the `bundled:` URL scheme (see `tile-packs.json` and `commands/tiles.rs`). The
exact same download pipeline (streamed copy → progress events → cancel → magic
validation → atomic rename) runs; only the byte source is a local file rather
than an HTTP GET. A real production build replaces this step: render the real
regional raster sets, pack them with the same `OMPACK01` container, drop them in
`packs/`, and repoint each `url` at the production CDN — nothing else changes.

No third-party deps — pure stdlib (math + zlib + struct), so it runs anywhere.
Re-running is reproducible: identical inputs produce identical bytes.
"""

import json
import math
import os
import struct
import zlib

TILE_SIZE = 256

# Per-region placeholder definitions:
#   id          -> the manifest pack id (and `packs/<id>.ompack` filename)
#   lat, lon    -> a representative point used to derive the slippy tile centre
#   fill        -> a distinct dark Signal-Lab-palette RGB so each region's
#                  placeholder is visually distinguishable (still "no real data")
# The zoom band is the manifest's 6..12; a small NEIGHBOURHOOD x NEIGHBOURHOOD
# block of tiles is emitted per zoom level to keep each pack to tens of KB
# (consistent with the ~12 KB base-world placeholder).
MIN_ZOOM = 6
MAX_ZOOM = 12
NEIGHBOURHOOD = 2  # NxN tiles per zoom level around the region centre

REGIONS = [
    {"id": "europe-west", "lat": 48.0, "lon": 2.0, "fill": (18, 26, 40)},
    {"id": "north-america-us", "lat": 39.0, "lon": -98.0, "fill": (16, 32, 26)},
    {"id": "asia-east", "lat": 35.0, "lon": 120.0, "fill": (38, 30, 16)},
    {"id": "oceania-au", "lat": -25.0, "lon": 133.0, "fill": (40, 20, 22)},
]


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


def deg2tile(lat: float, lon: float, z: int):
    """Standard slippy-map (Web-Mercator) lon/lat -> (x, y) tile at zoom z."""
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    # Clamp into the valid tile grid.
    x = max(0, min(n - 1, x))
    y = max(0, min(n - 1, y))
    return x, y


def build_ompack(out_path: str, region) -> None:
    tile = solid_png(TILE_SIZE, TILE_SIZE, region["fill"])
    directory = {}
    blob = bytearray()
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        n = 2**z
        cx, cy = deg2tile(region["lat"], region["lon"], z)
        for dx in range(NEIGHBOURHOOD):
            for dy in range(NEIGHBOURHOOD):
                x = min(n - 1, cx + dx)
                y = min(n - 1, cy + dy)
                key = f"{z}/{x}/{y}"
                if key in directory:
                    continue  # clamping can collide near the grid edge
                offset = len(blob)
                directory[key] = [offset, len(tile)]
                blob.extend(tile)

    dir_json = json.dumps(directory, separators=(",", ":")).encode("utf-8")
    with open(out_path, "wb") as f:
        f.write(b"OMPACK01")
        f.write(struct.pack("<I", len(dir_json)))
        f.write(dir_json)
        f.write(blob)
    print(
        f"wrote {out_path}: {len(directory)} tiles (z{MIN_ZOOM}..z{MAX_ZOOM}), "
        f"{os.path.getsize(out_path)} bytes [PLACEHOLDER — solid colour]"
    )


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    packs_dir = os.path.join(here, "packs")
    os.makedirs(packs_dir, exist_ok=True)
    for region in REGIONS:
        build_ompack(os.path.join(packs_dir, f"{region['id']}.ompack"), region)
