// Two-asset construction, corrected by measurement.
//
// The measured fact that drives this file (tools/sweep-twoasset.py): with a
// two-asset strategy the PLATE must own at least half the icon's area in each
// theme, because the plate's luminance is what has to clear 3.0:1 against that
// theme's background — the glyph is deliberately an extreme and can never clear it.
//
//   light-theme asset → plate dark,  glyph bright  (plate = the 3:1 surface)
//   dark-theme asset  → plate bright, glyph ink    (plate = the 3:1 surface)
//
// The first attempt failed for A on light (44%) because its band cut the plate in
// half: the bright cream band plus the amber stripe covered more than half the
// area, so the dark plate did not own the icon. The fix is to keep the mark INSIDE
// the plate — which is also the better drawing, because a selection that owns its
// border reads as "a region that got marked", not as a bar laid across a box.
//
//   node design-demos/app-icon/tools/twoasset.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/twoasset')
fs.mkdirSync(outDir, { recursive: true })

const INK = '#1d1a16'
const CREAM = '#f9f5ec'

const tile = (top, bottom) => `
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
  </linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#p)"/>`

// light-theme asset: dark plate owns the area
const LIGHT_TILE = tile('#332c22', '#1b1813')
// dark-theme asset: the true brand accent, bright enough to own the area
const DARK_TILE = tile('#f6ba66', '#d88521')

// A · selection with the mark inside it
const aMark = (selectionFill, bandFill) => `
  <rect x="52" y="52" width="152" height="152" rx="26" fill="${selectionFill}"/>
  <rect x="76" y="76" width="104" height="40" rx="6" fill="${bandFill}"/>
  <rect x="76" y="140" width="64" height="20" rx="5" fill="${bandFill}" fill-opacity="0.55"/>`

// B · the mark
const bMark = (fill) => `<g fill="${fill}">
  <rect x="58" y="30" width="46" height="196" rx="14"/>
  <rect x="152" y="30" width="46" height="196" rx="14"/>
  <rect x="24" y="58" width="208" height="46" rx="14"/>
  <rect x="24" y="152" width="208" height="46" rx="14"/></g>`

// C · two plates inside the tile
const cMark = (fill) => `
  <rect x="56" y="56" width="112" height="112" rx="24" fill="${fill}" fill-opacity="0.55"/>
  <rect x="92" y="92" width="112" height="112" rx="24" fill="${fill}"/>`

const MARKS = {
  A_light: aMark(CREAM, '#c98b2e'),
  A_dark: aMark(INK, CREAM),
  B_light: bMark(CREAM),
  B_dark: bMark(INK),
  C_light: cMark(CREAM),
  C_dark: cMark(INK)
}

const SVG = (tileSvg, mark) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${tileSvg}${mark}</svg>`

const VARIANTS = []
for (const id of ['A', 'B', 'C']) {
  VARIANTS.push({ name: `${id}-light`, svg: SVG(LIGHT_TILE, MARKS[`${id}_light`]) })
  VARIANTS.push({ name: `${id}-dark`, svg: SVG(DARK_TILE, MARKS[`${id}_dark`]) })
}

const SIZES = [16, 24, 32, 48, 256]
const browser = await chromium.launch()

async function shot(svg, size, file) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  await el.screenshot({ path: file, omitBackground: true })
  await ctx.close()
}

for (const v of VARIANTS) {
  for (const size of SIZES) {
    await shot(v.svg, size, path.join(outDir, `${v.name}-${size}.png`))
  }
  fs.writeFileSync(path.join(outDir, `${v.name}.svg`), v.svg)
}
await browser.close()

fs.writeFileSync(
  path.join(outDir, 'made.json'),
  JSON.stringify(VARIANTS.map((v) => ({ name: v.name })), null, 2)
)
console.log('two-asset variants rendered:', VARIANTS.length)
