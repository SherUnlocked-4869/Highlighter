// Render rim variants for tune-dark-edge.py. Prints one JSON line: the variant
// list with output filenames, so the Python side can measure them.
//
// The problem being solved: a dark plate on a #202020 taskbar has almost no edge.
// The rim has to be bright enough to bound the silhouette, but thin enough that
// it does not read as a second frame at 32px+.

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const work = path.join(root, 'design-demos/app-icon/out/tune')
fs.mkdirSync(work, { recursive: true })

const CFG = [
  // name, plate top, plate bottom, rim opacity, rim width
  ['dark-rim-16-013', '#2c261e', '#161310', 0.13, 16],
  ['dark-rim-16-020', '#2c261e', '#161310', 0.20, 16],
  ['dark-rim-16-028', '#2c261e', '#161310', 0.28, 16],
  ['dark-lift-000-16', '#3a332a', '#232019', 0.13, 16],
  ['dark-lift-000-24', '#3a332a', '#232019', 0.18, 16],
  ['dark-lift-rim-24', '#3a332a', '#232019', 0.24, 16],
  ['dark-rim-24-030', '#2c261e', '#161310', 0.30, 24],
  ['mid-graphite-44', '#4a4238', '#2c261e', 0.16, 16]
]

const svgFor = (top, bottom, rimOpacity, rimW) => {
  const r = 58
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="p" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="${r}" fill="url(#p)"/>
  <rect x="${8 + rimW / 2}" y="${8 + rimW / 2}" width="${240 - rimW}" height="${240 - rimW}"
        rx="${r - rimW / 2}" fill="none" stroke="#fbf7ee" stroke-opacity="${rimOpacity}" stroke-width="${rimW}"/>
</svg>`
}

const browser = await chromium.launch()
const out = []
for (const [name, top, bottom, opacity, rimW] of CFG) {
  const svg = svgFor(top, bottom, opacity, rimW)
  const ctx = await browser.newContext({ viewport: { width: 16, height: 16 } })
  const page = await ctx.newPage()
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:16px;height:16px}</style>` +
    svg.replace('width="256" height="256"', 'width="16" height="16"')
  )
  const el = await page.$('svg')
  await el.screenshot({ path: path.join(work, `${name}.png`), omitBackground: true })
  await ctx.close()
  out.push({ name, file: `${name}.png` })
}
await browser.close()

console.log(JSON.stringify(out))
