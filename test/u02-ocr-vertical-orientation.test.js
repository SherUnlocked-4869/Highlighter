'use strict'

// P2-02 (re-review): vertical-rl glyph orientation.
//
// The re-review found that the measured painter drew every vertical-rl grapheme upright, so a
// Latin letter — which the browser lays out SIDEWAYS in `text-orientation: mixed` — exported
// rotated 90° from the screen (single `I`: screen ink 21.6x2.4 CSS px at 125%, PNG 2.4x21.6).
//
// The renderer measures the live overlay DOM (shared/ocr-text-overlay.js) and now records, per
// grapheme, whether the browser set it sideways (`sideways`). The decision is the Unicode
// Vertical_Orientation property (UAX #50): characters from vertical scripts stay upright, the
// horizontal-script default is Rotated. This file pins the classifier itself (loaded from the
// production UMD in a VM) and the source contracts that carry the flag to the painter. The real
// Electron rendering/export parity is covered by test/u02-pin-renderer-runtime.test.js phase D.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

// shared/ocr-text-overlay.js is a browser IIFE that only needs `window` to publish its API; the
// DOM/measurement helpers are not called by the classifier. Running it in a VM keeps the test
// free of an Electron renderer for the pure property checks.
function loadOverlayApi() {
  const sandbox = { window: {}, console }
  sandbox.globalThis = sandbox
  vm.runInNewContext(read('shared', 'ocr-text-overlay.js'), sandbox, { filename: 'shared/ocr-text-overlay.js' })
  assert.ok(sandbox.window.OcrTextOverlay, 'the production overlay module publishes its API')
  return sandbox.window.OcrTextOverlay
}

const overlay = loadOverlayApi()

test('P2-02 vertical orientation: horizontal scripts are sideways, vertical scripts stay upright', () => {
  assert.equal(typeof overlay.verticalTextIsSideways, 'function')
  const sideways = (value) => overlay.verticalTextIsSideways(value)
  // The re-review's exact counterexample and the rest of the Latin/digit/punctuation default
  // (Vertical_Orientation default is Rotated).
  for (const text of ['I', 'A', 'i', 'x', '1', '#', '%', '\u2192', '\u2026', '\u2022', '(', '\u201c']) {
    assert.equal(sideways(text), true, `horizontal-script ${JSON.stringify(text)} is sideways`)
  }
  // Vertical scripts are Upright: CJK ideographs, kana, Hangul, CJK punctuation/fullwidth forms,
  // and the upright symbol/emoji ranges.
  for (const text of ['\u4e2d', '\u6587', '\u3042', '\u30a2', '\uac00', '\uff21', '\u3002', '\u3001',
    '\u2460', '\u25b6', '\u2764', '\u00b1', '\u00a9', '\u00d7']) {
    assert.equal(sideways(text), false, `vertical-script ${JSON.stringify(text)} stays upright`)
  }
  // Emoji are Upright in UAX #50; a ZWJ sequence keeps the base's orientation.
  for (const text of ['\u{1F680}', '\u{1F469}', '\u{1F469}\u200d\u{1F4BB}', '\u{1F1E6}\u{1F1E7}']) {
    assert.equal(sideways(text), false, `emoji ${JSON.stringify(text)} stays upright`)
  }
  // A combining/ZWJ cluster is classified by its base character; malformed input fails safely.
  assert.equal(sideways('e\u0301'), true, 'a Latin base plus combining mark is sideways')
  assert.equal(sideways('\u4e2d\ufe0f'), false, 'a CJK base plus variation selector is upright')
  assert.equal(sideways(''), false)
  assert.equal(sideways(null), false)
  assert.equal(sideways(undefined), false)
})

test('P2-02 the measured layout carries the orientation flag and the painter consumes it', () => {
  const overlaySource = read('shared', 'ocr-text-overlay.js')
  // The classifier is consulted once per measured vertical grapheme and serialised both in the
  // internal glyph accumulator and in the per-line payload the export consumes.
  assert.match(overlaySource, /function verticalTextIsSideways\(text\)/)
  assert.match(overlaySource, /sideways: vertical \? verticalTextIsSideways\(cluster\.text\) : false/)
  assert.match(overlaySource, /sideways: glyph\.sideways === true/)
  assert.match(overlaySource, /window\.OcrTextOverlay = \{[\s\S]*?verticalTextIsSideways,/)
  // The table is the UAX #50 upright ranges (default Rotated), bounded, with its provenance in
  // the source instead of an opaque inline blob.
  assert.match(overlaySource, /VERTICAL_UPRIGHT_RANGES/)
  assert.match(overlaySource, /UAX #50/)
  assert.match(overlaySource, /Vertical_Orientation/)
  const table = /const VERTICAL_UPRIGHT_RANGES = \[([\s\S]*?)\n  \]/.exec(overlaySource)
  assert.ok(table, 'the upright range table is present')
  const numbers = table[1].split(',').map((part) => part.trim()).filter(Boolean)
  assert.ok(numbers.length > 0 && numbers.length % 2 === 0, 'upright ranges are start/end pairs')
  assert.ok(numbers.length < 512, `the orientation table stays small (${numbers.length} numbers)`)

  const exportSource = read('pin', 'pin-view-export.js')
  // The plan maps the measured flag onto the export block; the painter rotates exactly those
  // graphemes 90° clockwise around their measured centre and keeps the browser's column/centre.
  assert.match(exportSource, /sideways: glyph\?\.sideways === true/)
  assert.match(exportSource, /if \(glyph\.sideways === true\) \{[\s\S]*?context\.rotate\(Math\.PI \/ 2\)/)
  // P2-02 also keeps a stacked upright ZWJ sequence stacked instead of collapsing it to one run.
  assert.match(exportSource, /function verticalUprightParts\(glyph, fontSize\)/)
  assert.match(exportSource, /context\.fillText\(parts\[index\]/)
})

test('P2-02 the shipped vertical overlay styles still use the mixed/default orientation the classifier models', () => {
  const css = read('pin', 'pin.css')
  // The overlay must keep the default `text-orientation: mixed` (not `upright`): the classifier
  // and the painter reproduce what this rule makes the browser do.
  const verticalRule = /#pinOcrOverlay \.ocr-text-block\.vertical\{([^}]*)\}/.exec(css)
  assert.ok(verticalRule, 'the vertical overlay rule exists')
  assert.match(verticalRule[1], /writing-mode:vertical-rl/)
  assert.doesNotMatch(css, /#pinOcrOverlay[^{]*\{[^}]*text-orientation:upright/)
})
