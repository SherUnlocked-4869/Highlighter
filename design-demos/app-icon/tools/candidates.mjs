// Highlighter · app icon candidates — v5
//
// v3/v4 established the construction rules by rendering and actually looking at
// the 16px rasters:
//   · 16px holds ONE filled silhouette + ONE counter-form; outlines collapse;
//   · a keyline on the mark eats half of it — the mark is never outlined;
//   · a mid-tone plate is what lets one tile read on a white window and on a
//     #202020 taskbar at once, and it lets the glyph be ink rather than light;
//   · load-bearing edges sit on multiples of 16u (=1px at 16px).
//
// v5 spends its budget on ONE idea: the product has a single verb — mark a region
// of the screen and keep it. Screenshot, recording, pin, clipboard entry and even
// the usage readout are all the same act. So the icon is that act: a selection,
// with the highlight crossing it and running out past the edge.

export const INK = '#1d1a16'
export const CREAM = '#f9f5ec'
export const AMBER = '#e5a44c'
export const AMBER_HI = '#f5b862'
export const AMBER_LO = '#d78722'

const defs = `
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${AMBER_HI}"/>
      <stop offset="1" stop-color="${AMBER_LO}"/>
    </linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b251d"/>
      <stop offset="1" stop-color="#17140f"/>
    </linearGradient>
  </defs>`

const plate = (fill, rimOpacity) => `
  <rect x="8" y="8" width="240" height="240" rx="56" fill="${fill}"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="${CREAM}" stroke-opacity="${rimOpacity}" stroke-width="16"/>`

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}\n</svg>\n`

// ── I1 · 选区 + 越框高亮（深板） ──────────────────────────────────────────
// The reference form. Cream selection, amber band crossing the whole tile and
// overhanging both edges — the overhang is what separates "highlight" from
// "divider", and it is the only small detail that survives to 16px because it
// changes the tile's outline (the band's ends break the rounded left/right edges).
const I1 = svg(`${plate('url(#plate)', 0.12)}
  <rect x="48" y="48" width="160" height="160" rx="24" fill="${CREAM}"/>
  <rect x="0" y="112" width="256" height="48" fill="url(#amber)"/>`)

// ── I2 · 同一构型，强调色板（明暗互换） ───────────────────────────────────
const I2 = svg(`${plate('url(#amber)', 0.24)}
  <rect x="48" y="48" width="160" height="160" rx="24" fill="${INK}"/>
  <rect x="0" y="112" width="256" height="48" fill="${CREAM}"/>`)

// ── I3 · 记号（井）—— 可读性上限对照 ──────────────────────────────────────
const I3 = svg(`${plate('url(#amber)', 0.24)}
  <g fill="${INK}">
    <rect x="56" y="24" width="48" height="208" rx="12"/>
    <rect x="152" y="24" width="48" height="208" rx="12"/>
    <rect x="24" y="56" width="208" height="48" rx="12"/>
    <rect x="24" y="152" width="208" height="48" rx="12"/>
  </g>`)

// ── I4 · 高亮扫过文字（强调色板） ─────────────────────────────────────────
// The literal highlighter: two ink lines above the band, one below, so the band
// reads as something that was dragged OVER content rather than a bar in a box.
const I4 = svg(`${plate('url(#amber)', 0.24)}
  <g fill="${INK}">
    <rect x="48" y="56" width="160" height="24" rx="8" fill-opacity="0.55"/>
    <rect x="48" y="88" width="112" height="24" rx="8" fill-opacity="0.55"/>
  </g>
  <rect x="0" y="124" width="256" height="48" fill="${CREAM}"/>
  <rect x="48" y="184" width="136" height="24" rx="8" fill="${INK}" fill-opacity="0.55"/>`)

// ── I5 · 贴上去的一块（深板） ─────────────────────────────────────────────
// The same "taken from the screen and kept" story, but as two offset plates: the
// one in front is the pin. Contrast raised from v4 so the back plate survives 16px.
const I5 = svg(`${plate('url(#plate)', 0.12)}
  <rect x="40" y="40" width="152" height="152" rx="24" fill="${AMBER}"/>
  <rect x="104" y="104" width="112" height="112" rx="20" fill="${CREAM}"/>`)

// ── I6 · 取景框（深板，实心角） ───────────────────────────────────────────
// The marquee drawn with four solid corner blocks instead of a continuous frame —
// this is the honest reading of "screenshot", sacrificed to a 16px compromise.
const I6 = svg(`${plate('url(#plate)', 0.12)}
  <g fill="${CREAM}">
    <rect x="40" y="40" width="56" height="56" rx="10"/>
    <rect x="160" y="40" width="56" height="56" rx="10"/>
    <rect x="40" y="160" width="56" height="56" rx="10"/>
    <rect x="160" y="160" width="56" height="56" rx="10"/>
  </g>
  <rect x="0" y="112" width="256" height="32" fill="url(#amber)"/>`)

export const CANDIDATES = [
  { id: 'I1', direction: 'A', directionName: 'MARK ON SELECTION', construction: '深板 · 亮选区 · 强调色带', name: '选区 + 越框高亮（推荐形态）', svg: I1 },
  { id: 'I2', direction: 'A', directionName: 'MARK ON SELECTION', construction: '强调色板 · 墨选区 · 亮带', name: '同一构型明暗互换', svg: I2 },
  { id: 'I3', direction: 'B', directionName: '记号 THE MARK', construction: '强调色板 · 墨色字', name: '井号（可读性上限对照）', svg: I3 },
  { id: 'I4', direction: 'B', directionName: '记号 THE MARK', construction: '强调色板 · 墨色字', name: '高亮扫过文字', svg: I4 },
  { id: 'I5', direction: 'C', directionName: '浮面 STACK', construction: '深板 · 强调色 · 亮字', name: '贴上去的一块', svg: I5 },
  { id: 'I6', direction: 'C', directionName: '取景框 MARQUEE', construction: '深板 · 亮角 · 强调色带', name: '四角取景框 + 高亮带', svg: I6 }
]
