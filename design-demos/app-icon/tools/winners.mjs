// Visual check of the plate sweep winners — because a number that passes the
// contrast bar can still look wrong. Renders the top-ranked variants at the sizes
// that matter, on both taskbar themes.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const plates = path.join(root, 'design-demos/app-icon/out/plates')

const PICKS = [
  'A-amber-437-cream-fi', // current build, for comparison
  'A-amber-265-cream-fi', // 54/54 — passes the bar
  'A-amber-243-cream-fi', // 59/51
  'A-amber-197-cream-fc', // 48/61
  'C-amber-315-ink',
  'C-amber-437-ink',
  'B-amber-437-ink'
]

const SIZES = [256, 64, 48, 32, 24, 16]
const b64 = (file) => fs.readFileSync(file).toString('base64')

const rows = PICKS.map((name) => {
  const cells = SIZES.map((s) => {
    const file = path.join(plates, `${name}-${s}.png`)
    if (!fs.existsSync(file)) return ''
    const shown = s === 16 ? 8 : 1
    const px = s * shown
    return `<figure class="cell"><img src="data:image/png;base64,${b64(file)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${s}${shown > 1 ? '·8×' : ''}</figcaption></figure>`
  }).join('')
  return `<section class="row"><header>${name}</header>
    <div class="strip light">${cells}</div>
    <div class="strip dark">${cells}</div></section>`
}).join('')

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#e8e2d4;font:12px/1.4 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
section{background:#fffdf7;border-radius:12px;margin-bottom:10px;overflow:hidden;box-shadow:0 8px 20px -14px rgba(52,38,20,.3)}
header{padding:6px 12px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace;font-size:11px;color:#8a4f0a}
.strip{display:flex;align-items:flex-end;gap:18px;padding:10px 12px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:4px}
figcaption{font:9px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>${rows}`

fs.writeFileSync(path.join(plates, 'winners.html'), html)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(plates, 'winners.html').replace(/\\/g, '/'))
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(plates, 'winners.png'), fullPage: true })
await browser.close()
console.log('winners sheet done')
