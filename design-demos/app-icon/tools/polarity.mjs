// Polarity sweep — the gap the review caught.
//
// Every earlier sweep held the plate amber and varied only its BRIGHTNESS. But the
// real question is which of the two elements owns the >50% area: the plate or the
// mark. That is a polarity question, and it was never tested.
//
// The claim to check: plate = --ink #1d1a16, mark = bright amber #e5a44c.
//   ink   vs #f3f3f3 = 15.62:1   → the plate clears the LIGHT theme easily
//   ink   vs #202020 =  1.06:1   → the plate does NOT clear the dark theme
//   amber vs #202020 =  7.56:1   → the MARK clears the dark theme
//   amber vs #f3f3f3 =  1.94:1   → the MARK does not clear the light theme
//
// So inverted polarity only works on both themes if the MARK owns >50% of the area
// on dark — which is a different drawing, not a colour change. This file renders
// both polarities at several mark:plate area ratios so the ratio can be measured
// rather than argued about.
//
//   node design-demos/app-icon/tools/polarity.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/polarity')
fs.mkdirSync(outDir, { recursive: true })

const INK = '#1d1a16'
const AMBER = '#e5a44c'

const TILE_DARK = `<rect x="8" y="8" width="240" height="240" rx="58" fill="${INK}"/>`
const TILE_AMBER = `<rect x="8" y="8" width="240" height="240" rx="58" fill="${AMBER}"/>`

// P1 — inverted polarity, thin mark: the plate owns most of the area.
// Expect: passes LIGHT (ink 15.6:1), fails DARK (ink 1.06:1 dominates).
const P1 = `<rect x="44" y="44" width="168" height="168" rx="26" fill="none" stroke="${AMBER}" stroke-width="32"/>
  <rect x="0" y="112" width="256" height="48" fill="${AMBER}"/>`

// P2 — inverted polarity, FAT mark: the mark now owns more than half.
// This is the only inverted variant that could clear dark.
const P2 = `<rect x="40" y="40" width="176" height="118" rx="24" fill="${AMBER}"/>
  <rect x="40" y="178" width="176" height="38" rx="10" fill="${AMBER}"/>`

// P3 — inverted polarity, mark as a solid slab with an ink slot cut in it.
const P3 = `<rect x="36" y="36" width="184" height="184" rx="26" fill="${AMBER}"/>
  <rect x="36" y="112" width="184" height="32" fill="${INK}"/>`

// P4 — normal polarity for reference (this is what ships today, retuned tile).
const P4 = `<rect x="8" y="8" width="240" height="240" rx="58" fill="#d98a2b"/>
  <rect x="44" y="44" width="168" height="168" rx="26" fill="${INK}"/>
  <rect x="0" y="112" width="256" height="48" fill="#f9f5ec"/>`

// P5 — normal polarity, bright tile, dark mark (the ORIGINAL brand build).
const CREAM = '#f9f5ec'
const P5 = `<rect x="8" y="8" width="240" height="240" rx="58" fill="${AMBER}"/>
  <rect x="44" y="44" width="168" height="168" rx="26" fill="${CREAM}"/>
  <rect x="0" y="112" width="256" height="48" fill="${INK}"/>`

const VARIANTS = [
  ['P1-inverted-thin', TILE_DARK + P1],
  ['P2-inverted-fat', TILE_DARK + P2],
  ['P3-inverted-slab', TILE_DARK + P3],
  ['P4-normal-retuned', P4],
  ['P5-normal-bright', P5]
]

const SVG = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${body}</svg>`

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

for (const [name, body] of VARIANTS) {
  const svg = SVG(body)
  for (const size of [16, 24, 48, 256]) {
    await shot(svg, size, path.join(outDir, `${name}-${size}.png`))
  }
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg)
}
await browser.close()

fs.writeFileSync(
  path.join(outDir, 'made.json'),
  JSON.stringify(VARIANTS.map(([name]) => ({ name })), null, 2)
)
console.log('polarity variants rendered:', VARIANTS.length)
