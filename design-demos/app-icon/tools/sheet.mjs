// Review sheet for the three final directions.
//
//   node design-demos/app-icon/tools/sheet.mjs
//
// Three columns, each showing: 256 master, then 128 / 64 / 48 / 32 / 24 actual
// pixels, then 16px at 10× nearest-neighbour. The 10× column is the point of the
// sheet — it is the true 16px raster, not a re-drawing of the vector.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const finalDir = path.join(root, 'design-demos/app-icon/out/final')
const pngDir = path.join(finalDir, 'png')

const directions = JSON.parse(fs.readFileSync(path.join(finalDir, 'directions.json'), 'utf8'))
const palette = JSON.parse(fs.readFileSync(path.join(finalDir, 'palette.json'), 'utf8'))

const b64 = (id, size) => fs.readFileSync(path.join(pngDir, `${id}-${size}.png`)).toString('base64')

const SIZES = [128, 64, 48, 32, 24]

const columns = directions.map((d) => {
  const small = SIZES.map((s) => {
    const px = s === 48 || s === 32 ? s : s
    return `<figure class="cell"><img src="data:image/png;base64,${b64(d.id, s)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px"><figcaption>${s}</figcaption></figure>`
  }).join('')

  return `<section class="dir">
    <div class="head">
      <span class="badge">${d.id}</span>
      <h2>${d.name}</h2>
      <span class="en">${d.en}</span>
    </div>
    <div class="hero light"><img src="data:image/png;base64,${b64(d.id, 256)}" width="128" height="128"><figcaption>256 → 128</figcaption></div>
    <div class="hero dark"><img src="data:image/png;base64,${b64(d.id, 256)}" width="128" height="128"><figcaption>on #202020</figcaption></div>
    <div class="sizes">${small}
      <figure class="cell big"><img src="data:image/png;base64,${b64(d.id, 16)}" width="160" height="160" style="image-rendering:pixelated"><figcaption>16px · 10×</figcaption></figure>
    </div>
    <p class="concept">${d.concept}</p>
    <dl>
      <dt>强在哪</dt><dd>${d.strength}</dd>
      <dt>代价</dt><dd>${d.tradeoff}</dd>
    </dl>
  </section>`
}).join('\n')

const swatches = [
  ['ink · --ink（底板）', palette.ink],
  ['accent · --primary（记号）', palette.accent],
  ['accent 上', palette.accentTop],
  ['accent 下', palette.accentBottom],
  ['cream · --surface', palette.cream]
].map(([label, hex]) => `
  <div class="sw">
    <span class="chip" style="background:${hex}"></span>
    <b>${hex.toUpperCase()}</b>
    <em>${label}</em>
  </div>`).join('')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Highlighter · 应用图标 · 三方向</title>
<style>
  body { margin:0; padding:44px 40px 56px; background:#e8e2d4; color:#1d1a16;
         font:14px/1.65 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif; }
  h1 { font:600 24px/1.3 "Segoe UI Variable Display","Segoe UI"; margin:0 0 6px; letter-spacing:-.01em; }
  .lede { margin:0 0 34px; max-width:74ch; color:#4a4338; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; align-items:start; }
  section.dir { background:#fffdf7; border-radius:20px; padding:20px 20px 24px;
                box-shadow:0 1px 2px rgba(52,38,20,.10), 0 18px 40px -24px rgba(52,38,20,.34); }
  .head { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .badge { font:600 13px/1 "Cascadia Mono",Consolas,monospace; color:#8a4f0a;
           background:#f7e3c4; border-radius:7px; padding:6px 9px; }
  .head h2 { font:600 17px/1.2 "Segoe UI Variable Display","Segoe UI"; margin:0; }
  .head .en { margin-left:auto; font:400 10px/1 "Cascadia Mono",Consolas,monospace;
              color:#9a8f79; letter-spacing:.08em; }
  .hero { border-radius:10px; padding:14px; display:flex; flex-direction:column;
          align-items:center; gap:8px; margin-bottom:8px; }
  .hero.light { background:#fffdf7; box-shadow:inset 0 0 0 1px #e6ddcc; }
  .hero.dark  { background:#202020; }
  .hero img { display:block; }
  .hero figcaption, .cell figcaption { font:10px "Cascadia Mono",Consolas,monospace; color:#9a8f79; }
  .hero.dark figcaption { color:#8f8a80; }
  .sizes { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; margin:14px 0 4px;
           padding:12px 4px; border-top:1px solid #ece3d2; border-bottom:1px solid #ece3d2; }
  .cell { margin:0; display:flex; flex-direction:column; align-items:center; gap:6px; }
  .cell.big { margin-left:auto; }
  .concept { margin:14px 0 12px; font-size:13px; color:#3b352c; }
  dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:12.5px; }
  dt { color:#8a8070; white-space:nowrap; }
  dd { margin:0; color:#3b352c; }
  h3.sec { font:600 14px/1.3 "Segoe UI Variable Display","Segoe UI"; margin:42px 0 14px; }
  .sws { display:flex; gap:12px; flex-wrap:wrap; }
  .sw { background:#fffdf7; border-radius:12px; padding:12px 14px; display:flex;
        align-items:center; gap:10px; font-size:12px;
        box-shadow:0 1px 2px rgba(52,38,20,.08), 0 10px 22px -16px rgba(52,38,20,.3); }
  .chip { width:22px; height:22px; border-radius:6px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.10);
          display:inline-block; flex:none; }
  .sw em { color:#8a8070; font-style:normal; }
  .note { margin:18px 0 0; max-width:80ch; font-size:12.5px; color:#5b5245; }
</style></head>
<body>
  <h1>Highlighter · 应用图标</h1>
  <p class="lede">三个方向共用同一枚底板（<b>--ink 深墨、圆角 58u、无高光无渐变</b>），差别全部押在<b>字形的语言</b>上。
  底板之所以是深色而不是品牌琥珀色，是算出来的：深色占大面积时才在深浅两个背景上都过 3:1，见下方配色说明。
  每段左侧是 128 与深底对照，右侧是 128 / 64 / 48 / 32 / 24px 的真实光栅，最后一格是 <b>16px 放大 10× 的最近邻</b>——
  那一格才是任务栏里真正会看到的像素。</p>
  <div class="grid">${columns}</div>

  <h3 class="sec">配色（取自产品已落地的 FILM token）</h3>
  <div class="sws">${swatches}</div>
  <p class="note">底板的深墨 <b>#1D1A16</b> 与记号的琥珀 <b>#E5A44C</b> 都直接取自产品 token（<code>--ink</code> / <code>--primary</code> 默认值），图标没有引入任何新颜色。
  极性是深底配亮记号，而不是反过来：两者互补——深墨对白底 15.6:1、对深底 1.06:1；琥珀对白底 1.94:1、对深底 7.56:1——所以让深墨占大面积，两边就都过线。用户在设置里改 <code>--primary</code> 时，图标记号的色相跟着走即可。</p>
</body></html>`

fs.writeFileSync(path.join(finalDir, 'sheet.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(finalDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(finalDir, 'sheet.png'), fullPage: true })
await browser.close()
console.log('sheet:', path.join(finalDir, 'sheet.png'))
