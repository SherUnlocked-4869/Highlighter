// The chosen direction: CAPTURE — the selection frame with the mark inside it.
//
//   node design-demos/app-icon/tools/capture-source.mjs
//
// Emits the three SVG masters that are the single source of truth for the shipped
// artwork. generate-icon.js rasterises them into assets/, so the artwork lives in
// exactly one place instead of being duplicated as drawing code in two languages.
//
//   capture-app.svg        large-regime art, graphite tile   → assets/icon.ico
//   capture-tray-light.svg small-regime art, graphite tile   → tray on a light taskbar
//   capture-tray-dark.svg  small-regime art, graphite tile   → tray on a dark taskbar
//
// ALL THREE USE THE SAME MATERIAL. An earlier version inverted the tile for the dark
// taskbar (warm light tile, graphite frame) so the tile edge would stay visible on
// #202020. That shipped, and it was wrong: the tray and the desktop shortcut looked
// like two different applications. The edge it was protecting is graphite-on-#202020
// = 1.07:1, while the cream frame is 14.97:1 and the amber mark 8.12:1 — the tile
// edge is the least important part of the icon, so trading brand consistency for it
// was a bad trade. The dark variant now differs only in light modelling (brighter
// specular, stronger top rim, deeper contact shade), never in hue or polarity.
//
// Why the tray files use the small-regime art: the tray is always drawn at 24px
// (TRAY_ICON_SIZE in tray-icon.js). The small-regime glyph is thicker and has no
// gradient or drop shadow, because those are exactly the things that smear at 24px
// — see tools/smallframes.mjs for the measurements.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const outDir = path.join(root, 'design-demos/app-icon/assets')
fs.mkdirSync(outDir, { recursive: true })

// ── superellipse ───────────────────────────────────────────────────────────
// |x|^5 + |y|^5 = 1. At 45° the curve sits at 2^(-1/5) = 87.1% of the half-size,
// which is where Apple's own tiles sit (87–89%). A rounded rectangle meets its
// straight edges with a curvature jump; this does not, which is why it reads as an
// object rather than a box.
const N = 5
const C = 128
const R = 120
const STEPS = 320

function squircle(inset = 0) {
  const r = R - inset
  const pts = []
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    pts.push(
      `${(C + r * Math.sign(c) * Math.abs(c) ** (2 / N)).toFixed(2)} ` +
      `${(C + r * Math.sign(s) * Math.abs(s) ** (2 / N)).toFixed(2)}`
    )
  }
  return `M${pts.join(' L')} Z`
}
const SHAPE = squircle()

// ── materials ──────────────────────────────────────────────────────────────
// Graphite: the dark surface. Light comes from above as a broad linear falloff
// plus a tight band grazing the top edge — a radial gradient here would lay a soft
// blob near the top centre, which is the tell of a template gradient (measured in
// tools/lightmodel.mjs).
const GRAPHITE = {
  top: '#5d5550', mid: '#37312c', bottom: '#1c1916',
  spec: 0.18, edge: 0.30, shade: 0.30, rim: 0.30,
  glyphLow: '#ece5d8', shadowColor: '#000000', glyphShadow: 0.40
}

// ── the dark-taskbar tray variant ──────────────────────────────────────────
// The first shipped version inverted the whole material (warm light tile,
// graphite frame) so the tile's edge stayed visible on a #202020 taskbar. That was
// an over-correction: an app icon and its tray icon reading as two different
// products is a worse failure than a soft tile edge, and the measurement said the
// edge was not carrying the icon anyway:
//
//   cream frame vs #202020 = 14.97 : 1   ← what the eye actually reads
//   amber mark  vs #202020 =  8.12 : 1
//   graphite tile edge     vs #202020 =  1.07 : 1  ← only this is lost
//
// The frame and the mark are the icon; the tile is a container. So the dark-taskbar
// variant now keeps the SAME graphite material as the app icon and only strengthens
// the things that help it sit on dark, with no inversion:
//   · a brighter top specular, so the tile's upper edge catches light
//   · a stronger top rim (the 1px inner highlight along the top of the tile)
//   · a slightly deeper contact shade, so the bottom edge separates downward
// See tools/tray-consistency.mjs — the graphite variant is the one that still reads
// as the same app as the desktop shortcut.
const GRAPHITE_ON_DARK = {
  ...GRAPHITE,
  spec: 0.30,
  edge: 0.48,
  shade: 0.40,
  rim: 0.52
}

const ACCENT = { top: '#f2ab48', bottom: '#d68f2e' }
const AMBER_LIGHT = '#ffdda8'

// ── the mark ───────────────────────────────────────────────────────────────
// Large regime: ring = outer minus inner (even-odd), so the frame is one clean
// shape. The inner hole carries r=14 — an earlier r=2 on an 84u hole was 2.4% of
// its width, i.e. visually a rectangle, which is not how a rounded frame is drawn.
const LARGE = {
  outer: 'M84 62 H172 A22 22 0 0 1 194 84 V172 A22 22 0 0 1 172 194 H84 A22 22 0 0 1 62 172 V84 A22 22 0 0 1 84 62 Z',
  inner: 'M100 86 H156 A14 14 0 0 1 170 100 V156 A14 14 0 0 1 156 170 H100 A14 14 0 0 1 86 156 V100 A14 14 0 0 1 100 86 Z',
  band: { x: 92, y: 112, w: 72, h: 34, r: 9 },
  bandHi: { x: 92, y: 112, w: 72, h: 11, r: 5 },
  strokeWidth: 2
}

// Small regime: the frame stroke widens 24u → 32u and the hole grows its radius,
// because at 24px a 24u ring is 2.25px and starts to break up.
const SMALL = {
  outer: 'M86 58 H170 A28 28 0 0 1 198 86 V170 A28 28 0 0 1 170 198 H86 A28 28 0 0 1 58 170 V86 A28 28 0 0 1 86 58 Z',
  inner: 'M96 94 H160 A14 14 0 0 1 174 108 V152 A14 14 0 0 1 160 166 H96 A14 14 0 0 1 82 152 V108 A14 14 0 0 1 96 94 Z',
  band: { x: 96, y: 114, w: 64, h: 28, r: 8 }
}

// ── svg builders ───────────────────────────────────────────────────────────
function tileDefs(id, pal) {
  return `
    <clipPath id="clip-${id}"><path d="${SHAPE}"/></clipPath>
    <linearGradient id="body-${id}" x1="0.10" y1="0" x2="0.44" y2="1">
      <stop offset="0" stop-color="${pal.top}"/>
      <stop offset="0.52" stop-color="${pal.mid}"/>
      <stop offset="1" stop-color="${pal.bottom}"/>
    </linearGradient>
    <linearGradient id="spec-${id}" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${pal.spec}"/>
      <stop offset="0.34" stop-color="#ffffff" stop-opacity="${(pal.spec * 0.30).toFixed(3)}"/>
      <stop offset="0.66" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="edge-${id}" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="${pal.edge}"/>
      <stop offset="0.13" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shade-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.52" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${pal.shade}"/>
    </linearGradient>
    <linearGradient id="face-${id}" x1="0" y1="0" x2="0.18" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="${pal.glyphLow}"/>
    </linearGradient>
    <linearGradient id="accent-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${ACCENT.top}"/>
      <stop offset="1" stop-color="${ACCENT.bottom}"/>
    </linearGradient>
    <filter id="drop-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="${pal.shadowColor}" flood-opacity="${pal.glyphShadow}"/>
    </filter>`
}

const open = (id) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Highlighter">`

function tileBody(id, pal) {
  return `
    <g clip-path="url(#clip-${id})">
      <rect width="256" height="256" fill="url(#body-${id})"/>
      <rect width="256" height="256" fill="url(#spec-${id})"/>
      <rect width="256" height="256" fill="url(#edge-${id})"/>
      <rect width="256" height="256" fill="url(#shade-${id})"/>
    </g>
    <path d="${squircle(1.4)}" fill="none" stroke="#ffffff" stroke-opacity="${pal.rim}" stroke-width="2.8"/>`
}

function svgLarge(id, pal) {
  const g = LARGE
  return `${open(id)}<defs>${tileDefs(id, pal)}</defs>${tileBody(id, pal)}
    <g filter="url(#drop-${id})">
      <path d="${g.outer} ${g.inner}" fill-rule="evenodd" fill="url(#face-${id})"/>
    </g>
    <rect x="${g.band.x}" y="${g.band.y}" width="${g.band.w}" height="${g.band.h}" rx="${g.band.r}" fill="url(#accent-${id})"/>
    <rect x="${g.bandHi.x}" y="${g.bandHi.y}" width="${g.bandHi.w}" height="${g.bandHi.h}" rx="${g.bandHi.r}" fill="${AMBER_LIGHT}" fill-opacity="0.62"/>
  </svg>`
}

function svgSmall(id, pal) {
  const g = SMALL
  return `${open(id)}<defs>${tileDefs(id, pal)}</defs>${tileBody(id, pal)}
    <path d="${g.outer} ${g.inner}" fill-rule="evenodd" fill="url(#face-${id})"/>
    <rect x="${g.band.x}" y="${g.band.y}" width="${g.band.w}" height="${g.band.h}" rx="${g.band.r}" fill="url(#accent-${id})"/>
  </svg>`
}

const FILES = [
  ['capture-app.svg', svgLarge('app', GRAPHITE)],
  ['capture-tray-light.svg', svgSmall('traylight', GRAPHITE)],
  ['capture-tray-dark.svg', svgSmall('traydark', GRAPHITE_ON_DARK)]
]

for (const [name, svg] of FILES) {
  fs.writeFileSync(path.join(outDir, name), svg)
  console.log('wrote', name)
}
