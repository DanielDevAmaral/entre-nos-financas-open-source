"""Render the Entre Nós vector mark at installation sizes (no font dependency)."""
from pathlib import Path
from PIL import Image, ImageDraw

folder = Path(__file__).resolve().parents[1] / "public/icons"
folder.mkdir(parents=True, exist_ok=True)
background, foreground = "#c5ab8b", "#29251f"
# Coordinates shared with the editable SVG, on a 512 × 512 canvas.
curves = [
    ((256,256),(216,216),(196,176),(148,176)),
    ((148,176),(100,176),(72,212),(72,256)),
    ((72,256),(72,300),(100,336),(148,336)),
    ((148,336),(196,336),(216,296),(256,256)),
    ((256,256),(296,216),(316,176),(364,176)),
    ((364,176),(412,176),(440,212),(440,256)),
    ((440,256),(440,300),(412,336),(364,336)),
    ((364,336),(316,336),(296,296),(256,256)),
]
points = []
for a,b,c,d in curves:
    for step in range(81):
        t = step / 80
        points.append(tuple((1-t)**3*a[k] + 3*(1-t)**2*t*b[k] + 3*(1-t)*t*t*c[k] + t**3*d[k] for k in (0,1)))
path = "M256 256 C216 216 196 176 148 176 C100 176 72 212 72 256 C72 300 100 336 148 336 C196 336 216 296 256 256 C296 216 316 176 364 176 C412 176 440 212 440 256 C440 300 412 336 364 336 C316 336 296 296 256 256"
(folder / "entre-nos-v2.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><title>Entre Nós</title><path fill="{background}" d="M0 0h512v512H0z"/><path d="{path}" fill="none" stroke="{foreground}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/></svg>\n', encoding="utf-8")
for size, name in [(192,"icon-192"),(512,"icon-512"),(180,"apple-touch-icon"),(1024,"ios-icon-1024")]:
    scale = size * 4 / 512
    image = Image.new("RGB", (size*4,size*4), background)
    ImageDraw.Draw(image).line([(round(x*scale),round(y*scale)) for x,y in points], fill=foreground, width=round(28*scale), joint="curve")
    image = image.resize((size,size), Image.Resampling.LANCZOS)
    image.save(folder / f"{name}-v2.png", optimize=True)
    # Keep legacy installation links working with the same new artwork.
    image.save(folder / f"{name}.png", optimize=True)
print("Ícones gerados: 180, 192, 512 e 1024 px, opacos e sem dependência de fonte.")
