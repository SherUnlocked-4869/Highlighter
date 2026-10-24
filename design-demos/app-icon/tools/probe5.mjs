// probe5 — last form hunt before the three directions are fixed.
//
// What the earlier probes proved about 16px, all on real rasters:
//   · one filled silhouette + one counter-form survives; two equal-weight forms
//     cancel each other (E1–E6 all became "a square cut by a bar");
//   · 45° strokes alias into a staircase;
//   · four separate corner marks merge into a "+";
//   · the band must NOT be a full-bleed centre line — that reads as a division
//     sign or a hamburger, not as a highlight.
//
// So: the counter-form has to be OFF-CENTRE and INSET, and the plate has to be
// solid so the counter-form is a knock-out rather than a second object.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')

const INK = '#1d1a16'
const CREAM = '#fbf7ee'
const defs = `
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6ba66"/><stop offset="1" stop-color="#d88521"/>
    </linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c261e"/><stop offset="1" stop-color="#161310"/>
    </linearGradient>
  </defs>`
const darkPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#plate)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="none" stroke="${CREAM}" stroke-opacity="0.13" stroke-width="16"/>`
const amberPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#amber)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="16"/>`
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}</svg>`

// P1 · solid selection, band knocked out at the lower third, inset margins
const P1 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="${CREAM}"/>
  <rect x="72" y="152" width="112" height="32" fill="url(#amber)"/>`)

// P2 · same at the upper third
const P2 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="${CREAM}"/>
  <rect x="72" y="72" width="112" height="32" fill="url(#amber)"/>`)

// P3 · selection with the band running to ONE edge only (bleeds right) — the mark
//      enters the selection from outside, which is what a real highlighter does
const P3 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="${CREAM}"/>
  <rect x="112" y="152" width="152" height="32" fill="url(#amber)"/>`)

// P4 · inverse: amber selection, cream band knocked out low
const P4 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="url(#amber)"/>
  <rect x="72" y="152" width="112" height="32" fill="${CREAM}"/>`)

// P5 · the pinned crop: selection plus a smaller plate overlapping its corner,
//      both solid, offset 32u — the silhouette changes at the corner so 16px can
//      still tell which shape is which
const P5 = svg(`${darkPlate}
  <rect x="40" y="40" width="144" height="144" rx="24" fill="${CREAM}" fill-opacity="0.5"/>
  <rect x="96" y="96" width="128" height="128" rx="24" fill="url(#amber)"/>`)

// P6 · mark with one stroke removed: a cross (the mark) inside a solid selection
const P6 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="url(#amber)"/>
  <g fill="${INK}">
    <rect x="112" y="72" width="32" height="112" rx="8"/>
    <rect x="72" y="112" width="112" height="32" rx="8"/>
  </g>`)

const VARIANTS = [['P1', P1], ['P2', P2], ['P3', P3], ['P4', P4], ['P5', P5], ['P6', P6]]
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

const browser = await chromium.launch()
async function raster(text, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    text.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf.toString('base64')
}

const rows = []
for (const [id, text] of VARIANTS) {
  const cells = []
  for (const size of SIZES) {
    const b64 = await raster(text, size)
    const shown = size <= 24 ? 10 : size === 32 ? 6 : size === 48 ? 4 : size === 64 ? 3 : size === 128 ? 2 : 1
    const px = size * shown
    cells.push(`<figure class="cell"><img src="data:image/png;base64,${b64}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}${shown > 1 ? `·${shown}×` : ''}</figcaption></figure>`)
  }
  rows.push(`<section class="row"><header><b>${id}</b></header>
    <div class="strip light">${cells.join('')}</div>
    <div class="strip dark">${cells.join('')}</div></section>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:22px;background:#e8e2d4;font:13px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
section{background:#fffdf7;border-radius:14px;margin-bottom:12px;overflow:hidden;box-shadow:0 10px 24px -14px rgba(52,38,20,.3)}
header{padding:7px 14px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
.strip{display:flex;align-items:flex-end;gap:16px;padding:12px 14px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>${rows.join('')}`
fs.writeFileSync(path.join(outDir, 'probe5.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe5.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe5.png'), fullPage: true })
await browser.close()
console.log('probe5 done')
