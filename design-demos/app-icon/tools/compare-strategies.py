"""Compare the three viable strategies on Microsoft's 3.0:1 bar.

  strategy 1  single asset, bright accent   (the first build)
  strategy 2  single asset, darkened accent (the compromise that passes)
  strategy 3  two assets, light + dark      (Microsoft's recommended route)

For strategy 3 each asset is judged against the theme it is FOR: the light-theme
asset against #f3f3f3, the dark-theme asset against #202020. Judging a dark-theme
asset against a light background would be measuring the wrong thing — that is what
the theme split exists to avoid.

    python design-demos/app-icon/tools/compare-strategies.py
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
FINAL = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'final', 'png')
TWO = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'twoasset')
PLATES = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'plates')


def acc():
    spec = importlib.util.spec_from_file_location('acc', os.path.join(HERE, 'acceptance.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    a = acc()
    light_bg, dark_bg = a.THEMES['light'], a.THEMES['dark']
    rows = []

    # strategy 1: the first build, bright accent (out/plates A-amber-437-cream-fi)
    for ident in ('A', 'B', 'C'):
        f = os.path.join(PLATES, f'{ident}-amber-437-{"cream-fi" if ident == "A" else "ink"}-16.png')
        if os.path.exists(f):
            l, _ = a.pass_fraction(f, 16, light_bg)
            d, _ = a.pass_fraction(f, 16, dark_bg)
            rows.append((f'{ident} 单套·亮琥珀', l, d))

    # strategy 2: the compromise (out/final)
    for ident in ('A', 'B', 'C'):
        f = os.path.join(FINAL, f'{ident}-16.png')
        if os.path.exists(f):
            l, _ = a.pass_fraction(f, 16, light_bg)
            d, _ = a.pass_fraction(f, 16, dark_bg)
            rows.append((f'{ident} 单套·压暗', l, d))

    # strategy 3: two assets, each judged on the theme it is for
    for ident in ('A', 'B', 'C'):
        lf = os.path.join(TWO, f'{ident}-light-16.png')
        df = os.path.join(TWO, f'{ident}-dark-16.png')
        if os.path.exists(lf) and os.path.exists(df):
            l, _ = a.pass_fraction(lf, 16, light_bg)
            d, _ = a.pass_fraction(df, 16, dark_bg)
            rows.append((f'{ident} 双套·分判', l, d))

    print("Microsoft's bar: >=50% of the icon at >=3.0:1, at 16px\n")
    print(f"{'strategy':<20}{'Light':>8}{'Dark':>8}{'worst':>8}   verdict")
    print('-' * 54)
    for name, l, d in rows:
        worst = min(l, d)
        print(f'{name:<20}{l * 100:>7.0f}%{d * 100:>7.0f}%{worst * 100:>7.0f}%   {"PASS" if worst >= .5 else "fail"}')

    print('\nnote: strategy 3 judges the light asset on light and the dark asset on dark —')
    print('that is the whole point of shipping two assets, and it is what Microsoft argues for.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
