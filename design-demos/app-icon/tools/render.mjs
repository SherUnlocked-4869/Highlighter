// Rasterise every candidate at the sizes that actually ship, then compose a
// review board. Run from the repo root:
//
//   node design-demos/app-icon/tools/render.mjs
//
// Output:
//   design-demos/app-icon/out/png/<id>-<size>.png   (transparent background)
//   design-demos/app-icon/out/board-candidates.png  (light + dark, 16px zoomed)

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANDIDATES } from './candidates.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')
const pngDir = path.join(outDir, 'png')

// The sizes assets/icon.ico already carries (checked with PIL: 16,24,32,48,64,128,256).
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

fs.mkdirSync(pngDir, { recursive: true })

const browser = await chromium.launch()

async function raster(svg, size, dsf = 1) {
  const ctx = await browser.newContext({
    viewport: { width: size, height: size },
    deviceScaleFactor: dsf
  })
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

const rendered = {}
for (const candidate of CANDIDATES) {
  rendered[candidate.id] = {}
  for (const size of ICO_SIZES) {
    const buf = await raster(candidate.svg, size)
    const file = path.join(pngDir, `${candidate.id}-${size}.png`)
    fs.writeFileSync(file, buf)
    rendered[candidate.id][size] = buf.toString('base64')
  }
  console.log('rendered', candidate.id)
}

// ── board ──────────────────────────────────────────────────────────────────
// Each row: the 256px master, then 64/48/32/24 actual pixels, then 16px at 8x
// with nearest-neighbour upscale (so what you are judging is the real 16px
// raster, not a re-drawing of the vector).
const ZOOM = 8
const rows = CANDIDATES.map((c) => {
  const cell = (size, zoom = 1) => {
    const px = size * zoom
    return `<figure class="cell"><img src="data:image/png;base64,${rendered[c.id][size]}" style="width:${px}px;height:${px}px;${zoom > 1 ? 'image-rendering:pixelated' : ''}" width="${px}" height="${px}"><figcaption>${size}px${zoom > 1 ? ` · ${zoom}×` : ''}</figcaption></figure>`
  }
  return `<section class="row">
    <header><b>${c.id}</b> ${c.name}<span>${c.directionName}</span></header>
    <div class="strip light">${cell(256, 1)}${cell(64)}${cell(48)}${cell(32)}${cell(24)}${cell(16, ZOOM)}</div>
    <div class="strip dark">${cell(256, 1)}${cell(64)}${cell(48)}${cell(32)}${cell(24)}${cell(16, ZOOM)}</div>
  </section>`
}).join('\n')

const board = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 40px; background: #e8e2d4; color: #1d1a16;
         font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif; }
  h1 { font: 600 20px/1.4 "Segoe UI Variable Display", "Segoe UI"; margin: 0 0 4px; }
  p.note { margin: 0 0 28px; color: #5b5245; }
  section.row { margin-bottom: 22px; background: #fffdf7; border-radius: 16px; overflow: hidden;
                box-shadow: 0 1px 3px rgba(52,38,20,.12), 0 12px 26px -14px rgba(52,38,20,.28); }
  section.row header { display: flex; align-items: baseline; gap: 10px; padding: 12px 20px;
                       border-bottom: 1px solid #e2d9c9; font-size: 13px; }
  header b { font-family: "Cascadia Mono", Consolas, monospace; font-size: 15px; color: #b8762a; }
  header span { margin-left: auto; color: #8b8069; font-size: 12px; }
  .strip { display: flex; align-items: flex-end; gap: 22px; padding: 16px 20px; }
  .strip.dark { background: #24211c; }
  .cell { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .cell img { display: block; border-radius: 2px; }
  figcaption { font-size: 11px; color: #8b8069; font-family: "Cascadia Mono", Consolas, monospace; white-space: nowrap; }
  .dark figcaption { color: #a99e88; }
</style></head><body>
  <h1>Highlighter · 应用图标候选（六版）</h1>
  <p class="note">每行上=浅底，下=深底。每行从左到右：256 主形、64、48、32、24、16px 原始光栅（16px 放大 8× 最近邻，方便直接判断真实可辨性）。</p>
  ${rows}
</body></html>`

fs.writeFileSync(path.join(outDir, 'board-candidates.html'), board)

const ctx = await browser.newContext({
  viewport: { width: 1180, height: 900 },
  deviceScaleFactor: 2
})
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'board-candidates.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'board-candidates.png'), fullPage: true })
await browser.close()

console.log('board:', path.join(outDir, 'board-candidates.png'))
