'use strict'

// U02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 4.2):
// long-capture preview/stitching and the pin end-of-drag fix.
//
// Behaviour-first on purpose: the long-capture window is a classic-script page with no module
// boundary, so the controller is executed in a vm with a fake DOM/canvas (the same technique
// test/recording-workbench-ui.test.js uses for its route). The fake canvas really stores RGBA
// pixels for 1:1 and nearest-neighbour copies, so "the preview is linear" and "the strip skips
// the fixed footer" are asserted on pixels/projections, not on source strings.
//
// The pin half runs the real domain against fake windows and a fake screen whose scale factor
// changes between creation and the drop, and counts `win.setBounds` calls.
//
// Item 4.2-3 (non-destructive vector re-annotation) is covered by
// test/u02-pin-reedit.test.js (DEV-01): the capture renderer now attaches a document-shaped
// snapshot to the pin payload and the pin domain reopens the editor from it. This file keeps
// the long-capture preview/stitching and end-of-drag geometry halves only.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const matcher = require('../long-capture/matcher')
const controllerSource = read('long-capture', 'long-capture.js')
const matcherWorkerSource = read('long-capture', 'matcher-worker.js')

const PREVIEW_THUMB_EDGE = 160
const PREVIEW_MAX_EDGE = 16384

// ---------------------------------------------------------------------------
// Fake canvas: geometry + real RGBA pixels for nearest-neighbour drawImage.
// ---------------------------------------------------------------------------

const MAX_PIXEL_COPY = 1_500_000

function ensurePixels(canvas) {
  const size = canvas.width * canvas.height * 4
  if (!canvas._pixels || canvas._pixels.length !== size) canvas._pixels = Buffer.alloc(size)
  return canvas._pixels
}

function drawScaled(destination, source, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (!source || !source._pixels) return
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return
  // Huge canvases only need geometry here; skipping the copy keeps the cap test quick without
  // weakening any pixel assertion (those stay far below the threshold).
  if (dw * dh > MAX_PIXEL_COPY) return
  const pixels = ensurePixels(destination)
  const src = source._pixels
  for (let y = 0; y < dh; y++) {
    const sourceY = sy + Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh))
    for (let x = 0; x < dw; x++) {
      const sourceX = sx + Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw))
      const sourceIndex = (sourceY * source.width + sourceX) * 4
      const target = ((dy + y) * destination.width + (dx + x)) * 4
      if (target < 0 || target + 3 >= pixels.length) continue
      pixels[target] = src[sourceIndex]
      pixels[target + 1] = src[sourceIndex + 1]
      pixels[target + 2] = src[sourceIndex + 2]
      pixels[target + 3] = src[sourceIndex + 3]
    }
  }
}

function createFakeCanvas(width = 1, height = 1) {
  const canvas = {
    _width: width,
    _height: height,
    _pixels: null,
    _context: null,
    _ops: [],
    style: {},
    hidden: false,
    get width() { return canvas._width },
    set width(value) {
      canvas._width = Math.max(0, Math.round(Number(value) || 0))
      canvas._pixels = null
    },
    get height() { return canvas._height },
    set height(value) {
      canvas._height = Math.max(0, Math.round(Number(value) || 0))
      canvas._pixels = null
    },
    getContext() {
      if (!canvas._context) canvas._context = createFakeContext(canvas)
      return canvas._context
    },
    toBlob(callback) { callback({ arrayBuffer: async () => new ArrayBuffer(0) }) }
  }
  return canvas
}

function createFakeContext(canvas) {
  return {
    drawImage(source, ...rest) {
      canvas._ops.push({ source, args: rest })
      if (rest.length === 8) drawScaled(canvas, source, ...rest)
    },
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4)
      const pixels = ensurePixels(canvas)
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const source = ((y + row) * canvas.width + (x + column)) * 4
          const target = (row * width + column) * 4
          data[target] = pixels[source]
          data[target + 1] = pixels[source + 1]
          data[target + 2] = pixels[source + 2]
          data[target + 3] = pixels[source + 3]
        }
      }
      return { data, width, height }
    },
    clearRect() {},
    fillRect() {},
    save() {},
    restore() {}
  }
}

function fillCanvas(canvas, color) {
  canvas._pixels = Buffer.alloc(canvas.width * canvas.height * 4)
  for (let index = 0; index < canvas._pixels.length; index += 4) {
    canvas._pixels[index] = color[0]
    canvas._pixels[index + 1] = color[1]
    canvas._pixels[index + 2] = color[2]
    canvas._pixels[index + 3] = 255
  }
  return canvas
}

function solidCanvas(width, height, color) {
  const canvas = createFakeCanvas()
  canvas.width = width
  canvas.height = height
  return fillCanvas(canvas, color)
}

function seedCanvas(canvas, width, height, rgba) {
  canvas.width = width
  canvas.height = height
  canvas._pixels = Buffer.from(rgba)
}

function canvasPixel(canvas, x, y) {
  const index = (y * canvas.width + x) * 4
  const pixels = canvas._pixels
  return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]
}

// ---------------------------------------------------------------------------
// Long-capture controller harness (fake DOM + fake canvases + fake preload API).
// ---------------------------------------------------------------------------

function createLongCaptureHarness() {
  const elements = new Map()
  const fallbackClassList = () => ({ toggle() {}, add() {}, remove() {} })

  function element(id) {
    if (elements.has(id)) return elements.get(id)
    const node = {
      id,
      textContent: '',
      hidden: false,
      disabled: false,
      value: '0',
      max: '0',
      title: '',
      style: {},
      dataset: {},
      classList: fallbackClassList(),
      setAttribute() {},
      removeAttribute() {},
      getAttribute() { return null },
      addEventListener() {},
      focus() {},
      onclick: null,
      onchange: null
    }
    elements.set(id, node)
    return node
  }

  const preview = createFakeCanvas(160, 180)
  elements.set('preview', preview)
  const document = {
    documentElement: { style: { setProperty() {} } },
    body: { classList: fallbackClassList() },
    getElementById: (id) => element(id),
    createElement: (tag) => (tag === 'canvas' ? createFakeCanvas() : element(`created:${tag}`)),
    querySelectorAll: () => []
  }
  const sandbox = {
    console,
    document,
    setTimeout,
    clearTimeout,
    performance: { now: () => 0 },
    Uint8ClampedArray,
    Math,
    // shared/i18n.js and shared/long-capture-limits.js are classic-script globals in the page.
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    setLanguage: () => {},
    applyTranslations: () => {},
    addEventListener: () => {},
    Worker: class { postMessage() {} terminate() {} },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    window: null
  }
  sandbox.window = sandbox
  sandbox.window.longCaptureLimits = {
    capabilities: () => ({ copy: true, pin: true, save: true, edge: 0, limits: { maxEdge: 0, maxPixels: 0 } })
  }
  sandbox.window.longCaptureAPI = {
    onInit() {},
    onSelectionUpdated() {},
    onInterfaceLanguage() {},
    ready() {},
    setOverlayActive() {},
    setSelectionEditing: async () => {},
    addStrip: async () => ({ width: 0, height: 0, strips: 1, trimStart: 0, trimEnd: 0 }),
    setTrim: async () => ({}),
    finish: async () => ({})
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(controllerSource, context, { filename: 'long-capture/long-capture.js' })
  return {
    run: (code) => vm.runInContext(code, context),
    get: (name) => vm.runInContext(name, context),
    preview
  }
}

// ---------------------------------------------------------------------------
// Synthetic scrolling frames (fixed bands + deterministic page content).
// ---------------------------------------------------------------------------

// Deterministic pseudo-random per page pixel. The page line also gets a distinct base
// brightness so the matcher's 1-D coarse profile sees a real signal (a flat profile would make
// the true shift indistinguishable from noise), while the grain feeds the 2-D refinement.
function pagePixel(pageIndex, cross) {
  let state = (Math.imul(pageIndex + 1, 0x9e3779b1) ^ Math.imul(cross + 1, 0x85ebca6b)) >>> 0
  state = Math.imul(state ^ (state >>> 16), 0x7feb352d) >>> 0
  state = Math.imul(state ^ (state >>> 15), 0x846ca68b) >>> 0
  return (state ^ (state >>> 16)) >>> 0
}

function contentColor(pageIndex, cross) {
  const grain = pagePixel(pageIndex, cross)
  const base = 40 + (pagePixel(pageIndex, 0) % 140)
  const value = Math.max(0, Math.min(255, base + (grain % 25) - 12))
  return [value, (value + ((grain >>> 8) % 40)) & 0xff, (value + ((grain >>> 16) % 40)) & 0xff]
}

function bandColor(kind, line, cross) {
  if (kind === 'lead') return [((line * 7 + cross * 3) & 0xff), 190, 40]
  return [250, ((line * 5 + cross * 9) & 0xff), 250]
}

function scrollingFrame({ axis = 'vertical', width, height, lead = 0, trail = 0, scroll = 0 }) {
  const horizontal = axis === 'horizontal'
  const lineCount = horizontal ? width : height
  const crossCount = horizontal ? height : width
  const contentEnd = lineCount - trail
  const buffer = Buffer.alloc(width * height * 4)
  for (let line = 0; line < lineCount; line++) {
    for (let cross = 0; cross < crossCount; cross++) {
      let color
      if (line < lead) color = bandColor('lead', line, cross)
      else if (line >= contentEnd) color = bandColor('trail', line, cross)
      else color = contentColor(scroll + (line - lead), cross)
      const row = horizontal ? cross : line
      const column = horizontal ? line : cross
      const index = (row * width + column) * 4
      buffer[index] = color[0]
      buffer[index + 1] = color[1]
      buffer[index + 2] = color[2]
      buffer[index + 3] = 255
    }
  }
  return buffer
}

function grayFrame(rgba, width, height) {
  const gray = matcher.toGrayscale(rgba)
  assert.equal(gray.length, width * height)
  return gray
}

function frameArrayBuffer(rgba) {
  return rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)
}

// The pre-U02 appendPreview geometry, kept as the "bug reproduced" reference. It intentionally
// repeats the old `nextHeight > 1200 ? 1000 / old.height` rescale so the test can prove the old
// canvas was resampled repeatedly and the raw->preview mapping is non-linear.
function legacyPreviewModel(strips) {
  let width = PREVIEW_THUMB_EDGE
  let height = Math.max(1, Math.round(strips[0].height * PREVIEW_THUMB_EDGE / strips[0].width))
  let positions = [0, height]
  let scaleEvents = 0
  for (let index = 1; index < strips.length; index++) {
    const strip = strips[index]
    const addition = Math.max(1, Math.round(strip.height * width / strip.width))
    if (height + addition > 1200) {
      const scale = 1000 / height
      height = Math.max(1, Math.round(height * scale))
      width = Math.max(1, Math.round(width * scale))
      positions = positions.map((value) => Math.round(value * scale))
      scaleEvents += 1
    }
    height += addition
    positions.push(height)
  }
  return { width, height, positions, scaleEvents }
}

// ---------------------------------------------------------------------------
// 1. Preview: uniform scale, no cascade, linear trim mapping.
// ---------------------------------------------------------------------------

test('U02 long-capture preview: 80 appends keep one uniform scale, the old cascade is reproduced as the reference failure', () => {
  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  const appendPreview = harness.get('appendPreview')
  const strips = []
  for (let index = 0; index < 80; index++) {
    const strip = solidCanvas(800, 120, [index, 255 - index, (index * 7) & 0xff])
    strips.push(strip)
    appendPreview(strip, 'append', index === 0)
  }

  // The new canvas is one uniform thumbnail: width = the fixed edge, height = raw * scale.
  const scale = PREVIEW_THUMB_EDGE / 800
  const rawHeight = 80 * 120
  assert.equal(harness.preview.width, PREVIEW_THUMB_EDGE)
  assert.equal(harness.preview.height, Math.round(rawHeight * scale))
  assert.equal(harness.preview.height / harness.preview.width, rawHeight / 800, 'one uniform aspect ratio')

  // Regression witness: the preview itself is never a source, every source is a fresh 160-wide
  // thumbnail (the old code redrew the already-shrunk canvas as its own source).
  assert.ok(harness.preview._ops.length >= 80)
  for (const operation of harness.preview._ops) {
    assert.notEqual(operation.source, harness.preview, 'the preview canvas must never resample itself')
    assert.equal(operation.source.width, PREVIEW_THUMB_EDGE)
  }
  // The last render paints every strip at the round(offset * scale) boundary: a linear mapping.
  const lastRender = harness.preview._ops.slice(-80)
  lastRender.forEach((operation, index) => {
    assert.equal(operation.args[5], Math.round(index * 120 * scale), `strip ${index} starts at the linear offset`)
    assert.equal(operation.args[7], Math.round((index + 1) * 120 * scale) - Math.round(index * 120 * scale))
  })

  // Reproduce the old failure with its own model (verbatim pre-U02 geometry; pure math, so the
  // 400-strip case costs nothing). It rescaled the whole canvas once per 1200px crossing: the
  // same top pixels were re-filtered a dozen times, the canvas width collapsed so CSS upscaled
  // it, and the raw->preview mapping drifted, which is exactly the trim-line desync in the report.
  const legacyStrips = Array.from({ length: 400 }, () => ({ width: 800, height: 120 }))
  const legacy = legacyPreviewModel(legacyStrips)
  assert.ok(legacy.scaleEvents >= 10, `old code rescaled the canvas ${legacy.scaleEvents} times (cumulative blur)`)
  assert.ok(legacy.width <= 24, `old preview width collapsed to ${legacy.width}px and was CSS-upscaled`)
  let maxFractionDeviation = 0
  for (let index = 1; index < legacyStrips.length; index++) {
    maxFractionDeviation = Math.max(maxFractionDeviation,
      Math.abs(legacy.positions[index] / legacy.height - index / legacyStrips.length))
  }
  assert.ok(maxFractionDeviation > 0.01,
    `old raw->preview mapping drifted by ${(maxFractionDeviation * 100).toFixed(2)}% (trim line desync)`)
  const linearHeight = 400 * 120 * (PREVIEW_THUMB_EDGE / 800)
  assert.ok(legacy.height < linearHeight * 0.6, 'the old canvas only covered part of the expected extent')
})

test('U02 long-capture preview: the trim percentage maps onto the real untrimmed height', () => {
  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  const appendPreview = harness.get('appendPreview')
  for (let index = 0; index < 10; index++) appendPreview(solidCanvas(800, 120, [index, 0, 0]), 'append', index === 0)
  // Visible height 1200 - 240 = 960, trims 144/336 -> the raw extent is still 1200 * 0.2 = 240.
  harness.run('total = { width: 800, height: 960, strips: 10, trimStart: 144, trimEnd: 96 }')
  harness.run('updateTrimPreview()')
  assert.equal(harness.preview.style.clipPath, 'inset(12% 0 8% 0)')
  // 12% of the preview is exactly trimStart * scale: the clip line and the main-process cut agree.
  const scale = PREVIEW_THUMB_EDGE / 800
  assert.ok(Math.abs(harness.preview.height * 0.12 - 144 * scale) <= 0.5)
  assert.ok(Math.abs(harness.preview.height * (1 - 0.08) - (1200 - 96) * scale) <= 0.5)
})

test('U02 long-capture preview: prepend keeps the strip order and the linear mapping', () => {
  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  const appendPreview = harness.get('appendPreview')
  appendPreview(solidCanvas(800, 120, [10, 0, 0]), 'append', true)
  appendPreview(solidCanvas(800, 120, [20, 0, 0]), 'append', false)
  appendPreview(solidCanvas(800, 120, [30, 0, 0]), 'prepend', false)
  assert.equal(harness.preview.height, Math.round(360 * PREVIEW_THUMB_EDGE / 800))
  assert.deepEqual(canvasPixel(harness.preview, 10, 0).slice(0, 3), [30, 0, 0], 'prepended strip sits on top')
  assert.deepEqual(canvasPixel(harness.preview, 10, harness.preview.height - 1).slice(0, 3), [20, 0, 0],
    'the last appended strip stays at the bottom')
  assert.deepEqual(canvasPixel(harness.preview, 10, 30).slice(0, 3), [10, 0, 0], 'middle strip keeps its slot')
})

test('U02 long-capture preview: horizontal stitching uses a fixed-height thumbnail band', () => {
  const harness = createLongCaptureHarness()
  harness.run('axis = "horizontal"')
  const appendPreview = harness.get('appendPreview')
  for (let index = 0; index < 10; index++) appendPreview(solidCanvas(120, 800, [index, 0, 0]), 'append', index === 0)
  const scale = PREVIEW_THUMB_EDGE / 800
  assert.equal(harness.preview.height, PREVIEW_THUMB_EDGE)
  assert.equal(harness.preview.width, Math.round(1200 * scale))
  harness.run('total = { width: 900, height: 800, strips: 10, trimStart: 150, trimEnd: 150 }')
  harness.run('updateTrimPreview()')
  assert.equal(harness.preview.style.clipPath, 'inset(0 12.5% 0 12.5%)')
})

test('U02 long-capture preview: a very long capture stays linear under the canvas edge cap', () => {
  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  const appendPreview = harness.get('appendPreview')
  // A narrow capture keeps the preferred thumb width but the raw length would exceed the canvas
  // edge: scale must shrink the cross axis too, so both axes stay on the same factor.
  appendPreview(solidCanvas(8, 1000, [1, 0, 0]), 'append', true)
  appendPreview(solidCanvas(8, 1000, [2, 0, 0]), 'append', false)
  assert.equal(harness.preview.height, PREVIEW_MAX_EDGE)
  assert.ok(harness.preview.width < PREVIEW_THUMB_EDGE)
  const scale = harness.preview.height / 2000
  assert.ok(Math.abs(harness.preview.width - 8 * scale) <= 1)
  assert.ok(harness.run('previewScaleFor(2000, 8)') < harness.run('previewScaleFor(1000, 8)'),
    'the cap changes the whole scale, not just the height')
})

// ---------------------------------------------------------------------------
// 2. Sticky bands: detection + strip cut.
// ---------------------------------------------------------------------------

const VERTICAL_VIEWPORT = { axis: 'vertical', width: 64, height: 480, lead: 40, trail: 30 }
const HORIZONTAL_VIEWPORT = { axis: 'horizontal', width: 600, height: 96, lead: 60, trail: 40 }

// Objects created inside the vm carry that realm's prototypes, so deep-equal comparisons go
// through JSON (the values themselves are plain geometry).
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value))
}

test('U02 sticky bands: detectStickyBands finds the fixed top/bottom bands of a scrolled pair', () => {
  const previous = scrollingFrame({ ...VERTICAL_VIEWPORT, scroll: 0 })
  const current = scrollingFrame({ ...VERTICAL_VIEWPORT, scroll: 120 })
  const sticky = matcher.detectStickyBands(
    grayFrame(previous, VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    grayFrame(current, VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    VERTICAL_VIEWPORT.width,
    VERTICAL_VIEWPORT.height,
    'vertical'
  )
  assert.deepEqual({ start: sticky.start, end: sticky.end },
    { start: VERTICAL_VIEWPORT.lead, end: VERTICAL_VIEWPORT.trail })

  const match = matcher.findBestShift(
    grayFrame(previous, VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    grayFrame(current, VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    VERTICAL_VIEWPORT.width,
    VERTICAL_VIEWPORT.height,
    'vertical'
  )
  assert.equal(match.status, 'matched')
  assert.equal(match.shift, 120)
  assert.deepEqual({ start: match.sticky.start, end: match.sticky.end },
    { start: VERTICAL_VIEWPORT.lead, end: VERTICAL_VIEWPORT.trail },
    'the matched result carries the bands to the renderer')

  // A still frame is classified before the band question; a direct call must not invent bands.
  const still = matcher.detectStickyBands(
    grayFrame(previous, VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    grayFrame(previous.slice(), VERTICAL_VIEWPORT.width, VERTICAL_VIEWPORT.height),
    VERTICAL_VIEWPORT.width,
    VERTICAL_VIEWPORT.height,
    'vertical'
  )
  assert.deepEqual({ start: still.start, end: still.end }, { start: 0, end: 0 })
})

test('U02 sticky bands: a content-only scroll reports no bands and keeps the full-edge cut', () => {
  const viewport = { axis: 'vertical', width: 64, height: 480 }
  const previous = scrollingFrame({ ...viewport, scroll: 0 })
  const current = scrollingFrame({ ...viewport, scroll: 120 })
  const sticky = matcher.detectStickyBands(
    grayFrame(previous, viewport.width, viewport.height),
    grayFrame(current, viewport.width, viewport.height),
    viewport.width,
    viewport.height,
    'vertical'
  )
  assert.deepEqual({ start: sticky.start, end: sticky.end }, { start: 0, end: 0 })

  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  seedCanvas(harness.get('cropCanvas'), viewport.width, viewport.height, current)
  const rect = jsonRoundTrip(harness.run(`stripCutRect(120, false, ${JSON.stringify({ start: 0, end: 0 })})`))
  assert.deepEqual(rect, { x: 0, y: viewport.height - 120, width: viewport.width, height: 120 })
})

test('U02 sticky bands: the appended strip excludes the fixed footer (old cut reproduced)', () => {
  const viewport = VERTICAL_VIEWPORT
  const previous = scrollingFrame({ ...viewport, scroll: 0 })
  const current = scrollingFrame({ ...viewport, scroll: 120 })
  const sticky = matcher.detectStickyBands(
    grayFrame(previous, viewport.width, viewport.height),
    grayFrame(current, viewport.width, viewport.height),
    viewport.width,
    viewport.height,
    'vertical'
  )
  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  seedCanvas(harness.get('cropCanvas'), viewport.width, viewport.height, current)

  const rect = jsonRoundTrip(harness.run(`stripCutRect(120, false, ${JSON.stringify({ start: sticky.start, end: sticky.end })})`))
  assert.deepEqual(rect, { x: 0, y: viewport.height - viewport.trail - 120, width: viewport.width, height: 120 },
    'the strip starts above the fixed footer')

  const strip = harness.run(`makeStripCanvas(120, false, ${JSON.stringify({ start: sticky.start, end: sticky.end })})`)
  assert.equal(strip.height, 120)
  // The new content is the page rows right after the previously visible viewport.
  const firstPageRow = viewport.height - viewport.lead - viewport.trail
  for (const row of [0, 1, 59, 118, 119]) {
    for (const column of [0, 17, 63]) {
      const expected = contentColor(firstPageRow + row, column)
      assert.deepEqual(canvasPixel(strip, column, row).slice(0, 3), expected,
        `row ${row} column ${column} is scrolled content`)
    }
  }

  // Reproduce the pre-U02 cut: the bottom `extension` rows are copied verbatim, which repeats
  // the fixed footer at the end of every appended strip.
  const legacyStrip = harness.run('makeStripCanvas(120, false, null)')
  const legacyLastRow = canvasPixel(legacyStrip, 7, legacyStrip.height - 1)
  assert.deepEqual(legacyLastRow.slice(0, 3), bandColor('trail', viewport.height - 1, 7),
    'the old cut ends inside the fixed footer: this is the repeated-navigation-bar bug')
})

test('U02 sticky bands: the prepended strip excludes the fixed header', () => {
  const viewport = VERTICAL_VIEWPORT
  const previous = scrollingFrame({ ...viewport, scroll: 300 })
  const current = scrollingFrame({ ...viewport, scroll: 240 })
  const match = matcher.findBestShift(
    grayFrame(previous, viewport.width, viewport.height),
    grayFrame(current, viewport.width, viewport.height),
    viewport.width,
    viewport.height,
    'vertical'
  )
  assert.equal(match.status, 'matched')
  assert.equal(match.shift, -60)
  assert.equal(match.sticky.start, viewport.lead)

  const harness = createLongCaptureHarness()
  harness.run('axis = "vertical"')
  seedCanvas(harness.get('cropCanvas'), viewport.width, viewport.height, current)
  const strip = harness.run(`makeStripCanvas(-60, false, ${JSON.stringify({ start: match.sticky.start, end: match.sticky.end })})`)
  assert.equal(strip.height, 60)
  for (const row of [0, 1, 29, 58, 59]) {
    for (const column of [0, 33, 63]) {
      const expected = contentColor(240 + row, column)
      assert.deepEqual(canvasPixel(strip, column, row).slice(0, 3), expected,
        `prepended row ${row} is scrolled content, not the fixed header`)
    }
  }
  const legacyStrip = harness.run('makeStripCanvas(-60, false, null)')
  assert.deepEqual(canvasPixel(legacyStrip, 7, 0).slice(0, 3), bandColor('lead', 0, 7),
    'the old prepend starts inside the fixed header')
})

test('U02 sticky bands: horizontal scrolling strips skip the fixed side bands', () => {
  const viewport = HORIZONTAL_VIEWPORT
  const previous = scrollingFrame({ ...viewport, scroll: 0 })
  const current = scrollingFrame({ ...viewport, scroll: 160 })
  const sticky = matcher.detectStickyBands(
    grayFrame(previous, viewport.width, viewport.height),
    grayFrame(current, viewport.width, viewport.height),
    viewport.width,
    viewport.height,
    'horizontal'
  )
  assert.deepEqual({ start: sticky.start, end: sticky.end },
    { start: viewport.lead, end: viewport.trail })
  const match = matcher.findBestShift(
    grayFrame(previous, viewport.width, viewport.height),
    grayFrame(current, viewport.width, viewport.height),
    viewport.width,
    viewport.height,
    'horizontal'
  )
  assert.equal(match.status, 'matched')
  assert.equal(match.shift, 160)

  const harness = createLongCaptureHarness()
  harness.run('axis = "horizontal"')
  seedCanvas(harness.get('cropCanvas'), viewport.width, viewport.height, current)
  const strip = harness.run(`makeStripCanvas(160, false, ${JSON.stringify({ start: sticky.start, end: sticky.end })})`)
  assert.equal(strip.width, 160)
  assert.equal(strip.height, viewport.height)
  const firstPageColumn = viewport.width - viewport.lead - viewport.trail
  for (const column of [0, 1, 64, 158, 159]) {
    for (const row of [0, 31, 95]) {
      const expected = contentColor(firstPageColumn + column, row)
      assert.deepEqual(canvasPixel(strip, column, row).slice(0, 3), expected)
    }
  }
  const legacyStrip = harness.run('makeStripCanvas(160, false, null)')
  assert.deepEqual(canvasPixel(legacyStrip, legacyStrip.width - 1, 9).slice(0, 3),
    bandColor('trail', viewport.width - 1, 9), 'the old horizontal cut ends inside the fixed side band')
})

test('U02 sticky bands: the matcher worker forwards the detected bands with the match', () => {
  let response = null
  let nextId = 0
  const worker = { postMessage: (message) => { response = message } }
  vm.runInNewContext(matcherWorkerSource, {
    importScripts() {},
    LongCaptureMatcher: matcher,
    Uint8ClampedArray,
    self: worker
  })
  const viewport = VERTICAL_VIEWPORT
  const send = (scroll) => {
    const rgba = scrollingFrame({ ...viewport, scroll })
    worker.onmessage({
      data: { type: 'frame', id: ++nextId, rgba: frameArrayBuffer(rgba), width: viewport.width, height: viewport.height, axis: 'vertical' }
    })
    return response
  }
  const initial = send(0)
  assert.equal(initial.status, 'initialized')
  worker.onmessage({ data: { type: 'commit', id: initial.id } })
  const matched = send(120)
  assert.equal(matched.status, 'matched')
  assert.equal(matched.shift, 120)
  assert.equal(matched.extension, 120)
  assert.deepEqual({ start: matched.sticky.start, end: matched.sticky.end },
    { start: viewport.lead, end: viewport.trail })
})

test('U02 sticky bands: the controller feeds the worker bands into the strip cut (structural, reason below)', () => {
  // Structural on purpose: captureFrame needs a live desktop media stream, a real Worker and a
  // working IPC bridge, none of which exist in a node test. The cut itself is behaviour-tested
  // above through the same makeStripCanvas/stripCutRect functions this call site uses.
  assert.match(controllerSource, /makeStripCanvas\(result\.extension, false, result\.sticky\)/)
  assert.match(controllerSource, /function stripCutRect\(shift, initialized, sticky\)/)
})

// ---------------------------------------------------------------------------
// 3. Pin end-of-drag: scale + snap merge into ONE setBounds.
// ---------------------------------------------------------------------------

function createPinHarness() {
  const handlers = new Map()
  const created = []
  const sends = []
  const primary = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1
  }
  const scaled = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.5
  }
  const screenState = { displays: [primary, scaled], matching: primary, cursor: { x: 10, y: 10 } }
  const screen = {
    getAllDisplays: () => screenState.displays.slice(),
    getPrimaryDisplay: () => primary,
    getDisplayMatching: () => screenState.matching,
    getDisplayNearestPoint: () => primary,
    getCursorScreenPoint: () => screenState.cursor,
    on() {},
    removeListener() {}
  }
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage() {} },
    nativeImage: {
      createFromBuffer: () => ({
        getSize: () => ({ width: 200, height: 100 }),
        isEmpty: () => false,
        toPNG: () => Buffer.from([1]),
        resize() { return this }
      })
    },
    screen,
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    path,
    rootDirectory: ROOT,
    createLocalWindow: () => {
      const win = {
        _state: { x: 0, y: 0, width: 100, height: 50 },
        _boundsCalls: [],
        _destroyed: false,
        _visible: false,
        _events: {},
        isDestroyed: () => win._destroyed,
        getBounds: () => ({ ...win._state }),
        setBounds: (bounds) => {
          win._boundsCalls.push({ ...bounds })
          win._state = { ...bounds }
        },
        setPosition: (x, y) => { win._state = { ...win._state, x, y } },
        setContentSize: (width, height) => { win._state = { ...win._state, width, height } },
        setAlwaysOnTop() {},
        setOpacity() {},
        setIgnoreMouseEvents() {},
        show() { win._visible = true },
        hide() { win._visible = false },
        isVisible: () => win._visible,
        moveTop() {},
        focus() {},
        loadFile: () => undefined,
        close() {},
        destroy() { win._destroyed = true },
        on: (event, callback) => { win._events[event] = callback }
      }
      win.webContents = {
        window: win,
        isDestroyed: () => false,
        send: (channel, payload) => sends.push({ win, channel, payload }),
        on() {},
        executeJavaScript: async () => true
      }
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async () => 'saved',
    createRecognitionWindow() {},
    getCreateCaptureWindow: () => async () => null,
    log() {},
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, handlers, sends, created, screenState, primary, scaled }
}

const PIN_SELECTION = { selectionBounds: { x: 300, y: 300, width: 200, height: 100 } }

test('U02 pin move-end: a cross-DPI release applies the resized box and the snap in exactly one setBounds', () => {
  const harness = createPinHarness()
  const win = harness.domain.createPinWindow(Buffer.from([1, 2, 3, 4]), PIN_SELECTION)
  assert.deepEqual(win.getBounds(), { x: 300, y: 300, width: 200, height: 100 })
  win._boundsCalls.length = 0

  // Drag towards the 150% monitor. The cursor delta is chosen so the release box sits inside the
  // scaled display and 7px above its bottom edge: the snap must then move it down by exactly 7.
  harness.screenState.cursor = { x: 100, y: 100 }
  harness.handlers.get('pin:move-start')({ sender: win.webContents })
  harness.screenState.cursor = { x: 1800, y: 766 }
  harness.handlers.get('pin:move')({ sender: win.webContents })
  assert.deepEqual(win.getBounds(), { x: 2000, y: 966, width: 200, height: 100 })
  win._boundsCalls.length = 0

  harness.screenState.matching = harness.scaled
  harness.handlers.get('pin:move-end')({ sender: win.webContents }, { altKey: false })

  // ONE OS move whose box already contains BOTH results: the 150% size (133x67) and the snapped y.
  assert.equal(win._boundsCalls.length, 1, 'the old syncPinDisplayScale + applySnapOnDragEnd pair moved twice')
  assert.deepEqual(win._boundsCalls[0], { x: 2000, y: 973, width: 133, height: 67 })
  assert.deepEqual(win.getBounds(), { x: 2000, y: 973, width: 133, height: 67 })

  const data = win._pinData
  assert.equal(data.displayScaleFactor, 1.5)
  assert.ok(Math.abs(data.baseWidth - 200 / 1.5) < 0.001)
  assert.ok(Math.abs(data.baseHeight - 100 / 1.5) < 0.001)
  assert.equal(data.zoom, 1)
  // The renderer is still told about the effective zoom exactly once.
  assert.deepEqual(harness.sends.filter(({ channel }) => channel === 'pin:zoom-changed').map(({ payload }) => payload), [100])
})

test('U02 pin move-end: a plain snap moves once, a stray release does not move at all', () => {
  const harness = createPinHarness()
  const win = harness.domain.createPinWindow(Buffer.from([1, 2, 3, 4]), PIN_SELECTION)
  win._boundsCalls.length = 0

  // No drag in flight: nothing to snap and the display scale is unchanged.
  harness.handlers.get('pin:move-end')({ sender: win.webContents }, { altKey: false })
  assert.equal(win._boundsCalls.length, 0)

  // Drag the pin 5 DIP from the work-area edge: one snap-only move.
  harness.screenState.cursor = { x: 100, y: 100 }
  harness.handlers.get('pin:move-start')({ sender: win.webContents })
  harness.screenState.cursor = { x: -195, y: 100 }
  harness.handlers.get('pin:move')({ sender: win.webContents })
  assert.deepEqual(win.getBounds(), { x: 5, y: 300, width: 200, height: 100 })
  win._boundsCalls.length = 0
  harness.handlers.get('pin:move-end')({ sender: win.webContents }, { altKey: false })
  assert.equal(win._boundsCalls.length, 1)
  assert.deepEqual(win._boundsCalls[0], { x: 0, y: 300, width: 200, height: 100 })
})
