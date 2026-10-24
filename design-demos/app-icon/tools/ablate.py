"""Measure the ablation variants (see ablate.mjs for what each one drops).

    python design-demos/app-icon/tools/ablate.py
"""

import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ABL = os.path.join(HERE, '..', 'out', 'ablate')


def acc():
    spec = importlib.util.spec_from_file_location('acc', os.path.join(HERE, 'acceptance.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    a = acc()
    made = json.load(open(os.path.join(ABL, 'made.json'), encoding='utf-8'))
    print(f"{'variant':<18}{'light':>8}{'dark':>7}{'worst':>8}")
    print('-' * 41)
    for m in made:
        p = os.path.join(ABL, m['name'] + '-16.png')
        if not os.path.exists(p):
            continue
        l, _ = a.pass_fraction(p, 16, a.THEMES['light'])
        d, _ = a.pass_fraction(p, 16, a.THEMES['dark'])
        print(f"{m['name']:<18}{l * 100:>7.0f}%{d * 100:>6.0f}%{min(l, d) * 100:>7.0f}%")


if __name__ == '__main__':
    main()
