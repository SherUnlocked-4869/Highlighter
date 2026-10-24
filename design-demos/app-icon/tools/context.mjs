// In-context proof: the three directions composited into the surfaces an app icon
// actually appears in on Windows.
//
//   node design-demos/app-icon/tools/context.mjs
//
// The review sheet judges the icon on its own. This one judges it where it lives:
//   · taskbar, 24px, light and dark, next to the icons it will sit beside
//   · Alt-Tab / task view, 32–48px with a title underneath
//   · title bar 16px (the size nobody designs for and everybody sees)
//   · notification / toast 48px
//   · Start menu tile 44px
//
// The competitor icons in refs/raw are used for the taskbar strip, so the
// comparison is against what is really on a user's machine rather than against
// white space.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const finalDir = path.join(root, 'design-demos/app-icon/out/final')
const pngDir = path.join(finalDir, 'png')
const refsRaw = path.join(root, 'design-demos/app-icon/refs/raw')

const dataUri = (file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
const icon = (id, size) => dataUri(path.join(pngDir, `${id}-${size}.png`))

// pick a representative 256px competitor png per vendor
function competitorPng(vendor) {
  const dir = path.join(refsRaw, vendor)
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png'))
  const want = files.find((f) => f.includes('256')) || files.sort((a, b) => a.length - b.length)[0]
  return want ? dataUri(path.join(dir, want)) : null
}

const COMPETITORS = ['Snipaste', 'PixPin', 'ShareX', 'SnippingTool', 'Flameshot', 'PowerToys']
  .map((v) => ({ v, uri: competitorPng(v) }))
  .filter((x) => x.uri)

const taskbarStrip = (theme) => COMPETITORS.map(
  (c) => `<img src="${c.uri}" width="24" height="24" title="${c.v}">`
).join('')

const directions = JSON.parse(fs.readFileSync(path.join(finalDir, 'directions.json'), 'utf8'))

const blocks = directions.map((d) => `
<section class="dir">
  <h2><span class="badge">${d.id}</span>${d.name}<em>${d.en}</em></h2>

  <div class="row">
    <div class="label">任务栏 · 24px<br><span>深色（默认）</span></div>
    <div class="taskbar dark">
      <span class="tb-start"></span>
      <span class="tb-search"></span>
      ${taskbarStrip('dark')}
      <span class="tb-sep"></span>
      <span class="tb-slot mine"><img src="${icon(d.id, 24)}" width="24" height="24"></span>
      <span class="tb-tray">15:41</span>
    </div>
  </div>

  <div class="row">
    <div class="label">任务栏 · 24px<br><span>浅色</span></div>
    <div class="taskbar light">
      <span class="tb-start"></span>
      <span class="tb-search"></span>
      ${taskbarStrip('light')}
      <span class="tb-sep"></span>
      <span class="tb-slot mine"><img src="${icon(d.id, 24)}" width="24" height="24"></span>
      <span class="tb-tray">15:41</span>
    </div>
  </div>

  <div class="row pair">
    <figure>
      <div class="altab">
        <img src="${icon(d.id, 48)}" width="48" height="48">
        <figcaption>Highlighter</figcaption>
      </div>
      <figcaption class="cap">Alt-Tab · 48px</figcaption>
    </figure>
    <figure>
      <div class="starttile">
        <img src="${icon(d.id, 44)}" width="44" height="44">
      </div>
      <figcaption class="cap">开始菜单磁贴 · 44px</figcaption>
    </figure>
    <figure>
      <div class="titlebar light">
        <img src="${icon(d.id, 16)}" width="16" height="16"><span>Highlighter — 设置</span>
        <span class="tb-btns">— □ ×</span>
      </div>
      <figcaption class="cap">标题栏 · 16px</figcaption>
    </figure>
  </div>

  <div class="row">
    <div class="label">通知 · 48px</div>
    <div class="toast ${d.id === 'A' ? 'lightToast' : 'darkToast'}">
      <img src="${icon(d.id, 48)}" width="48" height="48">
      <div class="toast-body">
        <b>Highlighter</b>
        <p>已复制到剪贴板 · OCR 完成 · 本日 12,480 tokens</p>
      </div>
    </div>
  </div>
</section>`).join('\n')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body { margin:0; padding:40px; background:#e8e2d4; color:#1d1a16;
         font:13px/1.5 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif; }
  h1 { font:600 22px/1.3 "Segoe UI Variable Display","Segoe UI"; margin:0 0 6px; }
  .lede { margin:0 0 30px; color:#4a4338; max-width:76ch; }
  section.dir { background:#fffdf7; border-radius:18px; padding:18px 20px 22px; margin-bottom:20px;
                box-shadow:0 1px 2px rgba(52,38,20,.10), 0 18px 40px -26px rgba(52,38,20,.34); }
  h2 { display:flex; align-items:center; gap:10px; font:600 16px/1.3 "Segoe UI Variable Display","Segoe UI";
       margin:0 0 16px; }
  h2 em { margin-left:auto; font:400 10px/1 "Cascadia Mono",Consolas,monospace;
          color:#9a8f79; letter-spacing:.08em; font-style:normal; }
  .badge { font:600 12px/1 "Cascadia Mono",Consolas,monospace; color:#8a4f0a;
           background:#f7e3c4; border-radius:6px; padding:5px 8px; }
  .row { display:flex; align-items:center; gap:16px; margin-bottom:14px; }
  .label { width:112px; flex:none; font-size:12px; color:#5b5245; line-height:1.45; }
  .label span { color:#9a8f79; }

  /* taskbar: Windows 11 heights — 48px bar, 24px icons, 6px gaps */
  .taskbar { flex:1; height:48px; display:flex; align-items:center; gap:6px;
             padding:0 10px; border-radius:8px; }
  .taskbar.dark { background:#202020; }
  .taskbar.light { background:#f3f3f3; box-shadow:inset 0 0 0 1px #e2e2e2; }
  .taskbar img { display:block; border-radius:3px; }
  .tb-start, .tb-search { width:24px; height:24px; border-radius:4px; flex:none; }
  .taskbar.dark .tb-start, .taskbar.dark .tb-search { background:#3a3a3a; }
  .taskbar.light .tb-start, .taskbar.light .tb-search { background:#dcdcdc; }
  .tb-sep { width:1px; height:20px; margin:0 4px; flex:none; }
  .taskbar.dark .tb-sep { background:#ffffff26; }
  .taskbar.light .tb-sep { background:#00000020; }
  .tb-slot { width:32px; height:32px; border-radius:5px; display:flex;
             align-items:center; justify-content:center; flex:none; }
  .taskbar.dark .tb-slot.mine { background:#ffffff14; }
  .taskbar.light .tb-slot.mine { background:#0000000d; }
  .tb-tray { margin-left:auto; font-size:11px; }
  .taskbar.dark .tb-tray { color:#dcdcdc; }
  .taskbar.light .tb-tray { color:#3a3a3a; }

  .pair { align-items:flex-end; gap:26px; }
  .pair figure { margin:0; display:flex; flex-direction:column; gap:8px; }
  .altab { background:#2b2b2b; border-radius:10px; padding:14px 18px 10px; width:150px;
           display:flex; flex-direction:column; align-items:center; gap:8px; }
  .altab figcaption { color:#e8e8e8; font-size:11px; }
  .starttile { background:#2b2b2b; border-radius:8px; padding:12px; }
  .titlebar { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:8px;
              width:250px; font-size:11.5px; }
  .titlebar.light { background:#f7f5f1; box-shadow:inset 0 0 0 1px #ddd6c9; color:#2b2620; }
  .tb-btns { margin-left:auto; color:#8a8070; letter-spacing:2px; }
  .cap { font:10px "Cascadia Mono",Consolas,monospace; color:#9a8f79; }
  .toast { display:flex; gap:12px; align-items:flex-start; padding:12px 14px; border-radius:10px;
           width:420px; }
  .toast.darkToast { background:#2b2b2b; color:#f0f0f0; }
  .toast.lightToast { background:#f7f5f1; color:#2b2620; box-shadow:inset 0 0 0 1px #ddd6c9; }
  .toast img { flex:none; border-radius:4px; }
  .toast-body b { font-size:12.5px; }
  .toast-body p { margin:2px 0 0; font-size:11.5px; opacity:.82; }
</style></head><body>
  <h1>图标在真实 Windows 环境里的样子</h1>
  <p class="lede">任务栏里我把它放在真实同类图标旁边（从 refs/raw 取得），因为判断「是否认得出来」只能在邻居中间判断。
  右侧「我的图标」所在槽位加了悬停底色，方便定位。</p>
  ${blocks}
</body></html>`

fs.writeFileSync(path.join(finalDir, 'context.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(finalDir, 'context.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(finalDir, 'context.png'), fullPage: true })
await browser.close()
console.log('context:', path.join(finalDir, 'context.png'))
