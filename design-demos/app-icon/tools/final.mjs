// Highlighter · app icon — FINAL, on the corrected construction.
//
//   node design-demos/app-icon/tools/final.mjs
//
// ── What changed and why (each step measured, not guessed) ────────────────
//
// 1. The first build used a bright accent tile with a light glyph. The seven real
//    shipping icons in refs/raw gave a calibration band (worst-background
//    separation 1.17–3.17), which showed the category tolerates a weak edge — but
//    Microsoft publishes one hard number, and it is the only one anyone has:
//      "Make sure at least half of your icon passes a 3.0:1 contrast ratio on
//       light and dark theme."
//      https://learn.microsoft.com/en-us/windows/apps/design/style/iconography/app-icon-design
//
// 2. Solving that as a constraint: a pixel clears 3:1 against both #f3f3f3
//    (L=.8963) and #202020 (L=.0144) only if its luminance is in [0.1433, 0.2654].
//    A first fix pulled the accent down into that band — it passed the number, but
//    the brand colour turned ochre and small-size separation got WORSE (measured
//    sepDark 8.45 → 6.69 for A). That fix was rejected.
//
// 3. The real variable is POLARITY, not brightness: the element owning >50% of the
//    area decides the outcome. --ink #1d1a16 is 15.62:1 on white and 1.06:1 on
//    #202020; #e5a44c is 1.94:1 on white and 7.56:1 on #202020. They are
//    complementary, so an INK plate with an AMBER mark clears both themes
//    (measured 61% light / 50% dark at 16px) and keeps the brand amber exactly.
//    tools/polarity.mjs holds that sweep.
//
// 4. So the tile is --ink and the accent goes back to doing what it does everywhere
//    else in the product: marking the thing you care about.
//
// ══ One idea, five capabilities ══════════════════════════════════════════
// Screenshot, recording, clipboard, pin and token-usage are not five features;
// they are one act repeated — take a piece of the screen, keep it, and let the
// kept pile become a record. Each direction draws that act and takes a different
// half of it as the hero.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/final')
for (const sub of ['svg', 'png', 'ico']) fs.mkdirSync(path.join(outDir, sub), { recursive: true })

// ── palette ────────────────────────────────────────────────────────────────
// From the landed FILM tokens (shared/tokens.css). Every value is a token; the
// icon introduces no new colour.
export const PALETTE = {
  ink: '#1d1a16',          // --ink (light end) — the plate
  accent: '#e5a44c',       // --primary default — the mark
  accentTop: '#f0b76a',    // mark gradient top
  accentBottom: '#d68f2e', // mark gradient bottom
  cream: '#f9f5ec'         // --surface
}
const P = PALETTE

const DEFS = `
  <defs>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.accentTop}"/>
      <stop offset="1" stop-color="${P.accentBottom}"/>
    </linearGradient>
  </defs>`

// ── tile ───────────────────────────────────────────────────────────────────
// 8u bleed = 0.5px at 16px, so the rounded corner is never clipped. Radius 58u of
// 256 = 22.7%; at 16px that reads as a 3px corner — what keeps a 16px square
// looking like an app tile rather than a window.
const R = 58
const TILE = `<rect x="8" y="8" width="240" height="240" rx="${R}" fill="${P.ink}"/>`

// No top rim and no plate gradient. The first build had both: a 16u cream highlight
// along the top edge and a subtle ink gradient. On an INK plate the highlight is a
// bright band across the whole top edge — exactly the wrong polarity for the light
// theme — and the gradient only ever moved the number by ~1pp. Measured with
// tools/ablate.mjs (flat/grad × rim/norim): A goes from 50% to 51% worst-case with
// both removed, B stays at 44%. They were decoration that cost contrast, so they are
// gone rather than merely toned down.

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Highlighter">${DEFS}${body}</svg>`

// ══════════════════════════════════════════════════════════════════════════
// A · 取景框上的记号  MARK ON FRAME
// ──────────────────────────────────────────────────────────────────────────
// The capture gesture: you drag a region. Screenshot and recording are the SAME
// drag, so one frame covers both. The band crosses the frame and runs out past the
// tile edge, so the mark is something that happened ON the region rather than a
// border that belongs to it. Two unequal shapes: the frame owns the silhouette, the
// band owns the colour.
const A = svg(`
  ${TILE}
  <rect x="44" y="44" width="168" height="168" rx="26" fill="none" stroke="url(#mark)" stroke-width="32"/>
  <rect x="0" y="112" width="256" height="48" fill="url(#mark)"/>`)

// ══════════════════════════════════════════════════════════════════════════
// B · 记号  THE MARK
// ──────────────────────────────────────────────────────────────────────────
// The product is named after the mark it lays down. Four bars of equal weight with
// generous counters — the most legible construction in the whole exploration, and
// the only one whose structure still reads at 16px without leaning on the tile. It
// names no single capability; the product name and the colour carry that.
const B = svg(`
  ${TILE}
  <g fill="url(#mark)">
    <rect x="58" y="30" width="46" height="196" rx="14"/>
    <rect x="152" y="30" width="46" height="196" rx="14"/>
    <rect x="24" y="58" width="208" height="46" rx="14"/>
    <rect x="24" y="152" width="208" height="46" rx="14"/>
  </g>`)

// ══════════════════════════════════════════════════════════════════════════
// C · 浮面  STACK
// ──────────────────────────────────────────────────────────────────────────
// The product's landed FILM language head-on: the capture overlay, the pin, the
// clipboard panel and the usage panel are one object at four depths. Two plates
// only — a third step merges into a smear at 16px — and the 40u offset (2.5px at
// 16px) is what keeps the two silhouettes apart.
const C = svg(`
  ${TILE}
  <rect x="48" y="48" width="136" height="136" rx="28" fill="url(#mark)" fill-opacity="0.65"/>
  <rect x="88" y="88" width="136" height="136" rx="28" fill="url(#mark)"/>`)

export const DIRECTIONS = [
  {
    id: 'A', name: '取景框上的记号', en: 'MARK ON FRAME', svg: A,
    glyph: '取景框 + 越框高亮带',
    concept: '截图与录屏是同一个手势：拉一个区域。高亮带横穿区域并越出画布——记号是「做过的事」，不是「画好的边」。',
    strength: '语义最直白；深色任务栏上最稳；20px 即恢复「框」的读法',
    tradeoff: '16px 时框的左右立柱塌成 1–2px 抗锯齿，退化成「两段条 + 一道横杠」，形状已不足以区分，靠颜色与位置'
  },
  {
    id: 'B', name: '记号', en: 'THE MARK', svg: B,
    glyph: '四笔等重的记号',
    concept: '产品以它画下的东西命名。五项能力最后都收敛成同一个物件：被标住、并且被留下的东西。',
    strength: '16px 结构最清楚（两竖两横 + 四个计数孔），是所有候选里唯一小尺寸仍在讲结构的',
    tradeoff: '语义最抽象，单看可能被读成表格/编号；深色面板上的面积通过率低于 A/C'
  },
  {
    id: 'C', name: '浮面', en: 'STACK', svg: C,
    glyph: '两枚错位浮面',
    concept: '把已落地的 FILM 语言正面看：截图浮层、贴图、剪贴板面板、AI 用量面板，是同一个物件在不同深度上的四次出现。',
    strength: '「五功能合一」的叙事最强；轮廓不对称，任务栏里不易与同类混淆',
    tradeoff: '16px 下第二层浮面几乎消失，32px 以下叙事失效'
  }
]

// ── rasterise ──────────────────────────────────────────────────────────────
// 20/40 are 125%/150% DPI, 44 is the Start-menu tile, 96 is 400% DPI.
const SIZES = [16, 20, 24, 32, 40, 44, 48, 64, 96, 128, 256]

const browser = await chromium.launch()
async function raster(text, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    text.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

for (const d of DIRECTIONS) {
  fs.writeFileSync(path.join(outDir, 'svg', `${d.id}.svg`), d.svg)
  for (const size of SIZES) {
    const buf = await raster(d.svg, size)
    fs.writeFileSync(path.join(outDir, 'png', `${d.id}-${size}.png`), buf)
  }
  console.log('rendered', d.id, d.en)
}
await browser.close()

fs.writeFileSync(path.join(outDir, 'palette.json'), JSON.stringify(P, null, 2))
fs.writeFileSync(
  path.join(outDir, 'directions.json'),
  JSON.stringify(DIRECTIONS.map(({ svg: _svg, ...rest }) => rest), null, 2)
)
console.log('\nwrote', outDir)
