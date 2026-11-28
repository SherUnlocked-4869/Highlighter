'use strict'

// U02 / DEV-02 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// offscreen "export the current view" for a pin.
//
// Three layers, matching the delivery:
//   1. the pure composition plan in pin/pin-view-export.js (geometry, rotation,
//      long-capture scroll, OCR block mapping, bounded canvas);
//   2. the preload envelope (size/request-id validation, existing channel only);
//   3. the pin domain lifecycle (single-flight, request/window identity, preview,
//      same-bytes save, timeout/closed/invalid cleanup).
//
// Pixel parity: the plan is asserted against independently computed matrices/rects;
// text ANTIALIASING is deliberately out of scope (documented in pin-view-export.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const viewExport = require('../pin/pin-view-export')
const pinDomain = require('../main/domains/pin')

const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
const DATA_URL = 'data:image/png;base64,AA=='

function makePng(width, height, tail = Buffer.from([7, 7, 7])) {
  const header = Buffer.alloc(24)
  header.writeUInt32BE(0x89504e47, 0)
  header.writeUInt32BE(0x0d0a1a0a, 4)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, tail])
}

// ---------------------------------------------------------------------------
// 1. Pure composition plan.
// ---------------------------------------------------------------------------

function rotatePoint(point, center, degrees) {
  const radians = degrees * Math.PI / 180
  return {
    x: center.x + (point.x - center.x) * Math.cos(radians) - (point.y - center.y) * Math.sin(radians),
    y: center.y + (point.x - center.x) * Math.sin(radians) + (point.y - center.y) * Math.cos(radians)
  }
}

function rotatedBounds(rect, center, degrees) {
  const width = rect.w ?? rect.width
  const height = rect.h ?? rect.height
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + width, y: rect.y },
    { x: rect.x + width, y: rect.y + height },
    { x: rect.x, y: rect.y + height }
  ].map((corner) => rotatePoint(corner, center, degrees))
  return {
    x: Math.min(...corners.map((corner) => corner.x)),
    y: Math.min(...corners.map((corner) => corner.y)),
    w: Math.max(...corners.map((corner) => corner.x)) - Math.min(...corners.map((corner) => corner.x)),
    h: Math.max(...corners.map((corner) => corner.y)) - Math.min(...corners.map((corner) => corner.y))
  }
}

function assertClose(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${message} ${actual} != ${expected}`)
}

function assertBoundsClose(actual, expected) {
  for (const key of ['x', 'y', 'w', 'h']) assertClose(actual[key], expected[key], key)
}

test('plan: an upright view exports the physical viewport and never the desktop', () => {
  const plan = viewExport.planViewExport({
    viewport: { width: 600, height: 800, devicePixelRatio: 2 },
    surface: { width: 600, height: 800 },
    rotation: 0,
    longCapture: false
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.width, 1200)
  assert.equal(plan.height, 1600)
  assert.deepEqual(plan.picture.source, { x: 0, y: 0, width: 600, height: 800 })
  assert.deepEqual(plan.picture.dest, { x: 0, y: 0, width: 1200, height: 1600 })
  assert.equal(plan.picture.rotation, 0)
  assert.deepEqual(plan.picture.center, { x: 600, y: 800 })
  // The transient window chrome can never be in the pixels: the plan draws no controls.
  for (const excluded of ['desktop', 'other-windows', 'controls', 'badges']) {
    assert.ok(plan.exclusions.includes(excluded), `exclusion ${excluded}`)
  }
})

test('plan: a quarter turn keeps the pre-rotation rectangle and rotates about the window centre', () => {
  // 600x800 picture at 100% -> the main process sizes the window to the rotated box 800x600.
  const plan = viewExport.planViewExport({
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 90
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.width, 800)
  assert.equal(plan.height, 600)
  assert.equal(plan.quarterTurn, true)
  assert.equal(plan.picture.rotation, 90)
  // pin.css centres a 100vh x 100vw #rotor for quarter turns.
  assert.deepEqual(plan.picture.dest, { x: 100, y: -100, width: 600, height: 800 })
  assert.deepEqual(plan.picture.center, { x: 400, y: 300 })
  // Independently rotate the pre-transform rect: it must equal the whole window box.
  const bounds = rotatedBounds(plan.picture.dest, plan.picture.center, 90)
  assertBoundsClose(bounds, { x: 0, y: 0, w: 800, h: 600 })
  // 270 uses the mirror image; the same box check is what proves the CSS and plan agree.
  const mirrored = viewExport.planViewExport({
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 270
  })
  assertBoundsClose(rotatedBounds(mirrored.picture.dest, mirrored.picture.center, 270), { x: 0, y: 0, w: 800, h: 600 })
  // 180 keeps the upright frame and only flips it.
  const flipped = viewExport.planViewExport({
    viewport: { width: 600, height: 800, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 180
  })
  assert.deepEqual(flipped.picture.dest, { x: 0, y: 0, width: 600, height: 800 })
  assert.equal(flipped.quarterTurn, false)
})

test('plan: zoom is already materialised in the window box, and DPR scales the output', () => {
  // A 600x800 pin at 75% is a 450x600 window; a quarter turn makes it 600x450.
  const plan = viewExport.planViewExport({
    viewport: { width: 600, height: 450, devicePixelRatio: 1.5 },
    surface: { width: 600, height: 800 },
    rotation: 90
  })
  assert.equal(plan.width, 900)
  assert.equal(plan.height, 675)
  // Pre-transform picture inside the 450x600 rotor, scaled by DPR.
  assert.deepEqual(plan.picture.dest, { x: 112.5, y: -112.5, width: 675, height: 900 })
  const bounds = rotatedBounds(plan.picture.dest, plan.picture.center, 90)
  assertBoundsClose(bounds, { x: 0, y: 0, w: 900, h: 675 })
})

test('plan: a long capture exports the visible strip at the current scroll offset', () => {
  const plan = viewExport.planViewExport({
    viewport: { width: 500, height: 400, devicePixelRatio: 2 },
    surface: { width: 500, height: 5000 },
    longCapture: true,
    scrollTop: 1200
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.width, 1000)
  assert.equal(plan.height, 800)
  assert.equal(plan.scrollTop, 1200)
  // The picture is painted at -scrollTop (physical px) and the canvas clips it; the
  // source is still the whole image so no re-encode/interpolation happens twice.
  assert.deepEqual(plan.picture.dest, { x: 0, y: -2400, width: 1000, height: 10000 })
  assert.deepEqual(plan.picture.source, { x: 0, y: 0, width: 500, height: 5000 })
  assert.equal(plan.quarterTurn, false)
})

test('plan: visible OCR blocks are mapped to output pixels, including rotation and scroll', () => {
  const block = (x, y, text = 'hello') => ({
    text,
    text_score: 0.95,
    box_points: [{ x, y }, { x: x + 100, y }, { x: x + 100, y: y + 50 }, { x, y: y + 50 }]
  })
  const upright = viewExport.planViewExport({
    viewport: { width: 600, height: 800, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 0,
    ocr: { visible: true, translated: false, blocks: [block(100, 100)], imageWidth: 600, imageHeight: 800 }
  })
  assert.equal(upright.ocrOverlay, true)
  assert.equal(upright.ocrBlocks.length, 1)
  const mapped = upright.ocrBlocks[0]
  assert.equal(mapped.text, 'hello')
  assertClose(mapped.centerX, 150, 'centerX')
  assertClose(mapped.centerY, 125, 'centerY')
  assert.equal(mapped.width, 100)
  assert.equal(mapped.height, 50)
  assert.equal(mapped.translated, false)
  assert.equal(mapped.angle, 0)

  // A quarter turn rotates the chip together with the picture around the window centre.
  const turned = viewExport.planViewExport({
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 90,
    ocr: { visible: true, translated: true, blocks: [block(100, 100)], imageWidth: 600, imageHeight: 800 }
  })
  const rotated = turned.ocrBlocks[0]
  // pre-transform chip centre (250,25) in the 800x600 window, rotated 90 about (400,300).
  assertClose(rotated.centerX, 675, 'rotated centerX')
  assertClose(rotated.centerY, 150, 'rotated centerY')
  assert.equal(rotated.angle, 90)
  assert.equal(rotated.translated, true)

  // A long capture: a block above the current scroll offset is outside the visible
  // strip; the block inside it is mapped by subtracting the scroll offset once.
  const scrolled = viewExport.planViewExport({
    viewport: { width: 500, height: 400, devicePixelRatio: 1 },
    surface: { width: 500, height: 5000 },
    longCapture: true,
    scrollTop: 1200,
    ocr: {
      visible: true,
      translated: false,
      imageWidth: 500,
      imageHeight: 5000,
      blocks: [block(10, 100), block(10, 1300)]
    }
  })
  assert.equal(scrolled.ocrBlocks.length, 1)
  assertClose(scrolled.ocrBlocks[0].centerY, 125, 'scrolled block centerY')

  // An invisible overlay is not part of the view (the old capturePage path hid it too).
  const hidden = viewExport.planViewExport({
    viewport: { width: 600, height: 800, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    ocr: { visible: false, blocks: [block(10, 10)], imageWidth: 600, imageHeight: 800 }
  })
  assert.deepEqual(hidden.ocrBlocks, [])
  assert.equal(hidden.ocrOverlay, false)
})

test('plan: bounded canvas and empty-image refusals are explicit, never silent', () => {
  const empty = viewExport.planViewExport({
    viewport: { width: 600, height: 800, devicePixelRatio: 1 },
    surface: { width: 0, height: 0 }
  })
  assert.deepEqual(empty, { ok: false, code: 'empty-image' })
  const huge = viewExport.planViewExport({
    viewport: { width: 6000, height: 6000, devicePixelRatio: 2 },
    surface: { width: 6000, height: 6000 }
  })
  assert.equal(huge.ok, false)
  assert.equal(huge.code, 'too-large')
  // Rotations and DPR inputs are normalised, never turned into NaN/zero geometry.
  assert.equal(viewExport.normalizeRotation(-90), 270)
  assert.equal(viewExport.normalizeRotation('x'), 0)
  assert.deepEqual(
    viewExport.normalizeViewport({ width: 0, height: -1, devicePixelRatio: 99 }),
    { width: 1, height: 1, devicePixelRatio: 4 }
  )
})

function createRecordingContext() {
  const ops = []
  // `font` / `fillStyle` are read back at fillText time so a test can assert the painter
  // used the measured DOM font size instead of the old shrink-to-fit heuristic.
  const state = { font: '', fillStyle: '' }
  const context = {
    ops,
    imageSmoothingEnabled: false,
    textAlign: '',
    textBaseline: '',
    save: () => ops.push({ op: 'save' }),
    restore: () => ops.push({ op: 'restore' }),
    translate: (x, y) => ops.push({ op: 'translate', x, y }),
    rotate: (angle) => ops.push({ op: 'rotate', angle }),
    drawImage: (...args) => ops.push({ op: 'drawImage', args }),
    fillRect: (x, y, w, h) => ops.push({ op: 'fillRect', x, y, w, h }),
    beginPath: () => ops.push({ op: 'beginPath' }),
    rect: (x, y, w, h) => ops.push({ op: 'rect', x, y, w, h }),
    clip: () => ops.push({ op: 'clip' }),
    fillText: (text, x, y) => ops.push({ op: 'fillText', text, x, y, font: state.font }),
    measureText: (text) => ({ width: String(text).length * 6 })
  }
  Object.defineProperty(context, 'font', { get: () => state.font, set: (value) => { state.font = value } })
  Object.defineProperty(context, 'fillStyle', { get: () => state.fillStyle, set: (value) => { state.fillStyle = value } })
  return context
}

// ---------------------------------------------------------------------------
// 1b. P2-02: the export and the real-diff view compose the ACTUAL visible rectangle.
// ---------------------------------------------------------------------------

test('plan: a long capture composes the measured visible picture rectangle, not an HTML scroller offset', () => {
  // pin.css scrolls BODY; document.scrollingElement stays the HTML element at 0. The live
  // rect (image top = -600 CSS px) is the only measurement the export may trust.
  const plan = viewExport.planViewExport({
    viewport: { width: 400, height: 420, devicePixelRatio: 1.5 },
    surface: { width: 400, height: 6000 },
    longCapture: true,
    visibleRect: { x: 0, y: -600, width: 390, height: 5850 },
    // A stale/zero scrollTop must not win over the measured rectangle.
    scrollTop: 0
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.scrollTop, 600)
  assert.deepEqual(plan.visibleRect, { x: 0, y: -600, width: 390, height: 5850 })
  // The picture is drawn at the negative rect top and scaled by the measured DOM width
  // (390 = body client width without the long-capture scrollbar), at the physical DPR.
  assert.deepEqual(plan.picture.dest, { x: 0, y: -900, width: 585, height: 8775 })
  assert.deepEqual(plan.picture.source, { x: 0, y: 0, width: 400, height: 6000 })
  // The first output row samples source y = 600 / (5850 / 6000) = 615.4 - i.e. INSIDE the
  // picture after the 600 px scroll, never the picture top the defect exported.
  const firstRowSourceY = Math.abs(plan.picture.dest.y) / plan.picture.dest.height * plan.picture.source.height
  assert.ok(firstRowSourceY > 400 && firstRowSourceY < 1200, `first row must come from the scrolled band (${firstRowSourceY})`)
  // Without a DOM measurement the explicit scroll offset stays the deterministic fallback.
  const fallback = viewExport.planViewExport({
    viewport: { width: 500, height: 400, devicePixelRatio: 2 },
    surface: { width: 500, height: 5000 },
    longCapture: true,
    scrollTop: 1200
  })
  assert.equal(fallback.scrollTop, 1200)
  assert.deepEqual(fallback.picture.dest, { x: 0, y: -2400, width: 1000, height: 10000 })
  assert.equal(fallback.visibleRect, null)
  // The rectangle parser is bounded and tolerant of DOM number strings.
  assert.equal(viewExport.normalizeVisibleRect(null), null)
  assert.equal(viewExport.normalizeVisibleRect({ x: 0, y: -600, width: 0, height: 10 }), null)
  assert.equal(viewExport.normalizeVisibleRect({ x: Number.NaN, y: 0, width: 10, height: 10 }), null)
  assert.deepEqual(viewExport.normalizeVisibleRect({ x: '0', y: '-600', width: '390', height: '5850.5' }),
    { x: 0, y: -600, width: 390, height: 5850.5 })
})

test('wiring: view export and the real-diff view share ONE measured visible rectangle (P2-02)', () => {
  const pinScript = read('pin', 'pin.js')
  // Comments may explain the trap; the CODE must never read a scroll element: body is the
  // scroller in a long pin and document.scrollingElement is the HTML element that never moves.
  const pinCode = pinScript.replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(pinCode, /document\.scrollingElement/)
  assert.doesNotMatch(pinCode, /document\.documentElement\.scrollTop/)
  // Exactly one measurement helper, consumed by both callsites.
  assert.equal((pinScript.match(/function measureVisibleSurfaceRect\(/g) || []).length, 1)
  assert.equal((pinScript.match(/visibleRect: measureVisibleSurfaceRect\(\)/g) || []).length, 2)
  const composeAt = pinScript.indexOf('async function composeViewExport')
  const diffAt = pinScript.indexOf('async function handleScreenDiffFrame')
  assert.ok(composeAt > 0 && diffAt > composeAt, 'both entry functions exist')
  assert.match(pinScript.slice(composeAt, diffAt), /visibleRect: measureVisibleSurfaceRect\(\)/)
  assert.match(pinScript.slice(diffAt), /visibleRect: measureVisibleSurfaceRect\(\)/)
})

// ---------------------------------------------------------------------------
// 1c. P2-04: the export painter consumes the layout measured from the LIVE overlay.
// ---------------------------------------------------------------------------

// A synthetic measured layout entry with the shape shared/ocr-text-overlay.js
// measureLayout() reads back from the rendered DOM: the chip rectangle in surface-local
// CSS px and per-glyph boxes relative to the chip centre.
function measuredEntry(blockIndex, options = {}) {
  return {
    blockIndex,
    width: options.width ?? 100,
    height: options.height ?? 40,
    centerX: options.centerX ?? 0,
    centerY: options.centerY ?? 0,
    angle: options.angle ?? 0,
    vertical: options.vertical === true,
    fontSize: options.fontSize ?? 12,
    fontFamily: options.fontFamily || 'system-ui, sans-serif',
    lines: options.lines || []
  }
}

function glyphLine(texts, axis, position, start, advance) {
  return {
    text: texts.join(''),
    glyphs: texts.map((text, index) => ({
      text,
      x: axis === 'x' ? position : start + index * advance,
      y: axis === 'x' ? start + index * advance : position,
      width: advance,
      height: advance
    }))
  }
}

test('plan: a wrapped / vertical overlay layout is mapped onto the export instead of one line (P2-04)', () => {
  const block = (x, y, w, h, text) => ({
    text,
    text_score: 0.95,
    box_points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
  })
  // Narrow translated block: the browser wrapped it into two centred lines.
  const horizontal = measuredEntry(0, {
    width: 60,
    height: 40,
    centerX: 120,
    centerY: 60,
    fontSize: 11,
    lines: [
      glyphLine(['这', '是'], 'y', 8, -12, 12),
      glyphLine(['译', '文'], 'y', -8, -12, 12)
    ]
  })
  const plan = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 2 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: {
      visible: true,
      translated: true,
      blocks: [block(90, 40, 60, 40, '这是译文')],
      imageWidth: 400,
      imageHeight: 300,
      layout: [horizontal]
    }
  })
  assert.equal(plan.ocrBlocks.length, 1)
  const mapped = plan.ocrBlocks[0]
  assert.equal(mapped.measured, true)
  assert.equal(mapped.translated, true)
  assert.equal(mapped.vertical, false)
  assert.equal(mapped.lines.length, 2, 'both wrapped lines are exported, not one centred fillText')
  assert.deepEqual(mapped.lines[0].glyphs.map((glyph) => glyph.text), ['这', '是'])
  assert.deepEqual(mapped.lines[1].glyphs.map((glyph) => glyph.text), ['译', '文'])
  // Chip geometry and per-glyph boxes come from the DOM measurement, at DPR scale.
  assert.equal(mapped.width, 120)
  assert.equal(mapped.height, 80)
  assert.equal(mapped.centerX, 240)
  assert.equal(mapped.centerY, 120)
  assert.equal(mapped.fontSize, 22)
  assert.equal(mapped.fontFamily, 'system-ui, sans-serif')
  assertClose(mapped.lines[0].glyphs[0].x, -24, 'first glyph x')
  assertClose(mapped.lines[0].glyphs[0].y, 16, 'first line y')
  assertClose(mapped.lines[1].glyphs[1].x, 0, 'last glyph x')
  assertClose(mapped.lines[1].glyphs[1].y, -16, 'last line y')

  // Vertical-rl: columns run right to left and glyphs run top to bottom.
  const vertical = measuredEntry(0, {
    width: 40,
    height: 200,
    centerX: 40,
    centerY: 120,
    vertical: true,
    fontSize: 14,
    lines: [
      glyphLine(['竖', '排', '中', '文'], 'x', 13, -21, 14),
      glyphLine(['第', '二'], 'x', -1, -14, 14),
      glyphLine(['列'], 'x', -15, 0, 14)
    ]
  })
  const turned = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: {
      visible: true,
      translated: false,
      blocks: [block(20, 20, 40, 200, '竖排中文第二列')],
      imageWidth: 400,
      imageHeight: 300,
      layout: [vertical]
    }
  })
  const column = turned.ocrBlocks[0]
  assert.equal(column.measured, true)
  assert.equal(column.vertical, true)
  assert.equal(column.lines.length, 3, 'one export column per measured vertical-rl column')
  assert.ok(column.lines[0].glyphs[0].x > column.lines[1].glyphs[0].x, 'first column sits to the right')
  assert.ok(column.lines[1].glyphs[0].x > column.lines[2].glyphs[0].x, 'columns are read right to left')
  assert.ok(column.lines[0].glyphs[0].y < column.lines[0].glyphs[3].y, 'glyphs run top to bottom inside a column')

  // A whole-pin quarter turn rotates the measured chip about the window centre; the
  // chip-local glyph boxes stay in the chip's own frame.
  const turnedBlock = measuredEntry(0, {
    width: 60,
    height: 40,
    centerX: 195,
    centerY: 100,
    fontSize: 11,
    lines: [glyphLine(['A', 'B'], 'y', 0, -6, 12)]
  })
  const rotated = viewExport.planViewExport({
    viewport: { width: 420, height: 400, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 90,
    ocr: {
      visible: true,
      blocks: [block(165, 80, 60, 40, 'AB')],
      imageWidth: 400,
      imageHeight: 300,
      layout: [turnedBlock]
    }
  })
  const spun = rotated.ocrBlocks[0]
  // pin.css centres a 400x420 rotor for the quarter turn: (x, y) = (10, -10) pre-transform.
  const pre = { x: 10 + 195, y: -10 + 100 }
  const placed = rotatePoint(pre, { x: 210, y: 200 }, 90)
  assertClose(spun.centerX, placed.x, 'rotated measured centre x')
  assertClose(spun.centerY, placed.y, 'rotated measured centre y')
  assert.equal(spun.angle, 90)
  assertClose(spun.lines[0].glyphs[0].x, -6, 'chip-local glyph box is not rotated twice')

  // A block without a measured entry keeps the deterministic box-point fallback so a
  // feature-detection miss can never hide text.
  const mixed = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: {
      visible: true,
      blocks: [block(10, 10, 100, 50, 'fallback'), block(200, 10, 100, 50, 'measured')],
      imageWidth: 400,
      imageHeight: 300,
      layout: [measuredEntry(1, { width: 100, height: 50, centerX: 250, centerY: 35, lines: [glyphLine(['测'], 'y', 0, 0, 12)] })]
    }
  })
  assert.equal(mixed.ocrBlocks.length, 2)
  assert.equal(mixed.ocrBlocks[0].measured, undefined, 'the unmeasured block keeps the legacy painter')
  assert.equal(mixed.ocrBlocks[1].measured, true)
  assert.equal(mixed.ocrBlocks[1].lines.length, 1)
})

test('draw: measured wrapped/vertical OCR is painted per measured glyph (P2-04)', () => {
  const block = (text) => ({
    text,
    text_score: 0.95,
    box_points: [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 140 }, { x: 20, y: 140 }]
  })
  const vertical = measuredEntry(0, {
    width: 40,
    height: 120,
    centerX: 40,
    centerY: 80,
    vertical: true,
    fontSize: 14,
    lines: [
      glyphLine(['竖', '排'], 'x', 13, -7, 14),
      glyphLine(['中', '文'], 'x', -1, -7, 14)
    ]
  })
  const plan = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: {
      visible: true,
      translated: false,
      blocks: [block('竖排中文')],
      imageWidth: 400,
      imageHeight: 300,
      layout: [vertical]
    }
  })
  const context = createRecordingContext()
  const picture = { width: 400, height: 300 }
  assert.equal(viewExport.drawViewExport(context, plan, { picture }), true)
  // The chip is the measured DOM rectangle and it clips the measured glyph run.
  const chip = context.ops.find((entry) => entry.op === 'fillRect')
  assert.deepEqual(chip, { op: 'fillRect', x: -20, y: -60, w: 40, h: 120 })
  const clip = context.ops.find((entry) => entry.op === 'rect')
  assert.deepEqual(clip, { op: 'rect', x: -20, y: -60, w: 40, h: 120 })
  const texts = context.ops.filter((entry) => entry.op === 'fillText')
  assert.deepEqual(texts.map((entry) => entry.text), ['竖', '排', '中', '文'])
  // One font string for the whole measured block, at the DOM font size (no shrink-to-fit).
  assert.match(texts[0].font, /(?:^|\s)14px/)
  const columnX = texts.map((entry) => entry.x)
  assert.ok(columnX[0] > columnX[2], 'the first column is painted to the right of the second')
  assert.ok(texts[1].y > texts[0].y, 'glyphs run top to bottom inside a column')
  // Every painted glyph stays inside the measured chip rectangle.
  for (const entry of texts) {
    assert.ok(entry.x - 7 >= -20 && entry.x + 7 <= 20, `glyph x inside the chip (${entry.x})`)
    assert.ok(entry.y - 7 >= -60 && entry.y + 7 <= 60, `glyph y inside the chip (${entry.y})`)
  }
  // The legacy painter (no measured layout) still does one bounded centred fillText.
  const fallbackPlan = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: { visible: true, blocks: [block('legacy')], imageWidth: 400, imageHeight: 300 }
  })
  const fallbackContext = createRecordingContext()
  viewExport.drawViewExport(fallbackContext, fallbackPlan, { picture })
  const fallbackTexts = fallbackContext.ops.filter((entry) => entry.op === 'fillText')
  assert.equal(fallbackTexts.length, 1)
  assert.equal(fallbackTexts[0].text, 'legacy')
})

test('draw: an authoritative measurement with no visible glyphs paints the chip only (P2-04)', () => {
  // The live chip's overflow:hidden clipped every glyph away (e.g. the vertical source block
  // whose oversized line-height pushes its column outside the chip). The export must match
  // that: chip background, no invented text.
  const plan = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: {
      visible: true,
      blocks: [{
        text: '竖排中文',
        text_score: 0.9,
        box_points: [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 220 }, { x: 20, y: 220 }]
      }],
      imageWidth: 400,
      imageHeight: 300,
      layout: [measuredEntry(0, { width: 40, height: 200, centerX: 40, centerY: 120, vertical: true, fontSize: 28.8, lines: [] })]
    }
  })
  assert.equal(plan.ocrBlocks.length, 1)
  assert.equal(plan.ocrBlocks[0].measured, true)
  assert.deepEqual(plan.ocrBlocks[0].lines, [])
  const context = createRecordingContext()
  assert.equal(viewExport.drawViewExport(context, plan, { picture: { width: 400, height: 300 } }), true)
  assert.equal(context.ops.filter((entry) => entry.op === 'fillText').length, 0, 'no invented text')
  assert.equal(context.ops.filter((entry) => entry.op === 'fillRect').length, 1, 'the chip background is still exported')
})

test('plan: the measured glyph budget is bounded (P2-04)', () => {  assert.ok(Number.isInteger(viewExport.MAX_OCR_GLYPHS) && viewExport.MAX_OCR_GLYPHS > 0)
  const blocks = []
  const layout = []
  for (let index = 0; index < 4; index += 1) {
    const glyphs = []
    for (let glyphIndex = 0; glyphIndex < 2000; glyphIndex += 1) {
      glyphs.push({ text: '字', x: glyphIndex % 20, y: Math.floor(glyphIndex / 20), width: 8, height: 8 })
    }
    blocks.push({
      text: '字'.repeat(30),
      text_score: 0.9,
      box_points: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 60 }, { x: 10, y: 60 }]
    })
    layout.push(measuredEntry(index, {
      width: 100,
      height: 50,
      centerX: 60,
      centerY: 35,
      lines: [{ text: '字', glyphs }]
    }))
  }
  const plan = viewExport.planViewExport({
    viewport: { width: 400, height: 300, devicePixelRatio: 1 },
    surface: { width: 400, height: 300 },
    rotation: 0,
    ocr: { visible: true, blocks, imageWidth: 400, imageHeight: 300, layout }
  })
  const total = plan.ocrBlocks.reduce((sum, blockEntry) => sum + (blockEntry.lines || [])
    .reduce((lineSum, line) => lineSum + (line.glyphs ? line.glyphs.length : 0), 0), 0)
  assert.ok(total <= viewExport.MAX_OCR_GLYPHS, `measured glyphs stay bounded (${total})`)
  assert.ok(plan.ocrBlocks.length <= viewExport.MAX_OCR_BLOCKS)
})

test('wiring: the renderer measures the live overlay layout for the export (P2-04)', () => {
  const pinScript = read('pin', 'pin.js')
  assert.match(pinScript, /measureLayout/)
  assert.match(pinScript, /\blayout\b/)
  const overlayScript = read('shared', 'ocr-text-overlay.js')
  assert.match(overlayScript, /function measureLayout\(/)
  assert.match(overlayScript, /blockIndex/)
  // The shared overlay must keep its renderBlocks contract for capture/*.js.
  assert.match(overlayScript, /renderBlocks/)
  assert.match(read('capture', 'capture.js'), /window\.OcrTextOverlay\.renderBlocks/)
})

test('draw: the picture is drawn once under the rotation matrix, then the OCR chips', () => {
  const plan = viewExport.planViewExport({
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    surface: { width: 600, height: 800 },
    rotation: 90,
    ocr: {
      visible: true,
      translated: false,
      imageWidth: 600,
      imageHeight: 800,
      blocks: [{
        text: 'A',
        text_score: 0.9,
        box_points: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 150 }, { x: 100, y: 150 }]
      }]
    }
  })
  const context = createRecordingContext()
  const picture = { width: 600, height: 800, tag: 'picture' }
  assert.equal(viewExport.drawViewExport(context, plan, { picture }), true)
  const drawImage = context.ops.find((entry) => entry.op === 'drawImage')
  assert.deepEqual(drawImage.args, [picture, 0, 0, 600, 800, 100, -100, 600, 800])
  const rotate = context.ops.find((entry) => entry.op === 'rotate')
  assert.ok(Math.abs(rotate.angle - Math.PI / 2) < 1e-9)
  // Chip: exactly one rect + text after the picture restore. The block is drawn in its
  // own rotated frame (translate to the mapped centre, then rotate by the chip angle),
  // so the fillRect is local to that frame.
  const chip = context.ops.find((entry) => entry.op === 'fillRect')
  assert.deepEqual(chip, {
    op: 'fillRect',
    x: -50, y: -25, w: 100, h: 50
  })
  const chipTranslate = context.ops.filter((entry) => entry.op === 'translate').at(-1)
  assertClose(chipTranslate.x, 675, 'chip x')
  assertClose(chipTranslate.y, 150, 'chip y')
  assert.equal(context.ops.find((entry) => entry.op === 'fillText').text, 'A')
  assert.equal(viewExport.drawViewExport(context, { ok: false }, { picture }), false)
  assert.equal(viewExport.drawViewExport(context, plan, {}), false)
})

// ---------------------------------------------------------------------------
// 2. Preload envelope: bounded, existing channel only, no new IPC surface.
// ---------------------------------------------------------------------------

function loadPinPreload() {
  const sent = []
  const listeners = new Map()
  let exposed = null
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`unexpected require ${name}`)
      return {
        contextBridge: {
          exposeInMainWorld: (apiName, api) => { exposed = { apiName, api } }
        },
        ipcRenderer: {
          send: (...args) => sent.push(args),
          invoke: async () => null,
          on: (channel, handler) => listeners.set(channel, handler),
          removeListener: (channel) => listeners.delete(channel)
        }
      }
    },
    module: { exports: {} },
    exports: {},
    ArrayBuffer,
    Uint8Array,
    Buffer,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(read('preload-pin.js'), sandbox, { filename: 'preload-pin.js' })
  assert.equal(exposed.apiName, 'pinAPI')
  return { api: exposed.api, sent, listeners }
}

test('preload: the composed PNG travels on the existing pin:context-menu channel', () => {
  const { api, sent, listeners } = loadPinPreload()
  const png = makePng(120, 80)
  assert.equal(api.viewExportResult({
    type: 'view-export-result', requestId: 'req-abc-1', ok: true, png, width: 120, height: 80, ocrOverlay: true
  }), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'pin:context-menu')
  assert.equal(sent[0][1], null)
  const envelope = sent[0][2]
  assert.equal(envelope.type, 'view-export-result')
  assert.equal(envelope.requestId, 'req-abc-1')
  assert.equal(envelope.ok, true)
  assert.equal(envelope.width, 120)
  assert.equal(envelope.height, 80)
  assert.equal(envelope.ocrOverlay, true)
  assert.ok(envelope.png instanceof ArrayBuffer)
  // No channel outside the pin window's frozen surface is ever used.
  const editChannels = new Set()
  for (const channel of read('preload-pin.js').matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)) editChannels.add(channel[1])
  for (const channel of editChannels) {
    assert.ok(['pin:context-menu', 'pin:close', 'pin:copy', 'pin:save', 'pin:resize', 'pin:set-opacity', 'pin:rotate', 'pin:move-start', 'pin:move', 'pin:move-end', 'pin:set-click-through', 'pin:ready', 'pin:render-ready', 'pin:export-pdf'].includes(channel), channel)
  }
})

test('preload: malformed or oversized view results are dropped before IPC', () => {
  const { api, sent, listeners } = loadPinPreload()
  const png = makePng(10, 10)
  assert.equal(api.viewExportResult(null), false)
  assert.equal(api.viewExportResult({ requestId: 'req-1', ok: true, png, width: 10, height: 10, type: 'wrong' }), false)
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'bad id!', ok: true, png, width: 10, height: 10 }), false)
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-1', ok: true, png: 'not-bytes', width: 10, height: 10 }), false)
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-1', ok: true, png, width: 0, height: 10 }), false)
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-1', ok: true, png, width: 20000, height: 10 }), false)
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-1', ok: true, png: Buffer.alloc(33 * 1024 * 1024), width: 10, height: 10 }), false)
  assert.equal(sent.length, 0)
  // A renderer-side failure is a bounded code, not a raw error string.
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-2', ok: false, code: 'TIMEOUT!!' }), true)
  assert.equal(sent.at(-1)[2].code, 'failed')
  assert.equal(api.viewExportResult({ type: 'view-export-result', requestId: 'req-3', ok: false, code: 'timeout' }), true)
  assert.equal(sent.at(-1)[2].code, 'timeout')
  // Main -> renderer request bridge is registered on the pin window only.
  const handled = []
  api.onViewExportRequest((request) => handled.push(request))
  assert.ok(listeners.has('pin:view-export-request'))
  listeners.get('pin:view-export-request')({}, { requestId: 'req-4' })
  listeners.get('pin:view-export-request')({}, null)
  assert.equal(handled.length, 1)
  assert.equal(handled[0].requestId, 'req-4')
})

// ---------------------------------------------------------------------------
// 3. Pin domain lifecycle.
// ---------------------------------------------------------------------------

function createFakePinImages() {
  const assets = new Map()
  let sequence = 0
  return {
    assets,
    add: ({ bytes, mime }) => {
      const id = `pin-image-${++sequence}`
      assets.set(id, { bytes, mime })
      return id
    },
    read: async (id) => {
      const entry = assets.get(id)
      if (!entry) throw new Error('贴图资源已释放')
      return entry
    },
    retain: (id) => assets.has(id),
    release: (id) => { assets.delete(id) },
    stats: () => ({ resident: 0, assets: assets.size, handles: 0 })
  }
}

function createHarness(options = {}) {
  const handlers = new Map()
  const sent = []
  const saved = []
  const errors = []
  const builtMenus = []
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromBuffer: (bytes) => ({
        bytes: Buffer.from(bytes),
        getSize: () => ({ width: 600, height: 800 }),
        isEmpty: () => options.nativeImageEmpty === true,
        resize: () => ({ getSize: () => ({ width: 128, height: 128 }) })
      })
    },
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      }),
      getDisplayNearestPoint: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    Menu: {
      buildFromTemplate: (template) => {
        builtMenus.push(template)
        return { popup: () => {}, template }
      }
    },
    path,
    rootDirectory: ROOT,
    createLocalWindow: () => {
      const win = {
        _ops: [],
        _bounds: [],
        _destroyed: false,
        isDestroyed: () => win._destroyed,
        isVisible: () => true,
        getBounds: () => ({ x: 0, y: 0, width: 600, height: 800 }),
        getContentBounds: () => ({ x: 0, y: 0, width: 600, height: 800 }),
        setBounds: (bounds) => win._bounds.push(bounds),
        setPosition: () => {},
        setContentSize: () => {},
        setAlwaysOnTop: () => {},
        setOpacity: () => {},
        setIgnoreMouseEvents: () => {},
        show: () => win._ops.push('show'),
        showInactive: () => win._ops.push('show-inactive'),
        hide: () => win._ops.push('hide'),
        moveTop: () => {},
        focus: () => {},
        loadFile: () => {},
        close: () => {},
        destroy: () => { win._destroyed = true },
        on: (event, cb) => {
          win._events = win._events || {}
          win._events[event] = cb
          if (event === 'closed') win._closed = cb
        },
        webContents: null
      }
      win.webContents = {
        window: win,
        isDestroyed: () => false,
        send: (channel, payload) => {
          sent.push({ win, channel, payload })
          if (channel === 'pin:view-export-request' && typeof options.answer === 'function') {
            const command = options.answer(payload?.requestId, win)
            if (!command) return
            setImmediate(() => handlers.get('pin:context-menu')?.({ sender: win.webContents }, null, command))
          }
        },
        on: () => {}
      }
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async (buffer) => {
      saved.push(Buffer.from(buffer))
      return options.savePath === undefined ? 'saved.png' : options.savePath
    },
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    pinImages: options.pinImages || createFakePinImages(),
    getCreateCaptureWindow: () => async () => null,
    log: () => {},
    showMessageBox: options.showMessageBox || (async () => ({ response: 0 })),
    showErrorBox: (message, detail) => errors.push({ message, detail }),
    viewExportTimeoutMs: options.timeoutMs,
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, handlers, sent, saved, errors, builtMenus }
}

function answerViewExport(harness, win, command) {
  harness.handlers.get('pin:context-menu')({ sender: win.webContents }, null, command)
}

test('domain: preview confirms, then saves exactly the renderer-composed PNG bytes', async () => {
  const composed = makePng(600, 800, Buffer.from([1, 2, 3, 4]))
  let preview = null
  const harness = createHarness({
    answer: (requestId) => ({
      type: 'view-export-result', requestId, ok: true, png: composed, width: 600, height: 800, ocrOverlay: true
    }),
    showMessageBox: async (_win, dialog) => {
      preview = dialog
      return { response: 0 }
    }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const receipt = await harness.domain.exportPinView(win)
  assert.equal(receipt.status, 'saved')
  assert.equal(receipt.filePath, 'saved.png')
  assert.deepEqual(harness.saved, [composed])
  assert.match(preview.detail, /600 × 800/)
  assert.match(preview.detail, /OCR 叠层/)
  assert.equal(harness.builtMenus.length, 0, 'a view-export envelope must not open the context menu')
  win._closed()
})

test('domain: a timeout, an invalid PNG and a stale request all settle without saving', async () => {
  // No renderer answer at all -> bounded timeout, retryable failure, no file.
  const timedOut = createHarness({ timeoutMs: 20 })
  const win = timedOut.domain.createPinWindow(ORIGINAL, {})
  const receipt = await timedOut.domain.exportPinView(win)
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.code, 'TIMEOUT')
  assert.equal(receipt.retryable, true)
  assert.equal(timedOut.saved.length, 0)
  assert.equal(timedOut.errors.length, 1)
  assert.match(timedOut.errors[0].detail, /超时/)
  // The pending request and its timer are gone.
  assert.equal(win._pinViewExportRequest, null)
  assert.equal(win._pinViewExporting, false)
  win._closed()

  // A renderer answer with a corrupt PNG header is rejected before anything is written.
  const invalid = createHarness({
    answer: (requestId) => ({
      type: 'view-export-result', requestId, ok: true, png: Buffer.from('not a png at all'), width: 600, height: 800
    })
  })
  const invalidWin = invalid.domain.createPinWindow(ORIGINAL, {})
  const invalidReceipt = await invalid.domain.exportPinView(invalidWin)
  assert.equal(invalidReceipt.status, 'failed')
  assert.equal(invalidReceipt.code, 'INVALID_RENDER')
  assert.equal(invalid.saved.length, 0)
  invalidWin._closed()

  // A declared size that disagrees with the PNG header is rejected as well.
  const mismatch = createHarness({
    answer: (requestId) => ({
      type: 'view-export-result', requestId, ok: true, png: makePng(600, 800), width: 500, height: 800
    })
  })
  const mismatchWin = mismatch.domain.createPinWindow(ORIGINAL, {})
  const mismatchReceipt = await mismatch.domain.exportPinView(mismatchWin)
  assert.equal(mismatchReceipt.code, 'INVALID_RENDER')
  assert.equal(mismatch.saved.length, 0)
  mismatchWin._closed()

  // A late answer for an OLD request id must be ignored, and the current request kept.
  const stale = createHarness({ timeoutMs: 200 })
  const staleWin = stale.domain.createPinWindow(ORIGINAL, {})
  const pending = stale.domain.exportPinView(staleWin)
  const requestId = stale.sent.find(({ channel }) => channel === 'pin:view-export-request').payload.requestId
  answerViewExport(stale, staleWin, {
    type: 'view-export-result', requestId: 'req-not-the-one', ok: true, png: makePng(600, 800), width: 600, height: 800
  })
  assert.equal(staleWin._pinViewExportRequest?.requestId, requestId)
  answerViewExport(stale, staleWin, {
    type: 'view-export-result', requestId, ok: true, png: makePng(600, 800), width: 600, height: 800, ocrOverlay: false
  })
  const staleReceipt = await pending
  assert.equal(staleReceipt.status, 'saved')
  assert.equal(stale.saved.length, 1)
  staleWin._closed()
})

test('domain: window/request identity - a re-annotated or closed pin never saves stale pixels', async () => {
  // Re-annotation replaces _pinData.imageId while the compose is in flight.
  const reopening = createHarness({ timeoutMs: 200 })
  const win = reopening.domain.createPinWindow(ORIGINAL, {})
  const pending = reopening.domain.exportPinView(win)
  const requestId = reopening.sent.find(({ channel }) => channel === 'pin:view-export-request').payload.requestId
  reopening.domain.updatePinWindow(win, makePng(10, 10), {})
  const receipt = await pending
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.code, 'IMAGE_CHANGED')
  assert.equal(reopening.saved.length, 0)
  // The late answer for the aborted request is ignored instead of settling a new request.
  assert.equal(win._pinViewExportRequest, null)
  answerViewExport(reopening, win, {
    type: 'view-export-result', requestId, ok: true, png: makePng(600, 800), width: 600, height: 800
  })
  assert.equal(win._pinViewExportRequest, null)
  win._closed()

  // Closing the window while composing releases the pending request without a dialog.
  const closing = createHarness({ timeoutMs: 200 })
  const closingWin = closing.domain.createPinWindow(ORIGINAL, {})
  const closingPending = closing.domain.exportPinView(closingWin)
  closingWin._closed()
  const closedReceipt = await closingPending
  assert.equal(closedReceipt.status, 'failed')
  assert.equal(closedReceipt.code, 'CANCELLED')
  assert.equal(closing.saved.length, 0)
  assert.equal(closing.errors.length, 0)
})

test('domain: single-flight - a second menu click while composing starts nothing', async () => {
  const harness = createHarness({ timeoutMs: 200 })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const first = harness.domain.exportPinView(win)
  const second = await harness.domain.exportPinView(win)
  assert.equal(second, null)
  assert.equal(harness.sent.filter(({ channel }) => channel === 'pin:view-export-request').length, 1)
  const requestId = harness.sent.find(({ channel }) => channel === 'pin:view-export-request').payload.requestId
  answerViewExport(harness, win, {
    type: 'view-export-result', requestId, ok: true, png: makePng(600, 800), width: 600, height: 800
  })
  assert.equal((await first).status, 'saved')
  win._closed()
})

test('domain: the bounded envelope normaliser is the single gate main trusts', () => {
  const png = makePng(120, 80)
  const valid = pinDomain.normalizeViewExportCommand({
    type: pinDomain.VIEW_EXPORT_RESULT_TYPE, requestId: 'req-1', ok: true, png, width: 120, height: 80, ocrOverlay: true
  })
  assert.equal(valid.ok, true)
  assert.equal(valid.requestId, 'req-1')
  assert.equal(valid.width, 120)
  assert.ok(Buffer.isBuffer(valid.bytes))
  assert.equal(valid.bytes.length, png.length)
  // ArrayBuffer and any view are accepted the same way (structured clone may pick either).
  const arrayBuffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
  assert.equal(pinDomain.normalizeViewExportCommand({
    type: 'view-export-result', requestId: 'req-2', ok: true, png: arrayBuffer, width: 120, height: 80
  }).ok, true)
  assert.equal(pinDomain.normalizeViewExportCommand({
    type: 'view-export-result', requestId: 'req-3', ok: true, png: new Uint8Array(png), width: 120, height: 80
  }).ok, true)
  // Not this envelope -> null, so context menus and workspace commands keep working.
  assert.equal(pinDomain.normalizeViewExportCommand(null), null)
  assert.equal(pinDomain.normalizeViewExportCommand({ type: 'workspace-save', name: 'x' }), null)
  assert.equal(pinDomain.normalizeViewExportCommand({ type: 'view-export-result', requestId: 'bad id', ok: false }), null)
  assert.equal(pinDomain.normalizeViewExportCommand({ type: 'view-export-result', requestId: 'req-4', ok: false, code: 'timeout' }).code, 'timeout')
  assert.equal(pinDomain.normalizeViewExportCommand({ type: 'view-export-result', requestId: 'req-4', ok: false, code: 'x'.repeat(80) }).code, 'failed')
  // Declared dimensions are bounded before any PNG decode is attempted.
  assert.equal(pinDomain.normalizeViewExportCommand({
    type: 'view-export-result', requestId: 'req-5', ok: true, png, width: 20000, height: 80
  }), null)
  assert.equal(pinDomain.normalizeViewExportCommand({
    type: 'view-export-result', requestId: 'req-6', ok: true, png, width: -1, height: 80
  }), null)
})

test('wiring: pin.html loads the compositor before pin.js; the renderer never captures the page', () => {
  const html = read('pin', 'pin.html')
  assert.ok(html.indexOf('pin-view-export.js') > 0)
  assert.ok(html.indexOf('pin-view-export.js') < html.indexOf('<script src="pin.js">'))
  const pinScript = read('pin', 'pin.js')
  const pinDomainSource = read('main', 'domains', 'pin', 'index.js')
  assert.match(pinScript, /planViewExport\(\{/)
  assert.match(pinScript, /window\.pinAPI\.viewExportResult\(\{/)
  assert.match(pinScript, /MAX_EXPORT_PNG_BYTES/)
  assert.match(pinScript, /onViewExportRequest/)
  assert.doesNotMatch(pinScript, /capturePage/)
  assert.doesNotMatch(pinDomainSource, /viewExportPrepareScript|capturePage/)
  // The preload mirror and the domain keep the same bounds.
  assert.match(read('preload-pin.js'), /MAX_VIEW_EXPORT_PNG_BYTES = 32 \* 1024 \* 1024/)
  assert.match(pinDomainSource, /MAX_VIEW_EXPORT_PNG_BYTES = 32 \* 1024 \* 1024/)
})
