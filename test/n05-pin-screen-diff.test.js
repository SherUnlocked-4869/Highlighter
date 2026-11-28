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

// ---------------------------------------------------------------------------
// 4. Adoption gate: missing evidence is a reject.
// ---------------------------------------------------------------------------

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
      getAllDisplays: () => options.displays || [DISPLAY_PRIMARY],
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
function screenSource(displayId, { width = 1920, height = 1080, isEmpty = false } = {}) {
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => isEmpty,
      crop: (rect) => ({
        isEmpty: () => false,
        getSize: () => ({ width: rect.width, height: rect.height }),
        toBitmap: () => Buffer.alloc(rect.width * rect.height * 4)
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