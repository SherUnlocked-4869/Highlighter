# Composite the REAL translucent captures over a synthetic desktop.
#
# probe-glass.js proves the strip's interior has alpha < 255 (it is genuinely
# translucent). A PNG with alpha alone still looks like a pale rectangle until
# something sits behind it, which is exactly the mistake the first landing made:
# the material was there in principle but had nothing to show through.
#
# This script does what the user's screen does: it paints a desktop, then alpha-
# composites the captured window over it. The desktop is drawn from the same
# values the direction's prototype used for its backdrop, so the comparison with
# the approved prototype is honest.
#
# Run: python tools/compose_glass.py
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
GLASS = os.path.join(ROOT, 'shots', 'glass')
OUT = GLASS

FONT_DIR = r'C:\Windows\Fonts'
def font(candidates, size):
    for name in candidates:
        path = os.path.join(FONT_DIR, name)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()

F_LABEL = font(['msyhbd.ttc', 'msyh.ttc'], 24)
F_SMALL = font(['msyh.ttc'], 19)
F_TITLE = font(['msyhbd.ttc'], 34)


def desktop(size, theme):
    """A plausible desktop: gradient, two tinted blooms, a window card, a taskbar.

    Deliberately CONTENTFUL — a flat backdrop is what makes glass look like grey
    paint, and that is the specific defect this image has to disprove.
    """
    w, h = size
    if theme == 'light':
        top, mid, bot = (245, 231, 205), (214, 198, 171), (168, 152, 121)
        win, win2 = (255, 246, 230), (125, 138, 99)
        bar = (38, 30, 22, 56)
    else:
        top, mid, bot = (69, 59, 48), (42, 36, 29), (22, 19, 16)
        win, win2 = (58, 51, 42), (25, 21, 17)
        bar = (8, 6, 4, 102)

    bg = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(bg)
    for y in range(h):
        t = y / max(1, h - 1)
        if t < 0.58:
            k = t / 0.58
            colour = tuple(round(top[i] + (mid[i] - top[i]) * k) for i in range(3))
        else:
            k = (t - 0.58) / 0.42
            colour = tuple(round(mid[i] + (bot[i] - mid[i]) * k) for i in range(3))
        d.line([(0, y), (w, y)], fill=colour)

    blooms = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blooms)
    bd.ellipse([-w // 7, h // 5, w // 2, h], fill=(230, 183, 132, 150))
    bd.ellipse([w // 2, h // 3, w + w // 6, h + h // 4], fill=(154, 168, 126, 130))
    blooms = blooms.filter(ImageFilter.GaussianBlur(58))
    bg = Image.alpha_composite(bg.convert('RGBA'), blooms)

    # A "someone else's window" so the glass has an edge to blur across.
    d = ImageDraw.Draw(bg)
    card = Image.new('RGBA', (int(w * 0.42), int(h * 0.62)), win + (255,))
    cd = ImageDraw.Draw(card)
    cd.rectangle([0, 0, card.width, 26], fill=(0, 0, 0, 16))
    for i in range(7):
        cd.rounded_rectangle([20, 52 + i * 26, 20 + int(card.width * (0.5 + 0.3 * ((i * 7) % 5) / 4)), 60 + i * 26],
                            4, fill=(0, 0, 0, 22))
    bg.alpha_composite(card, (int(w * 0.55), int(h * 0.16)))

    accent = Image.new('RGBA', (int(w * 0.2), int(h * 0.3)), win2 + (255,))
    bg.alpha_composite(accent, (int(-w * 0.03), int(h * 0.42)))

    d = ImageDraw.Draw(bg)
    d.rectangle([0, h - 34, w, h], fill=bar)
    for i in range(5):
        d.rounded_rectangle([16 + i * 34, h - 27, 40 + i * 34, h - 7], 5, fill=(255, 255, 255, 60))
    return bg


def build(theme):
    strip = Image.open(os.path.join(GLASS, f'toolbar-{theme}.png')).convert('RGBA')
    # Trim the transparent margin so the strip is measured, not floated.
    bbox = strip.getbbox()
    if bbox:
        strip = strip.crop(bbox)

    pad = 96
    width = strip.width + pad * 2
    height = strip.height + pad * 2 + 150
    canvas = desktop((width, height), theme)

    # Put the strip over the busiest part of the backdrop: a glass strip over
    # emptiness is exactly the failure mode being corrected.
    canvas.alpha_composite(strip, (pad, pad + 110))

    d = ImageDraw.Draw(canvas)
    ink = (29, 26, 22) if theme == 'light' else (244, 239, 228)
    sub = (79, 72, 57) if theme == 'light' else (179, 170, 150)
    d.text((pad, 34), '划词工具条 · 真实半透明窗口', font=F_TITLE, fill=ink)
    d.text((pad, 78), '下面这张是真实的透明窗口截图，叠在绘制的桌面内容上 —— 玻璃后面有东西可透。',
           font=F_SMALL, fill=sub)
    d.text((pad, pad + 110 + strip.height + 22),
           '窗体内 alpha ≈ 208–222（半透明），角落 alpha = 0（真透明）；'
           '填充来自 --glass-3 + blur 20px + saturate 1.18（历史截图；当前 --glass-blur-3 = 36px）。',
           font=F_SMALL, fill=sub)

    out = os.path.join(OUT, f'glass-{theme}.png')
    canvas.convert('RGB').save(out, quality=95)
    print(out, canvas.size)


if __name__ == '__main__':
    for theme in ('light', 'dark'):
        build(theme)
