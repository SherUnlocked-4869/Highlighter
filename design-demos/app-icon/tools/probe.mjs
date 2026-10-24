// Fast 16px iteration: render a batch of one-off variants and compose a single
// zoom sheet where each row is one variant on light / dark / and at 16, 24, 32.
//
//   node design-demos/app-icon/tools/probe.mjs
//
// This exists because judging a 256px master tells you nothing about whether the
// icon works in a taskbar. Everything here is decided on the real raster.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')
fs.mkdirSync(outDir, { recursive: true })

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

// J1 · diagonal marker stroke, blunt ends, dark plate
const J1 = svg(`${darkPlate}<g transform="rotate(-45 128 128)">
  <rect x="24" y="104" width="208" height="48" rx="8" fill="url(#amber)"/></g>`)

// J2 · diagonal stroke + the chip it kept, dark plate
const J2 = svg(`${darkPlate}<g transform="rotate(-45 128 128)">
  <rect x="16" y="104" width="160" height="48" rx="8" fill="url(#amber)"/>
  <rect x="176" y="96" width="64" height="64" rx="12" fill="${CREAM}"/></g>`)

// J3 · band crossing a selection, but the selection is a solid L-free rect that
//      touches the plate edge on the right, so the band + shape read as one mark
const J3 = svg(`${amberPlate}
  <rect x="56" y="56" width="144" height="144" rx="16" fill="${INK}"/>
  <rect x="-8" y="112" width="272" height="40" fill="${CREAM}"/>`)

// J4 · tall highlight, vertical (a highlight column) — tests orientation
const J4 = svg(`${amberPlate}
  <rect x="56" y="56" width="144" height="144" rx="16" fill="${INK}"/>
  <rect x="112" y="-8" width="40" height="272" fill="${CREAM}"/>`)

// J5 · the mark as a "kept" bracket pair: two thick L brackets facing each other
const J5 = svg(`${amberPlate}
  <path d="M48 40 H136 V80 H88 V176 H136 V216 H48 Z" fill="${INK}"/>
  <rect x="104" y="112" width="152" height="32" fill="${CREAM}"/>`)

// J6 · plate-less diagonal stroke with ink keyline, for the "no tile" option
const J6 = svg(`<g transform="rotate(-45 128 128)">
  <rect x="24" y="104" width="208" height="48" rx="8" fill="url(#amber)" stroke="${INK}" stroke-width="16"/></g>`)

const VARIANTS = [
  ['J1', J1], ['J2', J2], ['J3', J3], ['J4', J4], ['J5', J5], ['J6', J6]
]

const SIZES = [16, 24, 32, 48, 256]
const ZOOM = 12

const browser = await chromium.launch()

async function raster(svgText, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svgText.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf.toString('base64')
}

const rows = []
for (const [id, svgText] of VARIANTS) {
  const cells = []
  for (const size of SIZES) {
    const b64 = await raster(svgText, size)
    const shown = size === 16 ? ZOOM : size === 24 ? 8 : size === 32 ? 6 : size === 48 ? 4 : 1
    const px = size * shown
    cells.push(`<figure class="cell"><img src="data:image/png;base64,${b64}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}${shown > 1 ? ` · ${shown}×` : ''}</figcaption></figure>`)
  }
  rows.push(`<section class="row"><header><b>${id}</b></header>
    <div class="strip light">${cells.join('')}</div>
    <div class="strip dark">${cells.join('')}</div></section>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:28px;background:#e8e2d4;font:13px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
section{background:#fffdf7;border-radius:14px;margin-bottom:16px;overflow:hidden;box-shadow:0 10px 24px -14px rgba(52,38,20,.3)}
header{padding:8px 16px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace}
.strip{display:flex;align-items:flex-end;gap:26px;padding:14px 16px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>${rows.join('')}`

fs.writeFileSync(path.join(outDir, 'probe.html'), html)
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe.png'), fullPage: true })
await browser.close()
console.log('probe:', path.join(outDir, 'probe.png'))
