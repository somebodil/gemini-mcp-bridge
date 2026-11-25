# Draws the extension's icons (static/icons/*.png): two linked rings, a bridge between
# Gemini and the computer. Run: uv run --no-project --with pillow python scripts/icons.py
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "static" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SCALE = 8  # draw large, then shrink: smooth edges


def icon(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = s * 0.04
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=s * 0.22, fill=(11, 87, 208, 255))
    w = max(SCALE * 1.6, s * 0.085)
    r = s * 0.2
    cy = s * 0.5
    for cx, color in ((s * 0.38, (255, 255, 255, 255)), (s * 0.62, (168, 199, 250, 255))):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=int(w))
    return img.resize((size, size), Image.LANCZOS)


for n in (16, 32, 48, 128):
    icon(n).save(OUT / f"{n}.png")
print("icons:", ", ".join(str(OUT / f"{n}.png") for n in (16, 32, 48, 128)))
