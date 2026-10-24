"""Quantitative legibility check for the three icon directions.

Eyeballing a zoomed 16px raster is necessary but not sufficient: what decides
whether an icon survives a taskbar is how much interior contrast is left after the
OS shrinks it and the eye blurs it. Measured on the real rasters:

  1. avgStep      mean absolute luminance step between adjacent pixels — is
                  anything there at all at this size
  2. lumRange     max-min luminance — how much tonal range survived
  3. qSpread      spread between the four quadrant means — a PATTERN has spread,
                  a solid blob does not
  4. ctrEdge      centre mass vs rim mass — separates "object with a shape" from
                  "flat tile"
  5. sepLight /   separation of the tile's EDGE from #ffffff and from #202020, the
     sepDark      two backgrounds a taskbar actually uses. Measured on the edge
                  band, not on the disc mean: a dark tile with a bright interior
                  (direction A) averages to mid grey and would look like it fails
                  a mean-based test, while what the eye actually detects is the
                  silhouette's own edge.

These are comparative numbers, not a pass/fail standard — an icon is not text, so
no WCAG rule applies. What they catch is the failure the eye forgives: "looks fine
at 8×, is one grey smudge at 1×".

    python design-demos/app-icon/tools/verify.py
"""

import json
import math
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PNG_DIR = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'final', 'png')
OUT = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'final', 'verify.json')
IDS = ['A', 'B', 'C']


def rel_lum(r, g, b):
    def f(c):
        s = c / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def analyse(path, size):
    im = Image.open(path).convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    px = im.load()

    L = [[0.0] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            r, g, b, _a = px[x, y]
            L[y][x] = rel_lum(r, g, b)

    steps, n = 0.0, 0
    for y in range(size):
        for x in range(size - 1):
            steps += abs(L[y][x] - L[y][x + 1])
            n += 1
    for x in range(size):
        for y in range(size - 1):
            steps += abs(L[y][x] - L[y + 1][x])
            n += 1

    flat = [v for row in L for v in row]
    lum_range = max(flat) - min(flat)

    q, qn = [0.0] * 4, [0] * 4
    for y in range(size):
        for x in range(size):
            idx = (0 if y < size / 2 else 2) + (0 if x < size / 2 else 1)
            q[idx] += L[y][x]
            qn[idx] += 1
    qm = [q[i] / qn[i] for i in range(4)]
    q_spread = max(qm) - min(qm)

    centre, cn, edge, en = 0.0, 0, 0.0, 0
    r1, r2 = size * 0.30, size * 0.42
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5)
            if d < r1:
                centre += L[y][x]
                cn += 1
            elif d > r2:
                edge += L[y][x]
                en += 1
    ctr_edge = abs(centre / cn - edge / en) if cn and en else 0.0

    # Silhouette separation: the ring just inside the tile edge (r 0.87–0.98 of
    # half-size), i.e. the pixels that actually bound the shape against a taskbar.
    total, tn = 0.0, 0
    half = size / 2
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - half + 0.5, y - half + 0.5) / half
            if 0.80 <= d <= 0.94:
                total += L[y][x]
                tn += 1
    mean = total / tn if tn else 0.0

    def sep(bg):
        return (max(mean, bg) + 0.05) / (min(mean, bg) + 0.05)

    return {
        'size': size,
        'avgStep': round(steps / n, 4),
        'lumRange': round(lum_range, 3),
        'qSpread': round(q_spread, 3),
        'ctrEdge': round(ctr_edge, 3),
        'sepLight': round(sep(1.0), 2),
        'sepDark': round(sep(0.0144), 2),
    }


def main():
    rows = []
    for ident in IDS:
        for size in (16, 20, 24, 32, 48, 64):
            path = os.path.join(PNG_DIR, f'{ident}-{size}.png')
            if not os.path.exists(path):
                continue
            rows.append({'id': ident, **analyse(path, size)})

    header = f"{'id':<3}{'size':>5}{'avgStep':>10}{'lumRange':>10}{'qSpread':>9}{'ctrEdge':>9}{'sepLight':>10}{'sepDark':>9}"
    print(header)
    print('-' * len(header))
    for r in rows:
        print(
            f"{r['id']:<3}{r['size']:>5}{r['avgStep']:>10.4f}{r['lumRange']:>10.3f}"
            f"{r['qSpread']:>9.3f}{r['ctrEdge']:>9.3f}{r['sepLight']:>10.2f}{r['sepDark']:>9.2f}"
        )

    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)
    print('\nwritten:', OUT)


if __name__ == '__main__':
    main()
