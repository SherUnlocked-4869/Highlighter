'use strict'

// Behaviour tests for the R5 demo-look/zoom/ripple pure module
// (docs/plans/2026-11-03-recording-r5-contracts.md §3.1/§3.4). No ffmpeg here: the real-render
// frame assertions live in test/recording-export.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const demo = require('../shared/recording-demo')
const exportOptions = require('../shared/recording-export-options')

test('the frozen R5 constants are exported', () => {
  assert.deepEqual({ ...demo.DEMO_DEFAULTS }, {
    enabled: false,
    background: '#0f1115',
    padding: 0.08,
    radius: 12,
    shadow: true,
    ripples: false
  })
  assert.deepEqual({ ...demo.STYLE_LIMITS }, { paddingMin: 0, paddingMax: 0.2, radiusMin: 0, radiusMax: 24 })
  assert.deepEqual({ ...demo.ZOOM_LIMITS }, { maxSegments: 8, minDurationMs: 600, scaleMin: 1.25, scaleMax: 3, rampMs: 300 })
  assert.deepEqual({ ...demo.RIPPLE_LIMITS }, { maxClicks: 30, durationMs: 600, basePx: 28, growPx: 96 })
  assert.deepEqual([...demo.BACKGROUND_PRESETS], ['#0f1115', '#1e1e1e', '#f5f2ea', '#0a2540'])
})

test('normalizeDemoStyle coerces every field into its documented range', () => {
  assert.deepEqual(demo.normalizeDemoStyle(null), {
    enabled: false, background: '#0f1115', padding: 0.08, radius: 12, shadow: true, ripples: false
  })
  const style = demo.normalizeDemoStyle({
    enabled: true,
    background: '#ABC',
    padding: 9,
    radius: 99,
    shadow: 'yes',
    ripples: true,
    extra: 'dropped'
  })
  assert.equal(style.enabled, true)
  assert.equal(style.background, '#aabbcc', '#rgb expands to #rrggbb')
  assert.equal(style.padding, 0.2)
  assert.equal(style.radius, 24)
  assert.equal(style.shadow, false, 'non-boolean shadow falls back to false')
  assert.equal(style.ripples, true)
  assert.equal('extra' in style, false)
  // Unknown background keeps the default instead of persisting junk.
  assert.equal(demo.normalizeDemoStyle({ background: 'url(http://x)' }).background, '#0f1115')
})

test('normalizeZoomSegments sorts, clamps and enforces the 1-20 / >=600ms rules', () => {
  const normalized = demo.normalizeZoomSegments([
    { id: 'b', startMs: 2000, endMs: 3200, scale: 9, focusX: 2, focusY: -1, easing: 'nope' },
    { startMs: 0, endMs: 500, scale: 2 }, // too short -> dropped
    { startMs: 0, endMs: 900, scale: 1.1 }, // clamped into 1.25..3
    'junk'
  ])
  assert.deepEqual(normalized.map((zoom) => zoom.id), ['zoom-1', 'b'])
  assert.deepEqual(normalized[0], {
    id: 'zoom-1', startMs: 0, endMs: 900, scale: 1.25, focusX: 0.5, focusY: 0.5, easing: 'ease-in-out'
  })
  assert.equal(normalized[1].scale, 3)
  assert.equal(normalized[1].focusX, 1)
  assert.equal(normalized[1].focusY, 0)
  assert.equal(normalized[1].easing, 'ease-in-out')
  // Overlapping later segments are dropped; the first one wins.
  const overlap = demo.normalizeZoomSegments([
    { startMs: 0, endMs: 1000, scale: 2 },
    { startMs: 500, endMs: 1600, scale: 2 },
    { startMs: 1600, endMs: 2400, scale: 2 }
  ])
  assert.deepEqual(overlap.map((zoom) => [zoom.startMs, zoom.endMs]), [[0, 1000], [1600, 2400]])
  // Max 8 segments.
  const many = Array.from({ length: 12 }, (_value, index) => ({ startMs: index * 1000, endMs: index * 1000 + 800, scale: 2 }))
  assert.equal(demo.normalizeZoomSegments(many).length, 8)
})

test('normalizeClickTrack bounds and cleans events.json v1', () => {
  const track = demo.normalizeClickTrack({
    durationMs: 5000,
    sampledAtHz: 20,
    pointer: [
      { tMs: 1000, x: 0.5, y: 0.5 },
      { tMs: 1000, x: 0.5, y: 0.5 }, // duplicate coordinate
      { tMs: 2000, x: 1.4, y: -1 }, // clamped
      { tMs: 9000, x: 0.1, y: 0.1 }, // beyond duration -> dropped
      { tMs: -5, x: 0.1, y: 0.1 }
    ],
    clicks: [
      { tMs: 1500, x: 0.4, y: 0.4, button: 0 },
      { tMs: 1600, x: 0.4, y: 0.4, button: 5 }, // invalid button
      { tMs: 1700, x: 0.4, y: 0.4, button: 2 }
    ],
    truncated: false
  })
  assert.equal(track.durationMs, 5000)
  assert.equal(track.sampledAtHz, 20)
  assert.deepEqual(track.pointer, [
    { tMs: 1000, x: 0.5, y: 0.5 },
    { tMs: 2000, x: 1, y: 0 }
  ])
  assert.deepEqual(track.clicks, [
    { tMs: 1500, x: 0.4, y: 0.4, button: 0 },
    { tMs: 1700, x: 0.4, y: 0.4, button: 2 }
  ])
  assert.equal(track.truncated, false)
  assert.deepEqual(demo.normalizeClickTrack(null).pointer, [])
  // The pointer cap keeps the newest 20000 samples and reports truncation.
  const big = { durationMs: 1000000, pointer: Array.from({ length: 20010 }, (_v, i) => ({ tMs: i * 10, x: 0.5, y: 0.5 + (i % 2) * 0.01 })) }
  const bounded = demo.normalizeClickTrack(big)
  assert.equal(bounded.pointer.length, 20000)
  assert.equal(bounded.truncated, true)
})

test('mapDemoToOutput removes deleted gaps, truncates zooms and drops deleted-gap clicks', () => {
  const segments = [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }]
  const mapped = demo.mapDemoToOutput({
    style: { enabled: true, padding: 0.1 },
    // Spans the deleted 1000..2000 gap: two kept pieces that become adjacent in the output.
    zooms: [{ startMs: 500, endMs: 2500, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'linear' }],
    clicks: [
      { tMs: 500, x: 0.1, y: 0.2, button: 0 }, // kept -> output 500
      { tMs: 1500, x: 0.2, y: 0.2, button: 0 }, // deleted gap -> dropped
      { tMs: 2500, x: 0.3, y: 0.2, button: 0 } // kept -> output 1500
    ]
  }, segments)
  assert.equal(mapped.style.enabled, true)
  assert.equal(mapped.style.padding, 0.1)
  // A zoom span crossing the cut stays one continuous output zoom [500,1500].
  assert.deepEqual(mapped.zooms, [
    { startMs: 500, endMs: 1500, scale: 2, focusX: 0.4, focusY: 0.6, easing: 'linear' }
  ])
  assert.deepEqual(mapped.clicks, [
    { tMs: 500, x: 0.1, y: 0.2, button: 0 },
    { tMs: 1500, x: 0.3, y: 0.2, button: 0 }
  ])
  // Everything deleted -> empty plan (the UI disables export in that state).
  assert.deepEqual(demo.mapDemoToOutput({ zooms: [{ startMs: 0, endMs: 2000, scale: 2 }], clicks: [{ tMs: 100, x: 0, y: 0 }] }, []), {
    style: demo.normalizeDemoStyle(undefined), zooms: [], clicks: []
  })
})

test('resolveDemoCanvas matches R4 content dimensions and expands by padding', () => {
  const style = { enabled: true, padding: 0.1, radius: 16, shadow: true, background: '#f5f2ea' }
  const canvas = demo.resolveDemoCanvas({ sourceWidth: 1920, sourceHeight: 1080, resolution: 'source', style })
  assert.deepEqual(canvas, {
    contentWidth: 1920,
    contentHeight: 1080,
    canvasWidth: 2400,
    canvasHeight: 1350,
    paddingPx: 240,
    radiusPx: 24
  })
  // The content dims are exactly the R4 resolution result for every preset.
  for (const resolution of ['source', '1080p', '720p', '480p']) {
    for (const size of [{ w: 1920, h: 1080 }, { w: 1280, h: 720 }, { w: 640, h: 360 }]) {
      const resolved = demo.resolveDemoCanvas({ sourceWidth: size.w, sourceHeight: size.h, resolution, style: { enabled: false } })
      const expected = exportOptions.computeVideoOutput({ sourceWidth: size.w, sourceHeight: size.h, resolution }).value
      assert.deepEqual([resolved.contentWidth, resolved.contentHeight], [expected.width, expected.height], `${resolution} ${size.w}x${size.h}`)
    }
  }
  // Disabled / padding 0 / preset larger than the source: the canvas is never upscaled.
  assert.deepEqual(
    demo.resolveDemoCanvas({ sourceWidth: 1280, sourceHeight: 720, resolution: 'source', style: { enabled: false } }),
    { contentWidth: 1280, contentHeight: 720, canvasWidth: 1280, canvasHeight: 720, paddingPx: 0, radiusPx: 0 }
  )
  assert.deepEqual(
    demo.resolveDemoCanvas({ sourceWidth: 640, sourceHeight: 360, resolution: '720p', style: { enabled: true, padding: 0 } }),
    { contentWidth: 640, contentHeight: 360, canvasWidth: 640, canvasHeight: 360, paddingPx: 0, radiusPx: 6 }
  )
  assert.equal(demo.resolveDemoCanvas({ sourceWidth: 0, sourceHeight: 0, resolution: 'source', style }).code, 'invalid-source-size')
  // Even dimensions.
  const odd = demo.resolveDemoCanvas({ sourceWidth: 1281, sourceHeight: 721, resolution: 'source', style: { enabled: true, padding: 0.2, radius: 10 } })
  assert.equal(odd.canvasWidth % 2, 0)
  assert.equal(odd.canvasHeight % 2, 0)
  assert.equal(odd.contentWidth % 2, 0)
})

test('zoomExpression builds a piecewise ramp expression and matches the preview evaluator', () => {
  const zooms = [{ startMs: 1000, endMs: 2600, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }]
  const expression = demo.zoomExpression({ zooms, fps: 30, contentWidth: 1280, contentHeight: 720 })
  assert.match(expression.z, /on\/30/)
  assert.match(expression.z, /if\(lt\(/)
  assert.match(expression.z, /clip|min\(1,max\(0/)
  assert.match(expression.x, /clip\(0\.5\*iw-\(iw\/zoom\/2\),0,iw-iw\/zoom\)/)
  assert.match(expression.y, /clip\(0\.5\*ih-\(ih\/zoom\/2\),0,ih-ih\/zoom\)/)
  // An empty plan is the pass-through (no zoompan filter work).
  assert.deepEqual(demo.zoomExpression({ zooms: [], fps: 30, contentWidth: 1280, contentHeight: 720 }), { z: '1', x: '0', y: '0' })
  // The preview evaluator mirrors the 300 ms ramps: 1 at the edges, full scale while held.
  const outputZooms = [{ startMs: 1000, endMs: 2600, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }]
  assert.equal(demo.evaluateZoomAt(outputZooms, 500).scale, 1)
  assert.equal(demo.evaluateZoomAt(outputZooms, 1000).scale, 1)
  assert.equal(demo.evaluateZoomAt(outputZooms, 1150).scale, 1.5)
  assert.equal(demo.evaluateZoomAt(outputZooms, 1800).scale, 2)
  assert.equal(demo.evaluateZoomAt(outputZooms, 2450).scale, 1.5)
  assert.equal(demo.evaluateZoomAt(outputZooms, 2600).scale, 1)
  const inactive = demo.evaluateZoomAt(outputZooms, 0)
  assert.equal(inactive.active, false)
  assert.equal(inactive.scale, 1)
  // 600 ms minimum segment: ramp-in and ramp-out meet exactly in the middle.
  const short = [{ startMs: 0, endMs: 600, scale: 2, focusX: 0.5, focusY: 0.5, easing: 'linear' }]
  assert.equal(demo.evaluateZoomAt(short, 300).scale, 2)
  assert.match(demo.zoomExpression({ zooms: short, fps: 30 }).z, /0\.300000/)
})

test('suggestZoomSegments clusters clicks and dwell runs deterministically', () => {
  const durationMs = 10000
  const clickTrack = {
    durationMs,
    pointer: [],
    clicks: [
      { tMs: 1000, x: 0.20, y: 0.20 },
      { tMs: 1600, x: 0.22, y: 0.22 },
      { tMs: 2100, x: 0.24, y: 0.24 },
      { tMs: 8000, x: 0.80, y: 0.80 } // single click -> no cluster
    ]
  }
  const first = demo.suggestZoomSegments({ track: clickTrack, durationMs })
  const second = demo.suggestZoomSegments({ track: clickTrack, durationMs })
  assert.deepEqual(first, second, 'pure and deterministic')
  assert.equal(first.length, 1)
  assert.equal(first[0].reason, 'clicks')
  assert.equal(first[0].startMs, 200)
  assert.equal(first[0].endMs, 3300)
  assert.equal(first[0].scale, 2)
  assert.ok(Math.abs(first[0].focusX - 0.22) <= 0.01)

  const dwellTrack = {
    durationMs,
    clicks: [],
    pointer: Array.from({ length: 30 }, (_value, index) => ({ tMs: index * 100, x: 0.4 + (index % 2) * 0.001, y: 0.6 }))
  }
  const dwell = demo.suggestZoomSegments({ track: dwellTrack, durationMs })
  assert.equal(dwell.length, 1)
  assert.equal(dwell[0].reason, 'dwell')
  assert.equal(dwell[0].scale, 1.6)

  // Suggestions are clipped to the kept source ranges when provided.
  const clipped = demo.suggestZoomSegments({
    track: clickTrack,
    durationMs,
    outputSegments: [{ startMs: 0, endMs: 1200 }, { startMs: 2500, endMs: 4000 }]
  })
  // The cluster [200,3300] is split by the deleted 1200..2500 gap into two kept suggestions.
  assert.equal(clipped.length, 2)
  assert.deepEqual(clipped.map((suggestion) => [suggestion.startMs, suggestion.endMs]), [[200, 1200], [2500, 3300]])
  // No event track -> no suggestions.
  assert.deepEqual(demo.suggestZoomSegments({ track: null, durationMs }), [])
})

test('the module loads as a classic browser script and exposes the UI surface', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'recording-demo.js'), 'utf8')
  const sandbox = { globalThis: null }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox)
  const browser = sandbox.recordingDemo
  assert.equal(typeof browser, 'object')
  for (const name of ['normalizeDemoStyle', 'normalizeZoomSegments', 'normalizeClickTrack', 'mapDemoToOutput',
    'resolveDemoCanvas', 'suggestZoomSegments', 'zoomExpression', 'evaluateZoomAt']) {
    assert.equal(typeof browser[name], 'function', name)
  }
  assert.deepEqual({ ...browser.DEMO_DEFAULTS }, { ...demo.DEMO_DEFAULTS })
  assert.equal(browser.zoomExpression({ zooms: [], fps: 30 }).z, '1')
})
