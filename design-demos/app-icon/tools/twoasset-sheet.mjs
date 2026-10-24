// Visual sheet for the two-asset strategy — the one that keeps the brand amber.
//
// Each direction gets two assets. The light-theme asset is shown on white, the
// dark-theme asset on #202020, because that is the only pairing either of them will
// ever be seen in. Showing them on the "wrong" background would be a test of
// nothing.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const dir = path.join(root, 'design-demos/app-icon/out/twoasset')

const SIZES = [256, 64, 48, 32, 24, 16]
const b64 = (f) => fs.readFileSync(f).toString('base64')

const IDS = [
  ['A', '取景框上的记号', 'MARK ON FRAME'],
  ['B', '记号', 'THE MARK'],
  ['C', '浮面', 'STACK']
]

const cells = (id, theme) => SIZES.map((s) => {
  const file = path.join(dir, `${id}-${theme}-${s}.png`)
  if (!fs.existsSync(file)) return ''
  const shown = s === 16 ? 8 : 1
  const px = s * shown
  return `<figure class="cell"><img src="data:image/png;base64,${b64(file)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${s}${shown > 1 ? '·8×' : ''}</figcaption></figure>`
}).join('')

const rows = IDS.map(([id, name, en]) => `
<section class="row">
  <header><span class="badge">${id}</span>${name}<em>${en}</em></header>
  <div class="pair">
    <div class="half">
      <div class="cap">浅色主题资产 → 用在白/浅底</div>
      <div class="strip light">${cells(id, 'light')}</div>
    </div>
    <div class="half">
      <div class="cap">深色主题资产 → 用在深色任务栏</div>
      <div class="strip dark">${cells(id, 'dark')}</div>
    </div>
  </div>
</section>`).join('')

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;padding:32px;background:#e8e2d4;color:#1d1a16;
     font:13px/1.55 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif}
h1{font:600 21px/1.3 "Segoe UI Variable Display","Segoe UI";margin:0 0 6px}
.lede{margin:0 0 26px;max-width:78ch;color:#4a4338}
section{background:#fffdf7;border-radius:16px;margin-bottom:16px;overflow:hidden;
        box-shadow:0 1px 2px rgba(52,38,20,.10),0 16px 34px -24px rgba(52,38,20,.34)}
header{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid #ece3d2;
       font:600 15px/1.3 "Segoe UI Variable Display","Segoe UI"}
header em{margin-left:auto;font:400 10px/1 "Cascadia Mono",Consolas,monospace;color:#9a8f79;letter-spacing:.08em}
.badge{font:600 12px/1 "Cascadia Mono",Consolas,monospace;color:#8a4f0a;background:#f7e3c4;border-radius:6px;padding:5px 8px}
.pair{display:grid;grid-template-columns:1fr 1fr}
.half{border-right:1px solid #ece3d2}
.half:last-child{border-right:none}
.cap{font:11px "Cascadia Mono",Consolas,monospace;color:#8a8070;padding:10px 16px 0}
.strip{display:flex;align-items:flex-end;gap:16px;padding:12px 16px 16px}
.strip.dark{background:#202020}
.strip.dark + .cap{}
.cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#9a8f79}
.strip.dark figcaption{color:#a99e88}
</style>
<h1>双套资产方案 · 保住品牌琥珀</h1>
<p class="lede">微软官方给的路（而不是单套压暗）：浅色主题用深底板、深色主题用亮琥珀板，各自只管自己的背景。
代价是要出两套位图，收益是 <b>#E5A44C / #F6BA66</b> 这个明亮琥珀得以完整保留，同时两边都过 3:1。
产品里其实已经有这个先例——托盘图标本来就有 light/dark 两份（<code>main/services/tray-icon.js</code>）。</p>
${rows}
</html>`

fs.writeFileSync(path.join(dir, 'sheet.html'), html)
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(dir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(dir, 'sheet.png'), fullPage: true })
await browser.close()
console.log('two-asset sheet done')
