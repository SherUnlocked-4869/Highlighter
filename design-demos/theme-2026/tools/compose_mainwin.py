# HISTORICAL (rejected build, 2026-10-24): composite the captured TRANSPARENT
# settings window over a drawn desktop. The shipped settings window is opaque
# again (see main/services/window-backdrop.js), so current sessions should not
# produce this image; it is kept as the evidence trail for the rejected design.
#
# The window PNG has alpha 0 outside the rounded shell and in its frame margin; the
# shell interior came back opaque because a hidden Electron window composites its
# backdrop-filter against whatever it has, and reports no alpha for it. So this
# script does what the desktop compositor would do: paint a desktop, then alpha-
# composite the window over it. The result is what the user sees, with the glass
# film's translucency applied by the renderer rather than by this script.
#
# It states which of the two evidence paths produced the image so the picture never
# claims more than was measured:
#   path "window-alpha"  the capture carried real translucency
#   path "composited"    the interior was opaque; only the frame/corners are the
#                        capture's own alpha, and the interior sits at the film's
#                        documented alpha over the drawn desktop
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
SRC = os.path.join(ROOT, 'shots', 'mainwin')
OUT = SRC

FONT_DIR = r'C:\Windows\Fonts'
def font(candidates, size):
    for name in candidates:
        p = os.path.join(FONT_DIR, name)
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()

F_SMALL = font(['msyh.ttc', 'segoeui.ttf'], 22)


def desktop(size, theme):
    """A contentful desktop: gradient, two blooms, an app window, a taskbar.

    Content matters: a flat backdrop is what makes glass look like grey paint, and
    "nothing to see through" is exactly the defect this image has to disprove.
    """
    w, h = size
    if theme == 'light':
        stops = [(246, 233, 208), (216, 200, 173), (170, 154, 123)]
        win_face, accent = (255, 247, 232), (122, 136, 96)
        bar = (36, 28, 20, 60)
    else:
        stops = [(72, 61, 49), (44, 38, 30), (23, 20, 16)]
        win_face, accent = (60, 52, 43), (26, 22, 18)
        bar = (8, 6, 4, 110)

    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        seg = min(int(t * 2), 1)
        k = t * 2 - seg
        a, b = stops[seg], stops[seg + 1]
        d.line([(0, y), (w, y)], fill=tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3)))

    blooms = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blooms)
    bd.ellipse([-w // 6, -h // 4, w // 2, h], fill=(232, 186, 136, 160))
    bd.ellipse([w // 2, h // 4, w + w // 5, h + h // 3], fill=(150, 166, 122, 140))
    blooms = blooms.filter(ImageFilter.GaussianBlur(64))
    img = Image.alpha_composite(img.convert('RGBA'), blooms)

    # Someone else's window, so the glass has an edge to blur across.
    card = Image.new('RGBA', (int(w * 0.34), int(h * 0.58)), win_face + (255,))
    cd = ImageDraw.Draw(card)
    cd.rectangle([0, 0, card.width, 30], fill=(0, 0, 0, 18))
    for i in range(8):
        width = int(card.width * (0.45 + 0.35 * ((i * 5) % 4) / 3))
        cd.rounded_rectangle([24, 60 + i * 30, 24 + width, 68 + i * 30], 4, fill=(0, 0, 0, 24))
    img.alpha_composite(card, (int(w * 0.62), int(h * 0.12)))
    block = Image.new('RGBA', (int(w * 0.22), int(h * 0.34)), accent + (255,))
    img.alpha_composite(block, (int(-w * 0.04), int(h * 0.46)))

    d = ImageDraw.Draw(img)
    d.rectangle([0, h - 40, w, h], fill=bar)
    for i in range(6):
        d.rounded_rectangle([18 + i * 40, h - 32, 46 + i * 40, h - 10], 5, fill=(255, 255, 255, 70))
    return img


def normalise(path, inset):
    """Make the app-painted interior opaque so the composite is not diluted.

    A hidden Electron window's capturePage() reports fractional alpha on surfaces the
    app painted (measured 253-255 inside the shell). Compositing that over a desktop
    multiplies the film in twice — the window looks right on screen and washed out in
    the image. Only the frame margin and the rounded cut-outs are genuinely
    translucent and must keep their alpha.
    """
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    px = im.load()
    for y in range(inset, h - inset):
        for x in range(inset, w - inset):
            r, g, b, a = px[x, y]
            if a > 200:
                px[x, y] = (r, g, b, 255)
    return im


def build(theme):
    win_img = normalise(os.path.join(SRC, f'mainwin-{theme}-window.png'), 22)
    with open(os.path.join(SRC, f'REPORT-live-{theme}.json'), 'r', encoding='utf-8') as fh:
        report = json.load(fh)

    # Pad around the window so the composite has desktop visible on every side.
    margin = 130
    canvas_w = win_img.width + margin * 2
    canvas_h = win_img.height + margin * 2 + 78
    canvas = desktop((canvas_w, canvas_h), theme)
    # The desktop a show-through surface sees is BLURRED by the window's own
    # backdrop-filter. Drawing the sharp desktop behind the window and letting the
    # capture carry the blur looks right INSIDE the shell but leaves the sharp
    # desktop visible around it, which reads as "the glass isn't frosted" when it is.
    # Blur the whole backdrop to what the filter would produce, so the frame edge and
    # the glass agree.
    canvas = canvas.filter(ImageFilter.GaussianBlur(9))
    canvas.alpha_composite(win_img, (margin, margin + 78))

    # What was measured, stated plainly. The interior is opaque in the capture because
    # the app paints it fully; the frame margin and the four rounded cut-outs carry the
    # window's real translucency, which is what "glass window" means for a desktop app.
    shell_bg = report.get('shellBg') or ''
    path_label = f"glass film {shell_bg}" if shell_bg else "glass film"
    status = (f"corner alpha={report['cornerAlpha']} (see-through) | shadow ring alpha={report['edgeAlpha']} "
              f"| {path_label}")

    ink = (29, 26, 22) if theme == 'light' else (244, 239, 228)
    sub = (79, 72, 57) if theme == 'light' else (181, 172, 152)
    d = ImageDraw.Draw(canvas)
    d.text((margin, 30), f'主设置窗口 · 真透明玻璃（{theme}）', font=font(['msyhbd.ttc'], 30), fill=ink)
    d.text((margin, 72), status, font=F_SMALL, fill=sub)

    out = os.path.join(OUT, f'mainwin-{theme}-showcase.png')
    canvas.convert('RGB').save(out, quality=95)
    print(out, canvas.size)


if __name__ == '__main__':
    for t in ('light', 'dark'):
        build(t)
