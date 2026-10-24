"""Score the plate/glyph sweep against Microsoft's 3.0:1 bar.

Reads out/plates/made.json (written by plate-sweep.mjs), measures each variant at
16px on both themes, and prints the ranking plus the best variant per mark.

    python design-demos/app-icon/tools/score-plates.py
"""

import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PLATES = os.path.join(ROOT, 'design-demos', 'app-icon', 'out', 'plates')


def load_acceptance():
    spec = importlib.util.spec_from_file_location('acc', os.path.join(HERE, 'acceptance.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    acc = load_acceptance()
    with open(os.path.join(PLATES, 'made.json'), encoding='utf-8') as fh:
        made = json.load(fh)

    rows = []
    for m in made:
        path = os.path.join(PLATES, m['name'] + '-16.png')
        if not os.path.exists(path):
            continue
        light, _ = acc.pass_fraction(path, 16, acc.THEMES['light'])
        dark, _ = acc.pass_fraction(path, 16, acc.THEMES['dark'])
        rows.append((m['name'], min(light, dark), light, dark))

    rows.sort(key=lambda r: -r[1])
    print(f"{'variant':<32}{'min':>8}{'light':>8}{'dark':>7}")
    print('-' * 55)
    for name, worst, light, dark in rows[:24]:
        print(f'{name:<32}{worst * 100:>7.0f}%{light * 100:>7.0f}%{dark * 100:>6.0f}%')

    print('\nbest per mark:')
    best = {}
    for name, worst, light, dark in rows:
        mark = name.split('-')[0]
        if mark not in best:
            best[mark] = (name, worst, light, dark)
    for mark, (name, worst, light, dark) in sorted(best.items()):
        verdict = 'PASS' if worst >= 0.5 else 'fail'
        print(f'  {mark}: {name:<32} min={worst * 100:>3.0f}%  (light {light * 100:.0f}% / dark {dark * 100:.0f}%)  {verdict}')


if __name__ == '__main__':
    main()
