'use strict'

// N05 / DEV-08 measurement probe: can Windows screen capture return the REAL pixels under
// a pin while excluding the pin window itself?
//
// This is a pure measurement tool: it imports only the side-effect-free UMD planner
// (pin/pin-screen-diff.js) and Electron. It never imports the product domains, never
// writes user data and never keeps a frame after a check. Run it on a desktop session with
// a secondary display; it opens its own small always-on-top windows there.
//
//   node_modules/electron/dist/electron.exe --no-sandbox scripts/probe-pin-screen-diff.js \
//       [--out .tmp-work/probe/out/pin-screen-diff.json] [--frames 30]
//
// Method per check:
//   * POSITIVE CONTROL: the probe window is a solid colour; with content protection OFF
//     the captured region must be dominated by that colour (screen capture really sees it);
//   * EXCLUDED: with `win.setContentProtection(true)` the same region must NOT contain the
//     window's colour, while what is behind it (desktop / a second window) is captured;
//   * STACKED PINS: a protected top window over an unprotected bottom window: the capture
//     must show the bottom window's colour and none of the top's (no ghost rectangle);
//   * NEGATIVE COORDINATES: the same checks for a window placed at the secondary display's
//     negative-origin edge (this host's secondary display starts at y = -136);
//   * ALIGNMENT: consecutive protected frames of an unchanged desktop must diff to ~0 with
//     the shared RGBA diff, and the frame bytes/interval feed the adoption gate;
//   * PRODUCTION ENTRY (P1-01): the PRODUCT domain (createPinDomain) is constructed
//     WITHOUT `screenDiffDesktopCapturer` - exactly like main.js - and asked for its first
//     frame, a couple of 1 Hz updates and a manual stop. This is the wiring the review
//     found broken ("capturer.getSources is not a function"): the direct desktopCapturer
//     checks above deliberately bypass it, so this section is the only one that proves the
//     shipped entry works.
//
// Verdict uses pin/pin-screen-diff.js thresholds (selfCaptureRatio, alignmentRatio, frame
// budget, rate); the JSON keeps every raw ratio so the conclusion is reproducible.

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, screen, desktopCapturer, clipboard, nativeImage, Menu, ipcMain } = require('electron')

const ROOT = path.join(__dirname, '..')
const diffApi = require(path.join(ROOT, 'pin', 'pin-screen-diff.js'))
const { createPinDomain } = require(path.join(ROOT, 'main', 'domains', 'pin'))

const COLOUR_TOP = { r: 0xe1, g: 0x1d, b: 0x48 } // #e11d48, the "pin" window
const COLOUR_BOTTOM = { r: 0x25, g: 0x63, b: 0xeb } // #2563eb, what is behind it
const COLOUR_TOLERANCE = 24
const VISIBLE_MIN_RATIO = 0.5
const STACKED_BOTTOM_MIN_RATIO = 0.2

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const OUTPUT_PATH = path.isAbsolute(readArgument('--out', ''))
  ? readArgument('--out', '')
  : path.join(ROOT, readArgument('--out', path.join('.tmp-work', 'probe', 'out', 'pin-screen-diff.json')))
const PROTECTED_FRAMES = Math.max(3, Math.round(Number(readArgument('--frames', '30')) || 30))
const FRAME_INTERVAL_MS = 1050
// Consecutive frames over the STACKED pair: the bottom window is a solid, static colour,
// so pair differences can only come from the capture/exclusion path (a controlled
// "unchanged design"). This is the alignment metric the adoption gate uses; the live
// desktop behind a lone protected window is not an unchanged design and is reported
// separately as desktopAlignmentRatio.
const STACKED_ALIGNMENT_FRAMES = 10

function log() {
  process.stdout.write('[probe] ' + Array.from(arguments).join(' ') + '\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function colourFraction(pixels, width, height, colour) {
  let hits = 0
  const total = width * height
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    if (
      Math.abs(pixels[offset] - colour.r) <= COLOUR_TOLERANCE &&
      Math.abs(pixels[offset + 1] - colour.g) <= COLOUR_TOLERANCE &&
      Math.abs(pixels[offset + 2] - colour.b) <= COLOUR_TOLERANCE
    ) hits += 1
  }
  return hits / Math.max(1, total)
}

async function createColourWindow(display, bounds, colour, { protected: initiallyProtected = false } = {}) {
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: colour,
    skipTaskbar: true,
    alwaysOnTop: true,
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const html = '<!doctype html><html><body style="margin:0;background:' + colour + ';width:100vw;height:100vh"></body></html>'
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.setContentProtection(initiallyProtected === true)
  win.showInactive()
  await sleep(700)
  return win
}

function displaysSnapshot() {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    primary: display.id === screen.getPrimaryDisplay().id
  }))
}

async function grabFrame(display, plan) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: plan.thumbnail })
  // P2-03: identity-confirmed source only. A single-display host may fall back by
  // elimination (drivers that omit display_id); a multi-display host must match display_id
  // or the frame is refused rather than cropped from the wrong screen.
  const picked = diffApi.pickScreenSource(sources, display.id, {
    singleDisplay: screen.getAllDisplays().length === 1
  })
  if (!picked || picked.ok !== true) {
    throw new Error('no usable screen source: ' + String(picked?.code || 'UNKNOWN'))
  }
  const full = picked.source.thumbnail
  const fullSize = full.getSize()
  const rect = {
    x: Math.max(0, Math.min(plan.physicalRect.x, fullSize.width - 1)),
    y: Math.max(0, Math.min(plan.physicalRect.y, fullSize.height - 1)),
    width: 0,
    height: 0
  }
  rect.width = Math.max(1, Math.min(plan.physicalRect.width, fullSize.width - rect.x))
  rect.height = Math.max(1, Math.min(plan.physicalRect.height, fullSize.height - rect.y))
  const crop = full.crop(rect)
  if (!crop || (typeof crop.isEmpty === 'function' && crop.isEmpty())) throw new Error('empty crop')
  const size = crop.getSize()
  // Electron's nativeImage.toBitmap() is BGRA on Windows; the shared helper normalises it
  // to opaque RGBA (getBitmap() is deprecated and is deliberately not used).
  const pixels = diffApi.bgraToRgba(crop.toBitmap())
  if (!pixels || pixels.length !== size.width * size.height * 4) throw new Error('bad bitmap length')
  return {
    sourceId: picked.source.id,
    matchedDisplayId: picked.matched,
    size,
    fullSize,
    pixels,
    bytes: pixels.length
  }
}

function planFor(win, displays) {
  const bounds = win.getBounds()
  return {
    bounds,
    plan: diffApi.planScreenCapture({
      pinBounds: bounds,
      imageBounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
      displays,
      rotation: 0
    })
  }
}

// P1-01: the PRODUCTION entry, deliberately NOT the direct desktopCapturer used above.
// The pin domain is constructed with the same dependency surface main.js provides and
// WITHOUT `screenDiffDesktopCapturer`, so only its own default resolution can find
// Electron's desktopCapturer. A visible frameless window placed on the chosen display
// stands in for the pin window the capture path expects (AGENTS.md: visible automation
// windows belong on the secondary display). Sequence: first frame -> two 1 Hz updates ->
// manual stop.
async function runProductionEntry(display) {
  const entry = {
    windowBounds: null,
    firstFrame: null,
    start: false,
    updates: 0,
    deliveredFrames: 0,
    stopped: false,
    protectionCalls: []
  }
  const domain = createPinDomain({
    BrowserWindow,
    clipboard,
    nativeImage,
    screen,
    Menu,
    path,
    rootDirectory: ROOT,
    // The capture path never creates windows, so this only satisfies the domain's guard.
    createLocalWindow: (pagePath, options) => new BrowserWindow(options),
    getSettings: () => ({ fixedContent: { opacity: 1, zoomWithMouse: true }, plugins: {}, pinned: {} }),
    saveImageBuffer: async () => '',
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    getCreateCaptureWindow: () => async () => null,
    // Memory-only store: the production entry check must not write user data.
    pinImages: {
      add: () => 'probe-image',
      read: async () => ({ bytes: Buffer.from([1]), mime: 'image/png' }),
      retain: () => true,
      release: () => {},
      stats: () => ({ resident: 0, assets: 0, handles: 0 })
    },
    log: (...args) => log('[domain]', ...args),
    ipcMain
  })
  const bounds = {
    x: display.workArea.x + 120,
    y: display.workArea.y + 100,
    width: 420,
    height: 280
  }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    useContentSize: true,
    backgroundColor: '#e11d48',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><html><body style="margin:0;background:#e11d48;width:100vw;height:100vh"></body></html>'
    ))
    win.showInactive()
    await sleep(600)
    // The window-level fields the real createPinWindow sets and the capture path reads.
    win._pinData = { rotation: 0 }
    win._onionMode = 'off'
    win._pinContentProtection = false
    win._realPixelCompare = null
    entry.windowBounds = win.getBounds()
    const originalSetContentProtection = win.setContentProtection.bind(win)
    win.setContentProtection = (enabled) => {
      entry.protectionCalls.push(enabled === true)
      return originalSetContentProtection(enabled === true)
    }
    const delivered = []
    const originalSend = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, payload) => {
      if (channel === 'pin:screen-diff-frame') delivered.push(payload)
      return originalSend(channel, payload)
    }
    const content = win.getContentBounds()
    const imageBounds = { x: 0, y: 0, width: content.width, height: content.height }
    const first = await domain.captureScreenUnderPin(win, imageBounds)
    entry.firstFrame = first.ok
      ? {
          ok: true,
          width: first.width,
          height: first.height,
          bytes: first.bytes,
          sourceMatched: first.sourceMatched,
          displayId: first.plan.display.id,
          physicalRect: first.plan.physicalRect,
          thumbnail: first.plan.thumbnail
        }
      : { ok: false, code: first.code, message: first.message || '' }
    // The frame itself is dropped here on purpose: the probe never retains pixels.
    const started = domain.startRealPixelCompare(win, imageBounds)
    entry.start = started.ok === true
    if (started.ok) {
      for (let index = 0; index < 2; index += 1) {
        const update = await started.sampleNow()
        if (update && update.ok) entry.updates += 1
        if (index === 0) await sleep(FRAME_INTERVAL_MS)
      }
      const stats = started.getStats()
      entry.deliveredFrames = delivered.filter((payload) => payload && payload.pixels).length
      entry.session = {
        frames: stats.frames,
        retryableFailures: stats.retryableFailures,
        lastRetryableCode: stats.lastRetryableCode,
        stopped: stats.stopped
      }
      const firstPayload = delivered[0]
      if (firstPayload) {
        entry.frame = {
          width: firstPayload.width,
          height: firstPayload.height,
          pixels: firstPayload.pixels.length,
          dipRect: firstPayload.dipRect,
          scaleFactor: firstPayload.scaleFactor
        }
      }
      entry.stopped = started.stop('probe-done') === true
      entry.protectionRestored = win._pinContentProtection !== true
    }
  } catch (error) {
    entry.error = error && (error.stack || error.message)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await sleep(300)
  }
  entry.proven = entry.firstFrame?.ok === true && entry.start === true && entry.updates >= 1 &&
    entry.deliveredFrames >= 1 && entry.stopped === true && entry.protectionRestored === true &&
    entry.protectionCalls[0] === true && entry.protectionCalls.at(-1) === false
  return entry
}

async function run() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  const result = {
    at: new Date().toISOString(),
    windows: process.getSystemVersion(),
    electron: process.versions.electron,
    displayScaleFactorMode: 'per-display (Electron screen API)',
    protocol: {
      frames: PROTECTED_FRAMES,
      intervalMs: FRAME_INTERVAL_MS,
      colourTolerance: COLOUR_TOLERANCE,
      bitmapConversion: 'toBitmap() BGRA -> RGBA (pin-screen-diff.bgraToRgba)',
      thresholds: {
        selfCaptureMaxRatio: diffApi.SELF_CAPTURE_MAX_RATIO,
        alignmentToleranceRatio: diffApi.ALIGNMENT_TOLERANCE_RATIO,
        minProbeSamples: diffApi.MIN_PROBE_SAMPLES
      }
    },
    displays: displaysSnapshot(),
    checks: {},
    notes: []
  }
  const primary = screen.getPrimaryDisplay()
  const display = screen.getAllDisplays().find((entry) => entry.id !== primary.id) || primary
  result.secondary = {
    used: display.id !== primary.id,
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation
  }
  if (display.id === primary.id) {
    result.notes.push('no secondary display; single-display result')
  }

  // ---- Check A/B/C/D: single pin window, exclusion + move + alignment ------------
  const baseBounds = {
    x: display.workArea.x + 140,
    y: display.workArea.y + 180,
    width: 426,
    height: 284
  }
  const win = await createColourWindow(display, baseBounds, '#e11d48')
  const displays = result.displays
  let plan = planFor(win, displays).plan
  result.checks.single = { bounds: win.getBounds().toJSON ? win.getBounds() : win.getBounds(), plan: plan.ok ? {
    displayId: plan.display.id,
    dipRect: plan.dipRect,
    physicalRect: plan.physicalRect,
    thumbnail: plan.thumbnail,
    scaleFactor: plan.scaleFactor
  } : { ok: false, code: plan.code } }
  if (!plan.ok) {
    win.destroy()
    result.status = 'plan-failed'
    return result
  }

  win.setContentProtection(false)
  await sleep(500)
  const visible = await grabFrame(display, plan)
  const visibleRatio = colourFraction(visible.pixels, visible.size.width, visible.size.height, COLOUR_TOP)
  result.checks.single.positiveControl = { colourRatio: visibleRatio, size: visible.size, sourceMatched: visible.matchedDisplayId }

  win.setContentProtection(true)
  await sleep(600)
  const frames = []
  let previous = null
  const startedAt = Date.now()
  for (let index = 0; index < PROTECTED_FRAMES; index += 1) {
    const frame = await grabFrame(display, plan)
    const colourRatio = colourFraction(frame.pixels, frame.size.width, frame.size.height, COLOUR_TOP)
    let alignmentRatio = null
    if (previous && previous.size.width === frame.size.width && previous.size.height === frame.size.height) {
      const diff = diffApi.diffRgba(previous.pixels, frame.pixels, {
        width: frame.size.width,
        height: frame.size.height,
        tolerance: 8
      })
      alignmentRatio = diff.ok ? diff.ratio : null
    }
    frames.push({ index, colourRatio, alignmentRatio, bytes: frame.bytes })
    previous = frame
    if (index < PROTECTED_FRAMES - 1) await sleep(FRAME_INTERVAL_MS)
  }
  const elapsedMs = Date.now() - startedAt
  const protectedRatios = frames.map((frame) => frame.colourRatio)
  const alignmentRatios = frames.map((frame) => frame.alignmentRatio).filter((value) => Number.isFinite(value))
  const selfCaptureRatio = Math.max(...protectedRatios)
  const alignmentRatio = alignmentRatios.length
    ? alignmentRatios.reduce((sum, value) => sum + value, 0) / alignmentRatios.length
    : Number.NaN
  result.checks.single.exclusion = {
    frames: frames.length,
    colourRatios: protectedRatios,
    selfCaptureRatio,
    maxFrameBytes: Math.max(...frames.map((frame) => frame.bytes)),
    intervalMs: Math.round(elapsedMs / Math.max(1, frames.length - 1))
  }
  result.checks.single.alignment = { ratios: alignmentRatios, alignmentRatio }

  // Move while protected: exclusion follows the geometry, no ghost of the old rect.
  const movedBounds = { x: baseBounds.x + 40, y: baseBounds.y + 20, width: baseBounds.width, height: baseBounds.height }
  win.setContentProtection(false)
  win.setBounds(movedBounds)
  win.setContentProtection(true)
  await sleep(600)
  const movedPlan = planFor(win, displays).plan
  const movedFrame = await grabFrame(display, movedPlan)
  const movedProtectedRatio = colourFraction(movedFrame.pixels, movedFrame.size.width, movedFrame.size.height, COLOUR_TOP)
  win.setContentProtection(false)
  await sleep(500)
  const movedVisible = await grabFrame(display, movedPlan)
  const movedVisibleRatio = colourFraction(movedVisible.pixels, movedVisible.size.width, movedVisible.size.height, COLOUR_TOP)
  result.checks.single.moved = {
    bounds: movedBounds,
    physicalRect: movedPlan.physicalRect,
    protectedColourRatio: movedProtectedRatio,
    visibleColourRatio: movedVisibleRatio
  }
  win.destroy()
  await sleep(400)

  // ---- Check E: two stacked pins: bottom content visible, top excluded -----------
  const stacked = {}
  const bottomBounds = {
    x: display.workArea.x + 80,
    y: display.workArea.y + 120,
    width: 360,
    height: 260
  }
  const topBounds = {
    x: bottomBounds.x + 60,
    y: bottomBounds.y + 50,
    width: 300,
    height: 220
  }
  const bottomWin = await createColourWindow(display, bottomBounds, '#2563eb')
  const topWin = await createColourWindow(display, topBounds, '#e11d48')
  const stackedPlan = planFor(topWin, displays).plan
  topWin.setContentProtection(false)
  await sleep(500)
  const stackedVisible = await grabFrame(display, stackedPlan)
  stacked.visibleControl = {
    topColourRatio: colourFraction(stackedVisible.pixels, stackedVisible.size.width, stackedVisible.size.height, COLOUR_TOP),
    bottomColourRatio: colourFraction(stackedVisible.pixels, stackedVisible.size.width, stackedVisible.size.height, COLOUR_BOTTOM)
  }
  topWin.setContentProtection(true)
  await sleep(600)
  const stackedFrame = await grabFrame(display, stackedPlan)
  stacked.protected = {
    topColourRatio: colourFraction(stackedFrame.pixels, stackedFrame.size.width, stackedFrame.size.height, COLOUR_TOP),
    bottomColourRatio: colourFraction(stackedFrame.pixels, stackedFrame.size.width, stackedFrame.size.height, COLOUR_BOTTOM),
    physicalRect: stackedPlan.physicalRect,
    size: stackedFrame.size
  }
  // Controlled alignment: the design behind the protected top pin is a STATIC colour, so
  // any consecutive-frame delta is capture noise or misalignment, never content change.
  const stackedAlignment = []
  let stackedPrevious = stackedFrame
  for (let index = 1; index < STACKED_ALIGNMENT_FRAMES; index += 1) {
    await sleep(FRAME_INTERVAL_MS)
    const frame = await grabFrame(display, stackedPlan)
    const pair = diffApi.diffRgba(stackedPrevious.pixels, frame.pixels, {
      width: frame.size.width,
      height: frame.size.height,
      tolerance: 8
    })
    stackedAlignment.push({
      index,
      ratio: pair.ok ? pair.ratio : null,
      bottomColourRatio: colourFraction(frame.pixels, frame.size.width, frame.size.height, COLOUR_BOTTOM)
    })
    stackedPrevious = frame
  }
  const controlledRatios = stackedAlignment.map((pair) => pair.ratio).filter((value) => Number.isFinite(value))
  const controlledAlignmentRatio = controlledRatios.length
    ? controlledRatios.reduce((sum, value) => sum + value, 0) / controlledRatios.length
    : Number.NaN
  stacked.alignment = {
    frames: stackedAlignment,
    controlledAlignmentRatio,
    note: 'controlled pairing: static bottom window behind the protected top window'
  }
  stacked.proven = stacked.visibleControl.topColourRatio > VISIBLE_MIN_RATIO &&
    stacked.protected.topColourRatio <= diffApi.SELF_CAPTURE_MAX_RATIO &&
    stacked.protected.bottomColourRatio >= STACKED_BOTTOM_MIN_RATIO &&
    Number.isFinite(controlledAlignmentRatio) &&
    controlledAlignmentRatio <= diffApi.ALIGNMENT_TOLERANCE_RATIO
  result.checks.stacked = stacked
  topWin.destroy()
  bottomWin.destroy()
  await sleep(400)

  // ---- Check F: negative-coordinate placement on this display's origin -----------
  // The secondary display's work area starts at a NEGATIVE y on this host (-136), so this
  // window's DIP origin is below zero: the planner must subtract the display origin, not
  // assume (0,0).
  const negativeBounds = {
    x: display.workArea.x + 30,
    y: display.workArea.y + 10,
    width: 300,
    height: 200
  }
  const negativeWin = await createColourWindow(display, negativeBounds, '#e11d48')
  const negativePlan = planFor(negativeWin, displays).plan
  negativeWin.setContentProtection(false)
  await sleep(500)
  const negativeVisible = await grabFrame(display, negativePlan)
  negativeWin.setContentProtection(true)
  await sleep(600)
  const negativeProtected = await grabFrame(display, negativePlan)
  result.checks.negativeCoordinates = {
    windowBounds: negativeBounds,
    displayBounds: display.bounds,
    negativeOrigin: display.bounds.y < 0 || display.bounds.x < 0,
    plan: negativePlan.ok ? { dipRect: negativePlan.dipRect, physicalRect: negativePlan.physicalRect } : { ok: false, code: negativePlan.code },
    visibleColourRatio: colourFraction(negativeVisible.pixels, negativeVisible.size.width, negativeVisible.size.height, COLOUR_TOP),
    protectedColourRatio: colourFraction(negativeProtected.pixels, negativeProtected.size.width, negativeProtected.size.height, COLOUR_TOP)
  }
  result.checks.negativeCoordinates.proven = negativePlan.ok === true &&
    result.checks.negativeCoordinates.visibleColourRatio > VISIBLE_MIN_RATIO &&
    result.checks.negativeCoordinates.protectedColourRatio <= diffApi.SELF_CAPTURE_MAX_RATIO
  negativeWin.destroy()
  await sleep(300)

  // ---- Check G: the production domain entry (P1-01) -------------------------------
  // Everything above talks to desktopCapturer directly; this check asks the SHIPPED
  // domain (no injected capturer) for a first frame + a couple of 1 Hz updates + a manual
  // stop, which is the path a real user takes from the pin menu.
  result.checks.productionEntry = await runProductionEntry(display)

  // ---- Verdict ---------------------------------------------------------------
  const single = result.checks.single
  const gateAlignmentRatio = result.checks.stacked?.alignment?.controlledAlignmentRatio
  const adoptionInput = {
    samples: frames.length,
    selfCaptureRatio,
    // The gate asks for "the unchanged design diffs to ~0". A live desktop is not an
    // unchanged design, so the CONTROLLED static-bottom pairing is the gate metric; the
    // lone-window desktop ratio is reported next to it as an environment observation.
    alignmentRatio: Number.isFinite(gateAlignmentRatio) ? gateAlignmentRatio : alignmentRatio,
    maxFrameBytes: single.exclusion.maxFrameBytes,
    minIntervalMs: single.exclusion.intervalMs,
    exclusionMethod: 'content-protection'
  }
  result.adoptionInput = adoptionInput
  result.environment = {
    desktopAlignmentRatio: alignmentRatio,
    desktopAlignmentNote: 'consecutive frames of the live desktop behind one protected window; changes here are real content changes, not alignment evidence'
  }
  result.adoption = diffApi.evaluateDiffAdoption(adoptionInput)
  result.verdict = {
    screenCaptureWorks: visibleRatio > VISIBLE_MIN_RATIO,
    exclusionProven: visibleRatio > VISIBLE_MIN_RATIO &&
      selfCaptureRatio <= diffApi.SELF_CAPTURE_MAX_RATIO &&
      single.moved.protectedColourRatio <= diffApi.SELF_CAPTURE_MAX_RATIO &&
      single.moved.visibleColourRatio > VISIBLE_MIN_RATIO,
    alignmentProven: Number.isFinite(adoptionInput.alignmentRatio) &&
      adoptionInput.alignmentRatio <= diffApi.ALIGNMENT_TOLERANCE_RATIO,
    stackedPinsProven: result.checks.stacked.proven,
    negativeCoordinatesProven: result.checks.negativeCoordinates.proven,
    productionEntryProven: result.checks.productionEntry.proven
  }
  result.status = 'measured'
  return result
}

app.whenReady().then(async () => {
  let result = null
  try {
    result = await run()
  } catch (error) {
    result = { status: 'probe-failed', error: error && (error.stack || error.message) }
    log('probe failed:', error && error.stack)
  }
  try {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2))
  } catch (error) {
    log('write failed:', error.message)
  }
  log('RESULT=' + JSON.stringify({
    status: result.status,
    verdict: result.verdict,
    adoption: result.adoption,
    outPath: OUTPUT_PATH
  }))
  app.quit()
})

app.on('window-all-closed', () => {})
