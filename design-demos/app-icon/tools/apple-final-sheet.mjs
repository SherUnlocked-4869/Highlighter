// Review sheet for the shipping Apple-style set.
//
//   node design-demos/app-icon/tools/apple-final-sheet.mjs
//
// Layout: one row per direction. Columns are the sizes that matter, each drawn at
// its real pixel size (16px is additionally blown up 10× so the raster can be
// judged). Top half on a light surface, bottom half on #1a1a1c — the two places
// these icons will actually live.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const dir = path.join(root, 'design-demos/app-icon/out/apple/final')
const png = path.join(dir, 'png')

const directions = JSON.parse(fs.readFileSync(path.join(dir, 'directions.json'), 'utf8'))
const b64 = (id, s) => fs.readFileSync(path.join(png, `${id}-${s}.png`)).toString('base64')

const SIZES = [128, 96, 64, 48, 32, 24, 16]

const rows = directions.map((d) => {
  const cells = SIZES.map((s) => {
    const shown = s === 16 ? 6 : 1
    const px = s * shown
    return `<figure class="cell"><img src="data:image/png;base64,${b64(d.id, s)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${s}</figcaption></figure>`
  }).join('')

  return `<section class="dir">
    <div class="head">
      <span class="badge">${d.en}</span>
      <h2>${d.name}</h2>
      <span class="cn">${d.concept}</span>
    </div>
    <div class="bands">
      <div class="band">
        <div class="bandlabel">256 · 主形</div>
        <img src="data:image/png;base64,${b64(d.id, 256)}" width="224" height="224">
      </div>
      <div class="band sizes light"><div class="bandlabel">浅底</div>${cells}</div>
      <div class="band sizes dark"><div class="bandlabel">深底</div>${cells}</div>
    </div>
    <div class="notes">
      <p><span>强在哪</span>${d.strength}</p>
      <p><span>代价</span>${d.tradeoff}</p>
    </div>
  </section>`
}).join('')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Highlighter · 苹果风格图标</title><style>
  body{margin:0;padding:46px 42px 54px;background:#f2efe8;color:#1d1a16;
       font:14px/1.62 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif}
  h1{font:600 27px/1.22 "Segoe UI Variable Display","Segoe UI";margin:0 0 10px;letter-spacing:-.02em}
  .lede{margin:0 0 34px;max-width:76ch;color:#5b5245}
  .lede b{color:#1d1a16}
  section.dir{background:#fffdf7;border-radius:26px;margin-bottom:22px;overflow:hidden;
              box-shadow:0 1px 2px rgba(52,38,20,.07),0 30px 64px -38px rgba(52,38,20,.46)}
  .head{display:flex;align-items:baseline;gap:12px;padding:20px 26px 16px;flex-wrap:wrap}
  .badge{font:600 10px/1 "Cascadia Mono",Consolas,monospace;color:#a86c22;
         background:#f8e9cf;border-radius:6px;padding:6px 8px;letter-spacing:.1em}
  .head h2{font:600 19px/1.2 "Segoe UI Variable Display","Segoe UI";margin:0;letter-spacing:-.01em}
  .head .cn{flex:1 1 100%;font-size:13px;color:#5b5245;margin-top:2px}
  .bands{display:grid;grid-template-columns:264px 1fr 1fr;gap:0;border-top:1px solid #ece4d4}
  .band{padding:18px 20px;display:flex;flex-direction:column;gap:12px;justify-content:flex-end}
  .band.dark{background:#1a1a1c}
  .bandlabel{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e;letter-spacing:.05em}
  .band.dark .bandlabel{color:#7d766c}
  .band.sizes{flex-direction:row;align-items:flex-end;gap:18px;flex-wrap:wrap}
  .band.sizes.light{background:#faf7f1}
  .cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:7px}
  figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e}
  .band.dark figcaption{color:#7d766c}
  .notes{display:grid;grid-template-columns:1fr 1fr;gap:6px 26px;padding:14px 26px 20px;
         border-top:1px solid #ece4d4;font-size:12.5px;color:#5b5245}
  .notes p{margin:0}
  .notes span{display:inline-block;font:9px "Cascadia Mono",Consolas,monospace;color:#a2967e;
              letter-spacing:.08em;text-transform:uppercase;margin-right:8px}
</style></head><body>
  <h1>Highlighter · 应用图标 · 苹果风格</h1>
  <p class="lede">构造：<b>超椭圆</b>（|x|⁵+|y|⁵=1，曲率连续，45° 处落在 87.1%——与苹果磁贴同一位置）＋ <b>带色相偏移的本体渐变</b> ＋
  <b>顶部方向光</b>（大面积线性衰减 + 贴顶窄亮带，不是径向光团）＋ <b>底部接触阴影</b>。字形是独立物体：自带渐变、投影、上缘高光。
  <b>24px 及以下单独重画</b>（字形放大到 68%、去掉渐变与投影），这是苹果自己的做法，也是 16px 还认得出的原因。</p>
  ${rows}
</body></html>`

fs.writeFileSync(path.join(dir, 'sheet.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(dir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(dir, 'sheet.png'), fullPage: true })
await browser.close()
console.log('sheet done')
