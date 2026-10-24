"""Sweep the tile rim on a dark taskbar and report the measured separation.

The first measurement pass showed direction A and C nearly vanish on a #202020
taskbar (sepDark 2.38 / 1.38) even though they look fine on white — exactly the
failure the eye forgives on a light review sheet. This sweeps rim width and
opacity so the fix is a measured value rather than a guess.

    python design-demos/app-icon/tools/tune-dark-edge.py
"""

import math
import os
import subprocess

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
WORK = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'tune')

DARK_BG = 0.0144  # relative luminance of #202020
LIGHT_BG = 1.0     # #ffffff


def rel_lum(r, g, b):
    def f(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def edge_lum(path, size):
    """Mean luminance of the ring that bounds the silhouette (r 0.80–0.94)."""
    im = Image.open(path).convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    px = im.load()
    half = size / 2
    total, n = 0.0, 0
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - half + 0.5, y - half + 0.5) / half
            if 0.80 <= d <= 0.94:
                r, g, b, a = px[x, y]
                # composite over the background so alpha is accounted for
                r = r * a / 255.0
                g = g * a / 255.0
                b = b * a / 255.0
                total += rel_lum(r, g, b)
                n += 1
    return total / n if n else 0.0


def sep(lum, bg):
    return (max(lum, bg) + 0.05) / (min(lum, bg) + 0.05)


def main():
    import json
    os.makedirs(WORK, exist_ok=True)
    result = subprocess.run(
        ['node', os.path.join(HERE, 'tune-dark-edge.mjs')],
        cwd=ROOT, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise SystemExit(result.returncode)

    variants = json.loads(result.stdout.strip().splitlines()[-1])
    print(f"{'variant':<34}{'sepLight':>10}{'sepDark':>9}{'verdict':>10}")
    print('-' * 63)
    for v in variants:
        path = os.path.join(WORK, v['file'])
        lum = edge_lum(path, 16)
        sl, sd = sep(lum, LIGHT_BG), sep(lum, DARK_BG)
        worst = min(sl, sd)
        verdict = 'ok' if worst >= 2.0 else 'weak'
        print(f"{v['name']:<34}{sl:>10.2f}{sd:>9.2f}{verdict:>10}")


if __name__ == '__main__':
    main()
