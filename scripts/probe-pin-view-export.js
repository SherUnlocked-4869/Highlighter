'use strict'

// P2-02 / P2-04 runtime probe: load the REAL pin window (pin/pin.html + pin.css +
// preload-pin.js) in a hidden Electron BrowserWindow, drive it through the production IPC
// surface and measure what the offscreen "export current view" actually composes.
//
//   node_modules/electron/dist/electron.exe --no-sandbox scripts/probe-pin-view-export.js \
//       [--out .tmp-probe/pin-view-export.json]
//
// Evidence produced (all raw numbers in the JSON, the node test owns the thresholds):
//   * phaseA - a long capture scrolled to 600 CSS px. pin.css scrolls BODY
//     (document.scrollingElement is the unmoving HTML element), so the composed PNG must
//     start at the scrolled band (green), never at the picture top (red), and the same
//     code path must compose a red first row after scrolling back to 0.
//   * phaseB - the real-pixel compare (DEV-08) composes its own view through the same
//     measurement: a synthetic frame equal to the scrolled viewport must report "no
//     difference" instead of a large changed ratio.
//   * phaseC - OCR parity: the visible overlay is rendered by the production
//     renderRecognition() path, its DOM line/column boxes are read back with
//     Range.getClientRects(), and the composed PNG ink bounds are compared against them.
//     A vertical-rl translation must export as right-to-left columns, a narrow long
//     translation as multiple wrapped lines. A block the live chip clips away must stay
//     empty in the export (the export paints the visible overlay, not invisible overflow).
//
// The probe never writes user data (its Electron profile/tmp live under the caller's
// scratch dir) and only imports the side-effect-free UMD compositor for a sanity check.

const { app, ipcMain, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// P2-02 (re-review): the re-review's counterexample was measured at 125% Windows scaling
// (devicePixelRatio 1.25). Pinning the scale factor makes the vertical-glyph phase reproduce the
// exact reported ink sizes (21.6x2.4 CSS px for the sideways `I`) instead of depending on the host
// display settings; every phase converts CSS<->device pixels through the page's own dpr.
app.commandLine.appendSwitch('force-device-scale-factor', '1.25')

// PIN_VIEW_EXPORT_PROBE_ROOT lets an evidence run point the same probe at an older checkout
// copy (used to demonstrate the regression failing on b84eeba); normal runs use this repo.
const ROOT = process.env.PIN_VIEW_EXPORT_PROBE_ROOT || path.join(__dirname, '..')
const readArgument = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const OUTPUT_PATH = path.resolve(ROOT, readArgument('--out', path.join('.tmp-probe', 'pin-view-export.json')))
const SCRATCH = process.env.PIN_VIEW_EXPORT_PROBE_SCRATCH || path.join(ROOT, '.tmp-probe', 'scratch')
fs.mkdirSync(SCRATCH, { recursive: true })
fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
app.setPath('userData', path.join(SCRATCH, 'user-data'))

const report = { ok: false, phases: {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- a dependency-free PNG writer for the colour-banded / white fixtures ------------
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}
function makePng(width, height, pixelAt) {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0
    for (let x = 0; x < width; x += 1) {
      const colour = pixelAt(x, y)
      const offset = y * stride + 1 + x * 4
      raw[offset] = colour[0]
      raw[offset + 1] = colour[1]
      raw[offset + 2] = colour[2]
      raw[offset + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
// Top 400 source rows red, 400..1200 green, the rest blue: at the tested scroll offset the
// visible viewport is entirely green, while the picture top is red.
const BAND = makePng(400, 6000, (x, y) => (y < 400 ? [255, 0, 0] : y < 1200 ? [0, 255, 0] : [0, 0, 255]))
const WHITE = makePng(400, 6000, () => [255, 255, 255])
const VERTICAL_TEXT = '这是一段很长的译文需要自动换行显示在窄框里'
const TRANSLATED_BLOCKS = [
  { text: VERTICAL_TEXT, text_score: 0.9, box_points: [{ x: 40, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 160 }, { x: 40, y: 160 }] },
  { text: VERTICAL_TEXT, text_score: 0.9, box_points: [{ x: 120, y: 180 }, { x: 320, y: 180 }, { x: 320, y: 224 }, { x: 120, y: 224 }] }
]
const SOURCE_BLOCKS = [
  // A vertical source block whose oversized line-height pushes the column outside the chip:
  // the live overlay shows no glyph pixels, so the export must not invent any.
  { text: '竖排中文', text_score: 0.9, box_points: [{ x: 40, y: 40 }, { x: 80, y: 40 }, { x: 80, y: 240 }, { x: 40, y: 240 }] },
  { text: '识别文字', text_score: 0.9, box_points: [{ x: 120, y: 40 }, { x: 320, y: 40 }, { x: 320, y: 80 }, { x: 120, y: 80 }] }
]

const envelopes = []
ipcMain.on('pin:ready', () => {})
ipcMain.on('pin:render-ready', () => {})
ipcMain.on('pin:context-menu', (_event, _imageBounds, command) => {
  if (command && command.type === 'view-export-result') envelopes.push(command)
})

function toBuffer(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return Buffer.from(value || [])
}

async function waitFor(win, expression, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await win.webContents.executeJavaScript(expression)
    if (value) return value
    await sleep(50)
  }
  throw new Error('timeout waiting for ' + expression.slice(0, 120))
}

async function requestViewExport(win, requestId) {
  win.webContents.send('pin:view-export-request', { requestId })
  const started = Date.now()
  while (Date.now() - started < 20000) {
    const found = envelopes.find((entry) => entry.requestId === requestId)
    if (found) return found
    await sleep(25)
  }
  throw new Error('timeout waiting for view export ' + requestId)
}

// Decode a composed PNG in the page (the export fixture is PNG we generated ourselves) and
// either sample points or measure the ink over given CSS-px rectangles.
async function analysePng(win, png, spec) {
  const base64 = toBuffer(png).toString('base64')
  return win.webContents.executeJavaScript(`(async () => {
    const image = new Image()
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('composed png decode failed'))
    })
    image.src = 'data:image/png;base64,' + ${JSON.stringify(base64)}
    await loaded
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const scale = ${JSON.stringify(spec.devicePixelRatio || 1)}
    const inkAt = (x, y) => {
      const offset = (y * canvas.width + x) * 4
      if (offset < 0 || offset + 3 >= data.length) return false
      if (data[offset + 3] < 128) return false
      return data[offset] + data[offset + 1] + data[offset + 2] < 420
    }
    const rectangle = (css) => {
      const left = Math.max(0, Math.floor(css.x * scale))
      const top = Math.max(0, Math.floor(css.y * scale))
      const right = Math.min(canvas.width, Math.ceil((css.x + css.width) * scale))
      const bottom = Math.min(canvas.height, Math.ceil((css.y + css.height) * scale))
      let count = 0
      let minX = Infinity
      let minY = Infinity
      let maxX = -1
      let maxY = -1
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          if (!inkAt(x, y)) continue
          count += 1
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
      return count === 0
        ? { count: 0, bounds: null }
        : { count, bounds: { x: minX / scale, y: minY / scale, width: (maxX - minX + 1) / scale, height: (maxY - minY + 1) / scale } }
    }
    const samples = []
    for (const point of ${JSON.stringify(spec.samples || [])}) {
      const x = Math.round(point[0] * scale)
      const y = Math.round(point[1] * scale)
      const offset = (y * canvas.width + x) * 4
      samples.push({ x, y, rgba: [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]] })
    }
    return {
      width: canvas.width,
      height: canvas.height,
      samples,
      chips: ${JSON.stringify(spec.chips || [])}.map(rectangle),
      lines: ${JSON.stringify(spec.lines || [])}.map(rectangle)
    }
  })()`)
}

// Measure the rendered OCR overlay from the page: chip rects, Range line boxes and the
// measured payload the production export path will use.
function OCR_FACTS_SOURCE() {
  const overlay = document.getElementById('pinOcrOverlay')
  const measure = window.OcrTextOverlay && typeof window.OcrTextOverlay.measureLayout === 'function'
    ? window.OcrTextOverlay.measureLayout(overlay)
    : null
  const blocks = []
  for (const element of overlay.children) {
    const chip = element.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element)
    const lines = []
    for (const rect of range.getClientRects()) {
      if (!(rect.width > 0) || !(rect.height > 0)) continue
      // Only what the chip's overflow:hidden actually shows.
      if (rect.right <= chip.left || rect.left >= chip.right || rect.bottom <= chip.top || rect.top >= chip.bottom) continue
      lines.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    }
    const blockIndex = Number(element.dataset.blockIndex)
    blocks.push({
      blockIndex,
      className: element.className,
      text: element.textContent,
      chip: { x: chip.left, y: chip.top, width: chip.width, height: chip.height },
      lines,
      layout: measure ? measure.find((entry) => entry.blockIndex === blockIndex) || null : null
    })
  }
  return { dpr: devicePixelRatio, innerWidth, innerHeight, blocks, layoutAvailable: !!measure }
}

async function runOcrPhase(win, state, payload) {
  win.webContents.send('pin:recognition', payload)
  await waitFor(win, `document.getElementById("pinOcrOverlay").childElementCount === ${payload.result.textBlocks.length}`, 5000)
  await sleep(120)
  const facts = await win.webContents.executeJavaScript(`(${OCR_FACTS_SOURCE.toString()})()`)
  const spec = {
    devicePixelRatio: facts.dpr,
    chips: facts.blocks.map((block) => block.chip),
    lines: facts.blocks.flatMap((block) => block.lines)
  }
  const exported = await requestViewExport(win, state.requestId)
  if (!exported.ok) return { facts, exported: { ok: false, code: exported.code } }
  const analysis = await analysePng(win, exported.png, spec)
  return {
    facts,
    exported: { ok: true, width: exported.width, height: exported.height, pngBytes: toBuffer(exported.png).length },
    analysis
  }
}

// ---------------------------------------------------------------------------------------------
// P2-02 phase D: vertical-rl glyph orientation on the REAL pin renderer.
// ---------------------------------------------------------------------------------------------
const VERTICAL_GLYPH_CASES = [
  // `threshold` is the max RGB sum still counted as ink: dark text only for the text cases, a
  // looser bound for the coloured emoji so its non-white pixels are part of the comparison.
  { id: 'latin-i', text: 'I', threshold: 420 },
  { id: 'mixed-zh-en', text: '中A文', threshold: 420 },
  { id: 'cjk', text: '中文竖排', threshold: 420 },
  { id: 'emoji', text: '👩‍💻', threshold: 700 }
]
const VERTICAL_CHIP = { x: 40, y: 30, width: 40, height: 180 }
function verticalBlock(text) {
  const { x, y, width, height } = VERTICAL_CHIP
  return {
    text,
    text_score: 0.95,
    box_points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
  }
}

// Page-side: chip rect, the measured layout (the same payload the painter consumes) and the
// per-glyph boxes in CHIP-LOCAL CSS px so the node test can read the measured orientation flags.
function VERTICAL_FACTS_SOURCE() {
  const overlay = document.getElementById('pinOcrOverlay')
  const element = overlay.children[0]
  const chip = element.getBoundingClientRect()
  const layout = window.OcrTextOverlay.measureLayout(overlay)
  const metricsCanvas = document.createElement('canvas')
  const metricsContext = metricsCanvas.getContext('2d')
  if (layout[0]) metricsContext.font = `${layout[0].fontSize}px ${layout[0].fontFamily}`
  metricsContext.textAlign = 'center'
  metricsContext.textBaseline = 'middle'
  const glyphs = []
  for (const line of (layout[0] && Array.isArray(layout[0].lines) ? layout[0].lines : [])) {
    for (const glyph of (Array.isArray(line.glyphs) ? line.glyphs : [])) {
      const measured = metricsContext.measureText(glyph.text)
      glyphs.push({
        text: glyph.text,
        sideways: glyph.sideways === true,
        x: glyph.x,
        y: glyph.y,
        width: glyph.width,
        height: glyph.height,
        metrics: {
          ascent: measured.actualBoundingBoxAscent,
          descent: measured.actualBoundingBoxDescent,
          left: measured.actualBoundingBoxLeft,
          right: measured.actualBoundingBoxRight,
          fontAscent: measured.fontBoundingBoxAscent,
          fontDescent: measured.fontBoundingBoxDescent
        }
      })
    }
  }
  return {
    dpr: devicePixelRatio,
    innerWidth,
    innerHeight,
    chip: { x: chip.left, y: chip.top, width: chip.width, height: chip.height },
    vertical: !!(layout[0] && layout[0].vertical === true),
    fontSize: layout[0] ? layout[0].fontSize : 0,
    glyphs
  }
}

// Page-side: decode the live screen capture and the exported PNG, then report per-rect ink for
// both. `ink` is any non-background pixel (dark text AND coloured emoji); the same predicate is
// applied to both images, so IoU compares shape/orientation without depending on one colour.
async function VERTICAL_COMPARE_SOURCE(payload) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('image decode failed'))
    image.src = src
  })
  const screen = await load('data:image/png;base64,' + payload.screenBase64)
  const exported = await load('data:image/png;base64,' + payload.exportBase64)
  const toMask = (image) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const mask = new Uint8Array(canvas.width * canvas.height)
    for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
      if (data[index + 3] >= 128 && data[index] + data[index + 1] + data[index + 2] < payload.threshold) mask[pixel] = 1
    }
    return { mask, width: canvas.width, height: canvas.height }
  }
  const a = toMask(screen)
  const b = toMask(exported)
  const scale = Number(payload.dpr) || 1
  const analyse = (rect) => {
    const width = Math.min(a.width, b.width)
    const height = Math.min(a.height, b.height)
    const left = Math.max(0, Math.floor(rect.x * scale))
    const top = Math.max(0, Math.floor(rect.y * scale))
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * scale))
    const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * scale))
    const stats = () => ({ count: 0, sumX: 0, sumY: 0, minX: Infinity, minY: Infinity, maxX: -1, maxY: -1 })
    const sa = stats()
    const sb = stats()
    let intersection = 0
    let union = 0
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = y * a.width + x
        const inA = a.mask[pixel] === 1
        const inB = b.mask[pixel] === 1
        if (inA) {
          sa.count += 1; sa.sumX += x; sa.sumY += y
          if (x < sa.minX) sa.minX = x
          if (y < sa.minY) sa.minY = y
          if (x > sa.maxX) sa.maxX = x
          if (y > sa.maxY) sa.maxY = y
        }
        if (inB) {
          sb.count += 1; sb.sumX += x; sb.sumY += y
          if (x < sb.minX) sb.minX = x
          if (y < sb.minY) sb.minY = y
          if (x > sb.maxX) sb.maxX = x
          if (y > sb.maxY) sb.maxY = y
        }
        if (inA || inB) union += 1
        if (inA && inB) intersection += 1
      }
    }
    const shape = (entry) => entry.count === 0 ? { count: 0, bounds: null, centroid: null } : {
      count: entry.count,
      bounds: {
        x: entry.minX / scale,
        y: entry.minY / scale,
        width: (entry.maxX - entry.minX + 1) / scale,
        height: (entry.maxY - entry.minY + 1) / scale
      },
      centroid: { x: entry.sumX / entry.count / scale, y: entry.sumY / entry.count / scale }
    }
    return {
      screen: shape(sa),
      exported: shape(sb),
      iou: union === 0 ? 0 : intersection / union
    }
  }
  const glyphs = []
  for (const glyph of payload.glyphs) {
    glyphs.push({
      text: glyph.text,
      sideways: glyph.sideways === true,
      box: analyse({
        x: payload.chip.x + payload.chip.width / 2 + glyph.x - glyph.width / 2,
        y: payload.chip.y + payload.chip.height / 2 + glyph.y - glyph.height / 2,
        width: glyph.width,
        height: glyph.height
      })
    })
  }
  return {
    dpr: scale,
    screenSize: { width: a.width, height: a.height },
    exportSize: { width: b.width, height: b.height },
    chip: analyse(payload.chip),
    glyphs
  }
}

async function runVerticalGlyphPhase(win) {
  const results = []
  const progress = []
  for (const testCase of VERTICAL_GLYPH_CASES) {
    progress.push({ id: testCase.id, stage: 'recognition' })
    win.webContents.send('pin:recognition', {
      action: 'translate',
      phase: 'result',
      result: {
        imageWidth: 400,
        imageHeight: 6000,
        text: testCase.text,
        textBlocks: [verticalBlock(testCase.text)]
      }
    })
    await waitFor(win, `(() => {
      const overlay = document.getElementById('pinOcrOverlay')
      return overlay.childElementCount === 1 && overlay.textContent === ${JSON.stringify(testCase.text)}
    })()`, 6000)
    await sleep(250)
    const facts = await win.webContents.executeJavaScript(`(${VERTICAL_FACTS_SOURCE.toString()})()`)
    progress.push({ id: testCase.id, stage: 'facts', glyphs: facts.glyphs.length })
    // What the window actually renders on screen (device pixels), captured before the export.
    const screenPng = toBuffer((await win.webContents.capturePage()).toPNG())
    progress.push({ id: testCase.id, stage: 'captured', bytes: screenPng.length })
    const exported = await requestViewExport(win, `req-vertical-${testCase.id}`)
    progress.push({ id: testCase.id, stage: 'exported' })
    if (!exported.ok) {
      results.push({ id: testCase.id, facts, exported: { ok: false, code: exported.code } })
      continue
    }
    const analysis = await win.webContents.executeJavaScript(
      `(${VERTICAL_COMPARE_SOURCE.toString()})(${JSON.stringify({
        screenBase64: screenPng.toString('base64'),
        exportBase64: toBuffer(exported.png).toString('base64'),
        dpr: facts.dpr,
        threshold: testCase.threshold,
        chip: facts.chip,
        glyphs: facts.glyphs
      })})`
    )
    results.push({
      id: testCase.id,
      text: testCase.text,
      facts,
      exported: { ok: true, width: exported.width, height: exported.height },
      analysis
    })
  }
  return { cases: results, progress }
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 400,
      height: 420,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(ROOT, 'preload-pin.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden probe window must still paint every recognition update: the vertical-glyph
        // phase compares the LIVE rendering with the export, so background throttling would
        // hand back a stale frame from the previous phase.
        backgroundThrottling: false
      }
    })
    report.console = []
    win.webContents.on('console-message', (_event, level, message, line, source) => {
      report.console.push({ level, message: String(message).slice(0, 500), line, source: String(source || '').slice(0, 200) })
    })
    win.webContents.on('render-process-gone', (_event, details) => { report.renderProcessGone = details })
    await win.loadFile(path.join(ROOT, 'pin', 'pin.html'))
    await waitFor(win, 'typeof window.applyPinData === "function" && !!window.pinViewExport && !!document.getElementById("image")', 10000)
    report.page = await win.webContents.executeJavaScript('({ innerWidth, innerHeight, devicePixelRatio, readyState: document.readyState })')

    // ---- phase A: long capture, scrolled -------------------------------------------------
    win.webContents.send('pin:init', { imageBuffer: BAND, imageMime: 'image/png', longCapture: true, rotation: 0, opacity: 1, zoom: 1 })
    await waitFor(win, '(() => { const image = document.getElementById("image"); return !!image && !image.classList.contains("hidden") && image.complete && image.naturalWidth > 0 })()', 10000)
    await sleep(150)
    const scrollFacts = await win.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('image')
      document.body.scrollTop = 600
      document.scrollingElement.scrollTop = 600
      const rect = image.getBoundingClientRect()
      return {
        innerWidth, innerHeight, devicePixelRatio,
        scrollingElementTag: document.scrollingElement ? document.scrollingElement.tagName : '',
        scrollingElementScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : -1,
        bodyScrollTop: document.body.scrollTop,
        imageTop: rect.top,
        imageLeft: rect.left,
        imageWidth: rect.width,
        imageHeight: rect.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        maxScroll: document.body.scrollHeight - document.body.clientHeight
      }
    })()`)
    const scrolled = await requestViewExport(win, 'req-scroll-600')
    let scrolledPng = null
    if (scrolled.ok) {
      const sampleSpec = { devicePixelRatio: scrollFacts.devicePixelRatio, samples: [[scrollFacts.imageWidth * 0.25, 2], [scrollFacts.imageWidth * 0.5, 2], [scrollFacts.innerWidth * 0.5, scrollFacts.innerHeight - 3]] }
      scrolledPng = await analysePng(win, scrolled.png, sampleSpec)
    }
    await win.webContents.executeJavaScript('document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0')
    await sleep(60)
    const top = await requestViewExport(win, 'req-scroll-0')
    let topPng = null
    if (top.ok) {
      const sampleSpec = { devicePixelRatio: scrollFacts.devicePixelRatio, samples: [[scrollFacts.imageWidth * 0.25, 2], [scrollFacts.imageWidth * 0.5, 2]] }
      topPng = await analysePng(win, top.png, sampleSpec)
    }
    report.phases.longCapture = {
      scroll: scrollFacts,
      export600: scrolled.ok ? { ok: true, width: scrolled.width, height: scrolled.height, samples: scrolledPng.samples } : { ok: false, code: scrolled.code },
      export0: top.ok ? { ok: true, width: top.width, height: top.height, samples: topPng.samples } : { ok: false, code: top.code }
    }

    // ---- phase B: real-pixel compare shares the measurement -----------------------------
    await win.webContents.executeJavaScript('document.body.scrollTop = 600')
    await sleep(60)
    win.webContents.send('pin:onion-mode', { mode: 'real-diff' })
    await sleep(200)
    const frameSpec = await win.webContents.executeJavaScript(`(() => {
      const image = document.getElementById('image')
      const rect = image.getBoundingClientRect()
      return {
        dpr: devicePixelRatio, innerWidth, innerHeight,
        imageWidth: rect.width,
        waiting: window.t('pin.onion.real-diff.waiting'),
        noChange: window.t('pin.onion.real-diff.no-change'),
        changed: window.t('pin.onion.real-diff.changed')
      }
    })()`)
    const captureWidth = Math.round(frameSpec.innerWidth * frameSpec.dpr)
    const captureHeight = Math.round(frameSpec.innerHeight * frameSpec.dpr)
    const framePixels = Buffer.alloc(captureWidth * captureHeight * 4)
    const greenLimit = frameSpec.imageWidth * frameSpec.dpr
    for (let y = 0; y < captureHeight; y += 1) {
      for (let x = 0; x < captureWidth; x += 1) {
        const offset = (y * captureWidth + x) * 4
        framePixels[offset] = 0
        framePixels[offset + 1] = x + 0.5 <= greenLimit ? 255 : 0
        framePixels[offset + 2] = 0
        framePixels[offset + 3] = 255
      }
    }
    win.webContents.send('pin:screen-diff-frame', {
      sequence: 1,
      width: captureWidth,
      height: captureHeight,
      dipRect: { x: 0, y: 0, width: frameSpec.innerWidth, height: frameSpec.innerHeight },
      scaleFactor: 1,
      pixels: framePixels
    })
    const badge = await waitFor(win, `(() => {
      const badge = document.getElementById('pinDiffBadge')
      if (!badge || badge.hidden) return null
      if (badge.textContent === ${JSON.stringify(frameSpec.waiting)}) return null
      return { text: badge.textContent, overlayHidden: document.getElementById('pinDiffOverlay').hidden }
    })()`, 8000)
    report.phases.realDiff = {
      badge,
      expectedNoChange: frameSpec.noChange,
      changed: frameSpec.changed
    }

    // ---- phase C: OCR layout parity (P2-04) ---------------------------------------------
    win.webContents.send('pin:init', { imageBuffer: WHITE, imageMime: 'image/png', longCapture: false, rotation: 0, opacity: 1, zoom: 1 })
    await waitFor(win, '(() => { const surface = document.getElementById("pixelImage"); return !!surface && !surface.classList.contains("hidden") && surface.width === 400 })()', 10000)
    // The long-capture phase scrolled BODY; a normal pin is not scrollable, so put the
    // document back at 0 before measuring OCR (a real non-long pin never has this offset).
    await win.webContents.executeJavaScript('document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0')
    await sleep(150)
    report.phases.ocrSource = await runOcrPhase(win, { requestId: 'req-ocr-source' }, {
      action: 'ocr',
      phase: 'result',
      result: { imageWidth: 400, imageHeight: 6000, text: '竖排中文\n识别文字', textBlocks: SOURCE_BLOCKS }
    })
    report.phases.ocrTranslated = await runOcrPhase(win, { requestId: 'req-ocr-translated' }, {
      action: 'translate',
      phase: 'result',
      result: { imageWidth: 400, imageHeight: 6000, text: VERTICAL_TEXT, textBlocks: TRANSLATED_BLOCKS }
    })

    // ---- phase D: P2-02 vertical-rl glyph orientation --------------------------------
    // The re-review's counterexample: a single Latin `I` in a 40x180 vertical translation chip
    // rendered sideways on screen (ink 21.6x2.4 CSS px) but the export painted it upright
    // (2.4x21.6). For every case the probe compares the LIVE rendering (capturePage of the real
    // pin window) with "export current view" ink, per measured glyph box: bounds, centroid and
    // pixel-mask IoU. The node test owns the thresholds; the raw numbers live in the report.
    // A `show: false` window stops producing new frames after the initial paint, so capturePage()
    // would hand back a stale frame from an earlier phase. The phase compares the LIVE rendering,
    // so the window is shown INACTIVE completely off every display and at zero opacity (some
    // window managers clamp a far-off position back onto a screen) — no visible window, no focus
    // steal — while the samples are taken. capturePage reads the web-contents surface, so the
    // DWM opacity does not affect the pixels it returns.
    win.setPosition(-20000, 0)
    win.setOpacity(0)
    win.showInactive()
    await sleep(500)
    report.phases.verticalText = await runVerticalGlyphPhase(win)
    win.hide()

    win.destroy()
    report.ok = true
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error)
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2))
  app.exit(report.ok ? 0 : 1)
}, (error) => {
  report.error = String(error)
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2))
  app.exit(1)
})
