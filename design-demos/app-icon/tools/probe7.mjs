// probe7 — the last screening before the three directions are locked.
//
// New consideration the earlier probes did not test: at 16px in a real taskbar
// every app icon is a 16px rounded square, so differentiation cannot come from
// the silhouette alone. It comes from (a) hue, and (b) an ASYMMETRIC interior
// pattern with one bold weight. All the centred/symmetric forms tested so far
// (E1–E6, B1) win on legibility but read as "a symbol in a tile" — generic.
//
// So this round only tests asymmetric compositions of ONE story: a highlight laid
// over a piece of content, where the content is only partly visible. That is what
// the product does — it takes a piece of the screen and marks it.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')

const INK = '#1d1a16'
const defs = `
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6ba66"/><stop offset="1" stop-color="#d88521"/>
    </linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c261e"/><stop offset="1" stop-color="#161310"/>
    </linearGradient>
    <linearGradient id="creamg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="#efe7d7"/>
    </linearGradient>
  </defs>`
const darkPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#plate)"/>`
const amberPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#amber)"/>`
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}</svg>`

// R1 · 纸 + 越界高亮（低处）：the page sits high, the band crosses low and hangs
//      off both edges. Asymmetric, and the overhang says "the mark is not a border".
const R1 = svg(`${darkPlate}
  <rect x="48" y="40" width="160" height="128" rx="20" fill="url(#creamg)"/>
  <rect x="8" y="152" width="240" height="48" rx="4" fill="url(#amber)"/>`)

// R2 · 纸 + 越界高亮（高处）
const R2 = svg(`${darkPlate}
  <rect x="48" y="88" width="160" height="128" rx="20" fill="url(#creamg)"/>
  <rect x="8" y="56" width="240" height="48" rx="4" fill="url(#amber)"/>`)

// R3 · L 形高亮：the mark turns a corner around the content's lower-right
const R3 = svg(`${darkPlate}
  <rect x="40" y="40" width="136" height="136" rx="22" fill="url(#creamg)"/>
  <path d="M104 176 H216 V104" fill="none" stroke="url(#amber)" stroke-width="48" stroke-linecap="square"/>`)

// R4 · 页 + 抬起的角（贴图）：solid page, amber chip lifted off its corner
const R4 = svg(`${darkPlate}
  <rect x="40" y="40" width="144" height="144" rx="22" fill="url(#creamg)"/>
  <rect x="112" y="112" width="104" height="104" rx="22" fill="url(#amber)"/>`)

// R5 · 三片页（册）：three pages fanned, the front one marked
const R5 = svg(`${darkPlate}
  <rect x="72" y="32" width="120" height="120" rx="18" fill="#6b6152"/>
  <rect x="56" y="48" width="128" height="128" rx="18" fill="url(#creamg)" fill-opacity="0.55"/>
  <rect x="40" y="64" width="140" height="140" rx="18" fill="url(#creamg)"/>
  <rect x="72" y="120" width="76" height="28" rx="4" fill="url(#amber)"/>`)

// R6 · 条 + 缺口（marker 的笔尖缺口）：a band whose right end is clipped by a
//      notch, so the shape is asymmetric without adding a second element
const R6 = svg(`${amberPlate}
  <path d="M40 104 H176 V80 H216 V176 H176 V152 H40 Z" fill="${INK}"/>`)

const VARIANTS = [['R1', R1], ['R2', R2], ['R3', R3], ['R4', R4], ['R5', R5], ['R6', R6]]
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
fs.writeFileSync(path.join(outDir, 'probe7.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe7.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe7.png'), fullPage: true })
await browser.close()
console.log('probe7 done')
