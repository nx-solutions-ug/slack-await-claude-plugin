"""Composite the slack-await banners: AI background + VectorCraft logo + wordmark.

Run from anywhere: python3 assets/source/compose-banners.py
Needs Pillow, rsvg-convert and the Inter variable font.
"""

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent
LOGO_SVG = ASSETS / "logo.svg"
FONT = "/usr/share/fonts/inter/Inter[opsz,wght].ttf"
TITLE = "slack-await"
TAGLINE = "Ask a colleague. Get woken when they answer."


def logo(px: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "logo.png"
        subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), str(LOGO_SVG), "-o", str(out)], check=True)
        return Image.open(out).convert("RGBA")


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_axes([32, weight])
    return f


def compose(bg_name: str, size: tuple[int, int], logo_px: int, title_px: int, tag_px: int, out_name: str) -> None:
    bg = Image.open(HERE / bg_name).convert("RGBA").resize(size, Image.LANCZOS)
    w, h = size
    title_f = font(title_px, 750)
    tag_f = font(tag_px, 450)
    d = ImageDraw.Draw(bg)
    text_w = max(d.textlength(TITLE, font=title_f), d.textlength(TAGLINE, font=tag_f))
    gap = int(logo_px * 0.22)
    x0 = int((w - (logo_px + gap + text_w)) / 2)
    ly = int((h - logo_px) / 2)

    # Soft halo behind the logo so the indigo bubble reads on the dark ground.
    halo = Image.new("RGBA", size, (0, 0, 0, 0))
    cx, cy, r = x0 + logo_px / 2, ly + logo_px * 0.55, logo_px * 0.62
    ImageDraw.Draw(halo).ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 46))
    bg = Image.alpha_composite(bg, halo.filter(ImageFilter.GaussianBlur(logo_px * 0.12)))
    bg.alpha_composite(logo(logo_px), (x0, ly))

    d = ImageDraw.Draw(bg)
    tx = x0 + logo_px + gap
    block_h = title_px + int(tag_px * 0.55) + tag_px
    ty = int((h - block_h) / 2) - int(title_px * 0.12)
    d.text((tx, ty), TITLE, font=title_f, fill=(255, 255, 255, 255))
    d.text((tx + 2, ty + title_px + int(tag_px * 0.55)), TAGLINE, font=tag_f, fill=(199, 210, 254, 255))
    bg.convert("RGB").save(ASSETS / out_name, optimize=True)


if __name__ == "__main__":
    compose("banner-social-bg.jpg", (1280, 640), 184, 86, 27, "banner-social.png")
    compose("banner-readme-bg.jpg", (1200, 300), 150, 68, 24, "banner-readme.png")
