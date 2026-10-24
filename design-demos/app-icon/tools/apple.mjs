// Highlighter · app icon — Apple-style, v2.
//
//   node design-demos/app-icon/tools/apple.mjs
//
// v1 got the TILE right (superellipse + three-layer light model) and the GLYPHS
// wrong: they were flat white fills with no body of their own, so they read as
// stencils cut into the tile rather than as objects resting on it. That is the
// single thing that separates "an icon with a gradient" from "an Apple icon".
//
// In Apple's icons the glyph is its own object with its own light:
//   · a subtle vertical gradient (never flat white — pure white looks printed)
//   · a soft drop shadow onto the tile, proving it sits on top
//   · a hairline top highlight on the glyph, catching the same light as the tile
//   · rounded, human geometry: no sharp corners anywhere, no 1px detail
//
// The tile recipe is unchanged and is the Apple construction proper:
//   1. superellipse |x|^n + |y|^n = 1, curvature-continuous (a rounded rect is not)
//   2. body gradient that shifts HUE, not just lightness
//   3. broad specular sweep over the top third
//   4. contact shade at the bottom, giving the tile thickness
//   5. 1px top rim

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/apple')
for (const sub of ['svg', 'png']) fs.mkdirSync(path.join(outDir, sub), { recursive: true })

// ── superellipse ───────────────────────────────────────────────────────────
// n=5. At 45° the curve sits at 2^(-1/5) = 87.1% of the half-size; Apple's tiles
// are ~87–89%, so this is measured against their silhouette rather than guessed.
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

// ── tile ───────────────────────────────────────────────────────────────────
function tileDefs(id, pal) {
  return `
    <clipPath id="clip-${id}"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body-${id}" x1="0.08" y1="0" x2="0.42" y2="1">
      <stop offset="0" stop-color="${pal.top}"/>
      <stop offset="0.46" stop-color="${pal.mid}"/>
      <stop offset="1" stop-color="${pal.bottom}"/>
    </linearGradient>
    <!-- Light model: a broad DIRECTIONAL source from above, plus a tight band that
         grazes the top edge. An earlier version used a radial gradient, which lays a
         soft blob near the top centre — the signature of a template gradient. Measured
         side by side (tools/lightmodel.mjs), the directional pair is the one that
         reads as light on a surface. -->
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
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${pal.shade}"/>
    </linearGradient>
    <linearGradient id="glyphface-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.62" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="${pal.glyphLow}"/>
    </linearGradient>
    <filter id="glyphdrop-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${pal.shadowColor}" flood-opacity="${pal.glyphShadow}"/>
    </filter>`
}

function tileBody(id, pal) {
  return `
    <g clip-path="url(#clip-${id})">
      <rect width="256" height="256" fill="url(#body-${id})"/>
      <rect width="256" height="256" fill="url(#spec-${id})"/>
      <rect width="256" height="256" fill="url(#edge-${id})"/>
      <rect width="256" height="256" fill="url(#shade-${id})"/>
    </g>
    <path d="${squircle(1.4)}" fill="none" stroke="#ffffff" stroke-opacity="${pal.rim}" stroke-width="2.8"/>`
}

const AMBER = {
  top: '#ffdda2', mid: '#f2ab48', bottom: '#c87517',
  spec: 0.40, edge: 0.55, shade: 0.22, rim: 0.40,
  glyphLow: '#f0e6d4', shadowColor: '#7d4207', glyphShadow: 0.26
}

const GRAPHITE = {
  top: '#5d5550', mid: '#37312c', bottom: '#1c1916',
  spec: 0.18, edge: 0.30, shade: 0.30, rim: 0.30,
  glyphLow: '#ece5d8', shadowColor: '#000000', glyphShadow: 0.42
}

// ── glyph helpers ──────────────────────────────────────────────────────────
// Every glyph is: drop shadow → filled face with its own gradient → 1px top
// highlight. That three-step recipe is what gives it the same material logic as
// the tile, one layer up.

// Direction A · the stroke.
// A highlighter mark TAPERS — pressure falls off as the nib lifts. The left cap is
// a full 44u round landing; the stroke narrows to 30u at the lift-off and both ends
// stay round. An earlier version cut a hard 30° chisel on the end and it read as a
// FLAG at 256px (the corner sprouted); a plain pill read as a lozenge. Tapering is
// what makes it read as a stroke that was made rather than a shape that exists.
const STROKE_PATH =
  'M72 106 H150 L186 122 Q196 126 196 136 Q196 146 186 150 H72 A22 22 0 0 1 72 106 Z'

// Direction B · the capture frame with the mark crossing it.
// Frame drawn as two nested rounded rects (outline), band on top.
const FRAME_OUTER = 'M86 62 H170 A24 24 0 0 1 194 86 V170 A24 24 0 0 1 170 194 H86 A24 24 0 0 1 62 170 V86 A24 24 0 0 1 86 62 Z'
const FRAME_INNER = 'M90 86 H166 A4 4 0 0 1 170 90 V166 A4 4 0 0 1 166 170 H90 A4 4 0 0 1 86 166 V90 A4 4 0 0 1 90 86 Z'

// Direction C · three stacked glass plates, stepped to the lower-right.
const PLATE = (x, y, w, r) =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + w - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + w} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + w - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`

function strokeGlyph(id, pal) {
  return `
    <g filter="url(#glyphdrop-${id})">
      <path d="${STROKE_PATH}" fill="url(#glyphface-${id})"/>
    </g>
    <path d="${STROKE_PATH}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="2"/>`
}

function frameGlyph(id, pal) {
  // frame = outer path minus inner path (even-odd), so it is one clean ring
  const ring = `${FRAME_OUTER} ${FRAME_INNER}`
  return `
    <g filter="url(#glyphdrop-${id})">
      <path d="${ring}" fill="url(#glyphface-${id})" fill-rule="evenodd"/>
    </g>
    <rect x="92" y="112" width="72" height="34" rx="9" fill="#f2ab48"/>
    <rect x="92" y="112" width="72" height="11" rx="5" fill="#ffdda2" fill-opacity="0.62"/>`
}

function layersGlyph(id, pal) {
  return `
    <g filter="url(#glyphdrop-${id})">
      <path d="${PLATE(64, 64, 104, 26)}" fill="#ffffff" fill-opacity="0.24"/>
      <path d="${PLATE(80, 80, 104, 26)}" fill="#ffffff" fill-opacity="0.44"/>
      <path d="${PLATE(96, 96, 104, 26)}" fill="url(#glyphface-${id})"/>
    </g>
    <path d="${PLATE(96, 96, 104, 26)}" fill="none" stroke="#ffffff" stroke-opacity="0.8" stroke-width="2"/>`
}

export const DIRECTIONS = [
  {
    id: 'swipe', name: '一笔', en: 'SWIPE', tile: AMBER, glyph: strokeGlyph,
    concept: '高亮笔落下只有一个动作：一笔，左端是圆润的落笔，右端是笔锋抬起时的斜切。产品名就是这一笔。',
    why: '苹果最强的工具类图标就是一个手势、一个形、没有配件——记事本、提醒事项、语音备忘录都是这个结构'
  },
  {
    id: 'capture', name: '取景', en: 'CAPTURE', tile: GRAPHITE, glyph: frameGlyph,
    concept: '截图与录屏是同一个手势：拉一个框。琥珀色的记号横切过框并伸出边界——留下的是记号，不是边框。',
    why: '深色版面是苹果 Pro 应用的语气；整枚图标只有一处彩色，这是苹果的用色节制'
  },
  {
    id: 'layers', name: '浮层', en: 'LAYERS', tile: AMBER, glyph: layersGlyph,
    concept: '截图浮层、贴图、剪贴板、用量面板是同一个物件在四个深度上的出现；层叠本身就是「五功能合一」。',
    why: '半透明玻璃叠放是苹果处理「堆叠 / 图层」隐喻的标准材料'
  }
]

// ── render ─────────────────────────────────────────────────────────────────
const SIZES = [16, 20, 24, 32, 40, 44, 48, 64, 96, 128, 256]

const svgFor = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Highlighter">` +
  `<defs>${tileDefs(d.id, d.tile)}</defs>${tileBody(d.id, d.tile)}${d.glyph(d.id, d.tile)}</svg>`

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
  const svg = svgFor(d)
  fs.writeFileSync(path.join(outDir, 'svg', `${d.id}.svg`), svg)
  for (const size of SIZES) {
    fs.writeFileSync(path.join(outDir, 'png', `${d.id}-${size}.png`), await raster(svg, size))
  }
  console.log('rendered', d.id, d.en)
}
await browser.close()

fs.writeFileSync(
  path.join(outDir, 'directions.json'),
  JSON.stringify(DIRECTIONS.map((d) => ({ id: d.id, name: d.name, en: d.en, concept: d.concept, why: d.why })), null, 2)
)
console.log('\nwrote', outDir)
