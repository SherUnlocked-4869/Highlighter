'use strict'

// N05 / DEV-08 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// EXPERIMENTAL real-screen pixel diff for the pin onion comparison.
//
// This prototype is intentionally NOT user-visible: the plan's gate is to prove, on the
// target Windows/DPI host, that the pixels under a pin can be captured while EXCLUDING the
// pin window itself. These tests cover the pure planning/measurement seams and the
// experiment-only main-process sampler; they cannot prove exclusion or alignment, so the
// final section asserts the shipped flash mode is still the default and nothing consumes
// diff frames. The real-window probe remains root's job.
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
// 5. Main-process experiment-only sampler (fake Electron touch points).
// ---------------------------------------------------------------------------

function createExperimentHarness() {
  const protectionCalls = []
  const capturedFrames = []
  const win = {
    _pinData: { rotation: 0 },
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 400, height: 200 }),
    setContentProtection: (enabled) => protectionCalls.push(enabled)
  }
  const desktopCapturer = {
    getSources: async ({ thumbnailSize }) => {
      capturedFrames.push(thumbnailSize)
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
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: () => null },
    clipboard: { writeImage: () => {} },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 400, height: 200 }) }) },
    screen: {
      getAllDisplays: () => [DISPLAY_PRIMARY],
      getDisplayMatching: () => DISPLAY_PRIMARY,
      getDisplayNearestPoint: () => DISPLAY_PRIMARY,
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    path,
    rootDirectory: ROOT,
    createLocalWindow: () => ({ isDestroyed: () => false, on: () => {}, webContents: { on: () => {} } }),
    getSettings: () => ({ fixedContent: { opacity: 1 }, plugins: {}, pinned: {} }),
    saveImageBuffer: async () => '',
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    pinImages: { add: () => 1, read: async () => ({ bytes: Buffer.from([1]), mime: 'image/png' }), retain: () => true, release: () => {}, stats: () => ({}) },
    getCreateCaptureWindow: () => async () => null,
    screenDiffDesktopCapturer: desktopCapturer,
    log: () => {},
    ipcMain: { on: () => {} }
  })
  return { domain, win, protectionCalls, capturedFrames }
}

test('experiment sampler: content protection toggles per frame and the frame is summary-only', async () => {
  const harness = createExperimentHarness()
  const sampler = harness.domain.createScreenDiffSampler({
    win: harness.win,
    intervalMs: 250,
    imageBounds: { x: 0, y: 0, width: 400, height: 200 }
  })
  assert.equal(sampler.ok, true)
  const frame = await sampler.sample()
  assert.equal(frame.ok, true)
  assert.equal(frame.width, 400)
  assert.equal(frame.height, 200)
  assert.equal(frame.bytes, 400 * 200 * 4)
  // Content protection was enabled for the capture and restored OFF afterwards.
  assert.deepEqual(harness.protectionCalls, [true, false])
  assert.deepEqual(harness.capturedFrames[0], { width: 1920, height: 1080 })
  // The sampler keeps numbers only, never the bitmap.
  assert.equal(sampler.getStats().frames, 1)
  assert.equal(sampler.getStats().maxBytesSeen, 400 * 200 * 4)
  sampler.stop('probe-done')
  assert.equal(sampler.getStats().stopped, true)
})

test('experiment sampler: refuses without a window or a content-protection setter', () => {
  const harness = createExperimentHarness()
  assert.deepEqual(harness.domain.createScreenDiffSampler({ win: null }), { ok: false, code: 'NO_WINDOW' })
  const bare = { ...harness.win, setContentProtection: undefined }
  assert.deepEqual(harness.domain.createScreenDiffSampler({ win: bare }), { ok: false, code: 'NO_CONTENT_PROTECTION' })
})

// ---------------------------------------------------------------------------
// 6. Not wired: the shipped flash mode stays the default.
// ---------------------------------------------------------------------------

test('wiring: the prototype is not reachable from any user surface', () => {
  const pinScript = read('pin', 'pin.js')
  const pinHtml = read('pin', 'pin.html')
  const pinCss = read('pin', 'pin.css')
  const pinDomainSource = read('main', 'domains', 'pin', 'index.js')
  // The renderer never loads or consumes the diff module; flash/difference are unchanged.
  assert.doesNotMatch(pinHtml, /pin-screen-diff/)
  assert.doesNotMatch(pinScript, /pinScreenDiff|screenDiff|screenPixels/)
  assert.match(pinCss, /body\.onion-flash \.pin-surface\{animation:pin-onion-flash/)
  assert.match(pinScript, /TOGGLE_FLASH: 'toggle-flash'/)
  // The context menu has no screen-diff entry: the experiment is driven by the probe only.
  assert.doesNotMatch(pinDomainSource, /label: t\('pin\.screen-diff/)
  assert.match(pinDomainSource, /EXPERIMENT-ONLY/)
  // The experimental module stays a separate UMD contract (node-testable) and is not
  // referenced from preload-pin.js either - no IPC surface was added for it.
  assert.doesNotMatch(read('preload-pin.js'), /screenDiff|screen-diff/)
})
