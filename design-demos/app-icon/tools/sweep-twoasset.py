"""Settle the two-asset construction by measurement instead of by hand.

The constraint, solved rather than eyeballed: a pixel clears 3.0:1 against
#f3f3f3 (L=.8963) only if its own luminance is <= 0.2654, and against #202020
(L=.0144) only if it is >= 0.1433. So:

  light-theme asset  must be mostly DARK  (the plate passes, the glyph does not)
  dark-theme asset   must be mostly BRIGHT (the plate passes, the glyph does not)

Which means: for each direction, in each theme, the PLATE has to own at least half
of the icon's area. That is a fact about the metric, not a preference, and it is
what the sweep below measures. It also explains why a single asset can never pass
both themes: a plate cannot be dark and bright at once.

Writes out/twoasset/sweep.json with the measured pass fraction for each variant.
"""

import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
TWO = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'twoasset')


def acc():
    spec = importlib.util.spec_from_file_location('acc', os.path.join(HERE, 'acceptance.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    a = acc()
    with open(os.path.join(TWO, 'made.json'), encoding='utf-8') as fh:
        made = json.load(fh)

    rows = []
    for m in made:
        path = os.path.join(TWO, f"{m['name']}-16.png")
        if not os.path.exists(path):
            continue
        theme = 'light' if m['name'].endswith('-light') else 'dark'
        bg = a.THEMES[theme]
        frac, _ = a.pass_fraction(path, 16, bg)
        rows.append({'variant': m['name'], 'judged_on': theme, 'pass': frac})

    rows.sort(key=lambda r: (r['judged_on'], -r['pass']))
    print("two-asset variants, each judged on the theme it is FOR\n")
    print(f"{'variant':<16}{'theme':>8}{'pass':>8}   verdict")
    print('-' * 42)
    for r in rows:
        print(f"{r['variant']:<16}{r['judged_on']:>8}{r['pass'] * 100:>7.0f}%   "
              f"{'PASS' if r['pass'] >= 0.5 else 'fail'}")

    with open(os.path.join(TWO, 'sweep.json'), 'w', encoding='utf-8') as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
