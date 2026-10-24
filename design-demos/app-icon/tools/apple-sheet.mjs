// Review sheet for the Apple-style set.
//
// Big, on a light surface and a dark one, with the real 16px raster at 10×. The
// point is to judge craft first and small-size behaviour second — the previous
// round did it the other way round and produced a diagram.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const dir = path.join(root, 'design-demos/app-icon/out/apple')

const directions = JSON.parse(fs.readFileSync(path.join(dir, 'directions.json'), 'utf8'))
const SIZES = [128, 64, 48, 32, 24, 16]
const b64 = (id, size) => fs.readFileSync(path.join(dir, 'png', `${id}-${size}.png`)).toString('base64')

const cols = directions.map((d) => {
  const small = SIZES.map((s) => {
    const shown = s === 16 ? 5 : 1
    const px = s * shown
    return `<figure class="cell"><img src="data:image/png;base64,${b64(d.id, s)}" width="${px}" height="${px}" style="width:${px}px;height:${px}px;${shown > 1 ? 'image-rendering:pixelated' : ''}"><figcaption>${s}</figcaption></figure>`
  }).join('')

  return `<section class="dir">
    <header><b>${d.id.toUpperCase()}</b><h2>${d.name}</h2><em>${d.en}</em></header>
    <div class="hero light"><img src="data:image/png;base64,${b64(d.id, 256)}" width="200" height="200"></div>
    <div class="hero dark"><img src="data:image/png;base64,${b64(d.id, 256)}" width="136" height="136"></div>
    <div class="sizes">${small}</div>
    <p class="concept">${d.concept}</p>
    <p class="why"><span>为什么这样做</span>${d.why}</p>
  </section>`
}).join('')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body{margin:0;padding:48px 44px 56px;background:#f5f2ec;color:#1d1a16;
       font:14px/1.65 "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif}
  h1{font:600 26px/1.25 "Segoe UI Variable Display","Segoe UI";margin:0 0 8px;letter-spacing:-.015em}
  .lede{margin:0 0 36px;max-width:74ch;color:#5b5245}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;align-items:start}
  section.dir{background:#fffdf7;border-radius:24px;padding:22px 22px 26px;
              box-shadow:0 1px 2px rgba(52,38,20,.08),0 24px 56px -32px rgba(52,38,20,.42)}
  header{display:flex;align-items:center;gap:9px;margin-bottom:16px}
  header b{font:600 11px/1 "Cascadia Mono",Consolas,monospace;color:#b8762a;
           background:#f7e6cb;border-radius:7px;padding:6px 8px;letter-spacing:.06em}
  header h2{font:600 18px/1.2 "Segoe UI Variable Display","Segoe UI";margin:0;letter-spacing:-.01em}
  header em{margin-left:auto;font:400 10px/1 "Cascadia Mono",Consolas,monospace;
            color:#a2967e;letter-spacing:.1em}
  .hero{border-radius:18px;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
  .hero.light{background:#f5f2ec;padding:18px 0}
  .hero.dark{background:#1a1a1c;padding:14px 0}
  .hero img{display:block}
  .sizes{display:flex;align-items:flex-end;gap:11px;padding:14px 2px 16px;
         border-bottom:1px solid #ece3d2;margin-bottom:14px;flex-wrap:wrap}
  .cell{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
  figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e}
  .concept{margin:0 0 10px;font-size:13px;color:#3b352c}
  .why{margin:0;font-size:12px;color:#6b6153;display:flex;gap:8px;flex-direction:column}
  .why span{font:10px "Cascadia Mono",Consolas,monospace;color:#a2967e;letter-spacing:.06em;text-transform:uppercase}
</style></head><body>
  <h1>Highlighter · 应用图标 · 苹果风格</h1>
  <p class="lede">超椭圆底板（|x|⁵+|y|⁵=1，曲率连续）+ 三层光模型：本体渐变带色相偏移、上半部大面积柔和高光、下部接触阴影，再加 1px 上缘高光。
  字形带极轻投影，读作「放在底板上」而不是「印在底板里」。大图先看工艺，小图再看 16px。</p>
  <div class="grid">${cols}</div>
</body></html>`

fs.writeFileSync(path.join(dir, 'sheet.html'), html)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(dir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(500)
await page.screenshot({ path: path.join(dir, 'sheet.png'), fullPage: true })
await browser.close()
console.log('sheet done')
