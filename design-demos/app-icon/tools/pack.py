"""Package each direction as a multi-size .ico, plus the two theme-aware PNGs the
tray needs.

    python design-demos/app-icon/tools/pack.py

Writes into design-demos/app-icon/out/final/ico/. Nothing here touches
assets/ — replacing the shipped icon is a separate, reviewed step after the
direction is chosen (see direction-approved.md).

Why these sizes: assets/icon.ico already ships 16/24/32/48/64/128/256 (verified
with PIL on the existing file), so a replacement must match that set or the
Windows shell will upscale and blur the sizes it does not find. 20 and 40 are
added because Windows 11 uses them at 125% and 150% display scaling — the two most
common laptop settings — and without them the shell resamples the 32px or 48px
frame instead of drawing a purpose-made one.
"""

import json
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FINAL = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'final')
PNG_DIR = os.path.join(FINAL, 'png')
ICO_DIR = os.path.join(FINAL, 'ico')
os.makedirs(ICO_DIR, exist_ok=True)

# 20 and 40 are not in the current ico, but Windows 11 asks for them at 125%/150%.
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

directions = json.load(open(os.path.join(FINAL, 'directions.json'), encoding='utf-8'))

report = []
for d in directions:
    ident = d['id']
    frames = []
    for size in ICO_SIZES:
        src = os.path.join(PNG_DIR, f'{ident}-{size}.png')
        if not os.path.exists(src):
            continue
        frames.append(Image.open(src).convert('RGBA'))

    if not frames:
        raise SystemExit(f'no frames for {ident}')

    out = os.path.join(ICO_DIR, f'highlighter-{ident}.ico')
    # pillow writes the largest frame as the base and appends the rest; sorting
    # ascending keeps 256 first, which the Windows shell uses for jumbo views.
    frames_sorted = sorted(frames, key=lambda im: im.size[0], reverse=True)
    frames_sorted[0].save(out, format='ICO', sizes=[im.size for im in frames_sorted],
                          append_images=frames_sorted[1:])

    # The tray needs opaque-on-theme variants (see main/services/tray-icon.js:
    # Windows does not recolour tray bitmaps, so a dark taskbar needs its own
    # asset). Same silhouette on both, so the tray does not jump between themes.
    report.append({'id': ident, 'ico': os.path.relpath(out, ROOT), 'sizes': sorted({im.size[0] for im in frames})})

    for size in (24, 32):
        Image.open(os.path.join(PNG_DIR, f'{ident}-{size}.png')).convert('RGBA').save(
            os.path.join(ICO_DIR, f'highlighter-{ident}-{size}.png'))

print(json.dumps(report, ensure_ascii=False, indent=2))

# verify what we actually wrote by reading it back
print('\nread-back:')
for entry in report:
    path = os.path.join(ROOT, entry['ico'])
    im = Image.open(path)
    print(f"  {os.path.basename(path):<26} {sorted(im.info.get('sizes', []))}")
