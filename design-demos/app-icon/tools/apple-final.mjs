// Highlighter · app icon — Apple-style, shipping build.
//
//   node design-demos/app-icon/tools/apple-final.mjs
//
// Writes out/apple/final/{svg,png,ico}. Supersedes apple.mjs as the source of
// truth; apple.mjs, lightmodel.mjs, glyphpass.mjs and smallframes.mjs are the
// experiments that produced it.
//
// ══ The construction (this is what "Apple style" actually is) ═════════════
//
// 1. SQUIRCLE, not a rounded rect. |x|⁵ + |y|⁵ = 1, curvature-continuous. At 45°
//    the curve sits at 2^(-1/5) = 87.1% of the half-size, which is where Apple's
//    own tiles sit. A rounded rect meets its edges with a curvature jump, which is
//    why it reads as a box; this reads as an object.
//
// 2. BODY GRADIENT WITH HUE SHIFT. Light at the top, and the hue rotates toward
//    orange at the bottom rather than only darkening. Lightness-only gradients are
//    what make an icon look like a shaded flat disc.
//
// 3. DIRECTIONAL LIGHT, not a radial hotspot. A broad linear falloff from above
//    plus a tight band grazing the top edge. Measured against a radial specular
//    (tools/lightmodel.mjs): the radial one lays a soft blob near the top centre,
//    which is the tell of a template gradient.
//
// 4. CONTACT SHADE at the bottom — the tile's own thickness.
//
// 5. THE GLYPH IS ITS OWN OBJECT: its own vertical gradient (never flat white),
//    a soft drop shadow proving it rests on the tile, and a hairline top highlight
//    catching the same light as the tile.
//
// ══ Two size regimes, drawn separately ═════════════════════════════════════
// Apple ships hand-tuned frames per size instead of scaling one drawing. At 24px
// and below the glyph grows to ~68% of the tile, loses its gradient and shadow
// (both smear), and the tile keeps only its body gradient. Measured in
// tools/smallframes.mjs: scaled-down SWIPE is a mush of amber at 16px; the redrawn
// frame is a clean white bar.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/apple/final')
for (const sub of ['svg', 'png', 'ico']) fs.mkdirSync(path.join(outDir, sub), { recursive: true })

// ── superellipse ───────────────────────────────────────────────────────────
const N = 5
const C = 128
const R = 120
const STEPS = 320

function squircle(inset = 0) {
  const r = R - inset
  const pts = []
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    pts.push(
      `${(C + r * Math.sign(c) * Math.abs(c) ** (2 / N)).toFixed(2)} ` +
      `${(C + r * Math.sign(s) * Math.abs(s) ** (2 / N)).toFixed(2)}`
    )
  }
  return `M${pts.join(' L')} Z`
}
const SHAPE = squircle()

// ── palettes ───────────────────────────────────────────────────────────────
// Amber's midpoint is the product's --primary exactly (#e5a44c is what the body
// gradient passes through at ~52%), so the brand colour is the average of the
// tile rather than an approximation of it.
const AMBER = {
  top: '#ffdda8', mid: '#f2ab48', bottom: '#c8731a',
  spec: 0.40, edge: 0.55, shade: 0.22, rim: 0.40,
  glyphLow: '#efe4d0', shadowColor: '#7d4207', glyphShadow: 0.24,
  smallTop: '#ffd79b', smallMid: '#f0a844', smallBottom: '#c87517'
}

const GRAPHITE = {
  top: '#5d5550', mid: '#37312c', bottom: '#1c1916',
  spec: 0.18, edge: 0.30, shade: 0.30, rim: 0.30,
  glyphLow: '#ece5d8', shadowColor: '#000000', glyphShadow: 0.40,
  smallTop: '#57504a', smallMid: '#332e2a', smallBottom: '#1b1815'
}

const CREAM = '#fffdf7'

// ── geometry ───────────────────────────────────────────────────────────────
// Large-size glyphs (256 → 32px).
const BIG = {
  // A highlighter mark tapers: a full 44u round landing, narrowing to 30u as the
  // nib lifts, both ends round. A hard chisel read as a flag; a plain pill read as
  // a lozenge. The taper is what makes it a stroke that was made.
  // Symmetric taper: both edges converge on the centreline y=128 (44u tall at the
  // landing, 30u at the lift-off). An earlier path sloped only the top edge, which
  // made it read as a wedge cut off at one end rather than a nib lifting off.
  // Walked clockwise: landing cap top (72,106) -> top edge (linear, converging) ->
  // lift-off end (vertical, 30u) -> bottom edge (linear, converging) -> cap arc.
  // Both edges slope symmetrically about the centreline y=128, which is what makes
  // it read as a nib lifting off rather than a wedge cut at one end.
  // BOTH ends round, different radii — the pressure falloff is carried by the
  // difference in radius (22u landing -> 15u lift-off), not by a flat cut. An
  // earlier version ended on a vertical face, which read as a marker tip / wedge.
  stroke: 'M94 106 L181 113 A15 15 0 0 1 181 143 L94 150 A22 22 0 0 1 94 106 Z',
  // Frame = outer minus inner, so the ring is one clean shape. The band sits INSIDE
  // the selection: overhanging it read as a mistake at 256px.
  ring:
    'M84 62 H172 A22 22 0 0 1 194 84 V172 A22 22 0 0 1 172 194 H84 A22 22 0 0 1 62 172 V84 A22 22 0 0 1 84 62 Z ' +
    'M100 86 H156 A14 14 0 0 1 170 100 V156 A14 14 0 0 1 156 170 H100 A14 14 0 0 1 86 156 V100 A14 14 0 0 1 100 86 Z'
}

const plate = (x, y, w, r) =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + w - r} ` +
  `A${r} ${r} 0 0 1 ${x + w - r} ${y + w} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + w - r} ` +
  `V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`

// Small-size glyphs (24 → 16px): redrawn, not scaled.
const SMALL = {
  // thicker (52u) and longer, no taper — a taper is invisible at 22px
  swipe: `<rect x="58" y="102" width="142" height="52" rx="26" fill="${CREAM}"/>`,
  // frame stroke widened 24→32u, band shortened so it cannot touch the inner edge
  capture: `<path d="M86 58 H170 A28 28 0 0 1 198 86 V170 A28 28 0 0 1 170 198 H86 A28 28 0 0 1 58 170 V86 A28 28 0 0 1 86 58 Z
                      M90 94 H166 A4 4 0 0 1 170 98 V162 A4 4 0 0 1 166 166 H90 A4 4 0 0 1 86 162 V98 A4 4 0 0 1 90 94 Z"
           fill-rule="evenodd" fill="${CREAM}"/>
           <rect x="94" y="110" width="68" height="36" rx="10" fill="#f0a844"/>`,
  // two plates only (a third is a smear), back plate a flat tint rather than
  // translucency — translucency at 16px just greys the tile
  layers: `<path d="${plate(52, 52, 118, 28)}" fill="#a86c22"/>
           <path d="${plate(90, 90, 118, 28)}" fill="${CREAM}"/>`
}

const BIGGLYPH = {
  swipe: (id) => `
    <g filter="url(#drop-${id})"><path d="${BIG.stroke}" fill="url(#face-${id})"/></g>
    <path d="${BIG.stroke}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2"/>`,
  capture: (id) => `
    <g filter="url(#drop-${id})"><path d="${BIG.ring}" fill-rule="evenodd" fill="url(#face-${id})"/></g>
    <rect x="92" y="112" width="72" height="34" rx="9" fill="#f2ab48"/>
    <rect x="92" y="112" width="72" height="11" rx="5" fill="#ffdda8" fill-opacity="0.62"/>`,
  layers: (id) => `
    <g filter="url(#drop-${id})">
      <path d="${plate(60, 60, 104, 26)}" fill="#ffffff" fill-opacity="0.30"/>
      <path d="${plate(76, 76, 104, 26)}" fill="#ffffff" fill-opacity="0.55"/>
      <path d="${plate(92, 92, 104, 26)}" fill="url(#face-${id})"/>
    </g>
    <path d="${plate(92, 92, 104, 26)}" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="2"/>`
}

// ── svg builders ───────────────────────────────────────────────────────────
function svgLarge(id, pal) {
  const defs = `
    <clipPath id="clip-${id}"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body-${id}" x1="0.10" y1="0" x2="0.44" y2="1">
      <stop offset="0" stop-color="${pal.top}"/>
      <stop offset="0.52" stop-color="${pal.mid}"/>
      <stop offset="1" stop-color="${pal.bottom}"/>
    </linearGradient>
    <linearGradient id="spec-${id}" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${pal.spec}"/>
      <stop offset="0.34" stop-color="#ffffff" stop-opacity="${(pal.spec * 0.30).toFixed(3)}"/>
      <stop offset="0.66" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="edge-${id}" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${pal.edge}"/>
      <stop offset="0.13" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shade-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.52" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${pal.shade}"/>
    </linearGradient>
    <linearGradient id="face-${id}" x1="0" y1="0" x2="0.18" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="${pal.glyphLow}"/>
    </linearGradient>
    <filter id="drop-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${pal.shadowColor}" flood-opacity="${pal.glyphShadow}"/>
    </filter>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Highlighter">
    <defs>${defs}</defs>
    <g clip-path="url(#clip-${id})">
      <rect width="256" height="256" fill="url(#body-${id})"/>
      <rect width="256" height="256" fill="url(#spec-${id})"/>
      <rect width="256" height="256" fill="url(#edge-${id})"/>
      <rect width="256" height="256" fill="url(#shade-${id})"/>
    </g>
    <path d="${squircle(1.4)}" fill="none" stroke="#ffffff" stroke-opacity="${pal.rim}" stroke-width="2.8"/>
    ${BIGGLYPH[id](id)}
  </svg>`
}

function svgSmall(id, pal) {
  const defs = `
    <clipPath id="clip-${id}"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body-${id}" x1="0.2" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="${pal.smallTop}"/>
      <stop offset="0.5" stop-color="${pal.smallMid}"/>
      <stop offset="1" stop-color="${pal.smallBottom}"/>
    </linearGradient>`

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Highlighter">
    <defs>${defs}</defs>
    <g clip-path="url(#clip-${id})"><rect width="256" height="256" fill="url(#body-${id})"/></g>
    ${SMALL[id]}
  </svg>`
}

export const DIRECTIONS = [
  {
    id: 'swipe', name: '一笔', en: 'SWIPE', pal: AMBER,
    concept: '高亮笔落下只有一个动作：一笔。左端是圆润的落笔，向右逐渐收锋——笔压离开纸面时变细。产品名就是这一笔。',
    why: '苹果最强的工具类图标都是一个手势、一个形、没有配件（备忘、提醒、语音备忘录都是这个结构）',
    strength: '最像苹果；16px 重画后是一条干净的白杠，三个里最稳',
    tradeoff: '语义只说明「标记」，不指向截图/录屏/剪贴板任何一项，靠产品名承担'
  },
  {
    id: 'capture', name: '取景', en: 'CAPTURE', pal: GRAPHITE,
    concept: '截图与录屏是同一个手势：拉一个框。琥珀色的记号落在框内——被选中的那块被标住了。',
    why: '深色版面是苹果 Pro 应用的语气；整枚图标只有一处彩色，是苹果的用色节制',
    strength: '语义最强（截图/录屏/贴图都从「拉一个框」开始）；深色版面在任务栏里最稳',
    tradeoff: '框内再套记号，结构最复杂，16px 下必须靠重画才能保住'
  },
  {
    id: 'layers', name: '浮层', en: 'LAYERS', pal: AMBER,
    concept: '截图浮层、贴图、剪贴板、用量面板，是同一个物件在四个深度上的出现；层叠本身就是「五功能合一」。',
    why: '半透明叠放是苹果处理「堆叠 / 图层」隐喻的标准材料',
    strength: '融合叙事最强；轮廓不对称，任务栏里不易混淆',
    tradeoff: '16px 下第三层必然消失，只能保留两层；语义对单一功能最不具体'
  }
]

// ── render ─────────────────────────────────────────────────────────────────
// Big frames from 32px up; redrawn frames at 24px and below (Apple's own split).
const SIZES = [16, 20, 24, 32, 40, 44, 48, 64, 96, 128, 256]
const SMALL_MAX = 24

const browser = await chromium.launch()
async function raster(svg, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

for (const d of DIRECTIONS) {
  fs.writeFileSync(path.join(outDir, 'svg', `${d.id}-large.svg`), svgLarge(d.id, d.pal))
  fs.writeFileSync(path.join(outDir, 'svg', `${d.id}-small.svg`), svgSmall(d.id, d.pal))
  for (const size of SIZES) {
    const svg = size <= SMALL_MAX ? svgSmall(d.id, d.pal) : svgLarge(d.id, d.pal)
    fs.writeFileSync(path.join(outDir, 'png', `${d.id}-${size}.png`), await raster(svg, size))
  }
  console.log('rendered', d.id, d.en)
}
await browser.close()

fs.writeFileSync(
  path.join(outDir, 'directions.json'),
  JSON.stringify(DIRECTIONS.map(({ pal, ...rest }) => rest), null, 2)
)
console.log('\nwrote', outDir)
