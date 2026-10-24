// probe6 — fusion candidates.
//
// Brief: one icon must stand for screenshot + screen recording + clipboard +
// pin + AI usage analysis. These are not five things — they are one act repeated:
// take a piece of the screen, keep it, and let the kept pile become a record.
// So the icon has to show (a) a frame/region and (b) that the region is KEPT,
// lifted out and floating. Two forms, no more, or 16px loses it.
//
// Screened against the rules the earlier probes established:
//   · one filled silhouette + one counter-form;
//   · 45° strokes alias; everything axis-aligned;
//   · equal-weight forms cancel; one form must own the weight budget;
//   · a full-bleed centred band reads as a hamburger / division sign.

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
    <linearGradient id="creamg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="#f0e9da"/>
    </linearGradient>
  </defs>`
const darkPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#plate)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="none" stroke="${CREAM}" stroke-opacity="0.13" stroke-width="16"/>`
const amberPlate = `<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#amber)"/>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="16"/>`
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${defs}${body}</svg>`

// Q1 · 框 + 抬起的一角：the frame is the screen; its bottom-right corner has been
//      lifted off as its own plate. The silhouette changes at the corner, which
//      is what makes it readable small.
const Q1 = svg(`${darkPlate}
  <rect x="40" y="40" width="144" height="144" rx="22" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="120" y="120" width="104" height="104" rx="22" fill="url(#amber)"/>`)

// Q2 · same but the frame is solid cream (it was kept whole) and the lifted plate
//      is amber, overlapping
const Q2 = svg(`${darkPlate}
  <rect x="40" y="40" width="152" height="152" rx="22" fill="url(#creamg)"/>
  <rect x="120" y="120" width="104" height="104" rx="22" fill="url(#amber)"/>`)

// Q3 · 叠层（P5 精修）：back plate 60% cream, front amber, offset 40u
const Q3 = svg(`${amberPlate}
  <rect x="48" y="48" width="128" height="128" rx="26" fill="${INK}" fill-opacity="0.30"/>
  <rect x="80" y="88" width="128" height="128" rx="26" fill="${INK}"/>`)

// Q4 · a marking band that enters the frame from the left edge and stops short of
//      the right edge — an action, not a divider
const Q4 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="${CREAM}"/>
  <rect x="8" y="104" width="160" height="48" rx="0" fill="url(#amber)"/>`)

// Q5 · the record: three plates of decreasing opacity stacked (the kept pile)
const Q5 = svg(`${amberPlate}
  <rect x="56" y="152" width="144" height="56" rx="18" fill="${INK}" fill-opacity="0.28"/>
  <rect x="48" y="104" width="160" height="56" rx="18" fill="${INK}" fill-opacity="0.58"/>
  <rect x="40" y="56" width="176" height="56" rx="18" fill="${INK}"/>`)

// Q6 · capture frame with the recording dot knocked out of the band
const Q6 = svg(`${darkPlate}
  <rect x="40" y="40" width="176" height="176" rx="24" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="8" y="96" width="240" height="64" fill="url(#amber)"/>`)

const VARIANTS = [['Q1', Q1], ['Q2', Q2], ['Q3', Q3], ['Q4', Q4], ['Q5', Q5], ['Q6', Q6]]
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
fs.writeFileSync(path.join(outDir, 'probe6.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe6.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe6.png'), fullPage: true })
await browser.close()
console.log('probe6 done')
