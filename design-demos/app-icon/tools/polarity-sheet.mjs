// Visual sheet for the polarity test.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const dir = path.join(root, 'design-demos/app-icon/out/polarity')

const NAMES = [
  ['P5-normal-bright', '现行方案 · 亮琥珀底板 + 深记号（原始品牌色）'],
  ['P4-normal-retuned', '压暗底板 + 深记号（我上一轮的错误尝试）'],
  ['P1-inverted-thin', '反转极性 · 深底板 + 琥珀框与带'],
  ['P3-inverted-slab', '反转极性 · 琥珀大块，中间切一道墨槽'],
  ['P2-inverted-fat', '反转极性 · 琥珀占多数（对照组）']
]

const SIZES = [256, 64, 48, 32, 24, 16]
const b64 = (f) => fs.readFileSync(f).toString('base64')

const rows = NAMES.map(([id, label]) => {
  const cells = SIZES.map((s) => {
    const file = path.join(dir, `${id}-${s}.png`)
    if (!fs.existsSync(file)) return ''
    const shown = s === 16 ? 8 : 1
    const px = s * shown
    return `<figure class="cell"><img src="data:image/png;base64,${b64(file)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${s}${shown > 1 ? '·8×' : ''}</figcaption></figure>`
  }).join('')
  return `<section class="row"><header>${id}<span>${label}</span></header>
    <div class="strip light">${cells}</div>
    <div class="strip dark">${cells}</div></section>`
}).join('')

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:22px;background:#e8e2d4;font:12px/1.45 "Segoe UI Variable Text","Segoe UI",sans-serif;color:#1d1a16}
h1{font:600 18px/1.3 "Segoe UI Variable Display","Segoe UI";margin:0 0 6px}
p{margin:0 0 18px;max-width:76ch;color:#4a4338}
section{background:#fffdf7;border-radius:12px;margin-bottom:11px;overflow:hidden;box-shadow:0 8px 20px -14px rgba(52,38,20,.3)}
header{padding:7px 13px;border-bottom:1px solid #e2d9c9;font-family:"Cascadia Mono",Consolas,monospace;font-size:11px}
header span{margin-left:8px;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif;color:#8a8070}
.strip{display:flex;align-items:flex-end;gap:18px;padding:12px 13px}
.strip.dark{background:#202020}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:5px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8b8069}
.dark figcaption{color:#a99e88}
</style>
<h1>极性对照：底板与记号，谁占面积、谁对背景</h1>
<p>微软那条 3:1 是按「面积」算的：占多数的那个元素的明度决定成败。所以真正的问题是极性——深底板配亮记号，还是亮底板配深记号。
深色 <code>#1D1A16</code> 对白底 15.6:1、对深底 1.06:1；琥珀 <code>#E5A44C</code> 对白底 1.94:1、对深底 7.56:1。两者互补，关键看谁占面积。</p>
${rows}`

fs.writeFileSync(path.join(dir, 'sheet.html'), html)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1040, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(dir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(dir, 'sheet.png'), fullPage: true })
await browser.close()
console.log('polarity sheet done')
