// Tray consistency test: does the tray actually need a different MATERIAL from the
// app icon, or is that over-correction?
//
// The shipped tray on a dark taskbar uses an inverted material (warm light tile,
// graphite frame) so its edge stays visible against #202020. But an app icon and its
// tray icon reading as two different products is a worse failure than a soft edge —
// and the measurement says the edge may not matter as much as it looked:
//
//   cream frame  vs #202020 = 14.97 : 1   ← the glyph is what you see
//   amber mark   vs #202020 =  8.12 : 1
//   graphite tile edge      =  1.07 : 1   ← only this is lost
//
// So this renders both candidates at the tray's real 24px, on a dark taskbar, and
// lets the comparison decide instead of the earlier reasoning.
//
//   node design-demos/app-icon/tools/tray-consistency.mjs

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/tray-consistency')
fs.mkdirSync(outDir, { recursive: true })

// Candidates are the SVG sources already used by generate-icon.js.
const SOURCE = path.join(root, 'design-demos/app-icon/assets')
const smallGraphite = fs.readFileSync(path.join(SOURCE, 'capture-tray-light.svg'), 'utf8')
const smallWarm = fs.readFileSync(path.join(SOURCE, 'capture-tray-dark.svg'), 'utf8')

const browser = await chromium.launch()

async function raster(svg, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

// Real Windows tray geometry: 24px icon inside a ~40px-tall always-on-screen area,
// sitting next to other tray icons which are mostly light-on-dark glyphs.
const variants = [
  ['graphite (matches app icon)', smallGraphite],
  ['warm-inverted (current)', smallWarm]
]

const results = []
for (const [label, svg] of variants) {
  const png = await raster(svg, 24)
  fs.writeFileSync(path.join(outDir, `tray-24-${label.split(' ')[0]}.png`), png)
  results.push({ label, b64: png.toString('base64') })
}
await browser.close()

// Neighbour glyphs, drawn to scale, so the candidate is judged in its real context
// rather than alone on a swatch.
const neighbours = [
  // simple stand-ins at tray scale: a shield, a wifi arc, a volume glyph
  `<path d="M12 3 L19 6 V12 C19 16 16 19 12 20 C8 19 5 16 5 12 V6 Z" fill="none" stroke="#e8e8e8" stroke-width="1.6"/>`,
  `<path d="M5 15 A10 10 0 0 1 19 15" fill="none" stroke="#e8e8e8" stroke-width="1.6"/><circle cx="12" cy="17" r="1.4" fill="#e8e8e8"/>`,
  `<path d="M6 9 L10 9 L14 5 V19 L10 15 L6 15 Z" fill="#e8e8e8"/><path d="M16 9 A4 4 0 0 1 16 15" fill="none" stroke="#e8e8e8" stroke-width="1.5"/>`
].map((g) => `<svg width="24" height="24" viewBox="0 0 24 24">${g}</svg>`).join('')

const rows = results.map((r) => `
<section>
  <h2>${r.label}</h2>
  <div class="traybar">
    ${neighbours}
    <span class="slot onscreen"><img src="data:image/png;base64,${r.b64}" width="24" height="24"></span>
    <span class="clock">20:16</span>
  </div>
  <div class="zoom"><img src="data:image/png;base64,${r.b64}" width="192" height="192" style="image-rendering:pixelated"></div>
</section>`).join('')

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:26px;background:#f2efe8;font:13px/1.5 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
h1{font:600 18px/1.3 "Segoe UI Variable Display","Segoe UI";margin:0 0 6px}
.lede{margin:0 0 22px;max-width:78ch;color:#5b5245}
section{background:#fffdf7;border-radius:14px;padding:16px 18px;margin-bottom:14px;
        box-shadow:0 1px 2px rgba(52,38,20,.07),0 16px 36px -26px rgba(52,38,20,.4)}
h2{font:600 13px/1.3 "Segoe UI Variable Display","Segoe UI";margin:0 0 12px}
.traybar{display:flex;align-items:center;gap:14px;background:#202020;border-radius:8px;
         padding:8px 12px;height:40px;box-sizing:border-box}
.traybar svg{display:block}
.slot{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:4px}
.slot.onscreen{background:#2a2a2a}
.clock{margin-left:auto;color:#dcdcdc;font-size:11px}
.zoom{margin-top:12px;background:#202020;border-radius:10px;padding:12px;display:inline-block}
.zoom img{display:block}
</style>
<h1>托盘：石墨款 vs 反转材质款</h1>
<p class="lede">两者都画在真实 24px、真实深色任务栏（#202020）上，左侧是同尺寸的邻近托盘图标。
判据是「哪一个看起来和桌面上的 Highlighter 是同一个应用」，而不是「哪一个边缘更清楚」。</p>
${rows}`

fs.writeFileSync(path.join(outDir, 'sheet.html'), html)

const b2 = await chromium.launch()
const ctx = await b2.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true })
await b2.close()
console.log('tray consistency sheet done')
