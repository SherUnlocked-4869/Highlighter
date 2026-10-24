// Plate test: every direction re-rendered on the accent tile.
//
// The measured finding this answers: on a #202020 taskbar (the Windows 11 default)
// a dark-plate tile has almost no edge — direction C measured 1.38 luminance
// separation, A 2.38, and no rim width fixed it (sub-pixel rims do not survive a
// 16px raster). Only the mid-tone accent tile clears both backgrounds (B: 3.1 on
// white, 5.2 on #202020).
//
// So the plate becomes a SYSTEM decision shared by all directions, and the
// directions differ only in glyph language. This renders A and C on the accent
// tile so the colour decision can be judged on real rasters.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')
const work = path.join(outDir, 'plate-test')
fs.mkdirSync(work, { recursive: true })

const INK = '#1d1a16'
const CREAM = '#fbf7ee'
const DEFS = `<defs>
  <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f6ba66"/><stop offset="1" stop-color="#d88521"/>
  </linearGradient>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2c261e"/><stop offset="1" stop-color="#161310"/>
  </linearGradient>
  <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="#efe7d7"/>
  </linearGradient>
</defs>`

const plateAmber = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#amber)"/>
  <path d="M66 8 H190 A58 58 0 0 1 248 66 V70 A58 58 0 0 1 190 16 H66 A58 58 0 0 1 16 70 V66 A58 58 0 0 1 66 8 Z" fill="${CREAM}" fill-opacity="0.26"/>`
const plateDark = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#plate)"/>`

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${DEFS}${body}</svg>`

const VARIANTS = [
  // A on the accent tile: the selection flips to ink, the band to cream
  ['A-amber', svg(`${plateAmber}
    <rect x="44" y="44" width="168" height="168" rx="26" fill="${INK}"/>
    <rect x="0" y="112" width="256" height="48" fill="${CREAM}"/>`)],
  // A on the accent tile, selection cream and band ink (mark reads as a cut)
  ['A-amber-inv', svg(`${plateAmber}
    <rect x="44" y="44" width="168" height="168" rx="26" fill="${CREAM}"/>
    <rect x="0" y="112" width="256" height="48" fill="${INK}"/>`)],
  // C on the accent tile: back plate ink at 30%, front plate ink solid
  ['C-amber', svg(`${plateAmber}
    <rect x="48" y="48" width="136" height="136" rx="28" fill="${INK}" fill-opacity="0.34"/>
    <rect x="88" y="88" width="136" height="136" rx="28" fill="${INK}"/>`)],
  // C on the accent tile with a cream front plate
  ['C-amber-cream', svg(`${plateAmber}
    <rect x="48" y="48" width="136" height="136" rx="28" fill="${INK}" fill-opacity="0.34"/>
    <rect x="88" y="88" width="136" height="136" rx="28" fill="${CREAM}"/>`)],
  // B for reference (unchanged)
  ['B-amber', svg(`${plateAmber}
    <g fill="${INK}">
      <rect x="58" y="30" width="46" height="196" rx="14"/>
      <rect x="152" y="30" width="46" height="196" rx="14"/>
      <rect x="24" y="58" width="208" height="46" rx="14"/>
      <rect x="24" y="152" width="208" height="46" rx="14"/>
    </g>`)],
  // A on the DARK plate for comparison (the current build)
  ['A-dark', svg(`${plateDark}
    <rect x="44" y="44" width="168" height="168" rx="26" fill="url(#cream)"/>
    <rect x="0" y="112" width="256" height="48" fill="url(#amber)"/>`)],
  // C on the DARK plate for comparison
  ['C-dark', svg(`${plateDark}
    <rect x="48" y="48" width="136" height="136" rx="28" fill="url(#cream)" fill-opacity="0.42"/>
    <rect x="88" y="88" width="136" height="136" rx="28" fill="url(#amber)"/>`)]
]

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

const browser = await chromium.launch()
async function raster(text, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    text.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

const rows = []
for (const [name, text] of VARIANTS) {
  const cells = []
  for (const size of SIZES) {
    const buf = await raster(text, size)
    fs.writeFileSync(path.join(work, `${name}-${size}.png`), buf)
    const b64 = buf.toString('base64')
    const shown = size <= 24 ? 9 : size === 32 ? 5 : size === 48 ? 4 : size === 64 ? 3 : size === 128 ? 2 : 1
    const px = size * shown
    cells.push(`<figure class="cell"><img src="data:image/png;base64,${b64}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}${shown > 1 ? `·${shown}×` : ''}</figcaption></figure>`)
  }
  rows.push(`<section class="row"><header><b>${name}</b></header>
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
fs.writeFileSync(path.join(work, 'plate-test.html'), html)

const ctx = await browser.newContext({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(work, 'plate-test.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(work, 'plate-test.png'), fullPage: true })
await browser.close()
console.log('plate test done')
