#!/usr/bin/env python3
"""Render the exact curated runtime cell map as a compact QA sheet.

The animation map is read as JSON from stdin so src/animation-config.js remains
the source of truth. This script is a development aid and is not packaged.
"""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw


CELL_WIDTH = 192
CELL_HEIGHT = 208
PREVIEW_WIDTH = 96
PREVIEW_HEIGHT = 104
LABEL_HEIGHT = 22


def checker(width: int, height: int) -> Image.Image:
    image = Image.new("RGBA", (width, height), (238, 241, 244, 255))
    draw = ImageDraw.Draw(image)
    size = 12
    for y in range(0, height, size):
        for x in range(0, width, size):
            if (x // size + y // size) % 2:
                draw.rectangle((x, y, x + size - 1, y + size - 1), fill=(215, 220, 225, 255))
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atlas", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    mapping = json.load(sys.stdin)
    rows = list(mapping["states"].items())
    look = mapping["look"]
    rows.extend([("look 000-157.5", look[:8]), ("look 180-337.5", look[8:])])
    columns = max(len(cells) for _, cells in rows)
    sheet = Image.new("RGBA", (columns * PREVIEW_WIDTH, len(rows) * (LABEL_HEIGHT + PREVIEW_HEIGHT)), (15, 18, 22, 255))
    draw = ImageDraw.Draw(sheet)
    atlas = Image.open(args.atlas).convert("RGBA")

    for row_index, (label, cells) in enumerate(rows):
        y = row_index * (LABEL_HEIGHT + PREVIEW_HEIGHT)
        draw.text((5, y + 4), label, fill=(242, 246, 249, 255))
        for column_index, cell in enumerate(cells):
            source_x = cell["column"] * CELL_WIDTH
            source_y = cell["row"] * CELL_HEIGHT
            frame = atlas.crop((source_x, source_y, source_x + CELL_WIDTH, source_y + CELL_HEIGHT))
            frame = frame.resize((PREVIEW_WIDTH, PREVIEW_HEIGHT), Image.Resampling.LANCZOS)
            background = checker(PREVIEW_WIDTH, PREVIEW_HEIGHT)
            background.alpha_composite(frame)
            sheet.alpha_composite(background, (column_index * PREVIEW_WIDTH, y + LABEL_HEIGHT))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(args.output, quality=95)


if __name__ == "__main__":
    main()
