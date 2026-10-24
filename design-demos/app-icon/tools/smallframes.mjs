// Small-size frames, drawn separately — the thing Apple actually does.
//
// iOS app icons ship a hand-tuned frame at each size rather than one drawing
// scaled down. The reason is visible in the 16px row of the review sheet: SWIPE's
// stroke and LAYERS' plates both dissolve into a mush of amber, because at 16px a
// 40u element is 2.5px and the glyph's own gradient and shadow eat it.
//
// So: from 24px down, redraw instead of scaling down.
//   · the glyph gets bigger (optically, small sizes need a larger mark)
//   · the glyph loses its gradient and shadow (both are smear at this size)
//   · the tile loses its specular and edge band, keeping only the body gradient
//   · the superellipse keeps its shape but not its 1px rim
//
// This file proves the difference and then becomes the source for the small PNGs.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/smallframes')
fs.mkdirSync(outDir, { recursive: true })

const N = 5, C = 128, R = 120, STEPS = 320
function squircle(inset = 0) {
  const r = R - inset
  const pts = []
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    pts.push(`${(C + r * Math.sign(c) * Math.abs(c) ** (2 / N)).toFixed(2)} ${(C + r * Math.sign(s) * Math.abs(s) ** (2 / N)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}
const SHAPE = squircle()

const AMBER = { top: '#ffd79b', mid: '#f0a844', bottom: '#c87517' }
const GRAPHITE = { top: '#5d5550', mid: '#37312c', bottom: '#1c1916' }
const CREAM = '#fffdf7'

// ── large glyphs (256 → 32) ────────────────────────────────────────────────
// As in apple.mjs but re-declared here so this file can render standalone.
const bigStroke = 'M72 106 H150 L186 122 Q196 126 196 136 Q196 146 186 150 H72 A22 22 0 0 1 72 106 Z'
const bigRing = 'M84 62 H172 A22 22 0 0 1 194 84 V172 A22 22 0 0 1 172 194 H84 A22 22 0 0 1 62 172 V84 A22 22 0 0 1 84 62 Z ' +
                'M88 86 H168 A2 2 0 0 1 170 88 V168 A2 2 0 0 1 168 170 H88 A2 2 0 0 1 86 168 V88 A2 2 0 0 1 88 86 Z'
const plate = (x, y, w, r) =>
  `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + w - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + w} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + w - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`

// ── small glyphs (24 → 16) ─────────────────────────────────────────────────
// Bigger, flatter, fewer parts. Each one is redrawn for the small canvas: the mark
// grows from ~55% to ~68% of the tile, loses its own gradient, and any element that
// would land under 2px is widened.
const SMALL = {
  // stroke: thicker (52u vs 44u) and longer, no taper — the taper is invisible at 22px
  swipe: `<rect x="60" y="102" width="140" height="52" rx="26" fill="${CREAM}"/>`,
  // capture: frame stroke widened 24→32u, band 34→40u and shortened so it cannot
  // touch the frame's inner edge at 16px
  capture: `<path d="M86 58 H170 A28 28 0 0 1 198 86 V170 A28 28 0 0 1 170 198 H86 A28 28 0 0 1 58 170 V86 A28 28 0 0 1 86 58 Z
                     M88 92 H168 A0 0 0 0 1 168 92 V164 A0 0 0 0 1 168 164 H88 A0 0 0 0 1 88 164 V92 A0 0 0 0 1 88 92 Z"
           fill-rule="evenodd" fill="${CREAM}"/>
           <rect x="94" y="110" width="68" height="36" rx="10" fill="#f0a844"/>`,
  // layers: two plates only (the third is a smear at 16px), offset 44u, no translucency
  // on the back plate — it becomes a flat tint that survives
  layers: `<path d="${plate(60, 60, 116, 28)}" fill="#b4762a"/>
           <path d="${plate(96, 96, 116, 28)}" fill="${CREAM}"/>`
}

const TILEDEF = (id, pal) => `
  <clipPath id="c-${id}"><path d="${SHAPE}"/></clipPath>
  <linearGradient id="b-${id}" x1="0.2" y1="0" x2="0.5" y2="1">
    <stop offset="0" stop-color="${pal.top}"/><stop offset="0.5" stop-color="${pal.mid}"/><stop offset="1" stop-color="${pal.bottom}"/>
  </linearGradient>`

const svgSmall = (id, pal, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">` +
  `<defs>${TILEDEF(id, pal)}</defs>` +
  `<g clip-path="url(#c-${id})"><rect width="256" height="256" fill="url(#b-${id})"/></g>` +
  `${glyph}</svg>`

const svgBig = (id, pal, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">` +
  `<defs>${TILEDEF(id, pal)}</defs>` +
  `<g clip-path="url(#c-${id})"><rect width="256" height="256" fill="url(#b-${id})"/></g>` +
  `${glyph}</svg>`

const BIGGLYPH = {
  swipe: `<path d="${bigStroke}" fill="${CREAM}"/>`,
  capture: `<path d="${bigRing}" fill-rule="evenodd" fill="${CREAM}"/><rect x="92" y="112" width="72" height="34" rx="9" fill="#f2ab48"/>`,
  layers: `<path d="${plate(70, 70, 104, 26)}" fill="#ffffff" fill-opacity="0.30"/><path d="${plate(86, 86, 104, 26)}" fill="#ffffff" fill-opacity="0.55"/><path d="${plate(102, 102, 104, 26)}" fill="${CREAM}"/>`
}

const VARIANTS = [
  ['swipe', AMBER],
  ['capture', GRAPHITE],
  ['layers', AMBER]
]

const browser = await chromium.launch()
async function raster(svg, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

const rows = []
for (const [id, pal] of VARIANTS) {
  const cells = []
  // scaled-down path (what we ship today) vs redrawn path, at the small sizes
  for (const size of [32, 24, 20, 16]) {
    const scaled = await raster(svgBig(id, pal, BIGGLYPH[id]), size)
    const redrawn = await raster(svgSmall(id, pal, SMALL[id]), size)
    fs.writeFileSync(path.join(outDir, `${id}-${size}-scaled.png`), scaled)
    fs.writeFileSync(path.join(outDir, `${id}-${size}-redrawn.png`), redrawn)
    cells.push({ size, scaled: scaled.toString('base64'), redrawn: redrawn.toString('base64') })
  }
  rows.push({ id, cells })
}
await browser.close()

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:22px;background:#f5f2ec;font:12px/1.4 "Segoe UI Variable Text",sans-serif;color:#1d1a16}
h2{font:600 14px/1.3 "Segoe UI";margin:0 0 10px}
section{margin-bottom:22px}
table{border-collapse:collapse}
td{padding:6px 14px 6px 0;vertical-align:middle}
.lbl{font:10px "Cascadia Mono",Consolas,monospace;color:#8a8070;white-space:nowrap}
img{image-rendering:pixelated;display:block}
.hdr{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e}
</style>
${rows.map((r) => `<section><h2>${r.id.toUpperCase()}</h2><table>
<tr><td></td>${r.cells.map((c) => `<td class="hdr">${c.size}px</td>`).join('')}</tr>
<tr><td class="lbl">缩放（现状）</td>${r.cells.map((c) => `<td><img src="data:image/png;base64,${c.scaled}" width="${Math.round(c.size * 5)}" height="${Math.round(c.size * 5)}"></td>`).join('')}</tr>
<tr><td class="lbl">重画（提议）</td>${r.cells.map((c) => `<td><img src="data:image/png;base64,${c.redrawn}" width="${Math.round(c.size * 5)}" height="${Math.round(c.size * 5)}"></td>`).join('')}</tr>
</table></section>`).join('')}`

fs.writeFileSync(path.join(outDir, 'sheet.html'), html)
const b2 = await chromium.launch()
const ctx = await b2.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true })
await b2.close()
console.log('small frames done')
