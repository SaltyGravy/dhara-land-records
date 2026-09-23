"""Synthesize a deliberately degraded "scan" from a clean text fixture, for demoing the
honest failure path - low confidence and manual review - instead of only ever showing a
clean 100% pass. Real legacy khatauni/7-12 photos are rotated, faded, and re-compressed;
none of the bundled test fixtures or the browser smoke test's synthetic document are.

    python scripts/synthesize_degraded_scan.py tests/fixtures/sample-land-record-mixed-hindi-english.txt /tmp/degraded.jpg

Renders the fixture text, then applies rotation, a contrast/brightness drop toward mid-grey,
sensor-noise speckle, and JPEG re-compression - feed the result straight into the app's
upload flow (it goes through the same _preprocess_image enhancement as any real scan).
"""

import argparse
import io
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Fonts covering both Latin and Devanagari, macOS then Linux/Docker - tried in order so a
# mixed-script fixture renders as real glyphs throughout rather than tofu boxes for whichever
# script the font doesn't cover. The macOS Devanagari-only fonts are last: they render Hindi
# correctly but leave every English label and number as an empty box - a real risk on this
# app's frequently bilingual fixtures. Falls back to Pillow's bitmap font (ASCII-only) if
# nothing is found.
CANDIDATE_FONTS = [
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    "/usr/share/fonts/noto/NotoSansDevanagari-Regular.ttf",
    "/System/Library/Fonts/Supplemental/DevanagariMT.ttc",
    "/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc",
    "/System/Library/Fonts/Supplemental/ITFDevanagari.ttc",
]


def _load_font(explicit: str | None, size: int):
    for path in ([explicit] if explicit else CANDIDATE_FONTS):
        if path and Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    print("warning: no Devanagari-capable TrueType font found - falling back to a bitmap "
          "font that cannot render Hindi text; pass --font /path/to/font.ttf to fix this.")
    return ImageFont.load_default()


def render_clean(text: str, font) -> Image.Image:
    lines = text.splitlines() or [""]
    probe = ImageDraw.Draw(Image.new("L", (10, 10)))
    line_height = probe.textbbox((0, 0), "Ag", font=font)[3] + 16
    width = max((probe.textbbox((0, 0), line, font=font)[2] for line in lines), default=600)
    image = Image.new("L", (width + 120, line_height * len(lines) + 100), color=248)
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((60, 50 + index * line_height), line, font=font, fill=25)
    return image


def degrade(image: Image.Image, rotate: float, contrast_drop: float, jpeg_quality: int) -> Image.Image:
    rotated = image.convert("RGB").rotate(rotate, expand=True, fillcolor=(232, 226, 212), resample=Image.BICUBIC)
    faded = Image.blend(rotated, Image.new("RGB", rotated.size, (172, 166, 150)), contrast_drop)
    pixels = faded.load()
    for _ in range(faded.width * faded.height // 35):
        x, y = random.randrange(faded.width), random.randrange(faded.height)
        pixels[x, y] = tuple(max(0, min(255, channel + random.randint(-45, 45))) for channel in pixels[x, y])
    buffer = io.BytesIO()
    faded.save(buffer, format="JPEG", quality=jpeg_quality)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("fixture", nargs="?", default="tests/fixtures/sample-land-record-mixed-hindi-english.txt")
    parser.add_argument("output", nargs="?", default="/tmp/dhara-degraded-scan.jpg")
    parser.add_argument("--rotate", type=float, default=6.5, help="degrees to rotate, simulating a crooked phone photo")
    parser.add_argument("--contrast-drop", type=float, default=.55, help="0-1, how far to fade toward flat grey")
    parser.add_argument("--jpeg-quality", type=int, default=18, help="low quality = visible compression artifacting")
    parser.add_argument("--font", help="explicit TrueType font path, overrides the built-in candidate list")
    args = parser.parse_args()

    text = Path(args.fixture).read_text(encoding="utf-8")
    font = _load_font(args.font, 34)
    degraded = degrade(render_clean(text, font), args.rotate, args.contrast_drop, args.jpeg_quality)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    degraded.save(args.output, format="JPEG", quality=85)
    print(f"Wrote a degraded scan of {args.fixture} to {args.output} ({degraded.width}x{degraded.height}).")


if __name__ == "__main__":
    main()
