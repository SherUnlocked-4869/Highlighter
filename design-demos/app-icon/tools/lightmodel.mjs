// Light-model comparison for the tile itself.
//
// The suspicion: the radial "specular" gradient makes a soft BLOB near the top
// centre, which is the signature of a template gradient rather than of light. Real
// Apple tiles are lit by a broad directional source: brightest along the top edge,
// falling off smoothly downward, with the falloff axis very slightly tilted. That
// is a LINEAR ramp plus a narrow top rim, not a radial hotspot.
//
// This renders the same glyph on four light models so the difference can be seen
// at 256px, which is the only size where the difference exists at all.
//
//   node design-demos/app-icon/tools/lightmodel.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/out/lightmodel')
fs.mkdirSync(outDir, { recursive: true })

const N = 5, C = 128, R = 120, STEPS = 320
function squircle(inset = 0) {
  const r = R - inset
  const pts = []
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    pts.push(`${(C + r * Math.sign(c) * Math.abs(c) ** (2 / N)).toFixed(2)} ${(C + r * Math.sign(s) * Math.abs(s) ** (2 / N)).toFixed(2)}`)
  }
  return `M${pts.join(' L')} Z`
}
const SHAPE = squircle()

const STROKE = 'M72 106 H150 L186 122 Q196 126 196 136 Q196 146 186 150 H72 A22 22 0 0 1 72 106 Z'

// ── four light models ──────────────────────────────────────────────────────
// Each returns the <defs> extra + the layers painted over the body gradient.
const MODELS = {
  // M1 · current: radial hotspot high and centred
  radial: () => ({
    defs: `<radialGradient id="m" cx="0.46" cy="0" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity=".5"/>
      <stop offset="0.34" stop-color="#fff" stop-opacity=".15"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`,
    paint: `<rect width="256" height="256" fill="url(#m)"/>`
  }),

  // M2 · directional: light from straight above, linear falloff over the top 60%
  directional: () => ({
    defs: `<linearGradient id="m" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".46"/>
      <stop offset="0.30" stop-color="#fff" stop-opacity=".16"/>
      <stop offset="0.62" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    paint: `<rect width="256" height="256" fill="url(#m)"/>`
  }),

  // M3 · directional + tight top-edge band (the "light grazes the top surface" read)
  directionalBand: () => ({
    defs: `<linearGradient id="m" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".40"/>
      <stop offset="0.34" stop-color="#fff" stop-opacity=".12"/>
      <stop offset="0.66" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="b" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/>
      <stop offset="0.14" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    paint: `<rect width="256" height="256" fill="url(#m)"/><rect width="256" height="256" fill="url(#b)"/>`
  }),

  // M4 · diagonal sweep (light from upper-left at ~35°), like a lit glossy surface
  sweep: () => ({
    defs: `<linearGradient id="m" x1="0.15" y1="0" x2="0.75" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".50"/>
      <stop offset="0.38" stop-color="#fff" stop-opacity=".13"/>
      <stop offset="0.70" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    paint: `<rect width="256" height="256" fill="url(#m)"/>`
  })
}

const AMBER = { top: '#ffdda2', mid: '#f2ab48', bottom: '#c87517', shade: 0.22 }

function build(model, pad) {
  const { defs, paint } = MODELS[model]()
  return `
  <defs>
    <clipPath id="clip"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body" x1="0.08" y1="0" x2="0.42" y2="1">
      <stop offset="0" stop-color="${AMBER.top}"/><stop offset="0.46" stop-color="${AMBER.mid}"/><stop offset="1" stop-color="${AMBER.bottom}"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${AMBER.shade}"/>
    </linearGradient>
    ${defs}
    <linearGradient id="face" x1="0" y1="0" x2="0.15" y2="1">
      <stop offset="0" stop-color="#fff"/><stop offset="0.55" stop-color="#fffdf8"/><stop offset="1" stop-color="#efe4d0"/>
    </linearGradient>
    <filter id="drop" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#7d4207" flood-opacity=".24"/>
    </filter>
  </defs>
  <g clip-path="url(#clip)">
    <rect width="256" height="256" fill="url(#body)"/>
    ${paint}
    <rect width="256" height="256" fill="url(#shade)"/>
  </g>
  <path d="${squircle(1.4)}" fill="none" stroke="#fff" stroke-opacity=".46" stroke-width="2.8"/>
  <g filter="url(#drop)"><path d="${STROKE}" fill="url(#face)"/></g>`
}

const browser = await chromium.launch()
async function raster(body, size) {
  const ctx = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await ctx.newPage()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${body}</svg>`
  await page.setContent(
    `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>` +
    svg.replace('width="256" height="256"', `width="${size}" height="${size}"`)
  )
  const el = await page.$('svg')
  const buf = await el.screenshot({ omitBackground: true })
  await ctx.close()
  return buf
}

const cells = []
for (const model of Object.keys(MODELS)) {
  const body256 = build(model, 0)
  const big = await raster(body256, 256)
  const small = await raster(body256, 16)
  fs.writeFileSync(path.join(outDir, `${model}-256.png`), big)
  fs.writeFileSync(path.join(outDir, `${model}-16.png`), small)
  cells.push({ model, big: big.toString('base64'), small: small.toString('base64') })
}
await browser.close()

const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#f5f2ec;font:12px/1.4 "Segoe UI Variable Text",sans-serif;color:#1d1a16}
.row{display:flex;gap:26px;align-items:flex-end;margin-bottom:8px}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:8px}
figcaption{font:10px "Cascadia Mono",Consolas,monospace;color:#8a8070}
h2{font:600 14px/1.3 "Segoe UI";margin:22px 0 12px}
</style>
<h2>256px — 四种光模型</h2>
<div class="row">${cells.map((c) => `<figure><img src="data:image/png;base64,${c.big}" width="188" height="188"><figcaption>${c.model}</figcaption></figure>`).join('')}</div>
<h2>16px @8×</h2>
<div class="row">${cells.map((c) => `<figure><img src="data:image/png;base64,${c.small}" width="96" height="96" style="image-rendering:pixelated"><figcaption>${c.model}</figcaption></figure>`).join('')}</div>`

fs.writeFileSync(path.join(outDir, 'sheet.html'), html)
const b2 = await chromium.launch()
const ctx = await b2.newContext({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto('file://' + path.join(outDir, 'sheet.html').replace(/\\/g, '/'))
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true })
await b2.close()
console.log('light model sheet done')
