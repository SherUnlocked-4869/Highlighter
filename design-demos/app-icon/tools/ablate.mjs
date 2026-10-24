// Ablation: which of the tile's cosmetic layers actually help the 3:1 metric, and
// which quietly hurt it.
//
// The review flagged the 16u cream rim as "gradient-icon template residue" and
// suspected it was carrying the pass rate. Measuring says the opposite — on an ink
// plate the rim is a BRIGHT band covering the whole top edge, which is exactly the
// wrong polarity for the light theme. This renders the variants so the numbers can
// decide rather than either of us.
//
//   node design-demos/app-icon/tools/ablate.mjs && python design-demos/app-icon/tools/ablate.py

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/ablate')
fs.mkdirSync(outDir, { recursive: true })

const INK = '#1d1a16'
const INK_TOP = '#2a2419'
const ACCENT_TOP = '#f0b76a'
const ACCENT_BOT = '#d68f2e'
const CREAM = '#f9f5ec'
const R = 58

const defs = (gradPlate) => `<defs>
  ${gradPlate ? `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
     <stop offset="0" stop-color="${INK_TOP}"/><stop offset="1" stop-color="${INK}"/></linearGradient>` : ''}
  <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${ACCENT_TOP}"/><stop offset="1" stop-color="${ACCENT_BOT}"/></linearGradient>
</defs>`

const RIM = `<path d="M66 8 H190 A58 58 0 0 1 248 66 V70 A58 58 0 0 1 190 16 H66 A58 58 0 0 1 16 70 V66 A58 58 0 0 1 66 8 Z"
  fill="${CREAM}" fill-opacity="0.16"/>`

const A_MARK = `<rect x="44" y="44" width="168" height="168" rx="26" fill="none" stroke="url(#mark)" stroke-width="32"/>
  <rect x="0" y="112" width="256" height="48" fill="url(#mark)"/>`

const B_MARK = `<g fill="url(#mark)">
  <rect x="58" y="30" width="46" height="196" rx="14"/>
  <rect x="152" y="30" width="46" height="196" rx="14"/>
  <rect x="24" y="58" width="208" height="46" rx="14"/>
  <rect x="24" y="152" width="208" height="46" rx="14"/></g>`

const cMark = (op) => `<rect x="48" y="48" width="136" height="136" rx="28" fill="url(#mark)" fill-opacity="${op}"/>
  <rect x="88" y="88" width="136" height="136" rx="28" fill="url(#mark)"/>`

const VARIANTS = []
const push = (name, body) => VARIANTS.push([name, body])

for (const [vname, grad] of [['flat', false], ['grad', true]]) {
  for (const [rname, rim] of [['rim', RIM], ['norim', '']]) {
    const plate = `<rect x="8" y="8" width="240" height="240" rx="${R}" fill="${grad ? 'url(#plate)' : INK}"/>`
    const wrap = (body) => `${defs(grad)}${plate}${rim}${body}`
    push(`A-${vname}-${rname}`, wrap(A_MARK))
    push(`B-${vname}-${rname}`, wrap(B_MARK))
  }
}
// C opacity variants, on the flat no-rim base
const flatPlate = `<rect x="8" y="8" width="240" height="240" rx="${R}" fill="${INK}"/>`
for (const op of [0.42, 0.65, 1]) {
  push(`C-op${String(op).replace('.', '')}`, `${defs(false)}${flatPlate}${cMark(op)}`)
}

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

fs.writeFileSync(path.join(outDir, 'made.json'), JSON.stringify(VARIANTS.map(([name]) => ({ name })), null, 2))
console.log('ablations rendered:', VARIANTS.length)
