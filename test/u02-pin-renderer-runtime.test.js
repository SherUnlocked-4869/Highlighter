'use strict'

// U02 / DEV-02 P2-02 + P2-04 runtime regression: the REAL pin renderer (pin/pin.html +
// pin.css + preload-pin.js) in a hidden Electron window, driven through the production IPC
// surface. `scripts/probe-pin-view-export.js` composes the current view through
// composeViewExport/currentViewExportOcr and reports raw measurements; this test owns the
// thresholds.
//
// Fails on b84eeba:
//   * P2-02 - the long capture scrolls BODY while the export read document.scrollingElement
//     (0), so the composed PNG started at the picture top (red) instead of the scrolled band
//     (green); the real-diff view repeated the same wrong view and reported a huge changed
//     ratio for an identical frame.
//   * P2-04 - no measured OCR layout reached the painter, so a vertical-rl translation
//     exported as one shrunken horizontal line and a wrapped translation lost its wrap
//     points/size.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const electronPath = require('electron')
const probePath = path.join(root, 'scripts', 'probe-pin-view-export.js')
// The browser's line box is larger than the glyph ink (CJK ink height is ~0.75 of the line
// box), and the canvas painter clips ink to the glyph shape, so the exported ink rectangle is
// compared to the live line-box union with a generous tolerance. It still catches the defect
// by a wide margin: the legacy single-line painter was ~110 px short for the vertical block
// and ~35 px short for the wrapped horizontal block.
const INK_TOLERANCE = 12
const LAYOUT_TOLERANCE = 2

function readReport() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const scratch = fs.mkdtempSync(path.join(root, '.tmp', 'pin-view-export-probe-'))
  const resultPath = path.join(scratch, 'report.json')
  const env = {
    ...process.env,
    TMP: scratch,
    TEMP: scratch,
    ELECTRON_ENABLE_LOGGING: '0',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    PIN_VIEW_EXPORT_PROBE_SCRATCH: scratch
  }
  // ELECTRON_RUN_AS_NODE turns electron.exe into plain node (see AGENTS.md); the probe
  // needs a real Chromium renderer.
  delete env.ELECTRON_RUN_AS_NODE
  const runProbe = (extraArgs) => spawnSync(electronPath, [...extraArgs, probePath, '--out', resultPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 170000,
    windowsHide: true
  })
  // Keep the Chromium sandbox where it works; this host's sandbox cannot start, so the
  // first child dies immediately and the retry passes --no-sandbox (which must precede the
  // script path). A real failure writes a report and is not retried blindly.
  const attempts = [runProbe([])]
  if (attempts[0].status !== 0 && !fs.existsSync(resultPath)) attempts.push(runProbe(['--no-sandbox']))
  const result = attempts[attempts.length - 1]
  const report = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
  try {
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    // A lingering Electron file handle must not fail the run.
  }
  const failure = `pin view-export probe failed (attempt exits: ${attempts.map((attempt) => attempt.status).join(', ')}).
stdout:
${result.stdout}
${result.stderr ? `stderr:
${result.stderr}` : ''}
report:
${report ? JSON.stringify(report, null, 2) : 'no report written'}`
  assert.equal(result.status, 0, failure)
  assert.ok(report, failure)
  assert.equal(report.ok, true, failure)
  return report
}

function assertColour(sample, expected, message) {
  const [r, g, b] = sample.rgba
  const tolerance = 24
  assert.ok(
    Math.abs(r - expected[0]) <= tolerance && Math.abs(g - expected[1]) <= tolerance && Math.abs(b - expected[2]) <= tolerance,
    `${message}: expected rgb(${expected.join(',')}) got rgba(${sample.rgba.join(',')}) at (${sample.x}, ${sample.y})`
  )
}

function unionRects(rects) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return rects.length ? { x: left, y: top, width: right - left, height: bottom - top } : null
}

function assertRectClose(actual, expected, tolerance, message) {
  assert.ok(actual, `${message}: missing rectangle`)
  assert.ok(expected, `${message}: missing expected rectangle`)
  const keys = [
    ['x', 'left'],
    ['y', 'top'],
    ['width', 'width'],
    ['height', 'height']
  ]
  for (const [actualKey] of keys) {
    const delta = Math.abs(actual[actualKey] - expected[actualKey])
    assert.ok(delta <= tolerance, `${message}: ${actualKey} ${actual[actualKey]} != ${expected[actualKey]} (delta ${delta} > ${tolerance})`)
  }
}

// The glyph boxes of one measured layout line, in window CSS px (the fixture image is drawn
// at (0, 0) at 1:1 in the OCR phase, so surface-local + chip centre = viewport).
function layoutLineBounds(block, line) {
  // layout centreX/centreY are surface-local; the white fixture image starts at (0, 0).
  const originX = block.layout.centerX
  const originY = block.layout.centerY
  const chipCenterX = block.chip.x + block.chip.width / 2
  const chipCenterY = block.chip.y + block.chip.height / 2
  assert.ok(Math.abs(originX - chipCenterX) < 0.51, `layout centre x ${originX} matches the chip ${chipCenterX}`)
  assert.ok(Math.abs(originY - chipCenterY) < 0.51, `layout centre y ${originY} matches the chip ${chipCenterY}`)
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const glyph of line.glyphs || []) {
    left = Math.min(left, glyph.x - glyph.width / 2)
    top = Math.min(top, glyph.y - glyph.height / 2)
    right = Math.max(right, glyph.x + glyph.width / 2)
    bottom = Math.max(bottom, glyph.y + glyph.height / 2)
  }
  assert.ok(Number.isFinite(left), 'measured line has glyph boxes')
  return { x: originX + left, y: originY + top, width: right - left, height: bottom - top }
}

function assertOcrPhase(phase, expectations) {
  assert.equal(phase.exported.ok, true, `OCR view export failed: ${JSON.stringify(phase.exported)}`)
  assert.equal(phase.facts.layoutAvailable, true, 'the renderer measured the live overlay layout (P2-04)')
  assert.equal(phase.facts.blocks.length, expectations.length)
  assert.equal(phase.analysis.chips.length, expectations.length)
  let lineCursor = 0
  for (let blockIndex = 0; blockIndex < expectations.length; blockIndex += 1) {
    const expected = expectations[blockIndex]
    const block = phase.facts.blocks[blockIndex]
    const chip = block.chip
    const chipInk = phase.analysis.chips[blockIndex]
    const domLines = block.lines
    const lineInk = phase.analysis.lines.slice(lineCursor, lineCursor + domLines.length)
    lineCursor += domLines.length
    assert.ok(block.layout, `block ${blockIndex} has a measured layout entry`)
    assert.equal(block.layout.lines.length, domLines.length,
      `block ${blockIndex}: measured lines (${block.layout.lines.length}) equal the visible DOM line/column boxes (${domLines.length})`)
    if (expected.lines !== undefined) assert.equal(domLines.length, expected.lines, `block ${blockIndex}: visible line/column count`)
    // Every visible DOM line box is covered by measured glyph boxes...
    for (let lineIndex = 0; lineIndex < domLines.length; lineIndex += 1) {
      const bounds = layoutLineBounds(block, block.layout.lines[lineIndex])
      assertRectClose(bounds, domLines[lineIndex], LAYOUT_TOLERANCE,
        `block ${blockIndex} line ${lineIndex}: measured glyph bounds match the live DOM line box`)
      // ...and the export paints ink inside it.
      assert.ok(lineInk[lineIndex] && lineInk[lineIndex].count > 0,
        `block ${blockIndex} line ${lineIndex}: the export paints this line (P2-04)`)
    }
    // The exported ink rectangle matches what the live overlay shows.
    if (expected.ink === 'none') {
      assert.equal(chipInk.count, 0, `block ${blockIndex}: a fully clipped block stays empty in the export`)
    } else {
      assert.ok(chipInk.count > 100, `block ${blockIndex}: the exported text is really painted (${chipInk.count} px)`)
      assertRectClose(chipInk.bounds, unionRects(domLines), INK_TOLERANCE,
        `block ${blockIndex}: exported text bounds match the visible overlay bounds`)
    }
    if (expected.vertical) {
      assert.equal(block.layout.vertical, true)
      if (block.layout.lines.length > 1) {
        const columns = block.layout.lines.map((line) => (line.glyphs && line.glyphs.length ? line.glyphs[0].x : 0))
        for (let index = 1; index < columns.length; index += 1) {
          assert.ok(columns[index - 1] > columns[index],
            `block ${blockIndex}: vertical-rl columns are read right to left (${columns.join(', ')})`)
        }
      }
    } else if (block.layout.lines.length > 1) {
      const rows = block.layout.lines.map((line) => (line.glyphs && line.glyphs.length ? line.glyphs[0].y : 0))
      for (let index = 1; index < rows.length; index += 1) {
        assert.ok(rows[index - 1] < rows[index], `block ${blockIndex}: wrapped lines are read top to bottom (${rows.join(', ')})`)
      }
    }
  }
}

test('pin renderer runtime: visible-rect export, real-diff parity and measured OCR layout', { timeout: 180000 }, () => {
  const report = readReport()

  // ---- P2-02: long capture scrolled to 600 CSS px -------------------------------------
  const long = report.phases.longCapture
  assert.ok(long, 'the probe reported the long-capture phase')
  assert.equal(long.scroll.scrollingElementTag, 'HTML')
  assert.equal(long.scroll.scrollingElementScrollTop, 0, 'document.scrollingElement is the unmoving HTML element (the trap)')
  assert.ok(Math.abs(long.scroll.bodyScrollTop - 600) <= 1, `BODY is the real scroller (${long.scroll.bodyScrollTop})`)
  assert.ok(long.scroll.imageTop <= -599, `the visible picture rectangle starts 600px above the viewport (${long.scroll.imageTop})`)
  assert.equal(long.export600.ok, true, `the scrolled view export failed: ${JSON.stringify(long.export600)}`)
  assert.equal(long.export600.width, Math.round(long.scroll.innerWidth * long.scroll.devicePixelRatio))
  assert.equal(long.export600.height, Math.round(long.scroll.innerHeight * long.scroll.devicePixelRatio))
  // First and last visible rows of the scrolled viewport sample the picture's GREEN band. On
  // b84eeba the export read scrollTop 0 and these were RED (the picture top).
  for (const sample of long.export600.samples) assertColour(sample, [0, 255, 0], 'scrolled export must show the scrolled band')
  assert.equal(long.export0.ok, true)
  for (const sample of long.export0.samples) assertColour(sample, [255, 0, 0], 'un-scrolled export must show the picture top')

  // ---- P2-02: the real-diff view composes the same visible rectangle ------------------
  const realDiff = report.phases.realDiff
  assert.ok(realDiff && realDiff.badge, 'the probe reported the real-diff phase')
  assert.equal(realDiff.badge.overlayHidden, false, 'the diff overlay is shown')
  assert.equal(realDiff.badge.text, realDiff.expectedNoChange,
    'an identical frame must report no difference: the diff view composed the same scrolled viewport')
  assert.notEqual(realDiff.expectedNoChange, realDiff.changed)

  // ---- P2-04: OCR layout parity ------------------------------------------------------
  // Source OCR: the vertical block's oversized line-height pushes its single column outside
  // the chip (the live overlay shows no glyph pixels), so the export must stay empty there;
  // the horizontal block must keep its one line.
  assertOcrPhase(report.phases.ocrSource, [
    { lines: 0, ink: 'none', vertical: true },
    { lines: 1, ink: 'present', vertical: false }
  ])
  // Translated OCR: vertical-rl wraps into right-to-left columns, the narrow translation
  // wraps into two centred lines; both are painted at the DOM's positions and size.
  const translated = report.phases.ocrTranslated
  assertOcrPhase(translated, [
    { lines: 3, ink: 'present', vertical: true },
    { lines: 2, ink: 'present', vertical: false }
  ])
  // Sanity: the vertical-rl block really is a multi-column layout, not one line per block.
  assert.ok(translated.facts.blocks[0].layout.lines.length >= 2)
  assert.ok(translated.facts.blocks[1].layout.lines.length >= 2)

  // ---- P2-02: vertical-rl glyph orientation parity (the re-review's `I` defect) ----------
  // The real pin window (shown inactive off-screen so the frame is live) and the exported view
  // to PNG are compared per measured glyph box: bounds, centre and pixel-mask IoU. The defect
  // was a 90° difference: the screen showed the sideways `I` (21.6x2.4 CSS px at 125%) while the
  // PNG painted it upright (2.4x21.6).
  const vertical = report.phases.verticalText
  assert.ok(vertical, 'the probe reported the vertical-glyph phase')
  const cases = new Map(vertical.cases.map((entry) => [entry.id, entry]))
  const centreDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const assertGlyphParity = (id, expectations) => {
    const entry = cases.get(id)
    assert.ok(entry, `vertical case ${id} exists`)
    assert.equal(entry.exported.ok, true, `${id}: view export failed: ${JSON.stringify(entry.exported)}`)
    assert.equal(entry.facts.vertical, true, `${id}: the chip is a vertical-rl block`)
    assert.equal(entry.analysis.screenSize.width, entry.analysis.exportSize.width, `${id}: screen and export are the same physical width`)
    assert.ok(Math.abs(entry.analysis.screenSize.height - entry.analysis.exportSize.height) <= 2)
    assert.deepEqual(entry.analysis.glyphs.map((glyph) => glyph.text), expectations.map((item) => item.text))
    assert.deepEqual(entry.analysis.glyphs.map((glyph) => glyph.sideways), expectations.map((item) => item.sideways),
      `${id}: measured orientation flags`)
    for (let index = 0; index < expectations.length; index += 1) {
      const expected = expectations[index]
      const glyph = entry.analysis.glyphs[index]
      const screen = glyph.box.screen.bounds
      const exported = glyph.box.exported.bounds
      assert.ok(glyph.box.screen.count > 0 && glyph.box.exported.count > 0, `${id} [${glyph.text}]: both images show this glyph`)
      assert.ok(screen && exported, `${id} [${glyph.text}]: ink bounds exist`)
      assert.ok(centreDistance(glyph.box.screen.centroid, glyph.box.exported.centroid) <= (expected.centreTolerance || 3),
        `${id} [${glyph.text}]: ink centre moved ${centreDistance(glyph.box.screen.centroid, glyph.box.exported.centroid)} px`)
      // Same orientation means the exported ink covers the same axis-aligned extent as the live
      // rendering. A 90° error swaps width and height, which this tolerance catches. Sideways
      // glyphs get the tighter tolerance: for an upright error their width and height swap by
      // more than 2 CSS px. Upright CJK keeps the looser tolerance because Chromium's DOM text
      // rasterisation and the canvas painter differ by up to ~3 CSS px on complex glyphs.
      const dimensionTolerance = expected.dimensionTolerance || 4
      assert.ok(Math.abs(exported.width - screen.width) <= dimensionTolerance,
        `${id} [${glyph.text}]: exported ink width ${exported.width} vs screen ${screen.width}`)
      assert.ok(Math.abs(exported.height - screen.height) <= dimensionTolerance,
        `${id} [${glyph.text}]: exported ink height ${exported.height} vs screen ${screen.height}`)
      if (expected.iou !== undefined) {
        assert.ok(glyph.box.iou >= expected.iou, `${id} [${glyph.text}]: ink overlap ${glyph.box.iou} < ${expected.iou}`)
      }
    }
  }
  // Single Latin `I`: the browser sets it sideways, so BOTH images must show a wide, flat bar.
  assertGlyphParity('latin-i', [{ text: 'I', sideways: true, iou: 0.5, dimensionTolerance: 2 }])
  const latinCase = cases.get('latin-i')
  const latinScreen = latinCase.analysis.glyphs[0].box.screen.bounds
  const latinExport = latinCase.analysis.glyphs[0].box.exported.bounds
  assert.ok(latinScreen.width > latinScreen.height * 3,
    `screen I is sideways: ${latinScreen.width}x${latinScreen.height}`)
  assert.ok(latinExport.width > latinExport.height * 3,
    `exported I keeps the sideways orientation: ${latinExport.width}x${latinExport.height} (the defect was 2.4x21.6)`)
  assert.ok(Math.abs(latinExport.width - 21.6) <= 2 && Math.abs(latinExport.height - 3.2) <= 2,
    `exported I ink is ${latinExport.width}x${latinExport.height} CSS px (expected ~21.6x2.4-3.2 at 125%)`)
  // Mixed Chinese/English: only the Latin `A` is sideways; CJK stays upright with its glyph.
  assertGlyphParity('mixed-zh-en', [
    { text: '中', sideways: false },
    { text: 'A', sideways: true, iou: 0.5, dimensionTolerance: 2 },
    { text: '文', sideways: false }
  ])
  // Pure CJK: every glyph upright, same column order (top to bottom), same measured x centre.
  assertGlyphParity('cjk', [
    { text: '中', sideways: false },
    { text: '文', sideways: false },
    { text: '竖', sideways: false },
    { text: '排', sideways: false }
  ])
  const cjkGlyphs = cases.get('cjk').analysis.glyphs
  for (let index = 1; index < cjkGlyphs.length; index += 1) {
    assert.ok(cjkGlyphs[index - 1].box.screen.centroid.y < cjkGlyphs[index].box.screen.centroid.y,
      'CJK columns read top to bottom on screen')
    assert.ok(cjkGlyphs[index - 1].box.exported.centroid.y < cjkGlyphs[index].box.exported.centroid.y,
      'CJK columns read top to bottom in the export')
    assert.ok(Math.abs(cjkGlyphs[index - 1].box.exported.centroid.x - cjkGlyphs[index].box.exported.centroid.x) <= 2,
      'CJK glyphs stay in one column')
  }
  // ZWJ emoji: the browser cannot join it vertically and stacks the parts, and the export must
  // reproduce that stack (ink height ~67 CSS px, not one collapsed square run). It stays upright.
  assertGlyphParity('emoji', [{
    text: '👩‍💻',
    sideways: false,
    iou: 0.5,
    centreTolerance: 3,
    dimensionTolerance: 3
  }])
  const emojiExport = cases.get('emoji').analysis.glyphs[0].box.exported.bounds
  assert.ok(emojiExport.height > emojiExport.width * 1.8,
    `the exported ZWJ emoji keeps the vertical stack: ${emojiExport.width}x${emojiExport.height}`)
})

// ---------------------------------------------------------------------------
// P2-06/P2-07 runtime regression: grapheme-cluster shaping and the measurement
// attempt budget on the REAL pin renderer. The probe below is embedded here (and
// written to scratch at run time) because scripts/probe-pin-view-export.js is
// outside this change's write scope; it loads pin/pin.html + pin.css + preload-pin.js
// in a hidden Electron window and drives the production IPC surface.
// ---------------------------------------------------------------------------

const RUNTIME_PROBE_SOURCE = [
  "'use strict'",
  "",
  "// P2-06/P2-07 runtime probe. It is embedded in the node:test file and written to a",
  "// throwaway scratch file because scripts/probe-pin-view-export.js is outside this",
  "// change's write scope; it loads the REAL pin window and drives the production IPC.",
  "",
  "const { app, ipcMain, BrowserWindow } = require('electron')",
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const zlib = require('node:zlib')",
  "",
  "const ROOT = process.env.PIN_VIEW_EXPORT_PROBE_ROOT || process.cwd()",
  "const readArgument = (name, fallback) => {",
  "  const index = process.argv.indexOf(name)",
  "  return index === -1 ? fallback : process.argv[index + 1]",
  "}",
  "const OUTPUT_PATH = path.resolve(ROOT, readArgument('--out', path.join('.tmp-probe', 'pin-grapheme.json')))",
  "const SCRATCH = process.env.PIN_VIEW_EXPORT_PROBE_SCRATCH || path.join(ROOT, '.tmp-probe', 'scratch')",
  "fs.mkdirSync(SCRATCH, { recursive: true })",
  "fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })",
  "app.setPath('userData', path.join(SCRATCH, 'user-data'))",
  "",
  "const report = { ok: false, phases: {} }",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))",
  "",
  "function crc32(buffer) {",
  "  let crc = 0xffffffff",
  "  for (const byte of buffer) {",
  "    crc ^= byte",
  "    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))",
  "  }",
  "  return (crc ^ 0xffffffff) >>> 0",
  "}",
  "function pngChunk(type, data) {",
  "  const length = Buffer.alloc(4)",
  "  length.writeUInt32BE(data.length, 0)",
  "  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])",
  "  const crc = Buffer.alloc(4)",
  "  crc.writeUInt32BE(crc32(body), 0)",
  "  return Buffer.concat([length, body, crc])",
  "}",
  "function makePng(width, height, pixelAt) {",
  "  const stride = width * 4 + 1",
  "  const raw = Buffer.alloc(stride * height)",
  "  for (let y = 0; y < height; y += 1) {",
  "    raw[y * stride] = 0",
  "    for (let x = 0; x < width; x += 1) {",
  "      const colour = pixelAt(x, y)",
  "      const offset = y * stride + 1 + x * 4",
  "      raw[offset] = colour[0]",
  "      raw[offset + 1] = colour[1]",
  "      raw[offset + 2] = colour[2]",
  "      raw[offset + 3] = 255",
  "    }",
  "  }",
  "  const header = Buffer.alloc(13)",
  "  header.writeUInt32BE(width, 0)",
  "  header.writeUInt32BE(height, 4)",
  "  header[8] = 8",
  "  header[9] = 6",
  "  return Buffer.concat([",
  "    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),",
  "    pngChunk('IHDR', header),",
  "    pngChunk('IDAT', zlib.deflateSync(raw)),",
  "    pngChunk('IEND', Buffer.alloc(0))",
  "  ])",
  "}",
  "const WHITE = makePng(400, 6000, () => [255, 255, 255])",
  "",
  "// The real pin window needs these production channels; the probe answers view-export",
  "// requests itself instead of running the main-process pin domain.",
  "const envelopes = []",
  "ipcMain.on('pin:ready', () => {})",
  "ipcMain.on('pin:render-ready', () => {})",
  "ipcMain.on('pin:context-menu', (_event, _imageBounds, command) => {",
  "  if (command && command.type === 'view-export-result') envelopes.push(command)",
  "})",
  "",
  "function toBuffer(value) {",
  "  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))",
  "  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)",
  "  return Buffer.from(value || [])",
  "}",
  "",
  "async function waitFor(win, expression, timeoutMs = 8000) {",
  "  const started = Date.now()",
  "  while (Date.now() - started < timeoutMs) {",
  "    const value = await win.webContents.executeJavaScript(expression)",
  "    if (value) return value",
  "    await sleep(50)",
  "  }",
  "  throw new Error('timeout waiting for ' + expression.slice(0, 120))",
  "}",
  "",
  "async function requestViewExport(win, requestId) {",
  "  win.webContents.send('pin:view-export-request', { requestId })",
  "  const started = Date.now()",
  "  while (Date.now() - started < 20000) {",
  "    const found = envelopes.find((entry) => entry.requestId === requestId)",
  "    if (found) return found",
  "    await sleep(25)",
  "  }",
  "  throw new Error('timeout waiting for view export ' + requestId)",
  "}",
  "",
  "// Page-side facts: chip rects, DOM Range line boxes, grapheme clusters and the visible",
  "// prefix a budget-limited block must export.",
  "function OCR_FACTS_SOURCE() {",
  "  const overlay = document.getElementById('pinOcrOverlay')",
  "  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })",
  "  const inside = (box, chip) => !(box.right <= chip.left || box.left >= chip.right || box.bottom <= chip.top || box.top >= chip.bottom)",
  "  const blocks = []",
  "  for (const element of overlay.children) {",
  "    const raw = element.getBoundingClientRect()",
  "    const chip = { left: raw.left, top: raw.top, right: raw.right, bottom: raw.bottom, width: raw.width, height: raw.height }",
  "    const text = String(element.textContent || '')",
  "    let graphemeCount = 0",
  "    for (const _part of segmenter.segment(text)) graphemeCount += 1",
  "    const textNode = element.firstChild",
  "    const graphemes = []",
  "    if (textNode && textNode.nodeType === 3) {",
  "      let measured = 0",
  "      for (const part of segmenter.segment(text)) {",
  "        if (measured >= 64) break",
  "        measured += 1",
  "        const range = document.createRange()",
  "        range.setStart(textNode, part.index)",
  "        range.setEnd(textNode, part.index + part.segment.length)",
  "        const rects = range.getClientRects()",
  "        const box = rects.length ? rects[0] : null",
  "        if (!box || !(box.width > 0) || !(box.height > 0)) {",
  "          graphemes.push({ text: part.segment, visible: false, x: 0, y: 0, width: 0, height: 0 })",
  "          continue",
  "        }",
  "        graphemes.push({ text: part.segment, visible: inside(box, chip), x: box.left, y: box.top, width: box.width, height: box.height })",
  "      }",
  "    }",
  "    let visiblePrefix = ''",
  "    let left = Infinity",
  "    let top = Infinity",
  "    let right = -Infinity",
  "    let bottom = -Infinity",
  "    for (const grapheme of graphemes) {",
  "      if (!grapheme.visible) break",
  "      visiblePrefix += grapheme.text",
  "      left = Math.min(left, grapheme.x)",
  "      top = Math.min(top, grapheme.y)",
  "      right = Math.max(right, grapheme.x + grapheme.width)",
  "      bottom = Math.max(bottom, grapheme.y + grapheme.height)",
  "    }",
  "    const range = document.createRange()",
  "    range.selectNodeContents(element)",
  "    const lines = []",
  "    for (const rect of range.getClientRects()) {",
  "      if (!(rect.width > 0) || !(rect.height > 0)) continue",
  "      if (!inside(rect, chip)) continue",
  "      lines.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })",
  "    }",
  "    blocks.push({",
  "      blockIndex: Number(element.dataset.blockIndex),",
  "      text: text.length > 256 ? text.slice(0, 256) : text,",
  "      textLength: text.length,",
  "      graphemeCount,",
  "      chip: { x: chip.left, y: chip.top, width: chip.width, height: chip.height },",
  "      lines,",
  "      graphemes,",
  "      visiblePrefix,",
  "      visibleBounds: right > left ? { x: left, y: top, width: right - left, height: bottom - top } : null",
  "    })",
  "  }",
  "  return { dpr: devicePixelRatio, innerWidth, innerHeight, blocks }",
  "}",
  "",
  "function ANALYSE_SOURCE(payload) {",
  "  return new Promise((resolve, reject) => {",
  "    const image = new Image()",
  "    image.onload = () => {",
  "      try {",
  "        const canvas = document.createElement('canvas')",
  "        canvas.width = image.naturalWidth",
  "        canvas.height = image.naturalHeight",
  "        const context = canvas.getContext('2d')",
  "        context.drawImage(image, 0, 0)",
  "        const data = context.getImageData(0, 0, canvas.width, canvas.height).data",
  "        const scale = payload.dpr || 1",
  "        // Non-white ink: dark text AND the coloured emoji glyphs count, unlike the",
  "        // dark-only heuristic the P2-04 probe used.",
  "        const inkAt = (x, y) => {",
  "          const offset = (y * canvas.width + x) * 4",
  "          if (offset < 0 || offset + 3 >= data.length) return false",
  "          if (data[offset + 3] < 128) return false",
  "          return data[offset] < 245 || data[offset + 1] < 245 || data[offset + 2] < 245",
  "        }",
  "        const rectangle = (css) => {",
  "          const left = Math.max(0, Math.floor(css.x * scale))",
  "          const top = Math.max(0, Math.floor(css.y * scale))",
  "          const right = Math.min(canvas.width, Math.ceil((css.x + css.width) * scale))",
  "          const bottom = Math.min(canvas.height, Math.ceil((css.y + css.height) * scale))",
  "          let count = 0",
  "          let minX = Infinity",
  "          let minY = Infinity",
  "          let maxX = -1",
  "          let maxY = -1",
  "          for (let y = top; y < bottom; y += 1) {",
  "            for (let x = left; x < right; x += 1) {",
  "              if (!inkAt(x, y)) continue",
  "              count += 1",
  "              if (x < minX) minX = x",
  "              if (y < minY) minY = y",
  "              if (x > maxX) maxX = x",
  "              if (y > maxY) maxY = y",
  "            }",
  "          }",
  "          return count === 0",
  "            ? { count: 0, bounds: null }",
  "            : { count, bounds: { x: minX / scale, y: minY / scale, width: (maxX - minX + 1) / scale, height: (maxY - minY + 1) / scale } }",
  "        }",
  "        resolve({ width: canvas.width, height: canvas.height, chips: payload.chips.map(rectangle) })",
  "      } catch (error) {",
  "        reject(error)",
  "      }",
  "    }",
  "    image.onerror = () => reject(new Error('composed png decode failed'))",
  "    image.src = 'data:image/png;base64,' + payload.base64",
  "  })",
  "}",
  "",
  "// Page-side instrumentation: record the production painter's fillText calls and plan, and",
  "// count Range.getClientRects() calls only while the production measureLayout runs.",
  "function INSTRUMENT_SOURCE() {",
  "  const state = { fillTexts: [], plan: null, measured: null, rangeReads: 0, measuring: false }",
  "  window.__runtimeProbe = state",
  "  const contextPrototype = CanvasRenderingContext2D.prototype",
  "  const originalFillText = contextPrototype.fillText",
  "  contextPrototype.fillText = function (text, x, y) {",
  "    state.fillTexts.push({ text: String(text), x, y })",
  "    return originalFillText.apply(this, arguments)",
  "  }",
  "  const originalPlan = window.pinViewExport.planViewExport",
  "  window.pinViewExport.planViewExport = function (input) {",
  "    const plan = originalPlan.call(this, input)",
  "    state.plan = plan",
  "    return plan",
  "  }",
  "  const originalMeasure = window.OcrTextOverlay.measureLayout",
  "  window.OcrTextOverlay.measureLayout = function (host) {",
  "    state.rangeReads = 0",
  "    state.measured = originalMeasure.call(this, host)",
  "    return state.measured",
  "  }",
  "  const originalGetClientRects = Range.prototype.getClientRects",
  "  Range.prototype.getClientRects = function () {",
  "    if (state.measuring) state.rangeReads += 1",
  "    return originalGetClientRects.apply(this, arguments)",
  "  }",
  "  window.__beginExport = () => { state.fillTexts = []; state.plan = null; state.measured = null; state.rangeReads = 0; state.measuring = true }",
  "  window.__endExport = () => { state.measuring = false; return { fillTexts: state.fillTexts, plan: state.plan, measured: state.measured, rangeReads: state.rangeReads } }",
  "}",
  "",
  "const GRAPHEME_TEXTS = [",
  "  '测试👩‍💻',",
  "  'cafe' + String.fromCharCode(0x301) + ' 组合音标',",
  "  'مرحبا بالعالم',",
  "  '竖排👩‍💻文字'",
  "]",
  "const GRAPHEME_BLOCKS = [",
  "  { text: GRAPHEME_TEXTS[0], text_score: 0.9, box_points: [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 60 }, { x: 20, y: 60 }] },",
  "  { text: GRAPHEME_TEXTS[1], text_score: 0.9, box_points: [{ x: 20, y: 80 }, { x: 180, y: 80 }, { x: 180, y: 120 }, { x: 20, y: 120 }] },",
  "  { text: GRAPHEME_TEXTS[2], text_score: 0.9, box_points: [{ x: 20, y: 140 }, { x: 220, y: 140 }, { x: 220, y: 180 }, { x: 20, y: 180 }] },",
  "  { text: GRAPHEME_TEXTS[3], text_score: 0.9, box_points: [{ x: 300, y: 20 }, { x: 340, y: 20 }, { x: 340, y: 200 }, { x: 300, y: 200 }] }",
  "]",
  "",
  "const BUDGET_BLOCK_COUNT = 6",
  "const BUDGET_TEXT = '可'.repeat(3000)",
  "const BUDGET_BLOCKS = []",
  "for (let index = 0; index < BUDGET_BLOCK_COUNT; index += 1) {",
  "  const top = 20 + index * 38",
  "  BUDGET_BLOCKS.push({",
  "    text: BUDGET_TEXT,",
  "    text_score: 0.9,",
  "    box_points: [{ x: 20, y: top }, { x: 70, y: top }, { x: 70, y: top + 18 }, { x: 20, y: top + 18 }]",
  "  })",
  "}",
  "",
  "async function runOcrPhase(win, requestId, payload) {",
  "  win.webContents.send('pin:recognition', payload)",
  "  const expected = payload.result.textBlocks.length",
  "  await waitFor(win, 'document.getElementById(\"pinOcrOverlay\").childElementCount === ' + expected, 8000)",
  "  await sleep(200)",
  "  const facts = await win.webContents.executeJavaScript('(' + OCR_FACTS_SOURCE.toString() + ')()')",
  "  await win.webContents.executeJavaScript('window.__beginExport()')",
  "  const exported = await requestViewExport(win, requestId)",
  "  const runtime = await win.webContents.executeJavaScript('window.__endExport()')",
  "  let analysis = null",
  "  if (exported.ok) {",
  "    analysis = await win.webContents.executeJavaScript('(' + ANALYSE_SOURCE.toString() + ')(' + JSON.stringify({",
  "      base64: toBuffer(exported.png).toString('base64'),",
  "      dpr: facts.dpr,",
  "      chips: facts.blocks.map((block) => block.chip)",
  "    }) + ')')",
  "  }",
  "  return {",
  "    facts,",
  "    exported: exported.ok ? { ok: true, width: exported.width, height: exported.height } : { ok: false, code: exported.code },",
  "    runtime,",
  "    analysis",
  "  }",
  "}",
  "",
  "app.whenReady().then(async () => {",
  "  try {",
  "    const win = new BrowserWindow({",
  "      width: 400,",
  "      height: 420,",
  "      useContentSize: true,",
  "      show: false,",
  "      frame: false,",
  "      transparent: true,",
  "      backgroundColor: '#00000000',",
  "      webPreferences: {",
  "        preload: path.join(ROOT, 'preload-pin.js'),",
  "        contextIsolation: true,",
  "        nodeIntegration: false",
  "      }",
  "    })",
  "    await win.loadFile(path.join(ROOT, 'pin', 'pin.html'))",
  "    await waitFor(win, 'typeof window.applyPinData === \"function\" && !!window.pinViewExport && !!window.OcrTextOverlay && !!document.getElementById(\"pinOcrOverlay\")', 12000)",
  "    await win.webContents.executeJavaScript('(' + INSTRUMENT_SOURCE.toString() + ')()')",
  "    win.webContents.send('pin:init', { imageBuffer: WHITE, imageMime: 'image/png', longCapture: false, rotation: 0, opacity: 1, zoom: 1 })",
  "    await waitFor(win, '(() => { const surface = document.getElementById(\"pixelImage\"); return !!surface && !surface.classList.contains(\"hidden\") && surface.width === 400 })()', 12000)",
  "    await win.webContents.executeJavaScript('document.body.scrollTop = 0; document.scrollingElement.scrollTop = 0')",
  "    await sleep(200)",
  "    report.phases.graphemes = await runOcrPhase(win, 'req-grapheme', {",
  "      action: 'translate',",
  "      phase: 'result',",
  "      result: {",
  "        imageWidth: 400,",
  "        imageHeight: 6000,",
  "        text: GRAPHEME_TEXTS.join('\\n'),",
  "        textBlocks: GRAPHEME_BLOCKS",
  "      }",
  "    })",
  "    report.phases.budget = await runOcrPhase(win, 'req-budget', {",
  "      action: 'ocr',",
  "      phase: 'result',",
  "      result: {",
  "        imageWidth: 400,",
  "        imageHeight: 6000,",
  "        text: BUDGET_BLOCKS.map((block) => block.text).join('\\n'),",
  "        textBlocks: BUDGET_BLOCKS",
  "      }",
  "    })",
  "    win.destroy()",
  "    report.ok = true",
  "  } catch (error) {",
  "    report.error = String(error && error.stack ? error.stack : error)",
  "  }",
  "  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2))",
  "  app.exit(report.ok ? 0 : 1)",
  "}, (error) => {",
  "  report.error = String(error)",
  "  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2))",
  "  app.exit(1)",
  "})"
].join("\n")

function readGraphemeReport() {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true })
  const scratch = fs.mkdtempSync(path.join(root, '.tmp', 'pin-grapheme-probe-'))
  const scriptPath = path.join(scratch, 'probe.js')
  const resultPath = path.join(scratch, 'report.json')
  fs.writeFileSync(scriptPath, RUNTIME_PROBE_SOURCE)
  const env = {
    ...process.env,
    TMP: scratch,
    TEMP: scratch,
    ELECTRON_ENABLE_LOGGING: '0',
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    PIN_VIEW_EXPORT_PROBE_SCRATCH: scratch,
    // The probe can be pointed at a scratch copy of the checkout (the same escape hatch
    // scripts/probe-pin-view-export.js exposes) to demonstrate the regression on an older
    // revision; a normal run always loads this checkout.
    PIN_VIEW_EXPORT_PROBE_ROOT: process.env.PIN_VIEW_EXPORT_PROBE_ROOT || root
  }
  // ELECTRON_RUN_AS_NODE turns electron.exe into plain node (see AGENTS.md); the probe
  // needs a real Chromium renderer.
  delete env.ELECTRON_RUN_AS_NODE
  const runProbe = (extraArgs) => spawnSync(electronPath, [...extraArgs, scriptPath, '--out', resultPath], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 200000,
    windowsHide: true
  })
  // This host's Chromium sandbox cannot start; the retry passes --no-sandbox, which must
  // precede the script path. A real failure writes a report and is not retried blindly.
  const attempts = [runProbe([])]
  if (attempts[0].status !== 0 && !fs.existsSync(resultPath)) attempts.push(runProbe(['--no-sandbox']))
  const result = attempts[attempts.length - 1]
  const report = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null
  try {
    fs.rmSync(scratch, { recursive: true, force: true })
  } catch {
    // A lingering Electron file handle must not fail the run.
  }
  const failure = `pin grapheme/budget probe failed (attempt exits: ${attempts.map((attempt) => attempt.status).join(', ')}).
stdout:
${result.stdout}
${result.stderr ? `stderr:
${result.stderr}` : ''}
report:
${report ? JSON.stringify(report, null, 2) : 'no report written'}`
  assert.equal(result.status, 0, failure)
  assert.ok(report, failure)
  assert.equal(report.ok, true, failure)
  return report
}

// P2-02: a vertical upright ZWJ sequence the browser stacks (measured advance > 1.5 em) is
// painted as one fillText per part, not one per cluster; every other vertical glyph is one call.
function verticalDrawTexts(block) {
  const texts = []
  for (const line of Array.isArray(block.lines) ? block.lines : []) {
    for (const glyph of Array.isArray(line.glyphs) ? line.glyphs : []) {
      const text = typeof glyph?.text === 'string' ? glyph.text : ''
      const height = Number(glyph?.height) || 0
      const size = Number(block.fontSize) || 0
      const parts = text.indexOf('\u200d') !== -1 && size > 0 && height > size * 1.5
        ? text.split('\u200d').filter((part) => part.length > 0)
        : null
      if (parts && parts.length > 1) texts.push(...parts)
      else if (text) texts.push(text)
    }
  }
  return texts
}

// The recorded fillText calls are grouped in plan order: a measured horizontal block draws
// one call per line, a vertical block one call per (possibly split) glyph, and the legacy
// fallback one call.
function splitFillTexts(runtime) {
  const groups = []
  let cursor = 0
  for (const block of runtime.plan.ocrBlocks) {
    let expected = 1
    if (block.measured === true) {
      const lines = Array.isArray(block.lines) ? block.lines : []
      expected = block.vertical === true
        ? verticalDrawTexts(block).length
        : lines.length
    }
    groups.push(runtime.fillTexts.slice(cursor, cursor + expected))
    cursor += expected
  }
  return { groups, extra: runtime.fillTexts.length - cursor }
}

test('pin renderer runtime: grapheme shaping and a bounded measurement-attempt budget (P2-06/P2-07)', { timeout: 240000 }, () => {
  const report = readGraphemeReport()

  // ---- P2-06: grapheme clusters round-trip from the live overlay to the exported canvas
  const graphemes = report.phases.graphemes
  assert.ok(graphemes, 'the probe reported the grapheme phase')
  assert.equal(graphemes.exported.ok, true, `grapheme export failed: ${JSON.stringify(graphemes.exported)}`)
  const facts = graphemes.facts
  assert.equal(facts.blocks.length, 4)
  const measured = graphemes.runtime.measured
  const plan = graphemes.runtime.plan
  assert.ok(Array.isArray(measured) && measured.length === 4, 'the production export measured the live overlay')
  assert.ok(plan && plan.ok === true && plan.ocrBlocks.length === 4, 'the production composer planned the grapheme blocks')
  for (let index = 0; index < 4; index += 1) {
    assert.equal(measured[index].attempts, facts.blocks[index].graphemeCount, `block ${index}: one attempt per grapheme cluster`)
    assert.equal(measured[index].complete, true, `block ${index}: fully measured`)
    assert.equal(measured[index].lines.map((line) => line.text).join(''), facts.blocks[index].text, `block ${index}: layout keeps the whole line text`)
  }
  assert.equal(measured[0].lines.length, 1, 'the ZWJ sample is one shaped line, not one glyph per code point')
  assert.deepEqual(Array.from(measured[0].lines[0].glyphs, (glyph) => glyph.text), ['测', '试', '👩‍💻'])
  assert.equal(measured[0].lines[0].text, '测试👩‍💻')
  const expectedCombining = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(facts.blocks[1].text), (part) => part.segment)
  assert.deepEqual(measured[1].lines.reduce((all, line) => all.concat(Array.from(line.glyphs, (glyph) => glyph.text)), []), expectedCombining)
  assert.equal(measured[2].lines[0].text, 'مرحبا بالعالم')

  // Every horizontal measured line is ONE shaped fillText carrying the whole line.
  const groups = splitFillTexts(graphemes.runtime)
  assert.equal(groups.extra, 0, 'every recorded text draw belongs to a planned chip')
  for (let index = 0; index < 3; index += 1) {
    const block = plan.ocrBlocks[index]
    assert.equal(block.measured, true)
    assert.equal(block.vertical, false)
    assert.equal(groups.groups[index].length, block.lines.length, `block ${index}: exactly one fillText per measured line`)
    assert.deepEqual(groups.groups[index].map((call) => call.text), block.lines.map((line) => line.text), `block ${index}: each fillText carries the whole shaped line`)
  }

  // Vertical keeps right-to-left columns and paints one complete grapheme per draw.
  assert.equal(measured[3].vertical, true)
  assert.equal(plan.ocrBlocks[3].vertical, true)
  for (let index = 1; index < measured[3].lines.length; index += 1) {
    assert.ok(measured[3].lines[index - 1].glyphs[0].x > measured[3].lines[index].glyphs[0].x, 'vertical columns run right to left')
  }
  // P2-02: an upright ZWJ emoji sequence the browser stacked vertically is painted part by part
  // (the same slots); every non-ZWJ grapheme stays ONE complete fillText.
  const verticalDraws = verticalDrawTexts(plan.ocrBlocks[3])
  assert.deepEqual(groups.groups[3].map((call) => call.text), verticalDraws, 'vertical paints each measured grapheme / stacked part exactly once')
  assert.equal(verticalDraws.join(''), facts.blocks[3].text.replace(/\u200d/g, ''), 'the stacked parts cover the whole cluster text')
  const verticalGraphemes = plan.ocrBlocks[3].lines.reduce((all, line) => all.concat(Array.from(line.glyphs, (glyph) => glyph.text)), [])
  assert.equal(verticalGraphemes.join(''), facts.blocks[3].text, 'the measured clusters keep the ZWJ sequence whole')
  assert.ok(verticalDraws.length > verticalGraphemes.length, 'the ZWJ cluster is the one split into stacked parts')

  // The exported ink lands where the live overlay shows the glyphs.
  for (let index = 0; index < 3; index += 1) {
    const ink = graphemes.analysis.chips[index]
    assert.ok(ink.count > 100, `block ${index}: the grapheme text is painted (${ink.count} px)`)
    assertRectClose(ink.bounds, facts.blocks[index].visibleBounds, 16, `block ${index}: exported ink matches the visible overlay glyphs`)
    assert.equal(facts.blocks[index].visiblePrefix, facts.blocks[index].text, `block ${index}: the whole sample is visible`)
  }
  assert.ok(graphemes.analysis.chips[3].count > 100, 'the vertical grapheme text is painted')

  // ---- P2-07: the attempt budgets bound the synchronous DOM reads
  const budget = report.phases.budget
  assert.ok(budget, 'the probe reported the budget phase')
  assert.equal(budget.exported.ok, true, `budget export failed: ${JSON.stringify(budget.exported)}`)
  const budgetFacts = budget.facts
  const budgetMeasured = budget.runtime.measured
  const budgetPlan = budget.runtime.plan
  assert.equal(budgetFacts.blocks.length, 6)
  assert.ok(Array.isArray(budgetMeasured) && budgetMeasured.length === 6, 'the production export measured the clipped corpus')
  assert.ok(budget.runtime.rangeReads <= 4096, `global DOM reads stay inside the attempt budget (${budget.runtime.rangeReads})`)
  const totalAttempts = budgetMeasured.reduce((sum, layout) => sum + layout.attempts, 0)
  assert.equal(budget.runtime.rangeReads, totalAttempts, 'every synchronous layout read is an accounted measurement attempt')
  for (let index = 0; index < budgetMeasured.length; index += 1) {
    const layout = budgetMeasured[index]
    assert.ok(layout.attempts <= 512, `block ${index}: per-block attempt cap (${layout.attempts})`)
    assert.equal(layout.complete, false, `block ${index}: the 3000-character block is explicitly incomplete`)
    assert.equal(layout.lines.length, 1, `block ${index}: only the visible line is retained`)
  }
  assert.ok(budgetPlan && budgetPlan.ok === true)
  assert.equal(budgetPlan.ocrBlocks.length, 6)
  const budgetGroups = splitFillTexts(budget.runtime)
  assert.equal(budgetGroups.extra, 0, 'every recorded text draw belongs to a planned chip')
  for (let index = 0; index < budgetMeasured.length; index += 1) {
    const fact = budgetFacts.blocks[index]
    assert.equal(budgetPlan.ocrBlocks[index].measured, true)
    assert.equal(budgetGroups.groups[index].length, 1, `block ${index}: one shaped line draw`)
    assert.equal(budgetGroups.groups[index][0].text, fact.visiblePrefix, `block ${index}: the visible prefix is exported`)
    assert.deepEqual(Array.from(budgetMeasured[index].lines[0].glyphs, (glyph) => glyph.text).join(''), fact.visiblePrefix)
    assert.ok(fact.visiblePrefix.length > 0 && fact.visiblePrefix.length < fact.textLength, `block ${index}: the sample is really clipped (${fact.visiblePrefix.length}/${fact.textLength})`)
  }
  const firstInk = budget.analysis.chips[0]
  assert.ok(firstInk.count > 50, 'the budget-limited block paints its visible text')
  assertRectClose(firstInk.bounds, budgetFacts.blocks[0].visibleBounds, 16, 'the exported ink matches the visible prefix')
})
