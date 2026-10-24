// Highlighter · app icon — three directions, final form.
//
// Single source of truth for the icon set. Everything else under out/ is a
// render of this file. Run from the repo root:
//
//   node design-demos/app-icon/tools/build.mjs
//
// ── What the evidence forced (all judged on real 16px rasters, never on the
//    256px master; probe1–probe7 kept alongside this file) ──────────────────
//
//   · 16px holds ONE filled silhouette plus ONE counter-form. Two forms of equal
//     weight cancel each other and the icon reads as a symbol-in-a-box.
//   · The counter-form must not be a full-bleed centred band: that reads as a
//     hamburger / division sign, not as a highlight.
//   · 45° strokes alias into a staircase below 32px; every edge here is
//     axis-aligned.
//   · A mid-tone plate is what lets ONE tile work on a white window and on a
//     #202020 taskbar at the same time, and it lets the glyph be ink rather than
//     light — which buys back the contrast the small sizes need.
//   · Geometry is authored on 256 with load-bearing edges on multiples of 16, so
//     at 16×16 the drawing lands on the pixel grid instead of being averaged.
//   · Below 24px the tile's rounded corners are the only thing that says "app
//     icon", so the corner radius and the plate silhouette are not optional.
//
// ── One idea, five capabilities ────────────────────────────────────────────
// Screenshot, recording, clipboard, pin and token-usage are not five features;
// they are one act repeated — take a piece of the screen, keep it, and let the
// kept pile become a record. All three directions draw that act and differ only
// in which half of it they make the hero.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out')
const pngDir = path.join(outDir, 'png-final')
fs.mkdirSync(pngDir, { recursive: true })

// ── palette ────────────────────────────────────────────────────────────────
// Taken from the landed FILM tokens (shared/tokens.css) so the icon belongs to
// the product rather than to a generic app-icon colour scheme.
export const PALETTE = {
  // accent — the user-configurable --primary, default #e5a44c
  amberTop: '#f6ba66',
  amberBottom: '#d88521',
  amber: '#e5a44c',
  // dark surfaces — --surface-2 / --bg at the dark end
  plateTop: '#2c261e',
  plateBottom: '#161310',
  // light surfaces — --surface / --surface-3
  creamTop: '#fffdf7',
  creamBottom: '#efe7d7',
  cream: '#f9f5ec',
  // ink — --ink, light end
  ink: '#1d1a16'
}

const P = PALETTE

const DEFS = `
  <defs>
    <linearGradient id="amber" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.amberTop}"/>
      <stop offset="1" stop-color="${P.amberBottom}"/>
    </linearGradient>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.plateTop}"/>
      <stop offset="1" stop-color="${P.plateBottom}"/>
    </linearGradient>
    <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.creamTop}"/>
      <stop offset="1" stop-color="${P.creamBottom}"/>
    </linearGradient>
  </defs>`

// The tile. 8u bleed (0.5px at 16px) keeps the rounded corner from being clipped
// and gives the silhouette a hairline of air on a light desktop.
const RADIUS = 58
const plate = (fill) => `<rect x="8" y="8" width="240" height="240" rx="${RADIUS}" fill="${fill}"/>`

// Top rim: only visible as light catching the upper edge. 16u = 1px at 16px, so it
// either reads as one clean pixel row or disappears — it never half-renders.
const rim = (opacity) =>
  `<path d="M66 8 H190 A58 58 0 0 1 248 66 V70 A58 58 0 0 1 190 16 H66 A58 58 0 0 1 16 70 V66 A58 58 0 0 1 66 8 Z"
        fill="${P.cream}" fill-opacity="${opacity}"/>`

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${DEFS}${body}</svg>`

// ══════════════════════════════════════════════════════════════════════════
// A · 取景框上的记号  MARK ON FRAME
// ──────────────────────────────────────────────────────────────────────────
// Hero: the region that was taken. The highlight crosses it and runs out past the
// tile edge, so the mark is an action that happened, not a border that exists.
// This is the most literal answer to "screenshot + recording": they are the same
// drag, and what comes out is a marked region.
//
// Why the band overhangs: a band that stops inside the frame reads as a divider
// (that is exactly what E3/P2 looked like at 16px). The overhang is what tells
// you "this was laid over something", and it also breaks the tile's edge at the
// two points where the eye scans first.
const A = svg(`
  ${plate('url(#plate)')}
  ${rim(0.13)}
  <rect x="44" y="44" width="168" height="168" rx="26" fill="url(#cream)"/>
  <rect x="0" y="112" width="256" height="48" fill="url(#amber)"/>`)

// ══════════════════════════════════════════════════════════════════════════
// B · 记号  THE MARK
// ──────────────────────────────────────────────────────────────────────────
// Hero: the mark itself. The product is named after the thing it draws, and every
// one of the five capabilities ends in the same object — something marked and
// kept. Built from four rounded bars on the accent plate: the single most legible
// construction in the whole exploration (probe B1/K4), and the only one that is
// still unambiguous at 16px without relying on the tile for contrast.
const B = svg(`
  ${plate('url(#amber)')}
  ${rim(0.26)}
  <g fill="${P.ink}">
    <rect x="58" y="30" width="46" height="196" rx="14"/>
    <rect x="152" y="30" width="46" height="196" rx="14"/>
    <rect x="24" y="58" width="208" height="46" rx="14"/>
    <rect x="24" y="152" width="208" height="46" rx="14"/>
  </g>`)

// ══════════════════════════════════════════════════════════════════════════
// C · 浮面  STACK
// ──────────────────────────────────────────────────────────────────────────
// Hero: the kept pile. This is the product's landed FILM language seen head-on —
// the capture overlay, the pin, the clipboard panel and the usage panel are all
// the same object at different depths. Two plates only: at 16px a third step
// merges into a grey smear (probe B1 vs Q5), and the 40u offset (=2.5px at 16px)
// is what keeps the two silhouettes separate.
const C = svg(`
  ${plate('url(#plate)')}
  ${rim(0.13)}
  <rect x="48" y="48" width="136" height="136" rx="28" fill="url(#cream)" fill-opacity="0.42"/>
  <rect x="88" y="88" width="136" height="136" rx="28" fill="url(#amber)"/>`)

export const DIRECTIONS = [
  {
    id: 'A',
    name: '取景框上的记号',
    en: 'MARK ON FRAME',
    hero: '被取下的那一块区域',
    svg: A,
    plate: 'dark',
    oneLine: '截图与录屏是同一个手势：拉一个框。高亮带从框外扫进来并越出画布，说明记号是「做过的事」，不是「画好的边」。'
  },
  {
    id: 'B',
    name: '记号',
    en: 'THE MARK',
    hero: '留下的那一笔',
    svg: B,
    plate: 'amber',
    oneLine: '产品以它画出的东西命名；五项能力最后都落成同一个物件——被标住并留下的东西。'
  },
  {
    id: 'C',
    name: '浮面',
    en: 'STACK',
    hero: '留下的那一叠',
    svg: C,
    plate: 'dark',
    oneLine: '产品已落地的 FILM 语言正面看：截图浮层、贴图、剪贴板面板、用量面板，是同一个物件在不同深度上的四次出现。'
  }
]

// ── render ─────────────────────────────────────────────────────────────────
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

const browser = await chromium.launch()

async function raster(svgText, size, dsf = 1) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: dsf })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    svgText.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

const rendered = {}
for (const d of DIRECTIONS) {
  rendered[d.id] = {}
  for (const size of ICO_SIZES) {
    const buf = await raster(d.svg, size)
    fs.writeFileSync(path.join(pngDir, `${d.id}-${size}.png`), buf)
    rendered[d.id][size] = buf.toString('base64')
  }
  console.log('rendered', d.id, d.en)
}
await browser.close()

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
  palette: P,
  sizes: ICO_SIZES,
  directions: DIRECTIONS.map((d) => ({ id: d.id, name: d.name, en: d.en, svg: d.svg }))
}, null, 2))

// ── review sheet ───────────────────────────────────────────────────────────
// Each direction: 256 master, then 64/48/32/24 actual pixels, then 16px at 8×
// nearest-neighbour — so the small column is the true raster, not a re-draw.
const ZOOM = 8
const rows = DIRECTIONS.map((d) => {
  const cell = (size, zoom = 1) => {
    const px = size * zoom
    return `<figure class="cell"><img src="data:image/png;base64,${rendered[d.id][size]}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${zoom > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}px${zoom > 1 ? ` · ${zoom}×` : ''}</figcaption></figure>`
  }
  return `<section class="row">
    <header><b>${d.id}</b>${d.name}<em>${d.en}</em></header>
    <p class="line">${d.oneLine}</p>
    <div class="strip light">${cell(256)}${cell(64)}${cell(48)}${cell(32)}${cell(24)}${cell(16, ZOOM)}</div>
    <div class="strip dark">${cell(256)}${cell(64)}${cell(48)}${cell(32)}${cell(24)}${cell(16, ZOOM)}</div>
  </section>`
}).join('\n')

const sheet = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body { margin:0; padding:40px; background:#e8e2d4; color:#1d1a16;
         font:14px/1.6 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif; }
  h1 { font:600 22px/1.35 "Segoe UI Variable Display","Segoe UI"; margin:0 0 6px; }
  .sub { margin:0 0 30px; color:#5b5245; font-size:13px; }
  section { margin-bottom:22px; background:#fffdf7; border-radius:18px; overflow:hidden;
            box-shadow:0 1px 3px rgba(52,38,20,.10), 0 14px 30px -16px rgba(52,38,20,.28); }
  header { display:flex; align-items:baseline; gap:12px; padding:14px 22px 0;
           font:600 16px/1.4 "Segoe UI Variable Display","Segoe UI"; }
  header b { font:600 13px/1 "Cascadia Mono",Consolas,monospace; color:#b8762a;
             background:#f6e6cf; border-radius:6px; padding:5px 8px; }
  header em { font:400 12px/1 "Cascadia Mono",Consolas,monospace; color:#8b8069;
              letter-spacing:.06em; margin-left:auto; }
  p.line { margin:6px 22px 2px; color:#5b5245; font-size:13px; }
  .strip { display:flex; align-items:flex-end; gap:24px; padding:16px 22px; }
  .strip.dark { background:#202020; }
  .cell { margin:0; display:flex; flex-direction:column; align-items:center; gap:9px; }
  .cell img { display:block; }
  figcaption { font:11px "Cascadia Mono",Consolas,monospace; color:#8b8069; white-space:nowrap; }
  .dark figcaption { color:#a99e88; }
</style></head><body>
  <h1>Highlighter · 应用图标 · 三个方向</h1>
  <p class="sub">每段上排＝浅底，下排＝深底。从左到右：256 主形、64、48、32、24、16px 原始光栅（16px 放大 8× 最近邻，看到的是真实像素，不是重绘）。</p>
  ${rows}
</body></html>`

fs.writeFileSync(path.join(outDir, 'sheet.html'), sheet)

const b2 = await chromium.launch()
const ctx = await b2.newContext({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true })
await b2.close()

console.log('sheet:', path.join(outDir, 'sheet.png'))
