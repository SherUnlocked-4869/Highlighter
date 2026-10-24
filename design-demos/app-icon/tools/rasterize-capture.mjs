// Rasterise the capture SVGs into the exact PNG pixel sizes the ICO needs, and
// verify what came out.
//
//   node design-demos/app-icon/tools/rasterize-capture.mjs
//
// Writes design-demos/app-icon/.tmp/build/<size>.png for the app icon and the two
// tray variants. generate-icon.js then packs those into assets/icon.ico and the
// two tray PNGs, so the artwork is authored once (in SVG) and rastered by the
// renderer rather than by hand-rolled per-pixel code.
//
// Why the rasteriser is Playwright/Chromium: the artwork is SVG and every size has
// to be rendered from the vector, not downscaled from a 256 master — downscaling is
// what makes an icon look soft at 16px. Chromium is already a devDependency via
// @playwright/test, so this adds no dependency.

import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const assetDir = path.join(root, 'design-demos/app-icon/assets')
const tmp = path.join(root, 'design-demos/app-icon/.tmp/build')
fs.mkdirSync(tmp, { recursive: true })

// 20/40 are the 125%/150% DPI steps Windows asks for; 44 is the Start-menu tile;
// 96 is 400% DPI. The previous ico had only 7 sizes and let the shell resample the
// rest.
export const ICO_SIZES = [16, 20, 24, 32, 40, 44, 48, 64, 96, 128, 256]
const TRAY_SIZE = 24

// 24px and below get the SMALL-regime art (thicker frame, no gradient, no drop
// shadow) — the same split the tray uses, and for the same measured reason: at that
// size a gradient and a shadow are smear, not craft. The first cut of this script
// rendered every ICO frame from the large master, and the 16/20/24 frames came out
// visibly soft (see out/shipped/shipped.png). This is the fix.
const SMALL_REGIME_MAX = 24

const app = fs.readFileSync(path.join(assetDir, 'capture-app.svg'), 'utf8')
// capture-tray-light.svg IS the small-regime app art on the graphite tile: the tray
// on a light taskbar and the 16–24px app frames are the same drawing.
const appSmall = fs.readFileSync(path.join(assetDir, 'capture-tray-light.svg'), 'utf8')
const trayDark = fs.readFileSync(path.join(assetDir, 'capture-tray-dark.svg'), 'utf8')

const browser = await chromium.launch()

async function raster(svg, size, outFile) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  await page.setContent(
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    `svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  fs.writeFileSync(outFile, buf)
  await ctx.close()
  return buf
}

for (const size of ICO_SIZES) {
  const svg = size <= SMALL_REGIME_MAX ? appSmall : app
  await raster(svg, size, path.join(tmp, `app-${size}.png`))
}
console.log('app frames:', ICO_SIZES.join(' '), `(${ICO_SIZES.filter((s) => s <= SMALL_REGIME_MAX).join('/')} from the small regime)`)

// ── tray sources ───────────────────────────────────────────────────────────
// The tray draws at 24px LOGICAL and tray-icon.js resizes the source to that, so
// the source has to be larger than 24 or Windows' DPI scaling will upscale a 24px
// bitmap and blur it (the reason the old asset was 256). TRAY_SOURCE is 96: four
// times the logical size, so a 150%/200% display still downsamples instead of
// upsampling.
//
// Both tray files use the SMALL-regime art, because that is the size they are seen
// at. Using the large master here was the flaw in the first cut: the tray is the
// one place where the gradient and drop shadow are guaranteed to be seen at 24px.
const TRAY_SOURCE = 256
for (const [name, svg] of [['tray-light', appSmall], ['tray-dark', trayDark]]) {
  await raster(svg, TRAY_SOURCE, path.join(tmp, `${name}-${TRAY_SOURCE}.png`))
  // keep a 24px copy as evidence of what the tray actually draws
  await raster(svg, TRAY_SIZE, path.join(tmp, `${name}-${TRAY_SIZE}.png`))
  console.log('tray:', name, `source ${TRAY_SOURCE}px, drawn at ${TRAY_SIZE}px`)
}

await browser.close()

// ── verify what was actually written ───────────────────────────────────────
// Every frame must be fully opaque inside the tile and have a real transparent
// margin, otherwise the ICO will render with a hard square edge in Explorer.
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const report = []
for (const size of ICO_SIZES) {
  const file = path.join(tmp, `app-${size}.png`)
  const buf = fs.readFileSync(file)
  const dim = pngSize(buf)
  if (!dim || dim.width !== size || dim.height !== size) {
    throw new Error(`frame ${size}: expected ${size}x${size}, got ${JSON.stringify(dim)}`)
  }
  report.push({ size, bytes: buf.length })
}
console.log('verified', report.length, 'app frames, all square and correctly sized')
