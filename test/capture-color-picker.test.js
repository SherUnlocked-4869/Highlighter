const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sourcePointFromClient, formatColorSample, hexToRgb } = require('../capture/color-picker')

const ROOT = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

const capture = read('capture/capture.js')
const captureHtml = read('capture/capture.html')
const colorPicker = read('capture/color-picker.js')

// The locale tables register into a global bag like the windows do. A fresh bag keeps this
// file independent from whatever another test loaded into the same process.
globalThis.__LOCALES = {}
require('../shared/locales/capture.js')
const localeTables = globalThis.__LOCALES

// Pixel CENTRE -> client CSS point, using the same proportional contract the module owns.
// This is how a test names "the pixel that has this known sRGB value" at any display scale.
function clientForSourcePixel(bounds, imageWidth, imageHeight, x, y) {
  return {
    clientX: bounds.x + ((x + 0.5) * bounds.w) / imageWidth,
    clientY: bounds.y + ((y + 0.5) * bounds.h) / imageHeight
  }
}

// Extract one function body with a brace counter so the source-contract assertions below
// inspect only the code they name (comments with braces live outside these small helpers).
function functionBody(name) {
  const start = capture.indexOf('function ' + name + '(')
  assert.notEqual(start, -1, name + ' is declared')
  const open = capture.indexOf('{', start)
  let depth = 0
  for (let index = open; index < capture.length; index += 1) {
    const character = capture[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return capture.slice(start, index + 1)
    }
  }
  return ''
}

// A canvas handler slice: from its addEventListener call to the next one. Enough to prove
// ordering inside the handler without depending on its closing brace.
function canvasHandler(name) {
  const start = capture.indexOf("canvas.addEventListener('" + name + "'")
  assert.notEqual(start, -1, name + ' handler exists')
  const next = capture.indexOf("canvas.addEventListener('", start + 10)
  return capture.slice(start, next > start ? next : capture.length)
}

const SCALES = [
  { label: '100%', bounds: { x: 0, y: 0, w: 1920, h: 1080 } },
  { label: '150%', bounds: { x: 120, y: 80, w: 1280, h: 720 } },
  { label: '200%', bounds: { x: -200, y: -100, w: 960, h: 540 } }
]
const IMAGE_WIDTH = 1920
const IMAGE_HEIGHT = 1080

for (const scale of SCALES) {
  test('B02: sourcePointFromClient maps known pixels at ' + scale.label, () => {
    const { bounds } = scale
    // Corners, an off-origin point, the centre and the last pixel all map exactly. These are
    // the pixel centres whose PNG sRGB values the acceptance comparison samples.
    for (const [x, y] of [[0, 0], [1, 1], [10, 20], [960, 540], [1919, 1079]]) {
      const client = clientForSourcePixel(bounds, IMAGE_WIDTH, IMAGE_HEIGHT, x, y)
      assert.deepEqual(
        sourcePointFromClient({
          clientX: client.clientX,
          clientY: client.clientY,
          bounds,
          imageWidth: IMAGE_WIDTH,
          imageHeight: IMAGE_HEIGHT
        }),
        { x, y, inside: true },
        scale.label + ': source pixel ' + x + ',' + y
      )
    }

    // The covered rect is [x, x+w) x [y, y+h): the left/top edges are inside, while the
    // right/bottom edges are outside and clamp to the nearest existing pixel.
    assert.deepEqual(
      sourcePointFromClient({
        clientX: bounds.x,
        clientY: bounds.y,
        bounds,
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT
      }),
      { x: 0, y: 0, inside: true }
    )
    assert.deepEqual(
      sourcePointFromClient({
        clientX: bounds.x + bounds.w,
        clientY: bounds.y + bounds.h,
        bounds,
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT
      }),
      { x: IMAGE_WIDTH - 1, y: IMAGE_HEIGHT - 1, inside: false }
    )
    assert.deepEqual(
      sourcePointFromClient({
        clientX: bounds.x - 40,
        clientY: bounds.y - 40,
        bounds,
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT
      }),
      { x: 0, y: 0, inside: false }
    )
    assert.deepEqual(
      sourcePointFromClient({
        clientX: bounds.x + bounds.w + 40,
        clientY: bounds.y + bounds.h + 40,
        bounds,
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT
      }),
      { x: IMAGE_WIDTH - 1, y: IMAGE_HEIGHT - 1, inside: false }
    )
  })
}

test('B02: sourcePointFromClient rejects degenerate rectangles and sizes', () => {
  const base = { clientX: 5, clientY: 5, bounds: { x: 0, y: 0, w: 10, h: 10 }, imageWidth: 10, imageHeight: 10 }
  const outside = { x: 0, y: 0, inside: false }
  assert.deepEqual(sourcePointFromClient({ ...base, bounds: { x: 0, y: 0, w: 0, h: 10 } }), outside)
  assert.deepEqual(sourcePointFromClient({ ...base, bounds: { x: 0, y: 0, w: 10, h: 0 } }), outside)
  assert.deepEqual(sourcePointFromClient({ ...base, imageWidth: 0 }), outside)
  assert.deepEqual(sourcePointFromClient({ ...base, imageHeight: Number.NaN }), outside)
  assert.deepEqual(sourcePointFromClient({}), outside)
})

test('B02: formatColorSample produces the displayed and copied values', () => {
  assert.deepEqual(formatColorSample({ r: 255, g: 149, b: 0 }), {
    hex: '#ff9500',
    rgb: 'rgb(255, 149, 0)',
    cssHex: '#ff9500',
    textColor: '#000'
  })
  assert.deepEqual(formatColorSample({ r: 0, g: 0, b: 255 }), {
    hex: '#0000ff',
    rgb: 'rgb(0, 0, 255)',
    cssHex: '#0000ff',
    textColor: '#fff'
  })
  assert.equal(formatColorSample({ r: 0, g: 0, b: 0 }).textColor, '#fff')
  assert.equal(formatColorSample({ r: 255, g: 255, b: 255 }).textColor, '#000')
  assert.equal(formatColorSample({ r: 128, g: 128, b: 128 }).textColor, '#000')

  // Byte clamping keeps a malformed reading from producing an invalid CSS value.
  assert.equal(formatColorSample({ r: 300, g: -4, b: 12.6 }).hex, '#ff000d')
  assert.equal(formatColorSample({ r: 300, g: -4, b: 12.6 }).rgb, 'rgb(255, 0, 13)')

  // The value Enter copies round-trips through the test-side parser.
  for (const rgb of [{ r: 18, g: 52, b: 86 }, { r: 255, g: 0, b: 0 }, { r: 1, g: 2, b: 3 }]) {
    const sample = formatColorSample(rgb)
    assert.deepEqual(hexToRgb(sample.hex), rgb)
    assert.deepEqual(hexToRgb(sample.cssHex), rgb)
  }
})

test('B02: hexToRgb accepts the documented forms and rejects the rest', () => {
  assert.deepEqual(hexToRgb('#ff9500'), { r: 255, g: 149, b: 0 })
  assert.deepEqual(hexToRgb('ff9500'), { r: 255, g: 149, b: 0 })
  assert.deepEqual(hexToRgb('#F90'), { r: 255, g: 153, b: 0 })
  assert.deepEqual(hexToRgb('  #AbC  '), { r: 170, g: 187, b: 204 })
  assert.equal(hexToRgb('#ff9500ff'), null)
  assert.equal(hexToRgb('#gggggg'), null)
  assert.equal(hexToRgb(''), null)
  assert.equal(hexToRgb(null), null)
})

test('B02: the toolbar button ships hidden and next to the annotation colour', () => {
  const samplerIndex = captureHtml.indexOf('id="colorSampler"')
  const colorButtonIndex = captureHtml.indexOf('id="colorButton"')
  assert.ok(samplerIndex > 0, 'the entry exists')
  assert.ok(colorButtonIndex > samplerIndex, 'the entry is before the annotation colour swatch')
  assert.ok(colorButtonIndex - samplerIndex < 900, 'the entry is adjacent to the annotation colour')
  assert.match(
    captureHtml,
    /<button id="colorSampler"[^>]*\bhidden\b[^>]*data-i18n-title="capture\.toolbar\.color-picker"[^>]*data-i18n-aria-label="capture\.toolbar\.color-picker"/
  )
  assert.match(captureHtml, /id="colorSampler"[^>]*aria-pressed="false"/)

  const toolbarStart = captureHtml.indexOf('<div id="toolbar"')
  const toolbarEnd = captureHtml.indexOf('<div id="elementBar"')
  assert.ok(toolbarStart > 0 && toolbarEnd > toolbarStart)
  assert.ok(captureHtml.slice(toolbarStart, toolbarEnd).includes('id="colorSampler"'))
})

test('B02: the badge is a polite status region with swatch, HEX and RGB', () => {
  assert.match(
    captureHtml,
    /<div id="colorSampleBadge" class="color-sample-badge hidden" hidden role="status" aria-live="polite">/
  )
  const start = captureHtml.indexOf('id="colorSampleBadge"')
  const end = captureHtml.indexOf('</div>', start)
  const badge = captureHtml.slice(start, end)
  for (const id of ['colorSampleSwatch', 'colorSampleHex', 'colorSampleRgb', 'colorSampleCopied']) {
    assert.ok(badge.includes('id="' + id + '"'), 'badge carries #' + id)
  }
  for (const key of [
    'capture.color-picker.title-section',
    'capture.color-picker.hex',
    'capture.color-picker.rgb',
    'capture.color-picker.copied',
    'capture.color-picker.hint'
  ]) {
    assert.ok(badge.includes('data-i18n="' + key + '"'), 'badge uses ' + key)
  }
  // Styles live in capture.css (the page keeps no inline style block), and the badge still
  // hides through the shared .hidden/[hidden] contract.
  const captureCss = read('capture/capture.css')
  assert.match(captureCss, /\.color-sample-badge\s*\{/)
  assert.match(captureCss, /\.color-sample-badge\[hidden\]\s*\{/)
  assert.doesNotMatch(captureHtml, /<style>/)
})

test('B02: color-picker.js loads before capture.js', () => {
  const pickerIndex = captureHtml.indexOf('src="color-picker.js"')
  const captureIndex = captureHtml.indexOf('src="capture.js"')
  assert.ok(pickerIndex > 0, 'color-picker.js is loaded')
  assert.ok(captureIndex > 0, 'capture.js is loaded')
  assert.ok(pickerIndex < captureIndex, 'the pure contract loads first')
})

test('B02: showColorPicker defaults to true and only an explicit false hides the entry', () => {
  assert.match(capture, /function colorPickerEnabled\(settings\) \{\s*return settings\?\.screenshot\?\.showColorPicker !== false\s*\}/)
  const syncBody = functionBody('syncColorSampler')
  assert.match(syncBody, /colorSampler\.hidden = !enabled/)
  assert.match(syncBody, /colorSampler\.classList\.toggle\('hidden', !enabled\)/)
  assert.match(syncBody, /colorSampleImageData = null/)

  const onInitStart = capture.indexOf('window.captureAPI.onInit')
  const onInitEnd = capture.indexOf('function makeBlankCanvas')
  const onInit = capture.slice(onInitStart, onInitEnd)
  assert.ok(onInitStart > 0 && onInitEnd > onInitStart)
  assert.match(onInit, /syncColorSampler\(data\.settings\)/)
})

test('B02: sampling mode owns pointerdown before every selection/annotation branch', () => {
  const pointerdown = canvasHandler('pointerdown')
  const guardIndex = pointerdown.indexOf('if(colorSampling){')
  assert.ok(guardIndex > 0, 'the sampling guard is first in pointerdown')
  assert.ok(
    guardIndex < pointerdown.indexOf("resultPanel.classList.contains('hidden')"),
    'the guard precedes the result-panel branch'
  )
  const guard = pointerdown.slice(guardIndex, pointerdown.indexOf('}', guardIndex) + 1)
  assert.match(guard, /updateColorSample\(pointFromEvent\(event\)\)/)
  assert.match(guard, /return;/)
  assert.doesNotMatch(guard, /\bannotations\b|\bselection\b|commitAnnotation|snapshotAnnotations/)
})

test('B02: sampling mode ends pointermove before selection/annotation logic', () => {
  const pointermove = canvasHandler('pointermove')
  const guardIndex = pointermove.indexOf('if(colorSampling)')
  assert.ok(guardIndex > 0, 'the sampling guard exists in pointermove')
  assert.ok(
    guardIndex < pointermove.indexOf("if(selectState==='auto')"),
    'the guard precedes the smart-selection branch'
  )
  const guard = pointermove.slice(guardIndex, pointermove.indexOf('return', guardIndex) + 6)
  assert.match(guard, /updateColorSample\(point\)/)
  assert.doesNotMatch(guard, /\bannotations\b|\bselection\b|commitAnnotation|snapshotAnnotations/)
})

test('B02: pointerup, wheel and double-click cannot edit while sampling', () => {
  assert.match(canvasHandler('pointerup'), /\{\s*\/\/[^\n]*\n\s*if\(colorSampling\)return/)
  assert.match(canvasHandler('wheel'), /if\(colorSampling\)return/)
  assert.match(canvasHandler('dblclick'), /if\(colorSampling\)return/)
})

test('B02: the sampling code uses the cached frozen-image ImageData, not a recapture', () => {
  const dataBody = functionBody('colorSampleSourceData')
  assert.match(dataBody, /document\.createElement\('canvas'\)/)
  assert.match(dataBody, /getContext\('2d', \{ willReadFrequently: true \}\)/)
  assert.match(dataBody, /drawImage\(image, 0, 0\)/)
  assert.match(dataBody, /getImageData\(0, 0, width, height\)/)
  assert.match(dataBody, /colorSampleImageData\.width === width/)

  const updateBody = functionBody('updateColorSample')
  assert.match(updateBody, /sourcePointFromClient\(\{/)
  assert.match(updateBody, /formatColorSample\(\{/)
  assert.match(updateBody, /data\.data\[index\]/)
})

test('B02: sampling never mutates annotations, selection or the undo stack', () => {
  for (const name of ['enterColorSampling', 'exitColorSampling', 'updateColorSample', 'copyColorSample']) {
    const body = functionBody(name)
    assert.doesNotMatch(
      body,
      /\bannotations\b|\bselection\b|annotationHistory|snapshotAnnotations|commitAnnotation|undoAnnotations|redoAnnotations/,
      name + ' must keep the edit state untouched'
    )
  }
  // Entering clears the previous sample and switches the cursor to the sampling crosshair.
  const enterBody = functionBody('enterColorSampling')
  assert.match(enterBody, /resetColorSampleDisplay\(\)/)
  assert.match(enterBody, /canvas\.style\.cursor = 'crosshair'/)
  // Exiting returns to the region editor without a new selection.
  assert.match(functionBody('exitColorSampling'), /updateSelectionCursor\(point\)/)
})

test('B02: Enter copies the HEX value and shows the copied status', () => {
  assert.match(
    capture,
    /if\(colorSampling&&event\.key==='Enter'&&!event\.ctrlKey&&!event\.altKey&&!event\.metaKey\)\{event\.preventDefault\(\);copyColorSample\(\);return\}/
  )
  const copyBody = functionBody('copyColorSample')
  assert.match(copyBody, /navigator\.clipboard\.writeText\(colorSampleValue\.hex\)/)
  assert.match(copyBody, /colorSampleCopied\?\.classList\.remove\('hidden'\)/)
  assert.match(captureHtml, /id="colorSampleCopied"[^>]*data-i18n="capture\.color-picker\.copied"/)
})

test('B02: Escape leaves sampling before the shipped result-panel ladder', () => {
  const escapeIndex = capture.indexOf("if(event.key==='Escape')")
  assert.ok(escapeIndex > 0)
  const resultIndex = capture.indexOf("resultPanel.classList.contains('hidden')", escapeIndex)
  const samplingIndex = capture.indexOf('if(colorSampling){exitColorSampling();return;}', escapeIndex)
  assert.ok(samplingIndex > escapeIndex, 'the sampling exit sits inside the Escape handler')
  assert.ok(resultIndex > samplingIndex, 'the sampling exit precedes the result panel')
  assert.match(
    capture.slice(escapeIndex, resultIndex),
    /if\(colorSampling\)\{exitColorSampling\(\);return;\}/
  )
})

test('B02: annotation shortcuts are disabled while the sampling mode is active', () => {
  const keydownStart = capture.indexOf("addEventListener('keydown'")
  assert.ok(keydownStart > 0)
  const samplingGuard = capture.indexOf('if(colorSampling)return', keydownStart)
  const nudge = capture.indexOf('nudgeSelectedAnnotation(event)', keydownStart)
  const enterCopy = capture.indexOf("event.key==='Enter'&&!event.ctrlKey&&!event.altKey&&!event.metaKey", keydownStart)
  assert.ok(samplingGuard > 0, 'the mode guard exists in the keydown handler')
  assert.ok(enterCopy > 0 && samplingGuard > enterCopy, 'Enter copy is handled before the blanket guard')
  assert.ok(nudge > 0 && samplingGuard < nudge, 'nudge and the later shortcuts never run while sampling')
})

test('B02: no new global keyboard or mouse hook is introduced', () => {
  for (const [name, source] of [
    ['capture.js', capture],
    ['color-picker.js', colorPicker],
    ['capture.html', captureHtml]
  ]) {
    assert.doesNotMatch(source, /globalShortcut|uiohook|iohook|robotjs|RegisterHotKey/, name + ' adds no global hook')
  }
  // The pure module has no DOM wiring at all; only the canvas handlers in capture.js call it.
  assert.doesNotMatch(colorPicker, /addEventListener|querySelector|getElementById/)
  assert.match(colorPicker, /typeof module !== 'undefined' && module\.exports/)
  assert.match(colorPicker, /globalScope\.captureColorPicker = api/)
})

test('B02: the long-capture windows do not gain the entry', () => {
  for (const file of ['long-capture/overlay.html', 'long-capture/long-capture.html']) {
    const page = read(file)
    assert.doesNotMatch(page, /colorSampler|colorSampleBadge|color-picker\.js/, file + ' stays untouched')
  }
})

test('B02: all three locale tables define the new keys', () => {
  const keys = [
    'capture.toolbar.color-picker',
    'capture.color-picker.hint',
    'capture.color-picker.hex',
    'capture.color-picker.rgb',
    'capture.color-picker.copied',
    'capture.color-picker.title-section'
  ]
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    const table = localeTables[language]
    assert.ok(table, language + ' table is registered')
    for (const key of keys) {
      assert.equal(typeof table[key], 'string', language + ' defines ' + key)
      assert.ok(table[key].trim().length > 0, language + ' / ' + key + ' is not empty')
    }
    assert.notEqual(table['capture.toolbar.color-picker'], table['capture.toolbar.color'], language + ' names screen colour apart')
    assert.match(table['capture.color-picker.hint'], /Enter/)
    assert.match(table['capture.color-picker.hint'], /Esc/)
  }
})
