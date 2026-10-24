// probe2 — finalists only, decided on the 16px raster.
//
// Findings that drove this round:
//   · a 45° diagonal stroke aliases badly at 16px (probe J1/J2): the bar breaks
//     into a staircase and loses its ends. Axis-aligned forms stay crisp.
//   · a vertical band turns the tile into a toggle switch (J4) — orientation
//     carries meaning, horizontal reads as "a line of content being marked".
//   · outlined brackets read as the letter C (J5); a band across a solid block
//     reads as a hamburger (J3) unless the block keeps visible side margins.
//
// So each finalist keeps ONE axis-aligned filled form plus ONE counter-form, and
// the plate does the work of separating from both a white window and a #202020
// taskbar.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')

const INK = '#1d1a16'
const CREAM = '#f9f5ec'

const defs = `
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5b862"/><stop offset="1" stop-color="#d78722"/>
    </linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b251d"/><stop offset="1" stop-color="#17140f"/>
    </linearGradient>
  </defs>`

const darkPlate = `<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#plate)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="${CREAM}" stroke-opacity="0.12" stroke-width="16"/>`
const amberPlate = `<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#amber)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="#ffffff" stroke-opacity="0.24" stroke-width="16"/>`

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}</svg>`

// K1 · 高亮条 + 笔尖（横向，轴对齐）：产品名就是 "highlighter"，笔画就是它
const K1 = svg(`${amberPlate}
  <rect x="24" y="104" width="148" height="48" rx="6" fill="${CREAM}"/>
  <path d="M172 104 H216 A16 16 0 0 1 232 120 V136 A16 16 0 0 1 216 152 H172 Z" fill="${INK}"/>`)

// K2 · 同上，深板反色
const K2 = svg(`${darkPlate}
  <rect x="24" y="104" width="148" height="48" rx="6" fill="url(#amber)"/>
  <path d="M172 104 H216 A16 16 0 0 1 232 120 V136 A16 16 0 0 1 216 152 H172 Z" fill="${CREAM}"/>`)

// K3 · 「记号」# 减到两笔：一条竖 + 一条横压过它（更少笔画，16px 更清楚）
const K3 = svg(`${amberPlate}
  <g fill="${INK}">
    <rect x="72" y="40" width="48" height="176" rx="12"/>
    <rect x="24" y="88" width="208" height="44" rx="12"/>
    <rect x="24" y="140" width="208" height="44" rx="12"/>
  </g>`)

// K4 · 完整 #（对照）
const K4 = svg(`${amberPlate}
  <g fill="${INK}">
    <rect x="60" y="32" width="44" height="192" rx="12"/>
    <rect x="152" y="32" width="44" height="192" rx="12"/>
    <rect x="24" y="60" width="208" height="44" rx="12"/>
    <rect x="24" y="152" width="208" height="44" rx="12"/>
  </g>`)

// K5 · 取景框 + 越框高亮带，但框改成四段粗边（每段 ≥32u，端点对齐网格）
const K5 = svg(`${darkPlate}
  <g fill="${CREAM}">
    <rect x="40" y="40" width="176" height="32" rx="8"/>
    <rect x="40" y="184" width="176" height="32" rx="8"/>
    <rect x="40" y="72" width="32" height="112"/>
    <rect x="184" y="72" width="32" height="112"/>
  </g>
  <rect x="0" y="112" width="256" height="32" fill="url(#amber)"/>`)

// K6 · 两枚浮面（前后错位 32u，前块压住后块）
const K6 = svg(`${darkPlate}
  <rect x="56" y="40" width="144" height="144" rx="28" fill="${CREAM}" fill-opacity="0.42"/>
  <rect x="88" y="88" width="144" height="144" rx="28" fill="url(#amber)"/>`)

const VARIANTS = [['K1', K1], ['K2', K2], ['K3', K3], ['K4', K4], ['K5', K5], ['K6', K6]]
const SIZES = [16, 20, 24, 32, 48, 64, 256]

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
    const shown = size <= 24 ? 10 : size === 32 ? 6 : size === 48 ? 4 : size === 64 ? 3 : 1
    const px = size * shown
    cells.push(`<figure class="cell"><img src="data:image/png;base64,${b64}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}${shown > 1 ? ` ·${shown}×` : ''}</figcaption></figure>`)
  }
  rows.push(`<section class="row"><header><b>${id}</b></header>
    <div class="strip light">${cells.join('')}</div>
    <div class="strip dark">${cells.join('')}</div></section>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#e8e2d4;font:13px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
section{background:#fffdf7;border-radius:14px;margin-bottom:14px;overflow:hidden;box-shadow:0 10px 24px -14px rgba(52,38,20,.3)}
header{padding:7px 14px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
.strip{display:flex;align-items:flex-end;gap:20px;padding:12px 14px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>${rows.join('')}`

fs.writeFileSync(path.join(outDir, 'probe2.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe2.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe2.png'), fullPage: true })
await browser.close()
console.log('probe2 done')
