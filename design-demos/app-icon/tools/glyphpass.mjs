// Glyph refinement pass — judged at 256px, where craft is actually visible.
//
// What v2 showed when opened at full size:
//   · SWIPE's chisel came out as a flag, not a stroke: the diagonal ran the wrong
//     way and the shape read as a banner. A highlighter mark tapers; it does not
//     sprout a corner.
//   · CAPTURE's band overhung on ONE side only, which reads as a mistake rather
//     than as a gesture. Either it crosses symmetrically or it stays inside.
//   · LAYERS worked and is left alone apart from the tile's specular, which was
//     washing the upper third to near-white.
//
// This file renders variants of just those two glyphs so they can be compared at
// 256px side by side, then folds the winner back into apple.mjs.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/glyphpass')
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

const AMBER = { top: '#ffdda2', mid: '#f2ab48', bottom: '#c87517', spec: 0.5, shade: 0.22, rim: 0.46, glyphLow: '#efe4d0', shadowColor: '#7d4207', glyphShadow: 0.24 }
const GRAPHITE = { top: '#5d5550', mid: '#37312c', bottom: '#1c1916', spec: 0.18, shade: 0.30, rim: 0.34, glyphLow: '#ece5d8', shadowColor: '#000000', glyphShadow: 0.4 }

function defs(id, pal) {
  return `
    <clipPath id="clip-${id}"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body-${id}" x1="0.08" y1="0" x2="0.42" y2="1">
      <stop offset="0" stop-color="${pal.top}"/><stop offset="0.46" stop-color="${pal.mid}"/><stop offset="1" stop-color="${pal.bottom}"/>
    </linearGradient>
    <radialGradient id="spec-${id}" cx="0.46" cy="0" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity="${pal.spec}"/>
      <stop offset="0.34" stop-color="#fff" stop-opacity="${(pal.spec * 0.3).toFixed(3)}"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${pal.shade}"/>
    </linearGradient>
    <linearGradient id="face-${id}" x1="0" y1="0" x2="0.15" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#fffdf8"/><stop offset="1" stop-color="${pal.glyphLow}"/>
    </linearGradient>
    <filter id="drop-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${pal.shadowColor}" flood-opacity="${pal.glyphShadow}"/>
    </filter>`
}
const body = (id, pal) => `
    <g clip-path="url(#clip-${id})">
      <rect width="256" height="256" fill="url(#body-${id})"/>
      <rect width="256" height="256" fill="url(#spec-${id})"/>
      <rect width="256" height="256" fill="url(#shade-${id})"/>
    </g>
    <path d="${squircle(1.4)}" fill="none" stroke="#fff" stroke-opacity="${pal.rim}" stroke-width="2.8"/>`

// ── SWIPE variants ─────────────────────────────────────────────────────────
// S1 · tapered band: 44u tall at the landing cap, 30u at the lift-off. Both caps
//      round. This is what a real highlighter mark looks like — pressure falls off.
const S1 = `
  <g filter="url(#drop-sw1)">
    <path d="M72 106 H150 L186 122 Q196 126 196 136 Q196 146 186 150 H72 A22 22 0 0 1 72 106 Z" fill="url(#face-sw1)"/>
  </g>`

// S2 · pure band, both ends round, no chisel at all. The most Apple option:
//      nothing decorative, the shape is the shape.
const S2 = `
  <g filter="url(#drop-sw2)">
    <rect x="66" y="107" width="126" height="42" rx="21" fill="url(#face-sw2)"/>
  </g>`

// S3 · band with a proper chisel: the end is cut on a 30° angle so the TOP edge is
//      longer than the bottom — the opposite of v2, which is what makes it read as
//      a nib lifting rather than a flag.
const S3 = `
  <g filter="url(#drop-sw3)">
    <path d="M66 107 L192 107 L170 149 L66 149 A21 21 0 0 1 66 107 Z" fill="url(#face-sw3)"/>
  </g>`

// ── CAPTURE variants ───────────────────────────────────────────────────────
const ring = (o, i) => `${o} ${i}`
const OUTER = 'M84 62 H172 A22 22 0 0 1 194 84 V172 A22 22 0 0 1 172 194 H84 A22 22 0 0 1 62 172 V84 A22 22 0 0 1 84 62 Z'
const INNER = 'M88 86 H168 A2 2 0 0 1 170 88 V168 A2 2 0 0 1 168 170 H88 A2 2 0 0 1 86 168 V88 A2 2 0 0 1 88 86 Z'

// C1 · band crosses symmetrically and runs to both tile edges (the gesture
//      continues past the selection on both sides)
const C1 = `
  <g filter="url(#drop-cap1)">
    <path d="${ring(OUTER, INNER)}" fill-rule="evenodd" fill="url(#face-cap1)"/>
  </g>
  <rect x="0" y="115" width="256" height="30" fill="#f0a944"/>
  <rect x="0" y="115" width="256" height="9" fill="#ffdda2" fill-opacity="0.6"/>`

// C2 · band entirely INSIDE the frame — the mark is on the selection, and the frame
//      stays a clean closed shape
const C2 = `
  <g filter="url(#drop-cap2)">
    <path d="${ring(OUTER, INNER)}" fill-rule="evenodd" fill="url(#face-cap2)"/>
  </g>
  <rect x="92" y="112" width="72" height="34" rx="8" fill="#f0a944"/>
  <rect x="92" y="112" width="72" height="11" rx="5" fill="#ffdda2" fill-opacity="0.62"/>`

// C3 · frame only, no band — the purest reading, and the band becomes a notch cut
//      out of the frame's right side
const C3 = `
  <g filter="url(#drop-cap3)">
    <path d="${ring(OUTER, INNER)}" fill-rule="evenodd" fill="url(#face-cap3)"/>
  </g>
  <path d="M170 116 H178 A6 6 0 0 1 184 122 V138 A6 6 0 0 1 178 144 H170 Z" fill="#f0a944"/>`

const VARIANTS = [
  ['sw1', AMBER, S1],
  ['sw2', AMBER, S2],
  ['sw3', AMBER, S3],
  ['cap1', GRAPHITE, C1],
  ['cap2', GRAPHITE, C2],
  ['cap3', GRAPHITE, C3]
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

const cells = []
for (const [id, pal, glyph] of VARIANTS) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><defs>${defs(id, pal)}</defs>${body(id, pal)}${glyph}</svg>`
  const big = await raster(svg, 256)
  const small = await raster(svg, 16)
  fs.writeFileSync(path.join(outDir, `${id}-256.png`), big)
  fs.writeFileSync(path.join(outDir, `${id}-16.png`), small)
  cells.push({ id, big: big.toString('base64'), small: small.toString('base64') })
}
await browser.close()

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:26px;background:#f5f2ec;font:12px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
.row{display:flex;gap:24px;align-items:flex-end;margin-bottom:20px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
img{display:block;border-radius:14px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8a8070}
h2{font:600 14px/1.3 "Segoe UI";margin:0 0 12px}
</style>
<h2>SWIPE — 三种落笔</h2>
<div class="row">${cells.slice(0, 3).map((c) => `<figure><img src="data:image/png;base64,${c.big}" width="180" height="180"><figcaption>${c.id.toUpperCase()} · 256</figcaption></figure>`).join('')}</div>
<div class="row">${cells.slice(0, 3).map((c) => `<figure><img src="data:image/png;base64,${c.small}" width="128" height="128" style="image-rendering:pixelated"><figcaption>${c.id.toUpperCase()} · 16 @8×</figcaption></figure>`).join('')}</div>
<h2>CAPTURE — 三种记号位置</h2>
<div class="row">${cells.slice(3).map((c) => `<figure><img src="data:image/png;base64,${c.big}" width="180" height="180"><figcaption>${c.id.toUpperCase()} · 256</figcaption></figure>`).join('')}</div>
<div class="row">${cells.slice(3).map((c) => `<figure><img src="data:image/png;base64,${c.small}" width="128" height="128" style="image-rendering:pixelated"><figcaption>${c.id.toUpperCase()} · 16 @8×</figcaption></figure>`).join('')}</div>`

fs.writeFileSync(path.join(outDir, 'sheet.html'), html)
const b2 = await chromium.launch()
const ctx = await b2.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true })
await b2.close()
console.log('glyph pass done')
