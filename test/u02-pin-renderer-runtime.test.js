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
})
