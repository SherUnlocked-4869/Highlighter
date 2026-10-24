// In-context proof for the Apple-style set: the surfaces these icons actually
// live in on Windows, beside the real competitor icons from refs/raw.
//
//   node design-demos/app-icon/tools/apple-context.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const dir = path.join(root, 'design-demos/app-icon/out/apple/final')
const png = path.join(dir, 'png')
const refsRaw = path.join(root, 'design-demos/app-icon/refs/raw')

const uri = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
const icon = (id, s) => uri(path.join(png, `${id}-${s}.png`))

function competitor(vendor) {
  const d = path.join(refsRaw, vendor)
  if (!fs.existsSync(d)) return null
  const files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png'))
  const pick = files.find((f) => f.includes('256')) || files.sort((a, b) => a.length - b.length)[0]
  return pick ? uri(path.join(d, pick)) : null
}

const COMP = ['Snipaste', 'PixPin', 'ShareX', 'SnippingTool', 'Flameshot', 'PowerToys']
  .map((v) => competitor(v))
  .filter(Boolean)

const strip = COMP.map((u) => `<img src="${u}" width="24" height="24">`).join('')

const directions = JSON.parse(fs.readFileSync(path.join(dir, 'directions.json'), 'utf8'))

const blocks = directions.map((d) => `
<section>
  <h2><span class="badge">${d.en}</span>${d.name}</h2>

  <div class="row">
    <div class="lbl">任务栏 24px<br><span>深色</span></div>
    <div class="tb dark"><span class="fake"></span><span class="fake"></span>${strip}<span class="sep"></span><span class="slot"><img src="${icon(d.id, 24)}" width="24" height="24"></span><span class="clock">16:58</span></div>
  </div>

  <div class="row">
    <div class="lbl">任务栏 24px<br><span>浅色</span></div>
    <div class="tb light"><span class="fake"></span><span class="fake"></span>${strip}<span class="sep"></span><span class="slot"><img src="${icon(d.id, 24)}" width="24" height="24"></span><span class="clock">16:58</span></div>
  </div>

  <div class="row trio">
    <figure><div class="altab"><img src="${icon(d.id, 48)}" width="48" height="48"><figcaption>Highlighter</figcaption></div><figcaption class="cap">Alt-Tab 48px</figcaption></figure>
    <figure><div class="desk"><img src="${icon(d.id, 96)}" width="96" height="96"><figcaption>Highlighter</figcaption></div><figcaption class="cap">桌面 96px</figcaption></figure>
    <figure><div class="titlebar"><img src="${icon(d.id, 16)}" width="16" height="16"><span>Highlighter — 设置</span><span class="tb">— □ ×</span></div><figcaption class="cap">标题栏 16px</figcaption></figure>
  </div>
</section>`).join('')

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
body{margin:0;padding:38px;background:#f2efe8;color:#1d1a16;
     font:13px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif}
h1{font:600 22px/1.26 "Segoe UI Variable Display","Segoe UI";margin:0 0 6px;letter-spacing:-.015em}
.lede{margin:0 0 28px;max-width:76ch;color:#5b5245}
section{background:#fffdf7;border-radius:20px;padding:18px 22px 22px;margin-bottom:18px;
        box-shadow:0 1px 2px rgba(52,38,20,.07),0 24px 52px -34px rgba(52,38,20,.44)}
h2{display:flex;align-items:center;gap:10px;font:600 15px/1.3 "Segoe UI Variable Display","Segoe UI";margin:0 0 14px}
.badge{font:600 9px/1 "Cascadia Mono",Consolas,monospace;color:#a86c22;background:#f8e9cf;
       border-radius:5px;padding:5px 7px;letter-spacing:.1em}
.row{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.lbl{width:86px;flex:none;font-size:11px;color:#5b5245;line-height:1.4}
.lbl span{color:#a2967e}
.tb{flex:1;height:48px;display:flex;align-items:center;gap:6px;padding:0 10px;border-radius:9px}
.tb.dark{background:#202020}.tb.light{background:#f3f3f3;box-shadow:inset 0 0 0 1px #e4e4e4}
.tb img{display:block;border-radius:4px}
.fake{width:24px;height:24px;border-radius:5px;flex:none}
.tb.dark .fake{background:#3a3a3a}.tb.light .fake{background:#dcdcdc}
.sep{width:1px;height:20px;margin:0 4px;flex:none}
.tb.dark .sep{background:#ffffff26}.tb.light .sep{background:#00000020}
.slot{width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex:none}
.tb.dark .slot{background:#ffffff14}.tb.light .slot{background:#0000000d}
.clock{margin-left:auto;font-size:11px}
.tb.dark .clock{color:#dcdcdc}.tb.light .clock{color:#3a3a3a}
.trio{align-items:flex-end;gap:24px}
.trio figure{margin:0;display:flex;flex-direction:column;gap:7px}
.altab{background:#2b2b2b;border-radius:11px;padding:13px 18px 9px;width:148px;display:flex;flex-direction:column;align-items:center;gap:8px}
.altab figcaption{color:#e8e8e8;font-size:11px}
.desk{background:linear-gradient(160deg,#334155,#1e293b);border-radius:8px;padding:14px 10px 8px;
      display:flex;flex-direction:column;align-items:center;gap:7px;width:150px}
.desk figcaption{color:#e2e8f0;font-size:10px}
.titlebar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;width:246px;
          font-size:11.5px;background:#f7f5f1;box-shadow:inset 0 0 0 1px #ddd6c9;color:#2b2620}
.tb-btns{margin-left:auto;color:#8a8070;letter-spacing:2px}
.cap{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e}
</style>
<h1>图标在真实 Windows 环境里</h1>
<p class="lede">任务栏里旁边是 <code>refs/raw</code> 里 7 个真实同类产品的官方图标——判断「认不认得出来」只能在邻居中间判断。高亮框标出的是本图标所在槽位。</p>
${blocks}`

fs.writeFileSync(path.join(dir, 'context.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(dir, 'context.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(dir, 'context.png'), fullPage: true })
await browser.close()
console.log('context done')
