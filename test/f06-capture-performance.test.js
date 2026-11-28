// F06 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §三.6):
// capture/long-capture/pin performance contracts.
//
// Covered here:
//   1. isBlankCapture short-circuit: a big PNG skips the synchronous nativeImage decode.
//   2. matcher coarse-to-fine: same decision as the old exhaustive scan, far fewer scores.
//   3. pin image store LRU: access order decides which resident pin spills to disk.
//   4. long-capture session render(): ONE composite pass straight to result.png.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')

const { createCaptureDomain } = require('../main/domains/capture')
const matcher = require('../long-capture/matcher')
const { LongCaptureSession } = require('../main/services/long-capture-session')
const {
  createFileIo,
  createPinImageStore
} = require('../main/services/pin-image-store')

const ROOT = path.join(__dirname, '..')

// ---------------------------------------------------------------------------
// 1. Capture domain: blank detection only decodes PNGs that could be blank.
// ---------------------------------------------------------------------------

const DISPLAY = { id: 7, scaleFactor: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 } }
const NATIVE_SIZE = { width: 3840, height: 2160 }

function createCaptureHarness({ pngBuffer, blankDecode = true }) {
  const decodes = []
  const sources = []
  const thumbnail = {
    isEmpty: () => false,
    getSize: () => NATIVE_SIZE,
    resize: () => ({ toBitmap: () => Buffer.from([9, 9, 9, 255]) }),
    toPNG: () => Buffer.from([137, 80, 78, 71])
  }
  const screenshotDesktop = async () => pngBuffer
  screenshotDesktop.parseDisplaysOutput = () => [{ id: DISPLAY.id }]
  const domain = createCaptureDomain({
    app: { isPackaged: false },
    spawn: () => ({ stdout: { setEncoding() {}, on() {} }, stderr: { setEncoding() {}, on() {} }, once() {}, stdin: { write() {}, end() {} }, kill() {} }),
    execFile: () => {},
    fs,
    path,
    screen: {
      getDisplayMatching: () => DISPLAY,
      getDisplayNearestPoint: () => DISPLAY,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => null },
    desktopCapturer: {
      getSources: async (options) => {
        sources.push(options)
        return [{ id: 'screen:7', display_id: String(DISPLAY.id), thumbnail }]
      }
    },
    nativeImage: {
      createFromBuffer: (buffer) => {
        decodes.push(buffer.length)
        return {
          isEmpty: () => false,
          getSize: () => NATIVE_SIZE,
          resize: () => ({ toBitmap: () => blankDecode ? Buffer.alloc(32 * 32 * 4) : Buffer.from([9, 9, 9, 255]) })
        }
      }
    },
    clipboard: { writeImage: () => {} },
    dialog: { showErrorBox: () => {} },
    performance: { now: () => 0 },
    rootDirectory: ROOT,
    isWin: true,
    createLocalWindow: () => ({ isDestroyed: () => false }),
    getSettings: () => ({ screenshot: {} }),
    log: () => {},
    assertGameModeDisabled: () => {},
    getScreenshotDesktop: () => screenshotDesktop,
    listNativeDisplays: async () => [{ id: DISPLAY.id }],
    findNativeDisplay: () => ({ id: DISPLAY.id }),
    getNativeDisplayBounds: () => NATIVE_SIZE,
    readPngSize: () => NATIVE_SIZE,
    shouldFilterApp: () => false,
    pinDomain: {},
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: () => {},
    saveImageBuffer: async () => '',
    imageDataToBuffer: (value) => value,
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record() {}, snapshot() {} }
  })
  return { domain, decodes, sources }
}

test('F06 blank-capture: a screenshot-sized PNG is accepted without decoding', async () => {
  const buffer = Buffer.alloc(256 * 1024 + 1, 0)
  const { domain, decodes, sources } = createCaptureHarness({ pngBuffer: buffer })
  const capture = await domain.getDisplayCapture(DISPLAY)
  assert.equal(capture.backend, 'native')
  assert.equal(capture.imageBuffer, buffer)
  assert.deepEqual(decodes, [], 'the large PNG must not be synchronously decoded on the main thread')
  assert.equal(sources.length, 0, 'no Electron fallback capture either')
})

test('F06 blank-capture: a solid-colour 4K frame is still probed (measured ~166 KiB black)', async () => {
  // The review's 32 KiB estimate would have skipped this; a failed native capture returns a
  // black frame, so the fallback must still see it.
  const buffer = Buffer.alloc(166 * 1024, 0)
  const { domain, decodes, sources } = createCaptureHarness({ pngBuffer: buffer, blankDecode: true })
  const capture = await domain.getDisplayCapture(DISPLAY)
  // The fake image is all black, so the native attempt is rejected and the electron path wins.
  assert.equal(capture.backend, 'electron')
  assert.equal(capture.fallbackReason, 'native-blank')
  assert.deepEqual(decodes, [buffer.length], 'small buffers keep the original detection logic')
  assert.equal(sources.length, 1)
  assert.deepEqual(capture.imageBuffer, Buffer.from([137, 80, 78, 71]))
})

test('F06 blank-capture: a small non-blank PNG still wins as the native backend', async () => {
  const buffer = Buffer.alloc(1024, 0)
  const { domain, decodes } = createCaptureHarness({ pngBuffer: buffer, blankDecode: false })
  const capture = await domain.getDisplayCapture(DISPLAY)
  assert.equal(capture.backend, 'native')
  assert.equal(capture.imageBuffer, buffer)
  assert.deepEqual(decodes, [buffer.length])
})

// ---------------------------------------------------------------------------
// 2. Matcher: coarse profile scan + narrow full-score refinement.
// ---------------------------------------------------------------------------

// The verbatim pre-F06 decision procedure, used as the reference oracle. Only the
// scoring helpers are borrowed from the module; the scan/enumeration is the old one.
function referenceFindBestShift(previous, current, width, height, axis) {
  const stillStep = Math.max(1, Math.floor(previous.length / 12000))
  let stillDifference = 0
  let stillSamples = 0
  for (let index = 0; index < previous.length; index += stillStep) {
    stillDifference += Math.abs(previous[index] - current[index])
    stillSamples += 1
  }
  const stillScore = stillSamples ? stillDifference / stillSamples : 0
  if (stillScore <= 2.8) return { status: 'still', shift: 0, score: stillScore }

  const axisLength = axis === 'horizontal' ? width : height
  const minimumShift = Math.max(2, Math.floor(axisLength * 0.004))
  const maximumShift = Math.max(minimumShift, Math.floor(axisLength * 0.82))
  const scores = new Float64Array(maximumShift * 2 + 1)
  scores.fill(Number.POSITIVE_INFINITY)
  let bestShift = 0
  let bestScore = Number.POSITIVE_INFINITY
  let evaluated = 0
  for (const sign of [1, -1]) {
    for (let amount = minimumShift; amount <= maximumShift; amount++) {
      const shift = amount * sign
      const score = matcher.scoreShift(previous, current, width, height, axis, shift)
      evaluated += 1
      scores[shift + maximumShift] = score
      if (!bestShift || score < bestScore) {
        bestShift = shift
        bestScore = score
      }
    }
  }
  if (!bestShift) return { status: 'failed', shift: 0, score: Number.POSITIVE_INFINITY, evaluated }
  const coarseBestShift = bestShift
  bestShift = 0
  bestScore = Number.POSITIVE_INFINITY
  for (let shift = coarseBestShift - 1; shift <= coarseBestShift + 1; shift++) {
    if (Math.abs(shift) < minimumShift || Math.abs(shift) > maximumShift) continue
    const score = scores[shift + maximumShift]
    if (!bestShift || score < bestScore) {
      bestShift = shift
      bestScore = score
    }
  }
  let secondScore = Number.POSITIVE_INFINITY
  for (const sign of [1, -1]) {
    for (let amount = minimumShift; amount <= maximumShift; amount++) {
      const shift = amount * sign
      if (shift * bestShift >= 0 && Math.abs(shift - bestShift) <= 5) continue
      secondScore = Math.min(secondScore, scores[shift + maximumShift])
    }
  }
  const margin = Number.isFinite(secondScore) ? secondScore - bestScore : 255 - bestScore
  const accepted = bestScore <= 24 && margin >= 0.8
  return { status: accepted ? 'matched' : 'failed', shift: accepted ? bestShift : 0, score: bestScore, margin, evaluated }
}

function makeFrame(width, height, valueAt) {
  const frame = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) frame[y * width + x] = valueAt(x, y)
  }
  return frame
}

function scrollPair(base, width, height, axis, shift) {
  const current = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = axis === 'horizontal' ? x + shift : x
      const sourceY = axis === 'vertical' ? y + shift : y
      current[y * width + x] = sourceY >= 0 && sourceY < height && sourceX >= 0 && sourceX < width
        ? base[sourceY * width + sourceX]
        : (x * 13 + y * 7 + shift * 11) & 0xff
    }
  }
  return current
}

// A deterministic LCG stream, mirroring the benchmark's synthetic frame generator.
function lcgFrame(length, seed) {
  let state = seed >>> 0
  const output = new Uint8Array(length)
  for (let index = 0; index < output.length; index++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    output[index] = state >>> 24
  }
  return output
}

function assertSameDecision(name, previous, current, width, height, axis) {
  const reference = referenceFindBestShift(previous, current, width, height, axis)
  const result = matcher.findBestShift(previous, current, width, height, axis)
  assert.equal(result.status, reference.status, `${name}: decision parity`)
  if (reference.status === 'matched') {
    const delta = Math.abs(result.shift - reference.shift)
    assert.ok(delta <= 1, `${name}: coarse+fine shift ${result.shift} vs exhaustive ${reference.shift}`)
    const exhaustiveCandidates = reference.evaluated
    assert.ok(result.evaluatedShifts <= 8 * (2 * 4 + 1), `${name}: refinement window stays bounded (${result.evaluatedShifts})`)
    assert.ok(result.evaluatedShifts * 4 < exhaustiveCandidates,
      `${name}: ${result.evaluatedShifts} scores vs ${exhaustiveCandidates} exhaustive ones`)
  }
  return { reference, result }
}

test('F06 matcher: coarse+fine matches the exhaustive scan on structured scroll pairs', () => {
  const vertical = { width: 96, height: 600 }
  const verticalBase = makeFrame(vertical.width, vertical.height, (x, y) => {
    const line = Math.floor(y / 11)
    const glyph = ((x * 5 + line * 7) % 19) < 10
    return (line * 37 + Math.floor(x / 3) * 11 + (glyph ? 55 : 0) + y * 3) & 0xff
  })
  for (const shift of [137, -91, 7, 2, -233, 491]) {
    const current = scrollPair(verticalBase, vertical.width, vertical.height, 'vertical', shift)
    const { result } = assertSameDecision(`vertical ${shift}`, verticalBase, current, vertical.width, vertical.height, 'vertical')
    assert.equal(result.shift, shift, 'an exact scroll must resolve to the real shift')
  }

  const horizontal = { width: 400, height: 96 }
  const horizontalBase = makeFrame(horizontal.width, horizontal.height, (x, y) => {
    const column = Math.floor(x / 9)
    const glyph = ((x * 3 + y * 13) % 23) < 12
    return (column * 29 + y * 17 + (glyph ? 61 : 0) + x * 2) & 0xff
  })
  for (const shift of [53, -29, 11, -157, 301]) {
    const current = scrollPair(horizontalBase, horizontal.width, horizontal.height, 'horizontal', shift)
    const { result } = assertSameDecision(`horizontal ${shift}`, horizontalBase, current, horizontal.width, horizontal.height, 'horizontal')
    assert.equal(result.shift, shift, 'an exact horizontal scroll must resolve to the real shift')
  }
})

test('F06 matcher: coarse+fine matches the exhaustive scan on random and noisy frames', () => {
  const width = 96
  const height = 240
  const randomBase = lcgFrame(width * height, 0x12345678)
  for (const shift of [36, -17, 5, 101]) {
    const current = scrollPair(randomBase, width, height, 'vertical', shift)
    const { result } = assertSameDecision(`random ${shift}`, randomBase, current, width, height, 'vertical')
    assert.equal(result.shift, shift)
  }
  // Sub-pixel-ish capture noise: the exhaustive answer is still the oracle, equality is the goal
  // and a one-pixel drift is explicitly tolerated by the review's acceptance criteria.
  const clean = scrollPair(randomBase, width, height, 'vertical', 36)
  const noisy = new Uint8Array(clean.length)
  for (let index = 0; index < clean.length; index++) {
    noisy[index] = Math.max(0, Math.min(255, clean[index] + ((index * 37) % 7) - 3))
  }
  const { reference, result } = assertSameDecision('noisy 36', randomBase, noisy, width, height, 'vertical')
  assert.ok(Math.abs(result.shift - reference.shift) <= 1)
})

test('F06 matcher: still frames and repeated patterns keep their previous decisions', () => {
  const width = 72
  const height = 58
  const base = makeFrame(width, height, (x, y) => (x * 17 + y * 29 + x * y * 3) % 251)
  const still = matcher.findBestShift(base, base.slice(), width, height, 'vertical')
  assert.equal(still.status, 'still')
  assert.equal(still.shift, 0)

  const repeatedBase = makeFrame(width, height, (_x, y) => (y % 8) * 24)
  const repeatedShifted = makeFrame(width, height, (_x, y) => ((y + 3) % 8) * 24)
  assertSameDecision('repeated rows', repeatedBase, repeatedShifted, width, height, 'vertical')
  assert.equal(matcher.findBestShift(repeatedBase, repeatedShifted, width, height, 'vertical').status, 'failed',
    'a repeated pattern has no unique mapping, so it must stay rejected')
})

test('F06 matcher: 4K-length frame keeps the exhaustive answer at a fraction of the cost', () => {
  const width = 96
  const height = 2160
  const base = lcgFrame(width * height, 0x0badcafe)
  const shift = 360
  const current = scrollPair(base, width, height, 'vertical', shift)
  const { reference, result } = assertSameDecision('4K vertical 360', base, current, width, height, 'vertical')
  assert.equal(result.shift, shift)
  assert.ok(result.evaluatedShifts * 10 < reference.evaluated)
})

// ---------------------------------------------------------------------------
// 3. Pin image store: LRU resident set.
// ---------------------------------------------------------------------------

async function makeTempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-f06-pin-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}))
  return root
}

function pinBytes(length, seed) {
  const bytes = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index++) bytes[index] = (index * 31 + seed) & 0xff
  return bytes
}

test('F06 pin store: read() changes which resident pin spills (LRU, not FIFO)', async (t) => {
  const root = await makeTempRoot(t)
  const store = createPinImageStore({ memoryBudget: 100, tmpdir: root })
  try {
    const first = store.add({ bytes: pinBytes(60, 1), mime: 'image/png' })
    const second = store.add({ bytes: pinBytes(30, 2), mime: 'image/png' })
    assert.equal(store.stats().residentBytes, 90)

    // Touch the OLDEST pin: LRU then has to spill the middle one instead.
    assert.deepEqual((await store.read(first)).bytes, pinBytes(60, 1))
    const third = store.add({ bytes: pinBytes(30, 3), mime: 'image/png' })
    assert.equal(store.stats().residentBytes, 90, 'the just-used pin plus the new one stay resident')
    assert.equal(store.stats().spilled, 1)

    await store.whenIdle()
    assert.equal(store.stats().spilled, 1)
    assert.equal(store.stats().residentBytes, 90)
    assert.equal(store.stats().handles, 1)
    // Every pin still reads back its own pixels, including the evicted one.
    assert.deepEqual((await store.read(first)).bytes, pinBytes(60, 1))
    assert.deepEqual((await store.read(second)).bytes, pinBytes(30, 2))
    assert.deepEqual((await store.read(third)).bytes, pinBytes(30, 3))
    for (const id of [first, second, third]) store.release(id)
    await store.whenIdle()
    assert.equal(store.stats().assets, 0)
    assert.equal(store.stats().handles, 0)
  } finally {
    store.dispose()
  }
})

test('F06 pin store: a new pin no longer pays for the disk while old ones hold memory', async (t) => {
  const root = await makeTempRoot(t)
  const store = createPinImageStore({ memoryBudget: 100, tmpdir: root })
  try {
    const oldest = store.add({ bytes: pinBytes(60, 4), mime: 'image/png' })
    const middle = store.add({ bytes: pinBytes(30, 5), mime: 'image/png' })
    // 120 > 100: FIFO would have spilled the newest 30-byte pin and kept the 60-byte one.
    const newest = store.add({ bytes: pinBytes(30, 6), mime: 'image/png' })
    assert.equal(store.stats().residentBytes, 60, 'the oldest pin is the spill victim; the new pin stays resident')
    await store.whenIdle()
    assert.equal(store.stats().handles, 1, 'exactly one spill file was opened')
    assert.equal(store.stats().residentBytes, 60)
    assert.deepEqual((await store.read(oldest)).bytes, pinBytes(60, 4))
    assert.deepEqual((await store.read(newest)).bytes, pinBytes(30, 6))
    for (const id of [oldest, middle, newest]) store.release(id)
    await store.whenIdle()
    assert.equal(store.stats().assets, 0)
  } finally {
    store.dispose()
  }
})

test('F06 pin store: a failed LRU spill keeps the evicted pin resident (disk-full fallback)', async (t) => {
  const root = await makeTempRoot(t)
  const real = createFileIo()
  const io = {
    ...real,
    write: async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
  }
  const failures = []
  const store = createPinImageStore({
    memoryBudget: 100,
    tmpdir: root,
    io,
    onError: (error, info) => failures.push({ code: error.code, phase: info.phase })
  })
  try {
    const first = store.add({ bytes: pinBytes(60, 7), mime: 'image/png' })
    store.add({ bytes: pinBytes(30, 8), mime: 'image/png' })
    store.add({ bytes: pinBytes(30, 9), mime: 'image/png' })
    await store.whenIdle()
    assert.deepEqual(failures, [{ code: 'ENOSPC', phase: 'spill-write' }])
    assert.equal(store.stats().spillFailures, 1)
    // The refused spill degrades to resident pixels instead of losing the pin.
    assert.equal(store.stats().failedFallbackBytes, 60)
    assert.equal(store.stats().residentBytes, 120)
    assert.deepEqual((await store.read(first)).bytes, pinBytes(60, 7))
    store.release(first)
    await store.whenIdle()
    assert.equal(store.stats().assets, 2)
  } finally {
    store.dispose()
  }
})

// ---------------------------------------------------------------------------
// 4. Long-capture session: single composite pass to result.png.
// ---------------------------------------------------------------------------

async function stripPng(width, height, seed) {
  const raw = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      raw[index] = (x * 7 + seed * 31) & 0xff
      raw[index + 1] = (y * 11 + seed * 17) & 0xff
      raw[index + 2] = (x * y * 3 + seed * 53) & 0xff
      raw[index + 3] = 255
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

// The pre-F06 render pipeline, kept verbatim as the pixel reference: compose to
// composite.png, then extract (or copy) to the result.
async function renderWithReferencePipeline(session) {
  const rawSize = session.getUntrimmedSize()
  const size = session.getSize()
  let offset = 0
  const inputs = session.strips.map((strip) => {
    const input = {
      input: strip.filePath,
      left: session.axis === 'horizontal' ? offset : 0,
      top: session.axis === 'vertical' ? offset : 0
    }
    offset += session.axis === 'vertical' ? strip.height : strip.width
    return input
  })
  const compositePath = path.join(session.directory, 'composite-reference.png')
  const outputPath = path.join(session.directory, 'result-reference.png')
  await sharp({
    create: { width: rawSize.width, height: rawSize.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    limitInputPixels: false
  }).composite(inputs).png({ compressionLevel: 6 }).toFile(compositePath)
  if (session.trimStart || session.trimEnd) {
    const extract = session.axis === 'vertical'
      ? { left: 0, top: session.trimStart, width: size.width, height: size.height }
      : { left: session.trimStart, top: 0, width: size.width, height: size.height }
    await sharp(compositePath, { limitInputPixels: false }).extract(extract).png({ compressionLevel: 6 }).toFile(outputPath)
  } else {
    fs.copyFileSync(compositePath, outputPath)
  }
  return outputPath
}

async function rawPixels(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

async function buildSession(axis, tempRoot) {
  const session = new LongCaptureSession({ axis, tempRoot })
  if (axis === 'vertical') {
    for (const [index, height] of [6, 5, 9].entries()) {
      session.addStrip(await stripPng(8, height, index + 1), { width: 8, height })
    }
  } else {
    for (const [index, width] of [6, 5, 9].entries()) {
      session.addStrip(await stripPng(width, 8, index + 4), { width, height: 8 })
    }
  }
  return session
}

test('F06 long-capture render: one pass to result.png is pixel-identical to the old pipeline', async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-f06-long-'))
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }))
  const cases = [
    { axis: 'vertical', trim: [0, 0] },
    { axis: 'vertical', trim: [3, 4] },
    { axis: 'vertical', trim: [0, 7] },
    { axis: 'horizontal', trim: [0, 0] },
    { axis: 'horizontal', trim: [2, 4] }
  ]
  for (const { axis, trim } of cases) {
    const session = await buildSession(axis, tempRoot)
    try {
      session.setTrim(trim[0], trim[1])
      const expectedSize = session.getSize()
      const output = await session.render()
      assert.ok(fs.existsSync(output), 'render() produced result.png')
      assert.equal(path.basename(output), 'result.png')

      const reference = await renderWithReferencePipeline(session)
      const actual = await rawPixels(output)
      const previous = await rawPixels(reference)
      assert.equal(actual.width, expectedSize.width, `${axis} ${trim}: width matches the old implementation`)
      assert.equal(actual.height, expectedSize.height, `${axis} ${trim}: height matches the old implementation`)
      assert.equal(actual.width, previous.width)
      assert.equal(actual.height, previous.height)
      assert.equal(Buffer.compare(actual.data, previous.data), 0, `${axis} ${trim}: pixel-identical output`)

      // Only the strips and the final result may exist: no composite.png round trip.
      const produced = fs.readdirSync(session.directory)
        .filter((name) => name.endsWith('.png') && !name.startsWith('strip-') && !name.endsWith('-reference.png'))
      assert.deepEqual(produced, ['result.png'], `${axis} ${trim}: the render writes no intermediate PNG`)
      // A second call is served from the cache instead of composing again.
      assert.equal(await session.render(), output)
    } finally {
      session.cleanup()
    }
  }
})

test('F06 long-capture render: untrimmed output is a real PNG file, not a byte copy', async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-f06-long-copy-'))
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }))
  const session = await buildSession('vertical', tempRoot)
  try {
    const output = await session.render()
    const metadata = await sharp(output).metadata()
    const size = session.getSize()
    assert.equal(metadata.width, size.width)
    assert.equal(metadata.height, size.height)
    assert.equal(fs.existsSync(path.join(session.directory, 'composite.png')), false,
      'the old composite.png intermediate must not be produced')
  } finally {
    session.cleanup()
  }
})
