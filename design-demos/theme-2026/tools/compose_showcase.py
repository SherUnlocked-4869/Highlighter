# Composite the real window captures into the showcase image.
#
# Every tile in the output is a screenshot of the actual product window, taken by
# tools/showcase.js from a real Electron renderer with the B1 palette already
# applied (shared/tokens.css). Nothing here is redrawn, recoloured, or mocked: this
# script only arranges the pixels, adds the desktop backdrop the overlays float
# over, and labels each tile.
#
# Two variants are produced:
#   showcase-light.png  settings window + capture overlay + clipboard + toolbar + search
#   showcase-dark.png   the same set in dark mode
#
# Run: python tools/compose_showcase.py
import json
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
SHOTS = os.path.join(ROOT, 'shots', 'showcase')
OUT = SHOTS

# Windows system fonts only: this repo's renderer CSP forbids web fonts, and the
# composite is meant to look like the product, not like a design mockup.
FONT_DIR = r'C:\Windows\Fonts'
def font(name, size):
    for candidate in name:
        path = os.path.join(FONT_DIR, candidate)
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()

F_LABEL = font(['msyhbd.ttc', 'msyh.ttc', 'segoeuib.ttf'], 27)
F_SUB = font(['msyh.ttc', 'segoeui.ttf'], 22)
F_TITLE = font(['msyhbd.ttc', 'segoeuib.ttf'], 46)
F_TITLE_SUB = font(['msyh.ttc', 'segoeui.ttf'], 25)
F_MONO = font(['consola.ttf', 'cour.ttf'], 20)

THEMES = {
    'light': {
        # The desktop the overlays float over. Warm neutral so the floating
        # surfaces read as warm rather than as grey cut-outs.
        'desk_top': (206, 197, 182),
        'desk_bottom': (176, 166, 150),
        'card': (247, 243, 234),
        'card_edge': (222, 217, 201),
        'title': (29, 26, 22),
        'sub': (79, 72, 57),
        'label': (60, 54, 45),
        'accent': (229, 164, 76),
        'shadow': (120, 106, 84, 70),
    },
    'dark': {
        'desk_top': (28, 26, 22),
        'desk_bottom': (20, 18, 15),
        'card': (36, 33, 28),
        'card_edge': (58, 53, 45),
        'title': (244, 239, 228),
        'sub': (179, 170, 150),
        'label': (207, 199, 184),
        'accent': (229, 164, 76),
        'shadow': (0, 0, 0, 110),
    },
}

W = 2400
MARGIN = 96
GAP = 44


def vertical_gradient(size, top, bottom):
    """A plain two-stop gradient: the desktop behind the floating surfaces."""
    w, h = size
    grad = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        grad.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return grad.resize((w, h))


def drop_shadow(card, blur=26, offset=(0, 10), colour=(120, 106, 84, 70)):
    """A soft shadow so the capsuled tiles read as floating, matching the language."""
    pad = blur * 3
    canvas = Image.new('RGBA', (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new('RGBA', card.size, (0, 0, 0, 0))
    alpha = card.split()[-1] if card.mode == 'RGBA' else None
    shadow.paste(Image.new('RGBA', card.size, colour), (0, 0), alpha)
    canvas.paste(shadow, (pad + offset[0], pad + offset[1]))
    canvas.paste(card, (pad, pad), card if card.mode == 'RGBA' else None)
    return canvas, pad


def rounded(img, radius):
    """Round a screenshot's corners the way the product's own shell does."""
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def tile(path, width, radius=22):
    """Load a capture, scale it to `width`, round its corners, add a rim."""
    img = Image.open(path).convert('RGB')
    height = round(img.height * width / img.width)
    img = img.resize((width, height), Image.LANCZOS)
    card = rounded(img, radius)
    # 1px rim: the product's own --line-2, so the tile edge matches the window edge.
    rim = Image.new('RGBA', card.size, (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle(
        [0, 0, card.width - 1, card.height - 1], radius, outline=(0, 0, 0, 46), width=2)
    card = Image.alpha_composite(card, rim)
    return card


def build(theme_name):
    t = THEMES[theme_name]

    def shot(name, width, radius):
        # Both themes were captured from the SAME live window (only body.dark
        # toggled), so picking the matching file is enough — nothing is recoloured.
        return tile(os.path.join(SHOTS, f'{name}-{theme_name}.png'), width, radius=radius)

    home = shot('config-home', 1500, 20)
    clip = shot('clipboard', 470, 16)
    search = shot('search', 640, 16)
    toolbar = shot('toolbar', 700, 14)

    # layout
    # Row 1: the settings window (left) + a column of the three floaters (right).
    # Row 2: the capture overlay, scaled to the SAME content width so both rows
    # share a right edge. An unaligned second row was the first version's biggest
    # visual defect, and it made the capture look like an afterthought when it is
    # actually the screen this product IS.
    right_col_w = max(clip.width, search.width, toolbar.width)
    header_h = 250
    row1_h = max(home.height, clip.height + search.height + toolbar.height + GAP * 2)
    row1_w = home.width + GAP + right_col_w
    content_w = row1_w
    # Match the settings window's width rather than the content width: the overlay
    # is a 1.45:1 frame, so at full width it grew taller than everything above it
    # and stole the composition. Same width = same visual weight, and the row still
    # shares its left edge.
    capture = tile(os.path.join(SHOTS, f'capture-{theme_name}.png'), home.width, radius=18)

    canvas_w = content_w + MARGIN * 2
    canvas_h = header_h + row1_h + GAP * 3 + capture.height + MARGIN

    bg = vertical_gradient((canvas_w, canvas_h), t['desk_top'], t['desk_bottom']).convert('RGBA')
    canvas = bg

    draw = ImageDraw.Draw(canvas)
    # Header
    x0 = MARGIN
    draw.text((x0, 62), 'Highlighter · 主题效果图', font=F_TITLE, fill=t['title'])
    draw.text((x0, 130), 'B1「浮层优先 FILM」已落进产品：以下每一块都是真实 Electron 窗口的截图，不是原型。',
              font=F_TITLE_SUB, fill=t['sub'])
    # A short accent rule, the one place the accent appears outside the UI. It sits
    # BELOW the subtitle and the mode label is right-aligned, so nothing overlaps:
    # the first version drew the label on top of the rule and clipped the title.
    draw.rounded_rectangle([x0, 198, x0 + 96, 202], 2, fill=t['accent'])
    mode = 'LIGHT MODE' if theme_name == 'light' else 'DARK MODE'
    mode_w = draw.textlength(mode, font=F_MONO)
    draw.text((canvas_w - MARGIN - mode_w, 74), mode, font=F_MONO, fill=t['accent'])

    def place(card, x, y, label):
        shadowed, pad = drop_shadow(card, blur=26, offset=(0, 14), colour=t['shadow'])
        canvas.alpha_composite(shadowed, (x - pad, y - pad))
        if label:
            draw.text((x, y + card.height + 16), label, font=F_LABEL, fill=t['label'])

    row1_y = header_h
    place(home, MARGIN, row1_y, '主设置窗口 · 1120 × 760')
    right_x = MARGIN + home.width + GAP
    y = row1_y
    place(clip, right_x, y, '剪贴板面板 · 480 × 640')
    y += clip.height + GAP + 26
    place(search, right_x, y, '本地搜索 · 720 × 520')
    y += search.height + GAP + 26
    place(toolbar, right_x, y, '划词工具条 · 620 × 56')

    row2_y = row1_y + row1_h + GAP * 2 + 70
    place(capture, MARGIN, row2_y, '截图浮层 · 选区 + 两行 27 控件工具条（真实截图窗口）')

    foot_y = row2_y + capture.height + 78
    draw.text((MARGIN, foot_y),
              '调色 / 圆角 / 阴影均来自 shared/tokens.css，无一处为效果图特调。',
              font=F_SUB, fill=t['sub'])

    # Trim any slack the layout left at the edges.
    used_h = min(canvas_h, foot_y + 56 + MARGIN // 2)
    canvas = canvas.crop((0, 0, canvas_w, used_h))
    out = os.path.join(OUT, f'showcase-{theme_name}.png')
    canvas.convert('RGB').save(out, quality=95)
    print(out, canvas.size)


if __name__ == '__main__':
    for theme in ('light', 'dark'):
        build(theme)
