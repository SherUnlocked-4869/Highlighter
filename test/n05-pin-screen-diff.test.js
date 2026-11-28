'use strict'

// N05 / DEV-08 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// real-screen pixel diff for the pin onion comparison (adopted 2026-11-28).
//
// The plan's gate was to prove, on the target Windows/DPI host, that the pixels under a pin
// can be captured while EXCLUDING the pin window itself. That evidence is in
// docs/plans/2026-11-28-dev08-screen-diff-measurement.md (probe:
// scripts/probe-pin-screen-diff.js), so the mode is now an explicit user opt-in. These
// tests cover the pure planning/measurement seams, the bounded sampler and the display
// math; the shipped flash mode stays the default and only an explicit menu click starts
// real-pixel sampling.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const diff = require('../pin/pin-screen-diff')
const { createPinDomain } = require('../main/domains/pin')

const DISPLAY_PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
const DISPLAY_SCALED = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.5 }
const DISPLAY_LEFT_NEGATIVE = { id: 3, bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, workArea: { x: -1280, y: 0, width: 1280, height: 984 }, scaleFactor: 1.25 }

// ---------------------------------------------------------------------------
// 1. Capture planning: DIP image box -> display-local physical rectangle.
// ---------------------------------------------------------------------------

test('plan: a 150% display captures the physical pixels under the pin image box', () => {
  const plan = diff.planScreenCapture({
    pinBounds: { x: 2000, y: 100, width: 400, height: 300 },
    imageBounds: { x: 10, y: 20, width: 380, height: 260 },
    displays: [DISPLAY_PRIMARY, DISPLAY_SCALED]
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.display.id, DISPLAY_SCALED.id)
  assert.equal(plan.scaleFactor, 1.5)
  // imageBox = pin origin + renderer image offset = (2010,120,380,260).
  assert.deepEqual(plan.dipRect, { x: 2010, y: 120, width: 380, height: 260 })
  // Display-local physical pixels: (2010-1920)*1.5, 120*1.5.
  assert.deepEqual(plan.physicalRect, { x: 135, y: 180, width: 570, height: 390 })
  assert.deepEqual(plan.thumbnail, { width: 3840, height: 2160 })
  assert.equal(plan.bytes, 570 * 390 * 4)
})

test('plan: negative coordinates and mixed DPI use the same origin subtraction', () => {
  const plan = diff.planScreenCapture({
    pinBounds: { x: -1000, y: 50, width: 200, height: 100 },
    imageBounds: { x: 0, y: 0, width: 200, height: 100 },
    displays: [DISPLAY_PRIMARY, DISPLAY_LEFT_NEGATIVE]
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.display.id, 3)
  assert.deepEqual(plan.physicalRect, { x: 350, y: 63, width: 250, height: 125 })
  // A pin hanging over the display edge is clamped: only visible pixels are captured.
  const hanging = diff.planScreenCapture({
    pinBounds: { x: 1900, y: 1000, width: 400, height: 300 },
    imageBounds: { x: 0, y: 0, width: 400, height: 300 },
    displays: [DISPLAY_PRIMARY]
  })
  assert.equal(hanging.ok, true)
  assert.deepEqual(hanging.dipRect, { x: 1900, y: 1000, width: 20, height: 80 })
  // Entirely outside every display: refuse instead of reading non-existent pixels.
  const outside = diff.planScreenCapture({
    pinBounds: { x: 5000, y: 5000, width: 100, height: 100 },
    imageBounds: { x: 0, y: 0, width: 100, height: 100 },
    displays: [DISPLAY_PRIMARY]
  })
  assert.deepEqual(outside, { ok: false, code: 'OUTSIDE_DISPLAY' })
})

test('plan: rotation is normalised and an oversized capture is refused', () => {
  const plan = diff.planScreenCapture({
    pinBounds: { x: 0, y: 0, width: 300, height: 400 },
    imageBounds: { x: 0, y: 0, width: 300, height: 400 },
    rotation: 450,
    displays: [DISPLAY_PRIMARY]
  })
  assert.equal(plan.rotation, 90)
  assert.equal(diff.normalizeRotation(-90), 270)
  assert.equal(diff.normalizeRotation('x'), 0)
  const huge = diff.planScreenCapture({
    pinBounds: { x: 0, y: 0, width: 4000, height: 3000 },
    imageBounds: { x: 0, y: 0, width: 4000, height: 3000 },
    maxPixels: 100,
    displays: [DISPLAY_PRIMARY]
  })
  assert.equal(huge.ok, false)
  assert.equal(huge.code, 'TOO_MANY_PIXELS')
  assert.deepEqual(diff.planScreenCapture({ pinBounds: null, displays: [] }), { ok: false, code: 'INVALID_PIN_BOUNDS' })
})

test('plan: display lists keep only valid entries and pick by overlap area', () => {
  const displays = diff.normalizeDisplays([
    DISPLAY_PRIMARY,
    { id: 'junk' },
    null,
    { id: 9, bounds: { x: 10, y: 10, width: 0, height: 10 }, scaleFactor: 1 }
  ])
  assert.equal(displays.length, 1)
  assert.equal(diff.pickDisplay(displays, null).id, 1)
  assert.equal(diff.pickDisplay([], { x: 0, y: 0, width: 1, height: 1 }), null)
})

// ---------------------------------------------------------------------------
// 2. RGBA diff and alignment resampling.
// ---------------------------------------------------------------------------

function rgbaFrame(width, height, fill = 0) {
  return new Uint8Array(width * height * 4).fill(fill)
}

test('diff: identical frames report a zero-diff region; one pixel change is located exactly', () => {
  const width = 4
  const height = 2
  const base = rgbaFrame(width, height, 10)
  const same = diff.diffRgba(base, base, { width, height })
  assert.equal(same.ok, true)
  assert.equal(same.different, 0)
  assert.equal(same.ratio, 0)
  assert.equal(same.bounds, null)

  const changed = Uint8Array.from(base)
  const index = (1 * width + 2) * 4
  changed[index] = 200
  const one = diff.diffRgba(base, changed, { width, height })
  assert.equal(one.different, 1)
  assert.deepEqual(one.bounds, { x: 2, y: 1, width: 1, height: 1 })
  assert.equal(one.maxDelta, 190)
  // Below the tolerance the same edit is NOT a difference (anti-aliasing noise).
  const tolerant = diff.diffRgba(base, changed, { width, height, tolerance: 200 })
  assert.equal(tolerant.different, 0)
  // Two changes: the bounds cover both, which is the "changed coordinates" evidence.
  const both = Uint8Array.from(changed)
  both[(0 * width + 0) * 4 + 1] = 250
  const two = diff.diffRgba(base, both, { width, height })
  assert.equal(two.different, 2)
  assert.deepEqual(two.bounds, { x: 0, y: 0, width: 3, height: 2 })
})

test('diff: mismatched frame shapes are refused, never silently compared', () => {
  assert.equal(diff.diffRgba(rgbaFrame(2, 2), rgbaFrame(2, 2), { width: 3, height: 2 }).code, 'INVALID_FRAME')
  assert.equal(diff.diffRgba(rgbaFrame(2, 2), rgbaFrame(2, 2), { width: 0, height: 0 }).code, 'INVALID_SIZE')
})

test('resample: nearest-neighbour mapping is deterministic for alignment grids', () => {
  const source = new Uint8Array([
    10, 10, 10, 255, 20, 20, 20, 255,
    30, 30, 30, 255, 40, 40, 40, 255
  ])
  const scaled = diff.resampleRgba(source, 2, 2, 4, 4)
  assert.equal(scaled.length, 4 * 4 * 4)
  assert.deepEqual([...scaled.slice(0, 4)], [10, 10, 10, 255])
  assert.deepEqual([...scaled.slice(12, 16)], [20, 20, 20, 255])
  assert.deepEqual([...scaled.slice(48, 52)], [30, 30, 30, 255])
  assert.deepEqual([...scaled.slice(60, 64)], [40, 40, 40, 255])
  assert.equal(diff.resampleRgba(null, 1, 1, 2, 2), null)
})

// ---------------------------------------------------------------------------
// 3. Bounded sampler: 1 Hz, one in flight, failure cap, no lasting frame.
// ---------------------------------------------------------------------------

test('sampler: rate limit, single flight, byte budget and failure cap', async () => {
  let now = 1000
  let release = null
  const delivered = []
  const sampler = diff.createDiffSampler({
    now: () => now,
    intervalMs: 1000,
    maxPixels: 4,
    captureFrame: () => new Promise((resolve) => { release = resolve })
  })
  const first = sampler.sample()
  // A second request while the first is in flight is BUSY, not a second capture.
  assert.deepEqual(await sampler.sample(), { ok: false, code: 'BUSY' })
  release({ ok: true, pixels: rgbaFrame(2, 2, 1), width: 2, height: 2 })
  const firstResult = await first
  assert.equal(firstResult.ok, true)
  assert.equal(firstResult.delivered, true)
  assert.equal(sampler.getStats().frames, 1)
  assert.equal(sampler.getStats().maxBytesSeen, 16)
  // Same instant -> rate limited with the wait it needs.
  const limited = await sampler.sample()
  assert.equal(limited.code, 'RATE_LIMITED')
  assert.equal(limited.waitMs, 1000)
  assert.equal(sampler.getStats().skippedRate, 1)
  // One second later the next frame is allowed.
  now += 1000
  release = null
  const second = sampler.sample()
  release({ ok: true, pixels: rgbaFrame(2, 2, 2), width: 2, height: 2 })
  assert.equal((await second).ok, true)
  assert.equal(sampler.getStats().frames, 2)
  // A frame above the pixel budget fails and, after three consecutive failures, stops.
  const budget = diff.createDiffSampler({
    now: () => { now += 2000; return now },
    intervalMs: 1000,
    maxPixels: 1,
    captureFrame: async () => ({ ok: true, pixels: rgbaFrame(2, 2), width: 2, height: 2 })
  })
  assert.equal((await budget.sample()).code, 'FRAME_BUDGET')
  assert.equal((await budget.sample()).code, 'FRAME_BUDGET')
  assert.equal((await budget.sample()).code, 'FRAME_BUDGET')
  assert.equal(budget.getStats().stopped, true)
  assert.equal(budget.getStats().stopCode, 'FAILURE_LIMIT')
  assert.equal((await budget.sample()).code, 'STOPPED')
})

test('sampler: the onFrame callback is the only consumer and can abort delivery', async () => {
  const frames = []
  const sampler = diff.createDiffSampler({
    intervalMs: 250,
    captureFrame: async () => ({ ok: true, pixels: rgbaFrame(1, 1, 9), width: 1, height: 1 }),
    onFrame: (frame) => { frames.push(frame); return false }
  })
  const result = await sampler.sample()
  assert.equal(result.ok, true)
  assert.equal(result.delivered, false)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].bytes, 4)
  assert.equal(sampler.getStats().frames, 1)
})

test('sampler: retryable display/source failures never stop the session and recovery resumes', async () => {
  let now = 1000
  let next = { ok: false, code: 'DISPLAY_UNAVAILABLE', retryable: true }
  const frames = []
  const sampler = diff.createDiffSampler({
    now: () => { const value = now; now += 2000; return value },
    intervalMs: 1000,
    captureFrame: async () => next,
    onFrame: (frame) => { frames.push(frame); return true }
  })
  // The target display is temporarily missing. Eight consecutive samples are all refused
  // (no frame may be delivered from an unconfirmed source) and NONE of them counts against
  // the failure cap: the 1 Hz sampler keeps running instead of stopping permanently.
  for (let index = 0; index < 8; index += 1) {
    const result = await sampler.sample()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DISPLAY_UNAVAILABLE')
    assert.equal(result.retryable, true)
    assert.equal(sampler.getStats().stopped, false)
  }
  const waiting = sampler.getStats()
  assert.equal(waiting.failures, 0)
  assert.equal(waiting.consecutiveFailures, 0)
  assert.equal(waiting.retryableFailures, 8)
  assert.equal(waiting.lastRetryableCode, 'DISPLAY_UNAVAILABLE')
  assert.equal(frames.length, 0, 'no frame may be delivered while the display identity is unconfirmed')
  // The display/source recovers: the very next tick delivers a frame and the session is
  // still the same live one (nothing to restart).
  next = { ok: true, pixels: rgbaFrame(1, 1, 7), width: 1, height: 1 }
  const recovered = await sampler.sample()
  assert.equal(recovered.ok, true)
  assert.equal(recovered.delivered, true)
  assert.equal(frames.length, 1)
  assert.equal(sampler.getStats().frames, 1)
  assert.equal(sampler.getStats().stopped, false)
  // A GENUINE capture error (no retryable flag) still hits the consecutive-failure cap.
  const failing = diff.createDiffSampler({
    now: () => { now += 2000; return now },
    intervalMs: 1000,
    captureFrame: async () => ({ ok: false, code: 'CAPTURE_THREW' })
  })
  await failing.sample()
  await failing.sample()
  await failing.sample()
  assert.equal(failing.getStats().failures, 3)
  assert.equal(failing.getStats().stopped, true)
  assert.equal(failing.getStats().stopCode, 'FAILURE_LIMIT')
})

// P2-03 follow-up: a display can vanish from screen.getAllDisplays() while the pin stays
// visible (unplug, driver reset, RDP transition). The plan then has no display to intersect,
// which is a transient environment state: it must not spend the session's failure budget, and
// the SAME session must resume once the target display is back.
test('product: a transiently missing target display is retryable and the session resumes (P2-03)', async () => {
  const displays = []
  const harness = createScreenDiffHarness({ displays })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', {
    x: 0, y: 0, width: 400, height: 200
  })
  assert.equal(started.ok, true)
  // Let the 1 Hz session timer sample while the target display is missing from the list.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const waiting = started.getStats()
  assert.ok(waiting.retryableFailures >= 3, `the session kept retrying (${waiting.retryableFailures})`)
  assert.equal(waiting.failures, 0, 'transient planning failures never hit the failure cap')
  assert.equal(waiting.lastRetryableCode, 'NO_DISPLAY')
  assert.ok(win._realPixelCompare, 'the session stays alive while the display is missing')
  assert.equal(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length, 0,
    'no frame may be delivered from an absent display')
  // The target display comes back: the same session delivers a frame without a restart.
  displays.push(DISPLAY_PRIMARY)
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.ok(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length >= 1,
    'sampling resumes by itself once the display is back')
  assert.ok(win._realPixelCompare, 'the session was never restarted')
  win._closed()
})

test('product: only transient planning refusals are retryable (P2-03)', async () => {
  const harness = createScreenDiffHarness({ intervalMs: 250 })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  // Move the pin completely off the only display: planScreenCapture refuses OUTSIDE_DISPLAY,
  // which recovers when the user moves the pin back, so it must stay retryable.
  win.getBounds = () => ({ x: 5000, y: 5000, width: 400, height: 200 })
  const outside = await harness.domain.captureScreenUnderPin(win, { x: 0, y: 0, width: 400, height: 200 })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'OUTSIDE_DISPLAY')
  assert.equal(outside.retryable, true, 'a moved-off-screen pin recovers when it is moved back')
  // An invalid window box is a programming/data error, not a transient environment state: it
  // must keep counting against the failure cap instead of retrying forever.
  const invalidHarness = createScreenDiffHarness({ intervalMs: 250 })
  const invalidWin = invalidHarness.domain.createPinWindow(ORIGINAL, {})
  invalidWin.getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 })
  const invalid = await invalidHarness.domain.captureScreenUnderPin(invalidWin, { x: 0, y: 0, width: 0, height: 0 })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'INVALID_PIN_BOUNDS')
  assert.notEqual(invalid.retryable, true)
  win._closed()
  invalidWin._closed()
})

test('adoption: only measured exclusion+alignment+budget+rate may adopt', () => {
  const measured = {
    samples: 10,
    selfCaptureRatio: 0.001,
    alignmentRatio: 0.01,
    maxFrameBytes: 4 * 1024 * 1024,
    minIntervalMs: 1000,
    exclusionMethod: 'content-protection'
  }
  assert.deepEqual(diff.evaluateDiffAdoption(measured), { adopt: true, reasons: [] })
  assert.equal(diff.evaluateDiffAdoption({}).adopt, false)
  const reasons = diff.evaluateDiffAdoption({}).reasons
  for (const reason of ['insufficient-samples', 'self-capture-unmeasured', 'alignment-unmeasured', 'budget-unmeasured', 'rate-unmeasured']) {
    assert.ok(reasons.includes(reason), reason)
  }
  // A measured failure is a reject with the exact reason.
  assert.ok(diff.evaluateDiffAdoption({ ...measured, selfCaptureRatio: 0.4 }).reasons.includes('self-capture-detected'))
  assert.ok(diff.evaluateDiffAdoption({ ...measured, alignmentRatio: 0.5 }).reasons.includes('alignment-exceeded'))
  assert.ok(diff.evaluateDiffAdoption({ ...measured, maxFrameBytes: diff.MAX_CAPTURE_BYTES + 1 }).reasons.includes('budget-exceeded'))
  assert.ok(diff.evaluateDiffAdoption({ ...measured, minIntervalMs: 500 }).reasons.includes('rate-exceeded'))
  assert.ok(diff.evaluateDiffAdoption({ ...measured, exclusionMethod: 'clip-region' }).reasons.includes('unsupported-exclusion-method'))
})

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 5. Product wiring: opt-in real-pixel compare (adopted 2026-11-28).
// ---------------------------------------------------------------------------

function createScreenDiffHarness(options = {}) {
  const protectionCalls = []
  const capturedThumbnails = []
  const sends = []
  const events = {}
  const menus = []
  const winBounds = options.winBounds || { x: 100, y: 50, width: 400, height: 200 }
  const win = {
    _pinData: null,
    _destroyed: false,
    isDestroyed: () => win._destroyed,
    isVisible: () => true,
    getBounds: () => ({ ...winBounds }),
    getContentBounds: () => ({ ...winBounds }),
    setBounds: () => {},
    setPosition: () => {},
    setContentSize: () => {},
    setAlwaysOnTop: () => {},
    setOpacity: () => {},
    setIgnoreMouseEvents: () => {},
    show: () => {},
    showInactive: () => {},
    hide: () => {},
    moveTop: () => {},
    focus: () => {},
    close: () => {},
    loadFile: () => undefined,
    destroy: () => { win._destroyed = true },
    setContentProtection: options.noProtection === true ? undefined : (enabled) => protectionCalls.push(enabled),
    on: (event, callback) => {
      events[event] = callback
      if (event === 'closed') win._closed = callback
    },
    removeListener: (event, callback) => { if (events[event] === callback) delete events[event] },
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => sends.push({ channel, payload })
    }
  }
  const handlers = new Map()
  const desktopCapturer = options.desktopCapturer || {
    getSources: async ({ thumbnailSize }) => {
      capturedThumbnails.push(thumbnailSize)
      return [{
        display_id: '1',
        thumbnail: {
          isEmpty: () => false,
          crop: (rect) => ({
            isEmpty: () => false,
            getSize: () => ({ width: rect.width, height: rect.height }),
            toBitmap: () => Buffer.alloc(rect.width * rect.height * 4)
          })
        }
      }]
    }
  }
  const { createPinDomain } = require('../main/domains/pin')
  const deps = {
    BrowserWindow: { fromWebContents: () => win },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromBuffer: () => ({ getSize: () => ({ width: 400, height: 200 }), isEmpty: () => false })
    },
    screen: {
      // Real screen.getAllDisplays() returns a fresh array per call; the snapshot fidelity
      // matters for P2-5 (the pre-await list must not be mutated by the topology change).
      getAllDisplays: () => (options.displays ? options.displays.slice() : [DISPLAY_PRIMARY]),
      getDisplayMatching: () => (options.displays && options.displays[0]) || DISPLAY_PRIMARY,
      getDisplayNearestPoint: () => DISPLAY_PRIMARY,
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    Menu: {
      buildFromTemplate: (template) => {
        menus.push(template)
        return { popup: () => {} }
      }
    },
    path,
    rootDirectory: ROOT,
    createLocalWindow: () => win,
    getSettings: () => ({ fixedContent: { opacity: 1 }, plugins: {}, pinned: {} }),
    saveImageBuffer: async () => '',
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    pinImages: {
      add: () => 1,
      read: async () => ({ bytes: Buffer.from([1]), mime: 'image/png' }),
      retain: () => true,
      release: () => {},
      stats: () => ({})
    },
    getCreateCaptureWindow: () => async () => null,
    realDiffIntervalMs: options.intervalMs || 250,
    log: () => {},
    ipcMain: { on: (channel, handler) => { handlers.set(channel, handler) } }
  }
  // P1-01: the production wiring (main.js createPinDomain) does NOT inject a capturer.
  // `injectCapturer: false` reproduces exactly that, so the test drives the domain's own
  // default resolution instead of bypassing it with the test seam.
  if (options.injectCapturer !== false) deps.screenDiffDesktopCapturer = desktopCapturer
  const domain = createPinDomain(deps)
  return { domain, win, protectionCalls, capturedThumbnails, sends, events, menus, handlers, desktopCapturer }
}

const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])

// P1-01: drive the domain's PRODUCTION default branch by mocking the electron module for
// the duration of one call. The pin domain requires('electron') lazily (the same pattern
// as its dialog defaults), so replacing the require.cache entry reproduces "main.js did
// not inject screenDiffDesktopCapturer" without an Electron runtime.
async function withElectronModule(exportsValue, callback) {
  const electronPath = require.resolve('electron')
  const previous = require.cache[electronPath]
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: []
  }
  try {
    return await callback()
  } finally {
    if (previous) require.cache[electronPath] = previous
    else delete require.cache[electronPath]
  }
}

// A fake desktopCapturer source whose crop/toBitmap path answers like nativeImage does.
// `marker` fills the fake BGRA bitmap so a test can prove WHICH screen a delivered frame
// came from (the P2-5 counterexamples: the wrong screen must never be cropped).
function screenSource(displayId, { width = 1920, height = 1080, isEmpty = false, marker = 0 } = {}) {
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => isEmpty,
      crop: (rect) => ({
        isEmpty: () => false,
        getSize: () => ({ width: rect.width, height: rect.height }),
        toBitmap: () => Buffer.alloc(rect.width * rect.height * 4, marker)
      })
    }
  }
}

test('product: start/stop toggles content protection exactly once per transition', async () => {
  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', {
    x: 0, y: 0, width: 400, height: 200
  })
  assert.equal(started.ok, true)
  assert.equal(started.mode, 'real-diff')
  assert.equal(win._onionMode, 'real-diff')
  assert.deepEqual(harness.protectionCalls, [true], 'protection on for the whole session')
  assert.ok(harness.sends.some(({ channel, payload }) => channel === 'pin:onion-mode' && payload.mode === 'real-diff'))

  const frame = await started.sampleNow()
  assert.equal(frame.ok, true)
  const delivered = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')
  assert.equal(delivered.length, 1)
  const payload = delivered[0].payload
  assert.equal(payload.width, 400)
  assert.equal(payload.height, 200)
  assert.equal(payload.pixels.length, 400 * 200 * 4)
  assert.deepEqual(payload.dipRect, { x: 100, y: 50, width: 400, height: 200 })
  assert.equal(payload.scaleFactor, 1)

  const stopped = harness.domain.applyOnionModeSelection(win, 'off')
  assert.equal(stopped.ok, true)
  assert.equal(win._onionMode, 'off')
  assert.deepEqual(harness.protectionCalls, [true, false], 'protection restored on stop')
  assert.ok(harness.sends.some(({ channel, payload }) => channel === 'pin:onion-mode' && payload.mode === 'off'))
  assert.equal(win._realPixelCompare, null)
})

test('product: closing or hiding the pin stops sampling and restores protection', async () => {
  // Close while active.
  const closing = createScreenDiffHarness()
  const closingWin = closing.domain.createPinWindow(ORIGINAL, {})
  closing.domain.applyOnionModeSelection(closingWin, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  assert.deepEqual(closing.protectionCalls, [true])
  closing.events.closed()
  assert.deepEqual(closing.protectionCalls, [true, false])
  assert.equal(closingWin._realPixelCompare, null)

  // Hide while active (workspace suspend / tray hide).
  const hiding = createScreenDiffHarness()
  const hidingWin = hiding.domain.createPinWindow(ORIGINAL, {})
  hiding.domain.applyOnionModeSelection(hidingWin, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  hiding.events.hide()
  assert.deepEqual(hiding.protectionCalls, [true, false])
  assert.equal(hidingWin._realPixelCompare, null)
  assert.ok(hiding.sends.some(({ channel, payload }) => channel === 'pin:onion-mode' && payload.reason === 'hidden'))
})

test('product: sampler is rate limited, single-flight and stops after the failure cap', async () => {
  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  const first = await started.sampleNow()
  assert.equal(first.ok, true)
  const second = await started.sampleNow()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'RATE_LIMITED')
  assert.equal(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length, 1)
  win._closed()
  // A failing capture stops the session after three consecutive failures.
  let attempts = 0
  const failing = createScreenDiffHarness({
    desktopCapturer: {
      getSources: async () => { attempts += 1; throw new Error('capture unavailable') }
    }
  })
  const failingWin = failing.domain.createPinWindow(ORIGINAL, {})
  const failingStart = failing.domain.applyOnionModeSelection(failingWin, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  const pause = () => new Promise((resolve) => setTimeout(resolve, 300))
  await failingStart.sampleNow()
  await pause()
  await failingStart.sampleNow()
  await pause()
  await failingStart.sampleNow()
  assert.equal(attempts, 3)
  assert.equal(failingWin._realPixelCompare, null)
  assert.deepEqual(failing.protectionCalls, [true, false])
  assert.ok(failing.sends.some(({ channel, payload }) => channel === 'pin:onion-mode' && payload.mode === 'off' && payload.reason === 'FAILURE_LIMIT'))
})

test('product: the un-injected production default captures through the real desktopCapturer object (P1-01)', async () => {
  // main.js createPinDomain does NOT pass screenDiffDesktopCapturer, so this harness has
  // no test capturer either: only the domain's own default can make a frame work. The old
  // default returned a FUNCTION (`() => require('electron').desktopCapturer`), so the first
  // production frame failed with CAPTURE_THREW "capturer.getSources is not a function".
  const harness = createScreenDiffHarness({ injectCapturer: false })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const calls = []
  const fakeCapturer = {
    getSources: async ({ types, thumbnailSize }) => {
      calls.push({ types, thumbnailSize })
      return [screenSource('1')]
    }
  }
  const report = await withElectronModule({ desktopCapturer: fakeCapturer }, async () => {
    const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
    assert.equal(started.ok, true)
    const frame = await started.sampleNow()
    // A second tick through the same production default delivers sequence 2 (the
    // sampler's own 250 ms timer may take it, which is exactly the production 1 Hz
    // behaviour). Keep the fake electron module installed for the whole window: the
    // timer resolves the default lazily on every tick, like production.
    const secondDeadline = Date.now() + 2000
    while (Date.now() < secondDeadline) {
      if (harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const frames = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length
    // Manual stop restores content protection and drops the session.
    const stopped = started.stop('test-done')
    return { frame, frames, stopped }
  })
  assert.equal(report.frame.ok, true, `the production default must return a first frame (got ${report.frame.code})`)
  assert.equal(report.frame.delivered, true)
  assert.equal(report.frame.width, 400)
  assert.equal(report.frame.height, 200)
  assert.equal(report.frame.bytes, 400 * 200 * 4)
  // The capturer OBJECT itself was used: a factory function has no getSources to call.
  assert.equal(calls.length >= 2, true, 'continuous updates must keep using the resolved capturer')
  assert.deepEqual(calls[0].types, ['screen'])
  assert.deepEqual(calls[0].thumbnailSize, { width: 1920, height: 1080 })
  assert.equal(report.frames, 2, 'continuous updates must keep flowing')
  assert.equal(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')[0].payload.pixels.length, 400 * 200 * 4)
  // Manual stop restores content protection and drops the session (no capture left behind).
  assert.equal(report.stopped, true)
  assert.equal(win._realPixelCompare, null)
  assert.deepEqual(harness.protectionCalls, [true, false])
  win._closed()
})

test('product: a missing desktopCapturer degrades to a typed retryable failure (P1-01)', async () => {
  const harness = createScreenDiffHarness({ injectCapturer: false })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const missing = await withElectronModule({}, () => harness.domain.captureScreenUnderPin(win, { x: 0, y: 0, width: 400, height: 200 }))
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'CAPTURER_UNAVAILABLE', 'an unavailable capturer is a typed state, not a CAPTURE_THREW')
  assert.equal(missing.retryable, true, 'the sampler must keep retrying instead of burning the failure cap')
  win._closed()
})

test('product: a missing secondary source never delivers primary pixels, and recovery resumes (P2-03)', async () => {
  const DISPLAY_SECONDARY = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    scaleFactor: 1.5
  }
  // The pin sits on the secondary display; the capturer only reports the PRIMARY screen
  // source. Before P2-03, pickScreenSource fell back to that first source and the caller
  // cropped the secondary display's coordinates out of primary pixels.
  let sources = [screenSource('1', { width: 1920, height: 1080 }), screenSource('9', { isEmpty: true })]
  const desktopCapturer = { getSources: async () => sources }
  const harness = createScreenDiffHarness({
    displays: [DISPLAY_PRIMARY, DISPLAY_SECONDARY],
    winBounds: { x: 2000, y: 100, width: 400, height: 200 },
    desktopCapturer,
    intervalMs: 250
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  assert.equal(started.ok, true)
  // Let the 250 ms sampler tick at least twice with the secondary source absent.
  await new Promise((resolve) => setTimeout(resolve, 520))
  assert.equal(
    harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length,
    0,
    'no frame may be delivered from an unconfirmed (primary) source'
  )
  assert.ok(win._realPixelCompare, 'a transient display-unavailable state must not stop the session')
  const waiting = started.getStats()
  assert.equal(waiting.stopped, false)
  assert.equal(waiting.failures, 0, 'display-unavailable is not a genuine capture error')
  assert.ok(waiting.retryableFailures >= 1)
  assert.equal(waiting.lastRetryableCode, 'DISPLAY_UNAVAILABLE')
  // The target display/source comes back: sampling resumes inside the SAME session.
  sources = [screenSource('1', { width: 1920, height: 1080 }), screenSource('2', { width: 2560, height: 1440 })]
  const deadline = Date.now() + 2500
  while (Date.now() < deadline && harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const delivered = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')
  assert.equal(delivered.length, 1, 'the recovered secondary source must resume delivery')
  // The frame is the SECONDARY display's physical crop, not a primary-sized frame:
  // 2560x1440 primary at 1.5x would be 1280x720; the pin crop is 400x200 DIP -> 600x300.
  assert.equal(delivered[0].payload.width, 600)
  assert.equal(delivered[0].payload.height, 300)
  assert.deepEqual(delivered[0].payload.dipRect, { x: 2000, y: 100, width: 400, height: 200 })
  assert.equal(delivered[0].payload.scaleFactor, 1.5)
  assert.ok(win._realPixelCompare, 'the resumed session is the same live one')
  assert.equal(started.getStats().stopped, false)
  started.stop('test-done')
  win._closed()
})

// P2-5 (review finding 5): the single-display elimination fallback must never contradict an
// explicit source identity. A capturer that re-enumerated the topology can hand back exactly
// one source that names another display; before P2-5 the stale "one display" knowledge turned
// that into { ok:true, matched:false } and the caller cropped it with the target's rectangle.
test('product: a conflicting single-display source is refused retryably and never cropped (P2-5)', async () => {
  const sources = [screenSource('9', { marker: 9 })]
  const harness = createScreenDiffHarness({
    displays: [DISPLAY_PRIMARY],
    winBounds: { x: 100, y: 50, width: 400, height: 200 },
    desktopCapturer: { getSources: async () => sources }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const refused = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(refused.ok, false, 'a source that names another display is not the target by elimination')
  assert.equal(refused.code, 'DISPLAY_UNAVAILABLE')
  assert.equal(refused.retryable, true, 'the capturer can re-enumerate on a later tick')
  assert.equal(refused.pixels, undefined, 'no frame is delivered from the conflicting source')
  // The target source comes back: the same call site delivers the target display's pixels.
  sources[0] = screenSource('1', { marker: 21 })
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.sourceMatched, true)
  assert.equal(recovered.width, 400)
  assert.equal(recovered.height, 200)
  assert.deepEqual([...recovered.pixels.slice(0, 4)], [21, 21, 21, 21])
  win._closed()
})

// P2-5: two anonymous sources on a single-display system are ambiguous - list[0] is a coin
// flip, and a hotplug can leave the SECOND screen's source behind. Skip the frame and retry.
test('product: several anonymous single-display sources are refused retryably (P2-5)', async () => {
  const sources = [screenSource(undefined, { marker: 10 }), screenSource(null, { marker: 11 })]
  const harness = createScreenDiffHarness({
    displays: [DISPLAY_PRIMARY],
    winBounds: { x: 100, y: 50, width: 400, height: 200 },
    desktopCapturer: { getSources: async () => sources }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const refused = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(refused.ok, false, 'two anonymous sources cannot be disambiguated by elimination')
  assert.equal(refused.code, 'SOURCE_UNIDENTIFIED')
  assert.equal(refused.retryable, true)
  assert.equal(refused.pixels, undefined)
  // An identity-confirmed source restores delivery.
  sources[0] = screenSource('1', { marker: 22 })
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.sourceMatched, true)
  assert.equal(recovered.pixels[0], 22)
  win._closed()
})

// P2-5: the tightened fallback must not break the case it exists for - a driver that omits
// display_id on a genuine single-display host.
test('product: a single anonymous source on a genuine single-display system still captures (P2-5)', async () => {
  const harness = createScreenDiffHarness({
    displays: [DISPLAY_PRIMARY],
    winBounds: { x: 100, y: 50, width: 400, height: 200 },
    desktopCapturer: { getSources: async () => [screenSource(undefined, { marker: 7 })] }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const frame = await harness.domain.captureScreenUnderPin(win, { x: 0, y: 0, width: 400, height: 200 })
  assert.equal(frame.ok, true, `the driver-omitted-id fallback must still work (${frame.code})`)
  assert.equal(frame.sourceMatched, false)
  assert.equal(frame.width, 400)
  assert.equal(frame.height, 200)
  assert.equal(frame.pixels[0], 7)
  win._closed()
})

// P2-5: screen.getAllDisplays() is read BEFORE the getSources() await; a hotplug or driver
// re-enumeration in between means the plan's rectangle and the source list can describe two
// different topologies. Re-read the list after the await: a changed count refuses the frame
// (retryable) instead of cropping the new topology's source with the old rectangle.
test('product: a display added during getSources is a retryable topology change, not a frame (P2-5)', async () => {
  const topology = [DISPLAY_SCALED]
  let call = 0
  let recoveredSources = []
  const desktopCapturer = {
    getSources: async () => {
      call += 1
      if (call === 1) {
        // While getSources was awaiting, the primary display came back and the capturer
        // re-enumerated the NEW topology: its only usable source is the primary screen.
        topology.push(DISPLAY_PRIMARY)
        return [screenSource('1', { marker: 1 })]
      }
      return recoveredSources
    }
  }
  const harness = createScreenDiffHarness({
    displays: topology,
    winBounds: { x: 2000, y: 100, width: 400, height: 200 },
    desktopCapturer
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const stale = await harness.domain.captureScreenUnderPin(win, imageBounds)
  // Before P2-5 the stale one-display list allowed the elimination fallback to crop the
  // primary source with the secondary display's 600x300 rectangle.
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'TOPOLOGY_CHANGED')
  assert.equal(stale.retryable, true)
  assert.equal(stale.pixels, undefined)
  // The target display is back; the capturer omits its display_id (single-display
  // elimination is valid again) and the delivered frame must be the SECONDARY display's
  // crop: 400x200 DIP at 1.5x = 600x300, carrying the secondary pixels only.
  topology.splice(0, topology.length, DISPLAY_SCALED)
  recoveredSources = [screenSource(undefined, { marker: 33 })]
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.width, 600)
  assert.equal(recovered.height, 300)
  assert.equal(recovered.pixels.length, 600 * 300 * 4)
  assert.deepEqual(recovered.plan.dipRect, { x: 2000, y: 100, width: 400, height: 200 })
  assert.equal(recovered.plan.scaleFactor, 1.5)
  assert.equal(recovered.pixels[0], 33, 'only the recovered target display pixels may be delivered')
  win._closed()
})

// P2-5: a display swap can keep the display COUNT the same while the target id disappears.
// Only the "target id still present" check can catch that; counting alone (or the stale
// single-display flag) would deliver the replacement screen's pixels.
test('product: a vanished target display id during getSources is refused even at unchanged count (P2-5)', async () => {
  const topology = [DISPLAY_SCALED]
  let call = 0
  let recoveredSources = []
  const desktopCapturer = {
    getSources: async () => {
      call += 1
      if (call === 1) {
        // The pin's display was swapped for another single display during the await: the
        // count is still one, so only the target-id check can reveal the stale plan.
        topology.splice(0, topology.length, DISPLAY_PRIMARY)
        return [screenSource('1', { marker: 1 })]
      }
      return recoveredSources
    }
  }
  const harness = createScreenDiffHarness({
    displays: topology,
    winBounds: { x: 2000, y: 100, width: 400, height: 200 },
    desktopCapturer
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const stale = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'TOPOLOGY_CHANGED')
  assert.equal(stale.retryable, true)
  assert.equal(stale.pixels, undefined)
  // The target display id is back: only its pixels are delivered.
  topology.splice(0, topology.length, DISPLAY_SCALED)
  recoveredSources = [screenSource(undefined, { marker: 44 })]
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.width, 600)
  assert.equal(recovered.height, 300)
  assert.equal(recovered.plan.scaleFactor, 1.5)
  assert.equal(recovered.pixels[0], 44)
  win._closed()
})

// P2-01 (re-review): the deterministic counterexample. Two 1920x1080 screens keep ids 1/2 and the
// display COUNT, but swap their system coordinates while getSources() awaits. The old count+target
// id check passed and the first frame cropped the pre-swap physicalRect out of display 1's source:
// ok:true carrying marker 11, although the pin now sits on display 2 (marker 22). The transition
// frame must be retryable with NO pixels; the next frame re-plans from the current topology and
// delivers the screen actually under the pin with the correct crop size.
test('product: displays that keep ids/count but swap layout during getSources never deliver the old screen (P2-01)', async () => {
  const LEFT = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  const RIGHT = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  const topology = [LEFT, RIGHT]
  let call = 0
  const desktopCapturer = {
    getSources: async () => {
      call += 1
      if (call === 1) {
        // Same ids, same count; only the system coordinates swap during the await.
        topology.splice(0, topology.length,
          { ...LEFT, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
          { ...RIGHT, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
      }
      return [screenSource('1', { marker: 11 }), screenSource('2', { marker: 22 })]
    }
  }
  const harness = createScreenDiffHarness({
    displays: topology,
    winBounds: { x: 100, y: 50, width: 400, height: 200 },
    desktopCapturer
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const stale = await harness.domain.captureScreenUnderPin(win, imageBounds)
  // Before this fix the stale frame was { ok:true, pixels: marker 11 } at 400x200: the screen that
  // used to be under the pin, not the one that is under it now.
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'TOPOLOGY_CHANGED')
  assert.equal(stale.retryable, true)
  assert.equal(stale.pixels, undefined, 'the transition frame delivers no pixels')
  assert.deepEqual(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame'), [],
    'no screen-diff frame is sent for the stale mapping')
  // The next frame re-plans from the current topology: display 2 is now at x=0 under the pin.
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.sourceMatched, true)
  assert.equal(recovered.plan.display.id, 2, 'the frame is planned against the display actually under the pin')
  assert.equal(recovered.width, 400)
  assert.equal(recovered.height, 200)
  assert.equal(recovered.plan.physicalRect.width, 400)
  assert.equal(recovered.plan.physicalRect.height, 200)
  assert.equal(recovered.pixels[0], 22, 'only the screen now under the pin may be delivered')
  win._closed()
})

// P2-01: a scale-factor change of the target display during getSources is the same class of stale
// mapping: the DIP rectangle no longer maps to the old physical crop. Refuse the transition frame,
// then deliver the new physical mapping on the next tick.
test('product: a target-display scale change during getSources is retryable, the next frame uses the new crop (P2-01)', async () => {
  const topology = [{ ...DISPLAY_PRIMARY }]
  let call = 0
  const desktopCapturer = {
    getSources: async () => {
      call += 1
      if (call === 1) topology[0] = { ...DISPLAY_PRIMARY, scaleFactor: 2 }
      return [screenSource('1', { marker: 11 })]
    }
  }
  const harness = createScreenDiffHarness({
    displays: topology,
    winBounds: { x: 100, y: 50, width: 400, height: 200 },
    desktopCapturer
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  const imageBounds = { x: 0, y: 0, width: 400, height: 200 }
  const stale = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'TOPOLOGY_CHANGED')
  assert.equal(stale.retryable, true)
  assert.equal(stale.pixels, undefined)
  const recovered = await harness.domain.captureScreenUnderPin(win, imageBounds)
  assert.equal(recovered.ok, true, `recovery capture failed: ${recovered.code}`)
  assert.equal(recovered.width, 800, 'the same 400 DIP now maps to 800 physical pixels')
  assert.equal(recovered.height, 400)
  assert.equal(recovered.plan.scaleFactor, 2)
  assert.equal(recovered.pixels[0], 11)
  win._closed()
})

// P2-3 (review finding 3): the capture plan is computed from the window rectangle read at
// the start of the tick, and THEN getSources() awaits. A pin dragged to another display
// during that await used to deliver the OLD screen's pixels for one frame (the first frame
// carried marker 11 from the pre-move display). The transition frame must be retryable and
// deliver nothing; the next tick must plan from the current position and deliver that screen.
test('product: a pin moved to another display during getSources never delivers the old screen (P2-3)', async () => {
  const LEFT = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  const RIGHT = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  let bounds = { x: 100, y: 50, width: 400, height: 200 }
  let enumeration = 0
  const desktopCapturer = {
    getSources: async () => {
      enumeration += 1
      if (enumeration === 1) {
        // The user drags the pin to the second screen while the capturer enumerates.
        bounds = { x: 2020, y: 50, width: 400, height: 200 }
      }
      return [screenSource('1', { marker: 11 }), screenSource('2', { marker: 22 })]
    }
  }
  const harness = createScreenDiffHarness({ displays: [LEFT, RIGHT], desktopCapturer })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  win.getBounds = () => ({ ...bounds })
  win.getContentBounds = () => ({ ...bounds })
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  assert.equal(started.ok, true)
  const transition = await started.sampleNow()
  assert.equal(transition.ok, false, 'the stale pre-move rectangle must not produce a frame')
  assert.equal(transition.retryable, true, 'the stale rectangle is a retryable transition, not a capture failure')
  assert.equal(transition.code, 'TOPOLOGY_CHANGED')
  assert.equal(transition.pixels, undefined)
  assert.deepEqual(harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame'), [],
    'no screen-diff frame may be sent for the pre-move rectangle')
  // The next tick re-plans from the current position: display 2's pixels (marker 22).
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !harness.sends.some(({ channel }) => channel === 'pin:screen-diff-frame')) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const delivered = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')
  assert.ok(delivered.length >= 1, 'the next tick must deliver the frame now under the pin')
  assert.equal(delivered[0].payload.width, 400)
  assert.equal(delivered[0].payload.height, 200)
  assert.deepEqual(delivered[0].payload.dipRect, { x: 2020, y: 50, width: 400, height: 200 })
  assert.deepEqual([...delivered[0].payload.pixels.slice(0, 3)], [22, 22, 22],
    'only the screen now under the pin may be delivered')
  started.stop('test-done')
  win._closed()
})

// P2-3: the session used to snapshot win.getContentBounds() once at start and reuse that
// size every tick: shrinking the pin from 400x200 to 100x80 kept delivering 400x200 pixels
// that include screen area outside the window. Every sample must read the current content
// rectangle instead.
test('product: resizing the pin window mid-session captures the current content size (P2-3)', async () => {
  let bounds = { x: 100, y: 50, width: 400, height: 200 }
  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  win.getBounds = () => ({ ...bounds })
  win.getContentBounds = () => ({ ...bounds })
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  assert.equal(started.ok, true)
  const before = await started.sampleNow()
  assert.equal(before.ok, true)
  assert.equal(before.width, 400)
  assert.equal(before.height, 200)
  // Shrink the content window; two later samples must both capture only the new 100x80 box.
  bounds = { x: 100, y: 50, width: 100, height: 80 }
  const framesBefore = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length
  const deadline = Date.now() + 2000
  while (Date.now() < deadline &&
    harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length < framesBefore + 2) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const after = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').slice(framesBefore)
  assert.ok(after.length >= 2, `two post-resize samples must be delivered (got ${after.length})`)
  for (const frame of after) {
    assert.equal(frame.payload.width, 100, 'the shrunken window must not keep delivering its old width')
    assert.equal(frame.payload.height, 80, 'the shrunken window must not keep delivering its old height')
    assert.equal(frame.payload.pixels.length, 100 * 80 * 4)
    assert.deepEqual(frame.payload.dipRect, { x: 100, y: 50, width: 100, height: 80 })
  }
  started.stop('test-done')
  win._closed()
})

// P2-3: the size always follows the CURRENT content rectangle, but a caller that explicitly
// passed a non-zero image offset keeps that relative semantics (the old code reset it to 0,0).
test('product: an explicit image offset stays relative to the window while the size is current (P2-3)', async () => {
  let bounds = { x: 100, y: 50, width: 400, height: 200 }
  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  win.getBounds = () => ({ ...bounds })
  win.getContentBounds = () => ({ ...bounds })
  const started = harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 12, y: 6, width: 400, height: 200 })
  assert.equal(started.ok, true)
  const first = await started.sampleNow()
  assert.equal(first.ok, true, `first capture failed: ${first.code}`)
  let delivered = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')
  assert.deepEqual(delivered[0].payload.dipRect, { x: 112, y: 56, width: 400, height: 200 },
    'the explicit offset is kept relative to the window origin')
  bounds = { x: 100, y: 50, width: 100, height: 80 }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline &&
    harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  delivered = harness.sends.filter(({ channel }) => channel === 'pin:screen-diff-frame')
  assert.ok(delivered.length >= 2)
  assert.deepEqual(delivered[1].payload.dipRect, { x: 112, y: 56, width: 100, height: 80 },
    'the offset survives a content resize while the size follows the current content box')
  started.stop('test-done')
  win._closed()
})

test('product: refuses without content protection, and the menu offers the opt-in with its side effect', async () => {
  const bare = createScreenDiffHarness({ noProtection: true })
  const bareWin = bare.domain.createPinWindow(ORIGINAL, {})
  assert.deepEqual(
    bare.domain.applyOnionModeSelection(bareWin, 'real-diff', { x: 0, y: 0, width: 400, height: 200 }),
    { ok: false, code: 'NO_CONTENT_PROTECTION' }
  )
  assert.equal(bareWin._onionMode, 'off')

  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  harness.handlers.get('pin:context-menu')({ sender: win.webContents })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const { t } = require('../main/services/i18n-bootstrap')
  const template = harness.menus.at(-1)
  const onionMenu = template.find((item) => item.label === t('pin.onion.menu-label'))
  assert.ok(onionMenu, 'the context menu has an onion/compare submenu')
  assert.ok(Array.isArray(onionMenu.submenu))
  const labels = onionMenu.submenu.map((item) => item.label)
  for (const key of ['pin.onion.mode-off', 'pin.onion.mode-difference', 'pin.onion.mode-flash', 'pin.onion.mode-real-diff']) {
    assert.ok(labels.includes(t(key)), `${key} present`)
  }
  const realDiff = onionMenu.submenu.find((item) => item.label === t('pin.onion.mode-real-diff'))
  assert.equal(realDiff.type, 'radio')
  assert.equal(realDiff.checked, false, 'real-pixel compare is opt-in, off by default')
  const sideEffect = onionMenu.submenu.find((item) => item.label === t('pin.onion.real-diff.side-effect'))
  assert.ok(sideEffect && sideEffect.enabled === false, 'the capture-exclusion side effect is disclosed')
  // The shipped flash mode remains the default: stopping the new mode leaves mode off.
  harness.domain.applyOnionModeSelection(win, 'flash')
  assert.equal(win._onionMode, 'flash')
  harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  harness.domain.applyOnionModeSelection(win, 'off')
  assert.equal(win._onionMode, 'off')
  win._closed()
})

test('product: the renderer onion-state envelope is bounded and updates the menu mirror', () => {
  const pinDomain = require('../main/domains/pin')
  assert.deepEqual(pinDomain.ONION_MODES, ['off', 'difference', 'flash', 'real-diff'])
  assert.deepEqual(pinDomain.normalizeOnionStateCommand({ type: 'onion-state', mode: 'flash' }), {
    type: 'onion-state', mode: 'flash'
  })
  assert.equal(pinDomain.normalizeOnionStateCommand({ type: 'onion-state', mode: 'bogus' }), null)
  assert.equal(pinDomain.normalizeOnionStateCommand({ type: 'workspace-save', name: 'x' }), null)
  assert.equal(pinDomain.normalizeOnionStateCommand(null), null)

  const harness = createScreenDiffHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  assert.equal(win._onionMode, 'off')
  harness.handlers.get('pin:context-menu')({ sender: win.webContents }, null, { type: 'onion-state', mode: 'difference' })
  assert.equal(win._onionMode, 'difference')
  // A renderer echo that leaves real-diff while the sampler runs stops the sampler.
  harness.domain.applyOnionModeSelection(win, 'real-diff', { x: 0, y: 0, width: 400, height: 200 })
  assert.deepEqual(harness.protectionCalls, [true])
  harness.handlers.get('pin:context-menu')({ sender: win.webContents }, null, { type: 'onion-state', mode: 'off' })
  assert.equal(win._realPixelCompare, null)
  assert.deepEqual(harness.protectionCalls, [true, false])
  win._closed()
})

// ---------------------------------------------------------------------------
// 6. BGRA normalisation, display wiring and the unchanged flash default.
// ---------------------------------------------------------------------------

test('bgraToRgba swaps channels and forces opaque pixels; bad lengths are refused', () => {
  const bgra = Uint8Array.from([10, 20, 30, 0, 40, 50, 60, 77])
  assert.deepEqual([...diff.bgraToRgba(bgra)], [30, 20, 10, 255, 60, 50, 40, 255])
  assert.equal(diff.bgraToRgba(new Uint8Array([1, 2, 3])), null)
  assert.equal(diff.bgraToRgba(null), null)
})

test('pickScreenSource delivers only an identity-confirmed source (P2-03)', () => {
  const usable = (displayId) => ({ display_id: displayId, thumbnail: { isEmpty: () => false } })
  const empty = { display_id: '9', thumbnail: { isEmpty: () => true } }
  // The authoritative display_id match always wins.
  const matched = diff.pickScreenSource([empty, usable('7'), usable('9')], '7')
  assert.equal(matched.ok, true)
  assert.equal(matched.matched, true)
  assert.equal(matched.source.display_id, '7')
  // Nothing usable at all: typed refusal, never a blind fallback.
  assert.deepEqual(diff.pickScreenSource([], '7'), { ok: false, code: 'NO_SOURCES' })
  assert.deepEqual(diff.pickScreenSource([empty], '9'), { ok: false, code: 'NO_SOURCES' })
  // Multi-display: the target id is absent from the source list -> refuse and retry later.
  // Delivering the first source here would crop the target display's coordinates out of
  // another screen's pixels, which is exactly the P2-03 defect.
  assert.deepEqual(diff.pickScreenSource([usable('1')], '2'), { ok: false, code: 'DISPLAY_UNAVAILABLE' })
  // Multi-display with driver-omitted display_id: identity cannot be confirmed, so refuse.
  assert.deepEqual(diff.pickScreenSource([usable(undefined), usable(null)], '2'), {
    ok: false,
    code: 'SOURCE_UNIDENTIFIED'
  })
  // Single display: the only usable source IS the target by elimination (safe fallback).
  const single = diff.pickScreenSource([usable(undefined)], '2', { singleDisplay: true })
  assert.equal(single.ok, true)
  assert.equal(single.matched, false)
  assert.equal(single.fallback, 'single-display')
  assert.equal(single.source.display_id, undefined)
})

// P2-5 (review finding 5): the elimination fallback is valid only when the source list cannot
// contradict it - exactly ONE usable source and that source has no display_id. A unique source
// that explicitly names ANOTHER display, or several anonymous sources, may belong to a
// topology that changed while getSources() was awaiting; list[0] must not be served.
test('pickScreenSource only eliminates when the single source cannot contradict the target (P2-5)', () => {
  const usable = (displayId) => ({ display_id: displayId, thumbnail: { isEmpty: () => false } })
  // The review's two deterministic counterexamples.
  assert.deepEqual(diff.pickScreenSource([usable('9')], '1', { singleDisplay: true }), {
    ok: false,
    code: 'DISPLAY_UNAVAILABLE'
  })
  assert.deepEqual(diff.pickScreenSource([usable(undefined), usable(null)], '1', { singleDisplay: true }), {
    ok: false,
    code: 'SOURCE_UNIDENTIFIED'
  })
  // A single anonymous source on a genuinely single-display system is still the target by
  // elimination, including the empty-string id some drivers report.
  for (const anonymous of [undefined, null, '']) {
    const only = diff.pickScreenSource([usable(anonymous)], '1', { singleDisplay: true })
    assert.equal(only.ok, true, `anonymous id ${String(anonymous)} must still fall back`)
    assert.equal(only.matched, false)
    assert.equal(only.fallback, 'single-display')
  }
  // The tightened fallback never relaxes the multi-display contract.
  assert.deepEqual(diff.pickScreenSource([usable(undefined)], '1'), { ok: false, code: 'SOURCE_UNIDENTIFIED' })
  assert.deepEqual(diff.pickScreenSource([usable('2')], '1'), { ok: false, code: 'DISPLAY_UNAVAILABLE' })
})

// P2-5: the caller re-reads screen.getAllDisplays() after await getSources(); this pure check
// states when the plan and the sources still describe the same topology.
test('checkDisplayTopology refuses a count change or a vanished target id (P2-5)', () => {
  const primary = { id: 1 }
  const secondary = { id: 2 }
  assert.deepEqual(diff.checkDisplayTopology([primary], [primary], 1), { ok: true })
  // A display was added or removed between the plan and the sources.
  assert.deepEqual(diff.checkDisplayTopology([primary], [primary, secondary], 1), {
    ok: false,
    code: 'TOPOLOGY_CHANGED'
  })
  assert.deepEqual(diff.checkDisplayTopology([primary, secondary], [primary], 2), {
    ok: false,
    code: 'TOPOLOGY_CHANGED'
  })
  // The count is unchanged but the target id is gone (a display swap / re-enumeration).
  assert.deepEqual(diff.checkDisplayTopology([secondary], [primary], 2), {
    ok: false,
    code: 'TOPOLOGY_CHANGED'
  })
  // Electron display ids are numbers; sources compare their ids as strings.
  assert.deepEqual(diff.checkDisplayTopology([{ id: 1 }], [{ id: '1' }], '1'), { ok: true })
  // A target without an id cannot be presence-checked; the count remains the signal.
  assert.deepEqual(diff.checkDisplayTopology([{ id: null }], [{ id: null }], null), { ok: true })
})

// P2-01 (re-review): count + target-id are NOT enough when the ids and display count survive a
// layout swap. Recompute the mapping from the post-await display list and require the same target,
// scale, rotation, DIP rectangle and physical crop rectangle.
test('revalidateScreenCapturePlan refuses a same-id layout, scale or rotation change (P2-01)', () => {
  const displays = [DISPLAY_PRIMARY, DISPLAY_SCALED]
  const plan = diff.planScreenCapture({
    pinBounds: { x: 2000, y: 100, width: 400, height: 300 },
    imageBounds: { x: 10, y: 20, width: 380, height: 260 },
    rotation: 0,
    displays
  })
  assert.equal(plan.ok, true)
  const stable = diff.revalidateScreenCapturePlan(plan, displays)
  assert.equal(stable.ok, true)
  assert.deepEqual(stable.plan.physicalRect, plan.physicalRect)
  assert.equal(stable.plan.display.id, plan.display.id)
  // The re-review counterexample: two 1920x1080 displays keep ids 1/2 and the count, but swap
  // their system coordinates. The target id is still present, so the topology check passes; the
  // mapping no longer does.
  const swapped = [
    { ...DISPLAY_PRIMARY, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
    { ...DISPLAY_SCALED, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
  ]
  assert.deepEqual(diff.checkDisplayTopology(displays, swapped, plan.display.id), { ok: true },
    'the old topology check cannot see the swap')
  assert.deepEqual(diff.revalidateScreenCapturePlan(plan, swapped), { ok: false, code: 'TOPOLOGY_CHANGED' })
  // A scale-factor change alone changes the physical crop of the SAME DIP rectangle.
  const scaled = [{ ...DISPLAY_SCALED, scaleFactor: 1.25 }, DISPLAY_PRIMARY]
  assert.deepEqual(diff.revalidateScreenCapturePlan(plan, scaled), { ok: false, code: 'TOPOLOGY_CHANGED' })
  // A display rotation change moves which physical pixels the rectangle covers.
  const rotated = [DISPLAY_PRIMARY, { ...DISPLAY_SCALED, rotation: 90 }]
  assert.deepEqual(diff.revalidateScreenCapturePlan(plan, rotated), { ok: false, code: 'TOPOLOGY_CHANGED' })
  // A target that disappeared leaves the region outside every remaining display: the unchanged
  // plan is refused and the next tick re-plans (retryable either way).
  const gone = diff.revalidateScreenCapturePlan(plan, [DISPLAY_PRIMARY])
  assert.equal(gone.ok, false)
  assert.equal(gone.code, 'OUTSIDE_DISPLAY')
  assert.equal(diff.revalidateScreenCapturePlan(null, displays).code, 'INVALID_PLAN')
  // A pin that is entirely outside every display after the change is a retryable planning refusal.
  const movedAway = [{ ...DISPLAY_PRIMARY, bounds: { x: 5000, y: 0, width: 1920, height: 1080 } }]
  assert.equal(diff.revalidateScreenCapturePlan(plan, movedAway).ok, false)
})

// P2-3 (review finding 3): the window itself is part of the plan. A pin that moved or was
// resized while getSources() awaited must not be revalidated against the OLD window
// rectangle alone; the post-await window/content facts are compared too, and a difference is
// a retryable TOPOLOGY_CHANGED transition (the next tick re-plans from the current geometry).
test('revalidateScreenCapturePlan refuses a window that moved or resized while enumerating (P2-3)', () => {
  const displays = [DISPLAY_PRIMARY, DISPLAY_SCALED]
  const pinBounds = { x: 2000, y: 100, width: 400, height: 300 }
  const imageBounds = { x: 10, y: 20, width: 380, height: 260 }
  const plan = diff.planScreenCapture({ pinBounds, imageBounds, rotation: 0, displays })
  assert.equal(plan.ok, true)
  // Without post-await inputs the existing P2-01 behaviour is unchanged.
  assert.equal(diff.revalidateScreenCapturePlan(plan, displays).ok, true)
  assert.equal(diff.revalidateScreenCapturePlan(plan, displays, null).ok, true)
  // The same window rectangle the plan used is accepted, with the same mapping.
  const unchanged = diff.revalidateScreenCapturePlan(plan, displays, { pinBounds: { ...pinBounds } })
  assert.equal(unchanged.ok, true)
  assert.deepEqual(unchanged.plan.physicalRect, plan.physicalRect)
  // A pin moved during the await: the planned rectangle is not the window that exists now.
  assert.deepEqual(
    diff.revalidateScreenCapturePlan(plan, displays, { pinBounds: { ...pinBounds, x: 2100 } }),
    { ok: false, code: 'TOPOLOGY_CHANGED' }
  )
  // A pin resized during the await: the old width/height describes pixels outside the window.
  assert.deepEqual(
    diff.revalidateScreenCapturePlan(plan, displays, { pinBounds: { ...pinBounds, width: 100, height: 80 } }),
    { ok: false, code: 'TOPOLOGY_CHANGED' }
  )
  // A content box that changed while the window rectangle stayed put is the same stale plan.
  assert.deepEqual(
    diff.revalidateScreenCapturePlan(plan, displays, {
      pinBounds: { ...pinBounds },
      imageBounds: { ...imageBounds, width: 100, height: 80 }
    }),
    { ok: false, code: 'TOPOLOGY_CHANGED' }
  )
  // A window rectangle that cannot be described post-await is a retryable transition.
  assert.deepEqual(
    diff.revalidateScreenCapturePlan(plan, displays, { pinBounds: { x: 0, y: 0, width: 0, height: 0 } }),
    { ok: false, code: 'TOPOLOGY_CHANGED' }
  )
  // Display-side changes keep the P2-01 TOPOLOGY_CHANGED classification (no loosening).
  const swapped = [
    { ...DISPLAY_PRIMARY, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
    { ...DISPLAY_SCALED, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
  ]
  assert.deepEqual(
    diff.revalidateScreenCapturePlan(plan, swapped, { pinBounds: { ...pinBounds } }),
    { ok: false, code: 'TOPOLOGY_CHANGED' }
  )
})

test('wiring: the opt-in diff mode is reachable, bounded, and flash stays the default', () => {
  const pinScript = read('pin', 'pin.js')
  const pinHtml = read('pin', 'pin.html')
  const pinCss = read('pin', 'pin.css')
  const pinDomainSource = read('main', 'domains', 'pin', 'index.js')
  const preload = read('preload-pin.js')
  // The renderer loads the bounded diff-display contract before pin.js.
  assert.ok(pinHtml.indexOf('pin-diff-view.js') > 0)
  assert.ok(pinHtml.indexOf('pin-diff-view.js') < pinHtml.indexOf('<script src="pin.js">'))
  assert.doesNotMatch(pinHtml, /pin-screen-diff/)
  assert.match(pinScript, /applyRealDiffMode/)
  assert.match(pinScript, /onScreenDiffFrame/)
  assert.match(pinScript, /buildDiffMask/)
  assert.match(pinScript, /teardownRealDiffDisplay/)
  assert.match(pinScript, /diffViewApi\.diffBadge\(diff\)/)
  assert.match(read('pin', 'pin-diff-view.js'), /pin\.onion\.real-diff\.changed/)
  assert.match(pinCss, /#pinDiffOverlay\{position:fixed/)
  assert.match(pinCss, /#pinDiffBadge\{position:fixed/)
  // Shipped flash/difference stay untouched and are still renderer-only defaults.
  assert.match(pinCss, /body\.onion-flash \.pin-surface\{animation:pin-onion-flash/)
  assert.match(pinScript, /TOGGLE_FLASH: 'toggle-flash'/)
  assert.match(pinDomainSource, /label: t\('pin\.onion\.menu-label'\)/)
  assert.match(pinDomainSource, /label: t\('pin\.onion\.real-diff\.side-effect'\)/)
  assert.doesNotMatch(pinDomainSource, /EXPERIMENT-ONLY/)
  // Main -> renderer messages only; the preload sends the mode echo through the existing
  // pin:context-menu envelope, so the frozen IPC surface is unchanged.
  assert.match(preload, /onionState: \(value\) =>/)
  assert.match(preload, /ipcRenderer\.send\('pin:context-menu', null, normalized\)/)
  assert.match(preload, /onScreenDiffFrame/)
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((match) => match[1])
  assert.equal(channels.filter((channel) => /screen-diff|onion/i.test(channel)).length, 0)
  // The view-export composition never draws the diff overlay (it is not in the plan).
  const pinViewExport = read('pin', 'pin-view-export.js')
  assert.doesNotMatch(pinViewExport, /pinDiffOverlay|screenDiff/)
  // The diff display math is a separate UMD contract, node-testable without a GUI.
  assert.match(read('pin', 'pin-diff-view.js'), /planDiffOverlay/)
})
// ---------------------------------------------------------------------------
// 7. Preload bridges: bounded frame/state validation, no new IPC channel.
// ---------------------------------------------------------------------------

function loadPinPreload() {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const sent = []
  const listeners = new Map()
  let exposed = null
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`unexpected require ${name}`)
      return {
        contextBridge: { exposeInMainWorld: (apiName, api) => { exposed = { apiName, api } } },
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
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'preload-pin.js'), 'utf8'), sandbox, { filename: 'preload-pin.js' })
  return { api: exposed.api, sent, listeners }
}

test('preload: onion state and diff frames are validated before they cross IPC', () => {
  const { api, sent, listeners } = loadPinPreload()
  // The renderer's mode echo rides the existing pin:context-menu envelope.
  assert.equal(api.onionState({ type: 'onion-state', mode: 'real-diff' }), true)
  assert.equal(sent.at(-1)[0], 'pin:context-menu')
  assert.equal(sent.at(-1)[1], null)
  assert.equal(sent.at(-1)[2].type, 'onion-state')
  assert.equal(sent.at(-1)[2].mode, 'real-diff')
  assert.equal(api.onionState({ type: 'onion-state', mode: 'made-up' }), false)
  assert.equal(api.onionState({ type: 'view-export-result', mode: 'flash' }), false)
  assert.equal(api.onionState(null), false)

  // Main -> renderer commands accept only the shipped vocabulary.
  const commands = []
  api.onOnionCommand((command) => commands.push(command))
  api.onOnionMode(({ mode, reason }) => commands.push({ mode, reason }))
  const handlers = listeners
  handlers.get('pin:onion-command')({}, { action: 'toggle-flash' })
  handlers.get('pin:onion-command')({}, { action: 'run-arbitrary-code' })
  handlers.get('pin:onion-mode')({}, { mode: 'real-diff', reason: 'hidden' })
  handlers.get('pin:onion-mode')({}, { mode: 'bogus', reason: 'x'.repeat(200) })
  assert.equal(commands.length, 3)
  assert.equal(commands[0].action, 'toggle-flash')
  assert.equal(commands[1].mode, 'real-diff')
  assert.equal(commands[1].reason, 'hidden')
  assert.equal(commands[2].mode, 'off')
  assert.equal(commands[2].reason, '')
  assert.ok(!commands.some((command) => command.action === 'run-arbitrary-code'))

  // Frames are bounded: dimensions, byte length and rectangle shape.
  const frames = []
  api.onScreenDiffFrame((frame) => frames.push(frame))
  const pixels = new Uint8Array(2 * 1 * 4)
  handlers.get('pin:screen-diff-frame')({}, {
    sequence: 3,
    width: 2,
    height: 1,
    dipRect: { x: 10, y: 20, width: 2, height: 1 },
    scaleFactor: 1.25,
    pixels
  })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].width, 2)
  assert.equal(frames[0].height, 1)
  assert.equal(frames[0].pixels, pixels)
  assert.equal(frames[0].dipRect.x, 10)
  assert.equal(frames[0].dipRect.y, 20)
  assert.equal(frames[0].dipRect.width, 2)
  assert.equal(frames[0].dipRect.height, 1)
  assert.equal(frames[0].scaleFactor, 1.25)
  // Wrong byte length, absurd dimensions and a non-buffer payload are dropped.
  handlers.get('pin:screen-diff-frame')({}, { width: 2, height: 1, pixels: new Uint8Array(3) })
  handlers.get('pin:screen-diff-frame')({}, { width: 20000, height: 2, pixels: new Uint8Array(20000 * 2 * 4) })
  handlers.get('pin:screen-diff-frame')({}, { width: 2, height: 1, pixels: 'nope' })
  assert.equal(frames.length, 1)
  // No dedicated channel names were added to the frozen surface.
  const fs = require('node:fs')
  const channels = [...fs.readFileSync(path.join(ROOT, 'preload-pin.js'), 'utf8').matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)]
    .map((match) => match[1])
  assert.equal(channels.filter((channel) => /screen-diff|onion/i.test(channel)).length, 0)
})