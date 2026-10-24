// probe4 — direction A refinement, judged ONLY at 16–24px.
//
// A's problem at small sizes: the frame ring (2px) and the band (2px) are equal
// weight, so the interior splits into two 2px slots and the whole thing reads as a
// framed bar rather than "a selection that got marked". The fix is not more
// contrast — it is giving one of the two forms the weight budget. Four ways:

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
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}</svg>`

// E1 · frame 32u + band 48u (band wins the weight budget)
const E1 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="8" y="104" width="240" height="48" fill="url(#amber)"/>`)

// E2 · frame 24u (thinner) + band 48u
const E2 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="24"/>
  <rect x="8" y="104" width="240" height="48" fill="url(#amber)"/>`)

// E3 · frame 32u + band 48u, band inset to the frame's outer edge (no full bleed)
const E3 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="48" y="104" width="160" height="48" fill="url(#amber)"/>`)

// E4 · solid cream frame (filled selection) with an amber band knocked through it
const E4 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="${CREAM}"/>
  <rect x="8" y="104" width="240" height="48" fill="url(#amber)"/>`)

// E5 · band + frame, but the frame is a closed rect with rounded corners and the
//      band is drawn UNDER it (frame wins) so the mark sits in the selection
const E5 = svg(`${darkPlate}
  <rect x="8" y="104" width="240" height="48" fill="url(#amber)"/>
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>`)

// E6 · frame 32u + band 32u but band shifted up (thirds, not centre) — optical
//      centring, because a band on the exact centre reads as a "divided" symbol
const E6 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="8" y="96" width="240" height="32" fill="url(#amber)"/>`)

const VARIANTS = [['E1', E1], ['E2', E2], ['E3', E3], ['E4', E4], ['E5', E5], ['E6', E6]]
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
fs.writeFileSync(path.join(outDir, 'probe4.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe4.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe4.png'), fullPage: true })
await browser.close()
console.log('probe4 done')
