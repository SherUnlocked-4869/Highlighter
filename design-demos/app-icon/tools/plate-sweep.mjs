// Plate/glyph sweep against Microsoft's published contrast bar.
//
// Microsoft's app-icon design page states the only quantitative bar the platform
// gives: "Make sure at least half of your icon passes a 3.0:1 contrast ratio on
// light and dark theme."
//
// Solving that as a constraint gives a hard number. A pixel clears 3:1 against BOTH
// #f3f3f3 (L=.8963) and #202020 (L=.0144) only if its own luminance is inside
// [0.1433, 0.2654]. So with ONE asset, at least half the icon's area must sit in
// that mid band — which in practice means the PLATE is mid-tone and the glyph is an
// extreme. Every plate below walks that band; the glyphs are the two extremes.
//
// Measured reference (tools/acceptance.py): the seven shipping icons in refs/raw
// score worst-case 26–47% at 16px; Microsoft's own Snipping Tool scores 8% on
// light. So the bar is aspirational in the market — but it is still the right
// target to aim at, because it is the only line anyone has drawn.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/plates')
fs.mkdirSync(outDir, { recursive: true })

const CREAM = '#fbf7ee'
const INK = '#1d1a16'

// plate ramps: [name, top, bottom]
const PLATES = [
  ['amber-437', '#f6ba66', '#d88521'], // current: L≈.437 — too light for the bar
  ['amber-315', '#e5952f', '#c4741a'], // L≈.315
  ['amber-265', '#d98a2b', '#b8701c'], // L≈.265 — top of the band
  ['amber-243', '#cc8028', '#a96a1c'], // L≈.243
  ['amber-197', '#b47326', '#945a18'], // L≈.197 — centre of the band
  ['amber-160', '#a06420', '#844c14'], // L≈.160
  ['amber-143', '#96591c', '#7a4412']  // L≈.143 — bottom of the band
]

// glyphs: [name, fill]
const GLYPHS = [
  ['cream', CREAM],
  ['ink', INK]
]

// three marks, same as the directions
const MARKS = {
  A: (fill) => `<rect x="44" y="44" width="168" height="168" rx="26" fill="${fill}"/>
    <rect x="0" y="112" width="256" height="48" fill="none"/>`,
  B: (fill) => `<g fill="${fill}">
      <rect x="58" y="30" width="46" height="196" rx="14"/>
      <rect x="152" y="30" width="46" height="196" rx="14"/>
      <rect x="24" y="58" width="208" height="46" rx="14"/>
      <rect x="24" y="152" width="208" height="46" rx="14"/>
    </g>`,
  C: (fill) => `<rect x="48" y="48" width="136" height="136" rx="28" fill="${fill}" fill-opacity="0.34"/>
    <rect x="88" y="88" width="136" height="136" rx="28" fill="${fill}"/>`
}

const svgFor = (top, bottom, markSvg, glyphFill) => {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
  </linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#t)"/>
  ${markSvg(glyphFill)}
</svg>`
}

// A's mark is frame(fill1) + band(fill2): the frame takes the glyph colour and the
// band takes the opposite extreme, so both extremes get exercised.
const A_MARK = (frameFill, bandFill) => `<rect x="44" y="44" width="168" height="168" rx="26" fill="${frameFill}"/>
  <rect x="0" y="112" width="256" height="48" fill="${bandFill}"/>`

const browser = await chromium.launch()
async function shot(svg, size, file) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  fs.writeFileSync(file, buf)
  await ctx.close()
  return buf
}

const made = []
for (const [plateName, top, bottom] of PLATES) {
  for (const [glyphName, glyphFill] of GLYPHS) {
    // B and C use a single glyph colour
    for (const mark of ['B', 'C']) {
      const name = `${mark}-${plateName}-${glyphName}`
      const svg = svgFor(top, bottom, MARKS[mark], glyphFill)
      await shot(svg, 16, path.join(outDir, `${name}-16.png`))
      await shot(svg, 256, path.join(outDir, `${name}-256.png`))
      made.push({ name, mark, plate: plateName, glyph: glyphName })
    }
    // A uses two extremes: frame cream / band ink, and frame ink / band cream
    for (const [variant, frameFill, bandFill] of [
      ['fc', CREAM, INK],
      ['fi', INK, CREAM]
    ]) {
      const name = `A-${plateName}-${glyphName}-${variant}`
      const svg = svgFor(top, bottom, (f) => A_MARK(f, bandFill), frameFill)
      await shot(svg, 16, path.join(outDir, `${name}-16.png`))
      await shot(svg, 256, path.join(outDir, `${name}-256.png`))
      made.push({ name, mark: 'A', plate: plateName, glyph: glyphName + '-' + variant })
    }
  }
}
await browser.close()

fs.writeFileSync(path.join(outDir, 'made.json'), JSON.stringify(made, null, 2))
console.log('rendered', made.length, 'variants')
