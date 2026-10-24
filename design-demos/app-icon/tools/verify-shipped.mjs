// Verify the SHIPPED assets (not the design masters) in the places they appear.
//
//   node design-demos/app-icon/tools/verify-shipped.mjs
//
// This reads assets/icon.ico, assets/icon.png and assets/icon-dark.png exactly as
// the product will — the ICO's own embedded frames, and the two tray PNGs — and
// composites them into a taskbar, an Alt-Tab panel, a title bar and a tray, beside
// the real competitor icons from refs/raw.
//
// The point is to catch the class of mistake that only shows up after packaging:
// the design masters were approved, but what shipped is a different rasterisation
// path (Icon writer → ICO → shell). If those two disagree, this is where it shows.

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const assets = path.join(root, 'assets')
const outDir = path.join(root, 'design-demos/app-icon/out/shipped')
fs.mkdirSync(outDir, { recursive: true })

// ── extract the ICO frames with the bundled Python ─────────────────────────
// Pillow can enumerate an ICO's frames directly; doing it here means the frames we
// look at are the ones actually inside the file the installer ships.
const PY = 'C:/Users/MSN/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'
const extract = `
import os, sys
from PIL import Image
src = sys.argv[1]
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
ico = Image.open(src)
for (w, h) in sorted(ico.info.get('sizes', [])):
    im = Image.open(src)
    im.size = (w, h)
    im.load()
    im.convert('RGBA').save(os.path.join(out, f'ico-{w}.png'))
print('frames', sorted(ico.info.get('sizes', [])))
`
execFileSync(PY, ['-c', extract, path.join(assets, 'icon.ico'), outDir], { stdio: 'inherit' })

const dataUri = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
const ico = (size) => dataUri(path.join(outDir, `ico-${size}.png`))
const trayLight = dataUri(path.join(assets, 'icon.png'))
const trayDark = dataUri(path.join(assets, 'icon-dark.png'))

function competitor(vendor) {
  const d = path.join(root, 'design-demos/app-icon/refs/raw', vendor)
  if (!fs.existsSync(d)) return null
  const files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png'))
  const pick = files.find((f) => f.includes('256')) || files.sort((a, b) => a.length - b.length)[0]
  return pick ? dataUri(path.join(d, pick)) : null
}
const COMP = ['Snipaste', 'PixPin', 'ShareX', 'SnippingTool', 'Flameshot', 'PowerToys']
  .map(competitor).filter(Boolean)
const compStrip = COMP.map((u) => `<img src="${u}" width="24" height="24">`).join('')

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;padding:34px;background:#f2efe8;color:#1d1a16;
     font:13px/1.55 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif}
h1{font:600 21px/1.28 "Segoe UI Variable Display","Segoe UI";margin:0 0 4px}
.lede{margin:0 0 26px;color:#5b5245;max-width:78ch}
h2{font:600 13px/1.3 "Segoe UI Variable Display","Segoe UI";margin:26px 0 10px;color:#3b352c}
.card{background:#fffdf7;border-radius:16px;padding:16px 18px;margin-bottom:14px;
      box-shadow:0 1px 2px rgba(52,38,20,.07),0 20px 44px -30px rgba(52,38,20,.4)}
.row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.row:last-child{margin-bottom:0}
.lbl{width:96px;flex:none;font-size:11px;color:#5b5245;line-height:1.4}
.lbl span{color:#a2967e}
.tb{flex:1;height:48px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:9px}
.tb.dark{background:#202020}.tb.light{background:#f3f3f3;box-shadow:inset 0 0 0 1px #e4e4e4}
.tb img{display:block;border-radius:4px}
.fake{width:24px;height:24px;border-radius:5px;flex:none}
.tb.dark .fake{background:#3a3a3a}.tb.light .fake{background:#dcdcdc}
.sep{width:1px;height:20px;margin:0 4px;flex:none;background:#ffffff26}
.tb.light .sep{background:#00000020}
.slot{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none;background:#ffffff14}
.tb.light .slot{background:#0000000d}
.tray{display:flex;gap:10px;align-items:center;padding:5px 9px;border-radius:6px}
.tray.dark{background:#202020}.tray.light{background:#f3f3f3;box-shadow:inset 0 0 0 1px #e4e4e4}
.tray img{display:block}
.trio{display:flex;gap:26px;align-items:flex-end}
.trio figure{margin:0;display:flex;flex-direction:column;gap:7px;align-items:center}
.altab{background:#2b2b2b;border-radius:11px;padding:13px 18px 9px;width:150px;display:flex;
       flex-direction:column;align-items:center;gap:8px;color:#e8e8e8;font-size:11px}
.titlebar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;width:240px;
          font-size:11.5px;background:#f7f5f1;box-shadow:inset 0 0 0 1px #ddd6c9;color:#2b2620}
.cap{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e}
.sizes{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
</style>
<h1>交付资产验证（读的是 assets/ 里的真实文件）</h1>
<p class="lede">不是设计稿，是打包会用的 <code>assets/icon.ico</code>（从 ICO 内部解出的每一档帧）与两个托盘 PNG。
任务栏邻居仍是 <code>refs/raw</code> 里的真实竞品图标。</p>

<h2>① icon.ico 的每一档帧（从 ICO 内部读出）</h2>
<div class="card"><div class="sizes">
  ${[16, 20, 24, 32, 40, 44, 48, 64, 96, 128, 256].map((s) => {
    const shown = Math.min(s, 128)
    return `<figure style="margin:0;display:flex;flex-direction:column;align-items:center;gap:6px">
      <img src="${ico(s)}" width="${shown}" height="${shown}" style="width:${shown}px;height:${shown}px">
      <figcaption class="cap">${s}</figcaption></figure>`
  }).join('')}
</div></div>

<h2>② 任务栏</h2>
<div class="card">
  <div class="row"><div class="lbl">深色 24px</div>
    <div class="tb dark"><span class="fake"></span><span class="fake"></span>${compStrip}<span class="sep"></span><span class="slot"><img src="${ico(24)}" width="24" height="24"></span><span style="margin-left:auto;font-size:11px;color:#dcdcdc">19:45</span></div></div>
  <div class="row"><div class="lbl">浅色 24px</div>
    <div class="tb light"><span class="fake"></span><span class="fake"></span>${compStrip}<span class="sep"></span><span class="slot"><img src="${ico(24)}" width="24" height="24"></span><span style="margin-left:auto;font-size:11px;color:#3a3a3a">19:45</span></div></div>
</div>

<h2>③ 系统托盘（icon.png / icon-dark.png，24px 实际绘制尺寸）</h2>
<div class="card">
  <div class="row"><div class="lbl">深色任务栏<br><span>用 icon-dark.png</span></div>
    <div class="tray dark">
      <img src="${trayLight}" width="24" height="24" style="opacity:.35">
      <img src="${trayLight}" width="24" height="24" style="opacity:.35">
      <img src="${trayDark}" width="24" height="24">
      <span style="margin-left:auto;font-size:11px;color:#dcdcdc">19:45</span>
    </div></div>
  <div class="row"><div class="lbl">浅色任务栏<br><span>用 icon.png</span></div>
    <div class="tray light">
      <img src="${trayDark}" width="24" height="24">
      <img src="${trayDark}" width="24" height="24">
      <img src="${trayLight}" width="24" height="24">
      <span style="margin-left:auto;font-size:11px;color:#3a3a3a">19:45</span>
    </div></div>
  <p class="cap" style="margin:8px 0 0">灰显的两个是「另一套主题的资产」放在错误背景上的样子，用来对比：若只用单一资产，在对面主题上就是这个效果。</p>
</div>

<h2>④ 其他真实表面</h2>
<div class="card"><div class="trio">
  <figure><div class="altab"><img src="${ico(48)}" width="48" height="48"><span>Highlighter</span></div><figcaption class="cap">Alt-Tab 48px</figcaption></figure>
  <figure><div class="altab" style="background:#3a3a3a"><img src="${ico(32)}" width="32" height="32"><span>任务视图 32px</span></div><figcaption class="cap">任务视图 32px</figcaption></figure>
  <figure><div class="titlebar"><img src="${ico(16)}" width="16" height="16"><span>Highlighter — 设置</span><span style="margin-left:auto;color:#8a8070">— □ ×</span></div><figcaption class="cap">标题栏 16px</figcaption></figure>
</div></div>
</html>`

fs.writeFileSync(path.join(outDir, 'shipped.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1160, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'shipped.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(outDir, 'shipped.png'), fullPage: true })
await browser.close()
console.log('shipped verification sheet:', path.join(outDir, 'shipped.png'))
