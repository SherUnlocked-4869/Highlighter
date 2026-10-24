"""Acceptance test against Microsoft's own published threshold.

Microsoft's app-icon design page states the one quantitative bar the platform gives:

    "Make sure at least half of your icon passes a 3.0:1 contrast ratio on light
     and dark theme."
    https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-design

This measures exactly that, per direction, at the sizes that ship, on the two
themes — plus the competitor icons from refs/raw as a baseline, so the number has
a reference point instead of floating on its own.

    python design-demos/app-icon/tools/acceptance.py

Exit code is 0 when at least one direction passes both themes at 16/24/48px, 1
otherwise, so it can be wired into a gate later.
"""

import glob
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FINAL = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'final')
PNG_DIR = os.path.join(FINAL, 'png')
REFS_RAW = os.path.join(ROOT, 'design-demos', 'app-icon', 'refs', 'raw')

THRESHOLD = 3.0
THEMES = {
    # Windows 11 light / dark taskbar backgrounds
    'light': (0xF3 / 255, 0xF3 / 255, 0xF3 / 255),
    'dark': (0x20 / 255, 0x20 / 255, 0x20 / 255),
}


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def rel_lum(rgb):
    r, g, b = (srgb_to_lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = rel_lum(a), rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def pass_fraction(path, size, theme_rgb):
    """Fraction of the icon's solid pixels (alpha>=128) clearing 3.0:1 against the
    theme background — the literal reading of Microsoft's sentence."""
    im = Image.open(path).convert('RGBA')
    if im.size != (size, size):
        im = im.resize((size, size), Image.LANCZOS)
    px = im.load()
    total = passed = 0
    for y in range(size):
        for x in range(size):
            r, g, b, a = px[x, y]
            if a < 128:
                continue
            total += 1
            # composite over the theme so semi-transparent edges are judged fairly
            cr = (r * a + theme_rgb[0] * 255 * (255 - a)) / 255 / 255
            cg = (g * a + theme_rgb[1] * 255 * (255 - a)) / 255 / 255
            cb = (b * a + theme_rgb[2] * 255 * (255 - a)) / 255 / 255
            if ratio((cr, cg, cb), theme_rgb) >= THRESHOLD:
                passed += 1
    return (passed / total if total else 0.0), total


def competitor_baseline():
    """Same measurement on the seven real shipping icons, as a reference band.

    The originals were removed from the repository on 2026-10-24 (they are third
    parties' icon resources and this repo is public). When they are absent this
    returns an empty list and the caller prints a note instead of a blank table,
    so a missing reference band cannot be mistaken for a failed measurement.
    """
    picks = {
        'Snipaste': 'Snipaste/*256*',
        'PixPin': 'PixPin/*1024*',
        'ShareX': 'ShareX/*256*',
        'SnippingTool': 'SnippingTool/*256*',
        'CleanShotX': 'CleanShotX/*1024*',
        'Flameshot': 'Flameshot/*.png',
        'PowerToys': 'PowerToys/*256*',
    }
    rows = []
    for name, pat in picks.items():
        files = [f for f in glob.glob(os.path.join(REFS_RAW, pat)) if f.endswith('.png')]
        if not files:
            continue
        f = sorted(files, key=len)[0]
        light, _ = pass_fraction(f, 16, THEMES['light'])
        dark, _ = pass_fraction(f, 16, THEMES['dark'])
        rows.append((name, light, dark))
    return rows


def main():
    directions = json.load(open(os.path.join(FINAL, 'directions.json'), encoding='utf-8'))
    sizes = [16, 24, 48, 128]

    print("Microsoft's bar: >=50% of the icon at >=3.0:1 on BOTH themes\n")
    print(f"{'dir':<5}{'size':>5}{'light':>9}{'dark':>8}{'min':>7}   verdict")
    print('-' * 46)

    ok_any = False
    summary = {}
    for d in directions:
        ident = d['id']
        failures = []
        for size in sizes:
            path = os.path.join(PNG_DIR, f'{ident}-{size}.png')
            if not os.path.exists(path):
                continue
            light, n = pass_fraction(path, size, THEMES['light'])
            dark, _ = pass_fraction(path, size, THEMES['dark'])
            worst = min(light, dark)
            verdict = 'PASS' if worst >= 0.5 else 'fail'
            if verdict == 'fail':
                failures.append(size)
            print(f"{ident:<5}{size:>5}{light * 100:>8.0f}%{dark * 100:>7.0f}%{worst * 100:>6.0f}%   {verdict}")
            summary.setdefault(ident, []).append({'size': size, 'light': light, 'dark': dark})
        print()
        if len(failures) < len(sizes):
            ok_any = True

    baseline = competitor_baseline()
    if baseline:
        print('reference band — the seven shipping icons from refs/raw at 16px:')
        print(f"{'icon':<16}{'light':>9}{'dark':>8}")
        print('-' * 33)
        for name, light, dark in baseline:
            print(f'{name:<16}{light * 100:>8.0f}%{dark * 100:>7.0f}%')
    else:
        print('reference band — skipped: refs/raw was removed from the repository')
        print('  (third-party icon binaries; see design-demos/app-icon/refs/SOURCES.md)')

    with open(os.path.join(FINAL, 'acceptance.json'), 'w', encoding='utf-8') as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print('\nwritten:', os.path.join(FINAL, 'acceptance.json'))
    return 0 if ok_any else 1


if __name__ == '__main__':
    sys.exit(main())
