// probe3 — the three directions, refined, plus the two constructions that lost.
//
// Evidence accumulated across v1–v5 (all judged on real 16px rasters, not on the
// 256px master):
//   · 16px holds one filled silhouette + one counter-form;
//   · 45° strokes alias into a staircase (probe J1/J2) — everything axis-aligned;
//   · four separate corner brackets merge into a "+" (v1 A1);
//   · a band across a solid block reads as a hamburger (v5 I1/I2) unless the
//     block keeps side margins;
//   · a mid-tone plate is what makes ONE tile work on both a white window and a
//     #202020 taskbar, and lets the glyph be ink rather than light.

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

// ══ A · 取景框上的记号 MARK ON FRAME ════════════════════════════════════════
// The capture frame (screenshot + recording are the same drag) and the highlight
// passing over it (the mark that got kept). The band cuts the frame rather than
// sitting inside it, so the two shapes interlock instead of stacking.

// A1 · band cuts the frame, ends flush with the plate edge
const A1 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="8" y="112" width="240" height="32" fill="url(#amber)"/>`)

// A2 · same, but the frame is a closed ring and the band is INSIDE it
const A2 = svg(`${darkPlate}
  <rect x="48" y="48" width="160" height="160" rx="26" fill="none" stroke="${CREAM}" stroke-width="32"/>
  <rect x="80" y="112" width="96" height="32" fill="url(#amber)"/>`)

// ══ B · 记号 THE MARK ════════════════════════════════════════════════════════
// The product is named after the thing it draws, so the mark is the icon. Built
// from the same rounded bars as the rest of the set, on the accent plate so it
// never has to fight a light background.

// B1 · full # (two verticals crossed by two horizontals)
const B1 = svg(`${amberPlate}
  <g fill="${INK}">
    <rect x="58" y="30" width="46" height="196" rx="14"/>
    <rect x="152" y="30" width="46" height="196" rx="14"/>
    <rect x="24" y="58" width="208" height="46" rx="14"/>
    <rect x="24" y="152" width="208" height="46" rx="14"/>
  </g>`)

// B2 · reduced mark: one vertical, two horizontals (fewer strokes, larger counters)
const B2 = svg(`${amberPlate}
  <g fill="${INK}">
    <rect x="88" y="30" width="52" height="196" rx="16"/>
    <rect x="24" y="62" width="208" height="48" rx="16"/>
    <rect x="24" y="146" width="208" height="48" rx="16"/>
  </g>`)

// ══ C · 浮面 STACK ══════════════════════════════════════════════════════════
// The product's landed FILM language, seen head-on: capture, the pin, the
// clipboard entry, the usage readout are all the same object at different depths.

// C1 · two plates, the front one offset 32u (=2px at 16px) down-right
const C1 = svg(`${darkPlate}
  <rect x="48" y="48" width="144" height="144" rx="30" fill="${CREAM}" fill-opacity="0.34"/>
  <rect x="88" y="88" width="144" height="144" rx="30" fill="url(#amber)"/>`)

// C2 · two plates, front one solid cream with an amber band inside it
const C2 = svg(`${darkPlate}
  <rect x="44" y="44" width="148" height="148" rx="30" fill="url(#amber)"/>
  <rect x="84" y="84" width="148" height="148" rx="30" fill="${CREAM}"/>
  <rect x="84" y="140" width="148" height="36" fill="${INK}"/>`)

// ══ losers kept as controls ═════════════════════════════════════════════════
// D1 · marker stroke with a blunt tip (probe K1): reads as a bar with a cap
const D1 = svg(`${amberPlate}
  <rect x="24" y="104" width="148" height="48" rx="6" fill="${CREAM}"/>
  <path d="M172 104 H216 A16 16 0 0 1 232 120 V136 A16 16 0 0 1 216 152 H172 Z" fill="${INK}"/>`)

// D2 · corner brackets (v1 A1): merges into a "+" below 24px
const D2 = svg(`${darkPlate}
  <g fill="${CREAM}">
    <path d="M48 48 H112 V80 H80 V112 H48 Z"/>
    <path d="M208 48 H144 V80 H176 V112 H208 Z"/>
    <path d="M208 208 H144 V176 H176 V144 H208 Z"/>
    <path d="M48 208 H112 V176 H80 V144 H48 Z"/>
  </g>
  <rect x="8" y="112" width="240" height="32" fill="url(#amber)"/>`)

const VARIANTS = [
  ['A1', A1, '取景框上的记号 · 带切框'],
  ['A2', A2, '取景框上的记号 · 带在框内'],
  ['B1', B1, '记号 · 完整 #'],
  ['B2', B2, '记号 · 减笔'],
  ['C1', C1, '浮面 · 两枚错位'],
  ['C2', C2, '浮面 · 带记号的前板'],
  ['D1', D1, '对照 · 笔尖'],
  ['D2', D2, '对照 · 四角']
]
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
for (const [id, text, label] of VARIANTS) {
  const cells = []
  for (const size of SIZES) {
    const b64 = await raster(text, size)
    const shown = size <= 24 ? 8 : size === 32 ? 5 : size === 48 ? 4 : size === 64 ? 3 : 1
    const px = size * shown
    cells.push(`<figure class="cell"><img src="data:image/png;base64,${b64}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${size}${shown > 1 ? `·${shown}×` : ''}</figcaption></figure>`)
  }
  rows.push(`<section class="row"><header><b>${id}</b><span>${label}</span></header>
    <div class="strip light">${cells.join('')}</div>
    <div class="strip dark">${cells.join('')}</div></section>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#e8e2d4;font:13px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
section{background:#fffdf7;border-radius:14px;margin-bottom:14px;overflow:hidden;box-shadow:0 10px 24px -14px rgba(52,38,20,.3)}
header{display:flex;gap:10px;align-items:baseline;padding:7px 14px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace;font-size:12px}
header span{color:#8b8069;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif}
.strip{display:flex;align-items:flex-end;gap:18px;padding:12px 14px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>${rows.join('')}`

fs.writeFileSync(path.join(outDir, 'probe3.html'), html)
const ctx = await browser.newContext({ viewport: { width: 980, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'probe3.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'probe3.png'), fullPage: true })
await browser.close()
console.log('probe3 done')
