'use strict'

const {
  applyPinZoomFactor,
  clampPinOpacity,
  clampPinZoom,
  computePinDisplaySize,
  getPixelAlignedPinSize,
  getRotatedPinSize,
  normalizePinRotation,
  normalizePinZoomStep,
  nextPinOpacity,
  normalizeSelectionBounds,
  clampPinBoundsToWorkArea,
  boundsIntersectWorkArea
} = require('./geometry')
const { makeCaptureName } = require('../../services/capture-naming')
const { t } = require('../../services/i18n-bootstrap')
const { exportWindowToPdf, savePdfBuffer } = require('../../services/pdf-export')
// N05 (review section 5.5): workspace snapshots are a JSON manifest plus copied PNG
// assets under the pin domain's own directory. The writer is the same atomic one the
// data root uses, so a crash mid-save can never leave a half-written manifest.
const { atomicWriteJson } = require('../../services/data-root')
const fsp = require('node:fs/promises')
const os = require('node:os')
// Shared with the history "continue editing" entry point; pure arithmetic, no Electron.
// Keeping the compact-editor window box in one place is what stops the two re-edit
// flows from drifting (test/capture-floating-placement.test.js pins the contract).
const { resolveEditorLayout, scaleFactorFor } = require('../../../shared/editor-layout')
const { imageDataToBuffer } = require('../../services/image-buffer')
const { readPngSize } = require('../../services/capture-geometry')
const { createPinImageStore } = require('../../services/pin-image-store')
// D05: the abnormal-renderer retention policy. The domain owns window/image
// identity; the TTL, attempt cap and budget arithmetic live in the service.
const { createWindowResilience } = require('../../services/window-resilience')
// A07: end-of-drag snapping and the per-display tray grouping are pure geometry; the
// domain only feeds them Electron rects and applies the result with setBounds.
const {
  computePinSnap,
  displayKey,
  displayLabel,
  orderDisplays,
  pickDisplayForBounds,
  sameDisplay
} = require('../../services/pin-geometry')
// U02 / DEV-01: the pin re-annotation snapshot is DOCUMENT-SHAPED on purpose - it is the
// same shared contract the history "continue editing" path persists, so the coordinate
// transforms and the validator are defined once for both ends (renderer and main).
const captureDocument = require('../../../shared/capture-document')
// N05 / DEV-08: pure planning/measurement seams for the real-screen diff (adopted).
// Requiring the renderer directory from main is deliberate: the module is UMD and has no
// DOM/Electron dependency, and keeping ONE implementation is what lets the capture
// pixel math be unit-tested without a GUI.
const pinScreenDiff = require('../../../pin/pin-screen-diff')

// ---------------------------------------------------------------------------
// B03 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "export the current view" as data, not as scattered literals.
//
// A pin has two legitimate ways to leave the screen and the product used to be
// unable to say which one a menu item meant:
//
//   * the ORIGINAL image  - the exact bytes the pin was created from, unaffected by
//     rotation/zoom (done by copyPin/savePin below);
//   * the CURRENT VIEW    - what the pin window renders right now: the rotated and
//     zoomed picture plus the OCR overlay that is on screen, and deliberately
//     without the desktop or any other window behind it.
//
// These helpers are pure so the preview copy, the export and the tests share one
// definition of "what the view contains" and "which way it faces".
// ---------------------------------------------------------------------------
const PIN_VIEW_LAYERS = Object.freeze(['picture', 'rotation', 'zoom', 'ocr'])
// Everything the view export must never contain. The first two are structural (the
// pixels come from the pin renderer's own offscreen composition, not from the screen),
// the rest are the transient window chrome the compositor simply never draws.
const PIN_VIEW_EXCLUSIONS = Object.freeze(['desktop', 'other-windows', 'overlay-badges'])

function pinViewExportSize({ pixelWidth = 0, pixelHeight = 0, rotation = 0, zoom = 1 } = {}) {
  const scale = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1
  const width = Math.max(1, Math.round((Number(pixelWidth) || 0) * scale))
  const height = Math.max(1, Math.round((Number(pixelHeight) || 0) * scale))
  const rotated = getRotatedPinSize(width, height, rotation)
  return {
    width: rotated.width,
    height: rotated.height,
    rotation: rotated.rotation,
    quarterTurn: rotated.rotation === 90 || rotated.rotation === 270
  }
}

function describePinViewExport({ rotation = 0, zoom = 1, ocrOverlay = false, width = 0, height = 0 } = {}) {
  const angle = normalizePinRotation(rotation)
  const scale = Number.isFinite(Number(zoom)) && Number(zoom) > 0 ? Number(zoom) : 1
  const ocr = ocrOverlay === true
  return {
    rotation: angle,
    zoom: scale,
    // The export is the window's own rendering, so its orientation IS the stored
    // angle: a quarter turn puts the pre-rotation width on the vertical axis.
    orientation: angle,
    quarterTurn: angle === 90 || angle === 270,
    size: {
      width: Math.max(0, Math.round(Number(width) || 0)),
      height: Math.max(0, Math.round(Number(height) || 0))
    },
    ocrOverlay: ocr,
    included: ocr ? [...PIN_VIEW_LAYERS] : PIN_VIEW_LAYERS.filter((layer) => layer !== 'ocr'),
    excluded: [...PIN_VIEW_EXCLUSIONS]
  }
}

// ---------------------------------------------------------------------------
// DEV-02 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// bounded envelope for the renderer-composed "current view" PNG.
//
// Main -> renderer asks for a composition; the renderer answers through the pin
// window's existing authorized `pin:context-menu` channel as this command envelope
// (handoff section 5.2 legal extension style 3 - same pattern as the N05 workspace
// commands). Everything that crosses the boundary is normalised here first: the
// request id, the optional failure code, and the PNG bytes (size + declared size).
// The PNG header itself and the pixel budget are re-checked by the domain after the
// envelope passes, so a forged header cannot smuggle an oversized canvas through.
// ---------------------------------------------------------------------------
const VIEW_EXPORT_RESULT_TYPE = 'view-export-result'
const VIEW_EXPORT_REQUEST_ID = /^[a-z0-9-]{1,64}$/
const VIEW_EXPORT_ERROR_CODE = /^[a-z0-9-]{1,48}$/
const MAX_VIEW_EXPORT_PNG_BYTES = 32 * 1024 * 1024
const MAX_VIEW_EXPORT_DIMENSION = 16384
const MAX_VIEW_EXPORT_PIXELS = 24000000
const DEFAULT_VIEW_EXPORT_TIMEOUT_MS = 10000

function viewExportBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

// Envelope -> { requestId, ok, code, bytes, width, height, ocrOverlay }. Returns null
// for anything that is not this envelope (a context menu imageBounds payload or an
// unrelated command must keep reaching the existing handlers unchanged).
function normalizeViewExportCommand(command) {
  if (!command || typeof command !== 'object') return null
  if (command.type !== VIEW_EXPORT_RESULT_TYPE) return null
  const requestId = typeof command.requestId === 'string' && VIEW_EXPORT_REQUEST_ID.test(command.requestId)
    ? command.requestId
    : ''
  if (!requestId) return null
  if (command.ok !== true) {
    const code = typeof command.code === 'string' && VIEW_EXPORT_ERROR_CODE.test(command.code) ? command.code : 'failed'
    return { requestId, ok: false, code, bytes: null, width: 0, height: 0, ocrOverlay: false }
  }
  const bytes = viewExportBytes(command.png)
  if (!bytes || !bytes.length || bytes.length > MAX_VIEW_EXPORT_PNG_BYTES) return null
  const width = Math.round(Number(command.width))
  const height = Math.round(Number(command.height))
  const validSize = Number.isFinite(width) && Number.isFinite(height) &&
    width > 0 && height > 0 &&
    width <= MAX_VIEW_EXPORT_DIMENSION && height <= MAX_VIEW_EXPORT_DIMENSION &&
    width * height <= MAX_VIEW_EXPORT_PIXELS
  if (!validSize) return null
  return { requestId, ok: true, code: '', bytes, width, height, ocrOverlay: command.ocrOverlay === true }
}

// Renderer failure code -> visible copy key. The dialog title stays the existing
// "export failed" string; the detail names the actionable cause.
function pinViewExportFailureKey(code) {
  switch (String(code || '')) {
    case 'too-large':
    case 'png-too-large':
      return 'pin.view-export.too-large'
    case 'timeout':
      return 'pin.view-export.timeout'
    case 'busy':
    case 'unavailable':
    case 'canvas-unavailable':
      return 'pin.view-export.unavailable'
    case 'empty-image':
    case 'empty':
      return 'pin.view-export.empty'
    default:
      return 'pin.view-export.render-failed'
  }
}

// Renderer failure code -> receipt code. One place so the context menu's log line and
// the tests do not invent their own spellings.
function viewExportResultCode(code) {
  switch (String(code || '')) {
    case 'too-large':
    case 'png-too-large':
      return 'TOO_LARGE'
    case 'timeout':
      return 'TIMEOUT'
    case 'busy':
    case 'unavailable':
    case 'canvas-unavailable':
      return 'RENDERER_UNAVAILABLE'
    case 'empty-image':
    case 'empty':
      return 'EMPTY'
    case 'image-changed':
      return 'IMAGE_CHANGED'
    case 'invalid-png':
    case 'invalid-size':
      return 'INVALID_RENDER'
    case 'window-closed':
    case 'cancelled':
    case 'finished':
      return 'CANCELLED'
    default:
      return 'RENDER_FAILED'
  }
}

// ---------------------------------------------------------------------------
// N05 / DEV-08 (adopted 2026-11-28): onion-skin compare modes, including the opt-in
// "real pixel compare" that samples the screen pixels under the pin.
//
// The renderer already owns difference/flash locally (Ctrl+Shift+D/F). The context menu
// can drive those too, so the renderer reports its authoritative mode back through the
// same bounded command envelope the workspace actions use (no new IPC channel):
//   { type: 'onion-state', mode: 'off' | 'difference' | 'flash' | 'real-diff' }
// Main only mirrors the mode for the menu radio items; the real-pixel sampler is owned by
// the main process (start/stop below) because it needs desktopCapturer and content
// protection.
// ---------------------------------------------------------------------------
const ONION_MODES = Object.freeze(['off', 'difference', 'flash', 'real-diff'])
const ONION_MODE_SET = new Set(ONION_MODES)
const DEFAULT_REAL_DIFF_INTERVAL_MS = 1000

function normalizeOnionStateCommand(command) {
  if (!command || typeof command !== 'object') return null
  if (command.type !== 'onion-state') return null
  const mode = typeof command.mode === 'string' && ONION_MODE_SET.has(command.mode) ? command.mode : ''
  if (!mode) return null
  return { type: 'onion-state', mode }
}


// ---------------------------------------------------------------------------
// U02 / DEV-01 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// the optional non-destructive re-annotation snapshot of a pinned picture.
//
// Shape (transport): the capture renderer sends `meta.pinEditable` on the EXISTING
// capture:pin / capture:pin-reannotate payloads; the capture domain strips it before
// any history write and hands it to this domain as a separate argument. This domain
// normalises it once and keeps it IN MEMORY on `_pinData.pinEditable` - the workspace
// snapshot writer, the crash-recovery tickets and history all clone `meta` only, so an
// unredacted base image can never be serialised by any of them.
//
//   { schema: 1,
//     document: <shared/capture-document v3, crop === full base, source 'pin'>,
//     baseImage: { bytes, width, height, mime: 'image/png' },
//     sourceScaleFactor, byteLength }
//
// Rejections are explicit codes (the pin is still created, just as a flat bitmap).
// ---------------------------------------------------------------------------
const PIN_EDITABLE_SNAPSHOT_SCHEMA = 1
const MAX_PIN_SNAPSHOT_BASE_BYTES = 16 * 1024 * 1024
const MAX_PIN_SNAPSHOT_DIMENSION = 16384
const MAX_PIN_SNAPSHOT_PIXELS = 24000000
const MAX_PIN_SNAPSHOT_ANNOTATIONS = 2000
const DEFAULT_PIN_SNAPSHOT_BUDGET_BYTES = 32 * 1024 * 1024

function pinSnapshotBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function normalizePinEditableSnapshot(raw, options = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'INVALID_SNAPSHOT' }
  if (Math.max(0, Math.round(Number(raw.schema) || 0)) !== PIN_EDITABLE_SNAPSHOT_SCHEMA) {
    return { ok: false, code: 'UNSUPPORTED_SCHEMA' }
  }
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : MAX_PIN_SNAPSHOT_BASE_BYTES
  const bytes = pinSnapshotBytes(raw.baseImagePng)
  if (!bytes || !bytes.length) return { ok: false, code: 'EMPTY_BASE' }
  if (bytes.length > maxBytes) return { ok: false, code: 'BASE_TOO_LARGE' }
  const size = readPngSize(bytes)
  if (!size || !(size.width > 0) || !(size.height > 0)) return { ok: false, code: 'INVALID_BASE' }
  if (size.width > MAX_PIN_SNAPSHOT_DIMENSION || size.height > MAX_PIN_SNAPSHOT_DIMENSION ||
      size.width * size.height > MAX_PIN_SNAPSHOT_PIXELS) {
    return { ok: false, code: 'BASE_TOO_LARGE' }
  }
  // Validate the RAW shape first: normalizeDocument() is intentionally forgiving and
  // would silently drop an unknown annotation type, while a snapshot must be rejected
  // explicitly (the task asks for annotation-type validation at this boundary).
  const validation = captureDocument.validateDocument(raw.document, {
    expectedBaseWidth: size.width,
    expectedBaseHeight: size.height
  })
  if (!validation.ok) {
    return {
      ok: false,
      code: 'INVALID_DOCUMENT',
      errors: validation.errors.slice(0, 8).map((issue) => issue.code)
    }
  }
  let document
  try {
    document = captureDocument.normalizeDocument(raw.document)
  } catch (error) {
    return { ok: false, code: 'INVALID_DOCUMENT' }
  }
  // The snapshot is self-contained: its base image IS the crop, so the document must
  // describe the whole bitmap. A crop mismatch would make the editor show/export pixels
  // that are not what the pin displays.
  const crop = document.crop
  if (crop.x !== 0 || crop.y !== 0 || crop.w !== size.width || crop.h !== size.height) {
    return { ok: false, code: 'CROP_MISMATCH' }
  }
  if (document.captureMetadata?.longCapture === true) return { ok: false, code: 'LONG_CAPTURE' }
  if (document.annotations.length > MAX_PIN_SNAPSHOT_ANNOTATIONS) {
    return { ok: false, code: 'TOO_MANY_ANNOTATIONS' }
  }
  const sourceScaleFactor = Math.max(0.25, Number(raw.sourceScaleFactor) || 1)
  return {
    ok: true,
    snapshot: {
      schema: PIN_EDITABLE_SNAPSHOT_SCHEMA,
      document: { ...document, source: 'pin' },
      baseImage: { bytes, width: size.width, height: size.height, mime: 'image/png' },
      sourceScaleFactor,
      byteLength: bytes.length
    }
  }
}

// ---------------------------------------------------------------------------
// N05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.5):
// pin workspace snapshots as pure, serialisable data.
//
// A snapshot is a named group of live pins. The manifest lives in the pin domain's
// own data directory and is written with the data root's atomic JSON writer; one
// copied picture per pin lives under `snapshot-assets/<snapshotId>/`, so restoring a
// workspace never depends on the in-memory image store or on a file the user may
// have moved since. Everything in this section is Electron-free and pure so the
// serialisation, eviction and corruption rules are unit testable; the domain below
// owns the windows, the image store and the file system.
// ---------------------------------------------------------------------------
const WORKSPACE_SNAPSHOT_SCHEMA = 1
const MAX_WORKSPACE_SNAPSHOTS = 10
const MAX_WORKSPACE_SNAPSHOT_PINS = 20
const MAX_WORKSPACE_SNAPSHOT_NAME = 64
const WORKSPACE_SNAPSHOT_ASSET_DIR = 'snapshot-assets'
const WORKSPACE_SNAPSHOT_FILE_NAME = 'snapshots.json'
const WORKSPACE_SNAPSHOT_ID = /^[a-z0-9][a-z0-9-]{3,63}$/
const WORKSPACE_SNAPSHOT_ASSET = /^pin-\d{1,3}\.(png|jpg|jpeg|webp)$/
const WORKSPACE_IMAGE_MIME = /^image\/(png|jpeg|webp)$/
// The renderer -> main command envelope (see preload-pin.js for the mirrored list).
// It travels in the existing pin:context-menu listener because a NEW IPC channel
// would have to be added to the frozen sender-policy table in main/services/ipc-
// security.js, which is outside this task's write scope; secureIpcMain refuses any
// channel without a policy entry and assertComplete() runs at startup.
const WORKSPACE_COMMAND_TYPES = Object.freeze([
  'workspace-save',
  'workspace-restore',
  'workspace-restore-latest',
  'workspace-delete',
  'workspace-suspend',
  'workspace-resume',
  'workspace-list'
])

function normalizeWorkspaceSnapshotName(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_WORKSPACE_SNAPSHOT_NAME)
}

// Pin placements and annotations have to survive JSON, and the renderer's meta is
// untrusted-ish data: clone it through JSON so a function/date/undefined never ends
// up in the manifest, and degrade to null instead of throwing.
function cloneJsonValue(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function workspaceImageExtension(mime) {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

// One pin entry: the placement fields the window needs to be rebuilt exactly
// (position, zoom, rotation, opacity, click-through, always-on-top), the picture
// reference, and the vector-annotation payload when the pin entry carries one.
// The shipped capture -> pin path flattens annotations into pixels, so
// `annotations` is normally null; it is round-tripped so a future non-destructive
// re-annotation path (review §4.2) needs no snapshot format change.
function normalizeWorkspaceSnapshotPin(raw) {
  if (!raw || typeof raw !== 'object') return null
  const positive = (value) => Math.max(1, Math.round(Number(value) || 0))
  const bounds = raw.bounds && typeof raw.bounds === 'object'
    ? {
        x: Math.round(Number(raw.bounds.x) || 0),
        y: Math.round(Number(raw.bounds.y) || 0),
        width: positive(raw.bounds.width),
        height: positive(raw.bounds.height)
      }
    : null
  const asset = typeof raw.asset === 'string' && WORKSPACE_SNAPSHOT_ASSET.test(raw.asset) ? raw.asset : ''
  const mime = typeof raw.mime === 'string' && WORKSPACE_IMAGE_MIME.test(raw.mime) ? raw.mime : 'image/png'
  const meta = raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? cloneJsonValue(raw.meta) || {} : {}
  return {
    asset,
    mime,
    bytes: Math.max(0, Math.round(Number(raw.bytes) || 0)),
    bounds,
    zoom: clampPinZoom(raw.zoom),
    rotation: normalizePinRotation(raw.rotation),
    opacity: clampPinOpacity(raw.opacity),
    clickThrough: raw.clickThrough === true,
    alwaysOnTop: raw.alwaysOnTop !== false,
    longCapture: raw.longCapture === true,
    pixelWidth: positive(raw.pixelWidth),
    pixelHeight: positive(raw.pixelHeight),
    baseWidth: positive(raw.baseWidth ?? raw.pixelWidth),
    baseHeight: positive(raw.baseHeight ?? raw.pixelHeight),
    displayScaleFactor: Number(raw.displayScaleFactor) > 0 ? Number(raw.displayScaleFactor) : 1,
    annotations: raw.annotations === undefined ? null : cloneJsonValue(raw.annotations),
    meta
  }
}

function normalizeWorkspaceSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && WORKSPACE_SNAPSHOT_ID.test(raw.id) ? raw.id : ''
  if (!id) return null
  const pins = Array.isArray(raw.pins)
    ? raw.pins.map(normalizeWorkspaceSnapshotPin).filter(Boolean).slice(0, MAX_WORKSPACE_SNAPSHOT_PINS)
    : []
  return {
    id,
    name: normalizeWorkspaceSnapshotName(raw.name),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Math.max(0, Math.round(Number(raw.createdAt))) : 0,
    pins
  }
}

// A manifest is a schema version plus a bounded list. `corrupt: true` means the
// file could not be trusted at all (bad JSON / wrong shape / newer schema) and the
// caller has to rebuild it; an individual malformed snapshot is simply dropped so
// one bad entry cannot take the whole workspace list with it.
function normalizeWorkspaceSnapshotFile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { snapshots: [], corrupt: true }
  if (raw.version !== WORKSPACE_SNAPSHOT_SCHEMA) return { snapshots: [], corrupt: true }
  const source = Array.isArray(raw.snapshots) ? raw.snapshots : []
  const snapshots = []
  const seen = new Set()
  for (const item of source) {
    const normalized = normalizeWorkspaceSnapshot(item)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    snapshots.push(normalized)
    if (snapshots.length >= MAX_WORKSPACE_SNAPSHOTS) break
  }
  return { snapshots, corrupt: false }
}

function parseWorkspaceSnapshotText(text) {
  try {
    return normalizeWorkspaceSnapshotFile(JSON.parse(text))
  } catch {
    return { snapshots: [], corrupt: true }
  }
}

// Newest first: the restore-latest shortcut and the submenu both read index 0.
function appendWorkspaceSnapshot(entries, snapshot, max = MAX_WORKSPACE_SNAPSHOTS) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && entry.id !== snapshot.id) : []
  const merged = [snapshot, ...list]
  return { snapshots: merged.slice(0, max), evicted: merged.slice(max) }
}

function describeWorkspaceSnapshot(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    pinCount: snapshot.pins.length
  }
}

function buildWorkspaceSnapshot({ id, name, createdAt, pins } = {}) {
  return normalizeWorkspaceSnapshot({ id, name, createdAt, pins: Array.isArray(pins) ? pins : [] })
}

function normalizeWorkspaceCommand(command) {
  if (!command || typeof command !== 'object') return null
  const type = typeof command.type === 'string' ? command.type : ''
  if (!WORKSPACE_COMMAND_TYPES.includes(type)) return null
  return {
    type,
    name: normalizeWorkspaceSnapshotName(command.name),
    id: typeof command.id === 'string' && WORKSPACE_SNAPSHOT_ID.test(command.id) ? command.id : ''
  }
}

// Same-style atomic byte write as data-root.atomicWriteJson (temp file + rename),
// used for each copied snapshot picture.
async function writeBytesAtomic(filePath, bytes) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fsp.writeFile(temporaryPath, bytes)
    await fsp.rename(temporaryPath, filePath)
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

function createPinDomain(deps) {
  const {
    BrowserWindow,
    clipboard,
    nativeImage,
    screen,
    Menu,
    path,
    rootDirectory,
    createLocalWindow,
    getSettings,
    saveImageBuffer,
    createRecognitionWindow,
    getCreateCaptureWindow,
    recognizePin,
    log,
    ipcMain
  } = deps

  if (!ipcMain) throw new Error('Pin domain requires ipcMain')
  if (!createLocalWindow) throw new Error('Pin domain requires createLocalWindow')

  const MAX_PINNED = 20
  const pinWindows = new Set()
  // A spill write that fails (disk full, read-only volume) degrades to resident
  // pixels; log it so the fallback is visible in diagnostics instead of silent.
  const pinImages = deps.pinImages || createPinImageStore({
    onError: (error, info) => log(`Pin image store ${info.phase} failed:`, error.message)
  })
  let pinnedCount = 0
  let pinWindowSequence = 0
  // A07: a stable creation ordinal for the tray's pin labels. It is deliberately not
  // persisted - pin state is local to this process by design.
  let pinOrdinalSequence = 0

  // D05: a crashed renderer no longer takes the pixels with it. The policy is
  // injected in tests (fake clock, fake timers); in production it mirrors the
  // existing 20 pin / 32 MiB envelope instead of opening a second budget. The
  // callbacks are the only Electron/store touch points: retaining takes one
  // reference in the existing image store, releasing gives it back.
  const resilience = deps.windowResilience || createWindowResilience({
    policy: deps.windowResiliencePolicy,
    now: deps.now,
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    budget: () => ({
      pins: pinnedCount,
      bytes: typeof pinImages.stats === 'function' ? pinImages.stats().resident : 0
    }),
    retainResource: ({ imageId }) => (typeof pinImages.retain === 'function' ? pinImages.retain(imageId) : false),
    releaseResource: ({ imageId }) => pinImages.release(imageId),
    onRelease: (entry, info) => log(`Pin recovery released (${info.code}):`, entry.id)
  })

  function getRecoverablePins() {
    return resilience.list().map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      attempts: entry.attempts,
      exhausted: entry.exhausted,
      expiresAt: entry.expiresAt,
      bytes: entry.bytes
    }))
  }

  // The tray rebuild hook. main.js is not wired in D05 (deliberately), but the
  // next round passes `onRecoverableChange: () => createTrayIcon()`, which is the
  // same injection selectionDomain already uses for its tray updates.
  function notifyRecoverable(change = {}) {
    const list = getRecoverablePins()
    if (typeof deps.onRecoverableChange === 'function') {
      try {
        deps.onRecoverableChange(list, change)
      } catch (error) {
        log('Pin recoverable notification failed:', error.message)
      }
    }
    return list
  }

  // Only abnormal renderer exits retain pixels. A normal close goes through
  // `closed` and releases immediately, so a user who dismisses a pin never leaves
  // a recoverable entry behind. `details.reason` is forwarded for diagnostics.
  function handlePinRendererGone(win, details = {}) {
    if (!win || win.isDestroyed() || win._pinClosing || win._pinClosed) return false
    const data = win._pinData
    if (!data?.imageId) {
      if (!win.isDestroyed()) win.destroy()
      return false
    }
    const bounds = readPinBounds(win)
    const retained = resilience.retain({
      key: win._pinRecoveryKey,
      imageId: data.imageId,
      bytes: Number(data.imageBytes) || 0,
      reason: typeof details.reason === 'string' && details.reason ? details.reason : 'renderer-gone',
      // The pin still counts in `pinnedCount` here; it is about to be destroyed,
      // so the slot the retained reference occupies is the one it is releasing.
      livePins: Math.max(0, pinnedCount - 1),
      meta: bounds ? { ...(data.meta || {}), selectionBounds: bounds } : data.meta,
      placement: {
        bounds,
        opacity: data.opacity,
        rotation: data.rotation,
        zoom: data.zoom,
        clickThrough: data.clickThrough === true
      }
    })
    if (retained.ok) {
      win._pinRecoverableId = retained.entry.id
      log('Pin window renderer exited; retained for recovery:', details.reason || 'unknown', retained.entry.id)
      notifyRecoverable({ kind: 'retained', id: retained.entry.id, reason: retained.entry.reason })
    } else {
      // Budget/attempt refusals are expected under pressure; the image is released
      // by the normal `closed` path below, exactly like the old behaviour.
      log('Pin window could not be retained for recovery:', retained.code)
    }
    if (!win.isDestroyed()) win.destroy()
    return retained.ok
  }

  function readPinBounds(win) {
    try {
      const bounds = win.getBounds()
      if (!bounds) return null
      const values = [bounds.x, bounds.y, bounds.width, bounds.height]
      return values.every((value) => Number.isFinite(value)) ? { ...bounds } : null
    } catch {
      return null
    }
  }

  // One-shot recovery. The pixels are read back from the retained store entry and
  // the rebuilt window re-uses that same `imageId` (no copy, no second budget); the
  // renderer receives them through the normal `pin:init` path once it is ready.
  // A failure returns SAVE_OR_DISCARD and burns one attempt; the third failure
  // marks the ticket exhausted, so a tray double-click cannot restart a loop.
  async function recoverPin(ticketId) {
    if (!resilience.has(ticketId)) return { status: 'failed', code: 'NOT_FOUND' }
    if (!canPinMore()) {
      // Transient capacity, not a recovery failure: do not burn an attempt.
      return { status: 'failed', code: 'PIN_LIMIT', retryable: true }
    }
    const claim = resilience.claim(ticketId)
    if (!claim.ok) {
      if (claim.code === 'ATTEMPTS_EXHAUSTED') {
        return { status: 'failed', code: 'SAVE_OR_DISCARD', reason: 'ATTEMPTS_EXHAUSTED', exhausted: true, retryable: false }
      }
      return { status: 'failed', code: claim.code, retryable: claim.code === 'BUSY' }
    }
    const entry = claim.entry
    try {
      const { bytes } = await pinImages.read(entry.imageId)
      const win = createPinWindow(bytes, entry.meta || {}, { reuseImageId: entry.imageId })
      try {
        applyRecoveredPlacement(win, entry.placement)
      } catch (error) {
        // Never leave a half-restored window owning a reference the ticket also
        // holds: destroy it (which releases the window's share) and fail cleanly.
        if (!win.isDestroyed()) win.destroy()
        throw error
      }
      resilience.succeed(ticketId)
      notifyRecoverable({ kind: 'recovered', id: ticketId })
      return { status: 'recovered', window: win, imageId: entry.imageId, attempts: entry.attempts }
    } catch (error) {
      const failed = resilience.fail(ticketId, { code: 'RECOVERY_FAILED', message: error.message })
      if (!failed.ok) {
        // The ticket expired while the rebuild was in flight; nothing is left to
        // save. The caller still shows the failure instead of retrying forever.
        return { status: 'failed', code: 'SAVE_OR_DISCARD', reason: 'EXPIRED', exhausted: true, retryable: false }
      }
      log('Pin recovery failed:', error.message)
      notifyRecoverable({ kind: 'failed', id: ticketId })
      return {
        status: 'failed',
        code: 'SAVE_OR_DISCARD',
        reason: 'RECOVERY_FAILED',
        attempts: failed.attempts,
        exhausted: failed.exhausted,
        retryable: !failed.exhausted
      }
    }
  }

  function applyRecoveredPlacement(win, placement) {
    if (!win || win.isDestroyed() || !placement) return false
    if (placement.bounds && typeof win.setBounds === 'function') {
      try {
        // The display topology may have changed while the ticket was retained:
        // clamp instead of restoring a box that is now off-screen.
        const display = screen.getDisplayMatching(placement.bounds)
        win.setBounds(clampPinBoundsToWorkArea(placement.bounds, display.workArea), false)
      } catch (error) {
        log('Pin recovery placement failed:', error.message)
      }
    }
    if (win._pinData) {
      if (Number.isFinite(Number(placement.opacity))) win._pinData.opacity = clampPinOpacity(placement.opacity)
      // `pin:init` carries rotation/zoom/click-through, so restoring the fields is
      // enough for the rebuilt renderer to paint the same pin.
      if (Number.isFinite(Number(placement.rotation))) win._pinData.rotation = normalizePinRotation(placement.rotation)
      if (Number.isFinite(Number(placement.zoom))) win._pinData.zoom = Number(placement.zoom)
    }
    if (placement.clickThrough === true) setPinClickThrough(win, true)
    return true
  }

  // "Save or discard" after a failed rebuild (or at any time before the TTL
  // expires). Saving releases the retained reference only after the file is on
  // disk; a failed save keeps the ticket so a retry or discard is still possible.
  async function saveRecoverablePin(ticketId) {
    const ticket = resilience.get(ticketId)
    if (!ticket) return { status: 'failed', code: 'NOT_FOUND' }
    let savedPath = null
    try {
      const { bytes } = await pinImages.read(ticket.imageId)
      savedPath = await saveImageBuffer(bytes)
    } catch (error) {
      log('Pin recovery save failed:', error.message)
      return { status: 'failed', code: 'SAVE_FAILED' }
    }
    if (!savedPath) {
      // D05 (plan item 18): a cancelled save dialog writes nothing. Releasing the
      // retained pixels here was the bug: the user dismissed the dialog and the ticket
      // (the only copy left of that pin) disappeared with it.
      return { status: 'cancelled', code: 'SAVE_CANCELLED' }
    }
    resilience.release(ticketId, { code: 'SAVED', reason: 'saved' })
    notifyRecoverable({ kind: 'saved', id: ticketId })
    return { status: 'saved', savedPath }
  }

  // D05 (plan item 18): everything the tray needs for the "pins to recover" submenu. The
  // domain owns the actions as well as the data, so the menu layer never reaches into the
  // resilience store and main.js only forwards one value.
  function trayRecoveryMenu() {
    const items = getRecoverablePins().map((entry, index) => ({
      id: entry.id,
      index: index + 1,
      reason: entry.reason,
      attempts: entry.attempts,
      exhausted: entry.exhausted,
      expiresAt: entry.expiresAt,
      bytes: entry.bytes,
      canRetry: entry.exhausted !== true
    }))
    return {
      items,
      actions: {
        recover: (id) => recoverPin(id),
        save: (id) => saveRecoverablePin(id),
        discard: (id) => discardRecoverablePin(id)
      }
    }
  }

  function discardRecoverablePin(ticketId) {
    const released = resilience.release(ticketId, { code: 'DISCARDED', reason: 'discarded' })
    if (!released.ok) return { status: 'failed', code: released.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'BUSY' }
    notifyRecoverable({ kind: 'discarded', id: ticketId })
    return { status: 'discarded' }
  }

  function preparePinImage(input) {
    const bytes = imageDataToBuffer(input)
    const mime = typeof input === 'string' && /^data:(image\/[\w.+-]+);base64,/.exec(input)?.[1] || 'image/png'
    const size = readPngSize(bytes) || nativeImage.createFromBuffer(bytes).getSize()
    if (!size.width || !size.height) throw new Error('无法读取贴图尺寸')
    return { bytes, mime, size }
  }

  // U02 / DEV-01: pin re-annotation snapshots are held in memory on the live window only.
  // The aggregate budget keeps 20 pins from silently multiplying their base bitmaps; a
  // pin that would push the total over it simply stays a flat bitmap.
  const pinSnapshotBudgetBytes = Number.isFinite(Number(deps.pinSnapshotBudgetBytes)) && Number(deps.pinSnapshotBudgetBytes) >= 0
    ? Number(deps.pinSnapshotBudgetBytes)
    : DEFAULT_PIN_SNAPSHOT_BUDGET_BYTES
  let pinSnapshotBytes = 0

  function releasePinEditable(win) {
    const snapshot = win?._pinData?.pinEditable
    if (!snapshot) return false
    pinSnapshotBytes = Math.max(0, pinSnapshotBytes - (Number(snapshot.byteLength) || 0))
    win._pinData.pinEditable = null
    return true
  }

  // Validates the renderer-supplied snapshot and binds it to the CURRENT image generation
  // of this window. A rejected snapshot never fails the pin: it degrades to a flat bitmap.
  function attachPinEditable(win, rawSnapshot) {
    if (!win || win.isDestroyed?.() || !win._pinData || !rawSnapshot) return false
    const normalized = normalizePinEditableSnapshot(rawSnapshot)
    if (!normalized.ok) {
      log('Pin editable snapshot rejected:', normalized.code)
      return false
    }
    const snapshot = normalized.snapshot
    if (pinSnapshotBytes + snapshot.byteLength > pinSnapshotBudgetBytes) {
      log('Pin editable snapshot dropped: budget', pinSnapshotBytes + snapshot.byteLength, pinSnapshotBudgetBytes)
      return false
    }
    releasePinEditable(win)
    win._pinData.pinEditable = { ...snapshot, imageId: win._pinData.imageId }
    pinSnapshotBytes += snapshot.byteLength
    return true
  }

  // C04: spilled pins read their pixels asynchronously (bounded by the store's
  // queue), so every read below is awaited. The store hands back the same
  // `{ bytes, mime }` shape; only the timing changed.
  async function pinDataUrl(pin) {
    const { bytes, mime } = await pinImages.read(pin.imageId)
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  async function sendPinImage(win, channel) {
    if (!win || win.isDestroyed() || !win._pinData) return false
    const imageId = win._pinData.imageId
    try {
      const { bytes, mime } = await pinImages.read(imageId)
      // The pin can be closed or re-annotated while the spilled pixels were read
      // asynchronously: drop the stale payload instead of writing into a
      // released window or replacing a newer image.
      if (win.isDestroyed() || !win._pinData || win._pinData.imageId !== imageId) return false
      // Read the presentation at send time: zoom/opacity can change while the
      // read is queued, and an older copy would rewind the renderer.
      // U02 / DEV-01: the editable snapshot (base PNG + document) stays in the main
      // process; it is never part of the renderer's presentation payload.
      const { imageId: _imageId, pinEditable: _pinEditable, ...presentation } = win._pinData
      return sendToRenderer(win, channel, { ...presentation, imageBuffer: bytes, imageMime: mime })
    } catch (error) {
      log('Pin image send failed:', error.message)
      return false
    }
  }

  async function copyPin(win) {
    if (!win?._pinData || win.isDestroyed()) return
    const imageId = win._pinData.imageId
    try {
      const { bytes } = await pinImages.read(imageId)
      if (win.isDestroyed() || !win._pinData || win._pinData.imageId !== imageId) return
      clipboard.writeImage(nativeImage.createFromBuffer(bytes))
    } catch (error) {
      log('Pin copy failed:', error.message)
    }
  }

  async function savePin(win) {
    if (!win?._pinData || win.isDestroyed()) return
    const { bytes } = await pinImages.read(win._pinData.imageId)
    await saveImageBuffer(bytes)
  }

  // -------------------------------------------------------------------------
  // B03 + DEV-02: "export the current view" (the counterpart of the original-bytes
  // copy/save above).
  //
  // The composition itself belongs to the pin RENDERER (pin/pin-view-export.js): it
  // draws the picture, rotation, long-capture scroll offset and visible OCR blocks into
  // an offscreen canvas without touching the visible page. The old hide-styles plus
  // capture-the-window flow is gone, so a prepare failure can no longer paint the
  // transient chrome into the export and the on-screen pin can no longer flicker during
  // an export. This block owns the request/response lifecycle, the preview confirmation
  // and the save path - the same user-visible semantics as before.
  // -------------------------------------------------------------------------
  const injectedShowMessageBox = typeof deps.showMessageBox === 'function' ? deps.showMessageBox : null
  const injectedShowErrorBox = typeof deps.showErrorBox === 'function' ? deps.showErrorBox : null
  // Tests override this to exercise the timeout path without waiting the production
  // budget. The renderer has one bounded synchronous compose, so 10 s is already generous.
  const viewExportTimeoutMs = Number.isFinite(Number(deps.viewExportTimeoutMs)) && Number(deps.viewExportTimeoutMs) > 0
    ? Number(deps.viewExportTimeoutMs)
    : DEFAULT_VIEW_EXPORT_TIMEOUT_MS

  function defaultShowMessageBox(win, options) {
    const { dialog } = require('electron')
    return dialog.showMessageBox(win, options)
  }

  function defaultShowErrorBox(message, detail) {
    const { dialog } = require('electron')
    dialog.showErrorBox(message, detail)
  }

  // One in-flight composition per pin window. The timeout and the closed-window path
  // must both settle the deferred exactly once; `_pinViewExportRequest` is cleared first
  // so a late renderer answer can only be recognised as stale.
  function settlePinViewExport(win, result) {
    const request = win?._pinViewExportRequest
    if (!request) return false
    win._pinViewExportRequest = null
    if (request.timer) {
      clearTimeout(request.timer)
      request.timer = null
    }
    request.resolve(result)
    return true
  }

  function cancelPinViewExport(win, code = 'cancelled') {
    return settlePinViewExport(win, { ok: false, code })
  }

  function requestRenderedViewExport(win) {
    const sequence = Number(win._pinViewExportSeq) || 0
    win._pinViewExportSeq = sequence + 1
    const requestId = `req-${Date.now().toString(36)}-${win._pinViewExportSeq}`
    return new Promise((resolve) => {
      const request = { requestId, resolve, timer: null }
      win._pinViewExportRequest = request
      request.timer = setTimeout(() => {
        if (win._pinViewExportRequest !== request) return
        win._pinViewExportRequest = null
        request.timer = null
        resolve({ ok: false, code: 'timeout' })
      }, viewExportTimeoutMs)
      // A unit-test fake clock must not keep the node process alive on the production default.
      if (typeof request.timer?.unref === 'function') request.timer.unref()
      const sent = sendToRenderer(win, 'pin:view-export-request', { requestId })
      if (sent) return
      settlePinViewExport(win, { ok: false, code: 'unavailable' })
    })
  }

  // Renderer answer -> deferred. The window/request identity checks are what stop a
  // late answer from a re-annotated or closed pin from settling a newer request.
  function handlePinViewExportResult(win, command) {
    const request = win?._pinViewExportRequest
    if (!request || request.requestId !== command.requestId) {
      log('Pin view export answer ignored:', command.requestId, request ? 'request-mismatch' : 'no-request')
      return { status: 'ignored', code: 'STALE_REQUEST' }
    }
    if (!command.ok) {
      settlePinViewExport(win, { ok: false, code: command.code })
      return { status: 'renderer-failed', code: command.code }
    }
    // Re-validate the PNG itself, not just the envelope: the declared size must match the
    // decoded header and the pixel budget is re-checked against the real dimensions.
    const size = readPngSize(command.bytes)
    if (!size || !size.width || !size.height) {
      settlePinViewExport(win, { ok: false, code: 'invalid-png' })
      return { status: 'invalid', code: 'INVALID_PNG' }
    }
    if (size.width !== command.width || size.height !== command.height ||
        size.width > MAX_VIEW_EXPORT_DIMENSION || size.height > MAX_VIEW_EXPORT_DIMENSION ||
        size.width * size.height > MAX_VIEW_EXPORT_PIXELS) {
      settlePinViewExport(win, { ok: false, code: 'invalid-size' })
      return { status: 'invalid', code: 'INVALID_SIZE' }
    }
    settlePinViewExport(win, {
      ok: true,
      bytes: command.bytes,
      size,
      ocrOverlay: command.ocrOverlay === true
    })
    return { status: 'rendered', size }
  }

  // Downscaled so the native preview dialog can actually render it; the full-size
  // image is what gets written, so this never changes the exported orientation.
  function previewIcon(image) {
    if (!image || typeof image.resize !== 'function') return null
    try {
      return image.resize({ width: 128 })
    } catch (error) {
      log('Pin view export preview icon failed:', error.message)
      return null
    }
  }

  function viewExportPreviewText(plan) {
    return [
      t('pin.view-export.preview-size', { width: plan.size.width, height: plan.size.height }),
      t('pin.view-export.preview-include', {
        rotation: plan.rotation,
        zoom: Math.round(plan.zoom * 100)
      }),
      plan.ocrOverlay
        ? t('pin.view-export.preview-ocr-included')
        : t('pin.view-export.preview-ocr-excluded'),
      t('pin.view-export.preview-exclude')
    ].join('\n')
  }

  async function confirmViewExport(win, image, plan) {
    const options = {
      type: 'question',
      title: t('pin.view-export.preview-title'),
      message: t('pin.view-export.preview-message'),
      detail: viewExportPreviewText(plan),
      buttons: [t('pin.view-export.export'), t('common.button.cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const icon = previewIcon(image)
    if (icon) options.icon = icon
    const show = injectedShowMessageBox || defaultShowMessageBox
    const result = await show(win, options)
    return result?.response === 0
  }

  function reportViewExportFailure(message) {
    try {
      const show = injectedShowErrorBox || defaultShowErrorBox
      show(t('pin.view-export.failed'), message)
    } catch (error) {
      log('Pin view export error dialog failed:', error.message)
    }
  }

  async function exportPinView(win) {
    if (!win || win.isDestroyed() || !win._pinData) return null
    if (win._pinViewExporting) return null
    win._pinViewExporting = true
    const imageId = win._pinData.imageId
    // The plan describes the composition the renderer was asked for; both values are
    // captured before the request so a rotation/zoom change during the preview cannot
    // make the dialog describe pixels that were never rendered.
    const rotation = normalizePinRotation(win._pinData.rotation)
    const zoom = Number(win._pinData.zoom) || 1
    try {
      // A hidden pin has nothing to compose; saying so beats writing an empty PNG.
      if (typeof win.isVisible === 'function' && !win.isVisible()) {
        reportViewExportFailure(t('pin.view-export.not-visible'))
        return { status: 'hidden', code: 'NOT_VISIBLE' }
      }
      const rendered = await requestRenderedViewExport(win)
      if (!rendered.ok) {
        // A compose aborted because the window/image went away is not a render failure:
        // return a retryable receipt without a modal dialog. Timeouts and renderer-side
        // failures do explain themselves, because only the user can act on them.
        const code = viewExportResultCode(rendered.code)
        if (code === 'CANCELLED' || code === 'IMAGE_CHANGED') {
          return { status: 'failed', code, retryable: true }
        }
        reportViewExportFailure(t(pinViewExportFailureKey(rendered.code)))
        return { status: 'failed', code, retryable: true }
      }
      // The pin may have been re-annotated or closed while the offscreen compose ran: a
      // PNG for a replaced image must never be saved as if it were the current one.
      if (win.isDestroyed() || !win._pinData) return { status: 'failed', code: 'WINDOW_GONE', retryable: true }
      if (win._pinData.imageId !== imageId) return { status: 'failed', code: 'IMAGE_CHANGED', retryable: true }
      let image = null
      try {
        image = nativeImage.createFromBuffer(rendered.bytes)
      } catch (error) {
        log('Pin view export could not decode the composed PNG:', error.message)
      }
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
        reportViewExportFailure(t('pin.view-export.empty'))
        return { status: 'failed', code: 'EMPTY', retryable: true }
      }
      const plan = describePinViewExport({
        rotation,
        zoom,
        ocrOverlay: rendered.ocrOverlay === true,
        width: rendered.size.width,
        height: rendered.size.height
      })
      const accepted = await confirmViewExport(win, image, plan)
      if (!accepted) return { status: 'cancelled', plan }
      // The preview and the file are the SAME bytes: the renderer's PNG is saved as-is,
      // never re-encoded from the preview image.
      const filePath = await saveImageBuffer(rendered.bytes)
      // A cancelled save dialog is not an error: the user asked for the preview,
      // saw it and backed out.
      return filePath ? { status: 'saved', filePath, plan } : { status: 'cancelled', plan }
    } catch (error) {
      log('Pin view export failed:', error.message)
      reportViewExportFailure(error.message || String(error))
      return { status: 'failed', code: 'FAILED', message: error.message || String(error), retryable: true }
    } finally {
      win._pinViewExporting = false
      cancelPinViewExport(win, 'finished')
    }
  }

  // -------------------------------------------------------------------------
  // N05 / DEV-08: opt-in "real pixel compare" (ADOPTED 2026-11-28).
  //
  // Evidence: docs/plans/2026-11-28-dev08-screen-diff-measurement.md and the reproducible
  // probe in scripts/probe-pin-screen-diff.js. On this Windows host a protected window
  // stays visible but is absent from desktopCapturer frames (0/30 protected frames
  // contained its colour, ~0.986 with protection off), including two stacked pins and the
  // secondary display's negative-origin edge.
  //
  // The main process owns the sampling session because it needs desktopCapturer and
  // content protection:
  //   start -> remember the previous protection state, enable exclusion for the whole
  //            session, sample at most 1 Hz (one in flight, bounded pixels/bytes) and send
  //            one RGBA frame per tick;
  //   stop  -> restore the previous protection state, clear the timer, drop every frame.
  // The renderer diffs each frame against its OWN offscreen current-view composition
  // (pin/pin-view-export.js + pin/pin-diff-view.js); frames are memory-only and never
  // reach workspace snapshots, recovery tickets or history.
  // -------------------------------------------------------------------------
  const injectedDesktopCapturer = deps.screenDiffDesktopCapturer || null
  const injectedSetContentProtection = typeof deps.setContentProtection === 'function'
    ? deps.setContentProtection
    : null
  // P1-01: the production default must resolve the desktopCapturer OBJECT, not a factory.
  // The shipped wiring (main.js createPinDomain) does not inject one, and returning
  // `() => require('electron').desktopCapturer` made the first production frame fail with
  // "capturer.getSources is not a function" (CAPTURE_THREW), which the 1 Hz failure cap
  // then turned into a permanent stop after 3 seconds. The lazy require mirrors the dialog
  // defaults above and keeps the pure node tests Electron-free unless they take this path.
  function resolveDesktopCapturer() {
    if (injectedDesktopCapturer) return injectedDesktopCapturer
    try {
      return require('electron').desktopCapturer || null
    } catch (error) {
      log('Pin screen capture could not resolve desktopCapturer:', error.message)
      return null
    }
  }
  const realDiffIntervalMs = Number.isFinite(Number(deps.realDiffIntervalMs)) && Number(deps.realDiffIntervalMs) >= 250
    ? Number(deps.realDiffIntervalMs)
    : DEFAULT_REAL_DIFF_INTERVAL_MS
  const realDiffMaxPixels = Number.isFinite(Number(deps.realDiffMaxPixels)) && Number(deps.realDiffMaxPixels) > 0
    ? Math.min(Number(deps.realDiffMaxPixels), pinScreenDiff.MAX_CAPTURE_PIXELS)
    : pinScreenDiff.MAX_CAPTURE_PIXELS

  function contentProtectionSetter(win) {
    if (injectedSetContentProtection) return (enabled) => injectedSetContentProtection(win, enabled)
    if (win && typeof win.setContentProtection === 'function') return (enabled) => win.setContentProtection(enabled)
    return null
  }

  // The last protection value THIS domain set. Electron has no getter for content
  // protection, so the prior state can only be what we recorded before enabling; the
  // shipped product never sets it anywhere else. Documented in the measurement note.
  function setPinContentProtection(win, enabled) {
    const setter = contentProtectionSetter(win)
    if (!setter) return false
    try {
      setter(enabled === true)
    } catch (error) {
      log('Pin content protection failed:', error.message)
      return false
    }
    win._pinContentProtection = enabled === true
    return true
  }

  // One frame, no retention: the BGRA bitmap is returned to the caller and dropped from
  // this module immediately (the sampler keeps only numeric stats).
  async function captureScreenUnderPin(win, imageBounds = {}) {
    if (!win || win.isDestroyed() || !win._pinData) return { ok: false, code: 'NO_WINDOW' }
    if (typeof win.isVisible === 'function' && !win.isVisible()) return { ok: false, code: 'HIDDEN' }
    const displays = typeof screen.getAllDisplays === 'function'
      ? screen.getAllDisplays()
      : [screen.getDisplayMatching(win.getBounds())]
    const plan = pinScreenDiff.planScreenCapture({
      pinBounds: win.getBounds(),
      imageBounds,
      rotation: win._pinData.rotation,
      displays
    })
    if (!plan || plan.ok !== true) return plan || { ok: false, code: 'PLAN_FAILED' }
    const capturer = resolveDesktopCapturer()
    // A typed, RETRYABLE failure: a display/source can be temporarily unavailable while a
    // session runs, and the sampler must keep retrying instead of treating it as a real
    // capture error (see createDiffSampler's retryable handling).
    if (!capturer || typeof capturer.getSources !== 'function') {
      return { ok: false, code: 'CAPTURER_UNAVAILABLE', retryable: true }
    }
    let sources = []
    try {
      sources = await capturer.getSources({ types: ['screen'], thumbnailSize: plan.thumbnail })
    } catch (error) {
      return { ok: false, code: 'CAPTURE_THREW', message: error.message }
    }
    // display_id is the authoritative match. There is deliberately NO blind fallback: with
    // more than one display an unidentified source could be the primary screen, and the
    // caller would then crop the target display's coordinates out of the wrong pixels
    // (P2-03). The single-display case is safe by elimination - the only screen source IS
    // the target one - and pickScreenSource states that explicitly.
    const displaysCount = Array.isArray(displays) ? displays.length : 1
    const picked = pinScreenDiff.pickScreenSource(sources, plan.display.id, {
      singleDisplay: displaysCount === 1
    })
    if (!picked || picked.ok !== true) {
      return {
        ok: false,
        code: picked?.code || 'SOURCE_UNIDENTIFIED',
        retryable: true
      }
    }
    const thumbnail = picked.source.thumbnail
    let cropped = null
    try {
      cropped = typeof thumbnail.crop === 'function' ? thumbnail.crop(plan.physicalRect) : null
    } catch (error) {
      return { ok: false, code: 'CROP_FAILED', message: error.message }
    }
    if (!cropped || (typeof cropped.isEmpty === 'function' && cropped.isEmpty())) {
      return { ok: false, code: 'EMPTY_FRAME' }
    }
    const size = typeof cropped.getSize === 'function' ? cropped.getSize() : plan.physicalRect
    // toBitmap() (not the deprecated getBitmap()) returns BGRA on Windows.
    const bytes = typeof cropped.toBitmap === 'function' ? cropped.toBitmap() : null
    if (!bytes || !size?.width || !size?.height || bytes.length !== size.width * size.height * 4) {
      return { ok: false, code: 'FRAME_BUDGET' }
    }
    return {
      ok: true,
      pixels: bytes,
      width: size.width,
      height: size.height,
      bytes: bytes.length,
      sourceMatched: picked.matched,
      plan
    }
  }

  function stopRealPixelCompare(win, reason = 'off', options = {}) {
    const session = win?._realPixelCompare
    if (!session) return false
    win._realPixelCompare = null
    try { session.sampler.stop(reason) } catch {}
    if (session.timer) clearInterval(session.timer)
    if (typeof win.removeListener === 'function' && session.onHide) {
      try { win.removeListener('hide', session.onHide) } catch {}
    }
    if (win._onionMode === 'real-diff') win._onionMode = 'off'
    // Restore the recorded prior state (the product only ever enables it here).
    setPinContentProtection(win, session.priorProtection === true)
    if (options.notify !== false && win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
      sendToRenderer(win, 'pin:onion-mode', { mode: 'off', reason })
    }
    log('Pin real-pixel compare stopped:', reason)
    return true
  }

  function startRealPixelCompare(win, imageBounds = {}) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData) {
      return { ok: false, code: 'NO_WINDOW' }
    }
    if (win._realPixelCompare) stopRealPixelCompare(win, 'restart', { notify: false })
    const setter = contentProtectionSetter(win)
    if (!setter) return { ok: false, code: 'NO_CONTENT_PROTECTION' }
    // The comparison region is the PIN WINDOW's content box: "the pixels under the pin"
    // means everything the window covers, which also makes a long capture (scrolling
    // inside the window) and a moved window work without re-reading renderer geometry.
    // `getContentBounds` is the precise call for these frameless content-sized windows;
    // `getBounds` is the fallback for a test fake that only implements the latter.
    const windowBounds = typeof win.getContentBounds === 'function' ? win.getContentBounds() : win.getBounds()
    const relativeBounds = {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(Number(windowBounds?.width) || Number(imageBounds?.width) || 1)),
      height: Math.max(1, Math.round(Number(windowBounds?.height) || Number(imageBounds?.height) || 1))
    }
    const session = {
      imageBounds: relativeBounds,
      priorProtection: win._pinContentProtection === true,
      frames: 0,
      failures: 0,
      lastStats: null,
      timer: null,
      onHide: null,
      sampler: null,
      sampleOnce: null
    }
    // Protection is enabled for the WHOLE session: the exclusion must hold at the instant
    // the compositor serves the capture, and the menu copy discloses the side effect.
    if (!setPinContentProtection(win, true)) return { ok: false, code: 'NO_CONTENT_PROTECTION' }
    const deliverFrame = (frame) => {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
      if (win._realPixelCompare !== session) return false
      const rgba = pinScreenDiff.bgraToRgba(frame.pixels)
      if (!rgba || rgba.length !== frame.width * frame.height * 4) return false
      frame.rgba = rgba
      session.frames += 1
      return sendToRenderer(win, 'pin:screen-diff-frame', {
        sequence: session.frames,
        width: frame.width,
        height: frame.height,
        dipRect: frame.plan?.dipRect || null,
        scaleFactor: frame.plan?.scaleFactor || 1,
        pixels: rgba
      })
    }
    let sampleOnce = null
    const sampler = pinScreenDiff.createDiffSampler({
      intervalMs: realDiffIntervalMs,
      maxPixels: realDiffMaxPixels,
      captureFrame: async () => {
        const frame = await captureScreenUnderPin(win, session.imageBounds)
        if (!frame.ok) return frame
        // The BGRA bitmap is converted once, delivered to the renderer, and then dropped:
        // the sampler keeps no reference to any frame, only numeric stats.
        const delivered = deliverFrame(frame)
        return {
          ok: delivered,
          code: delivered ? '' : 'DELIVERY_FAILED',
          pixels: delivered ? frame.rgba : null,
          width: frame.width,
          height: frame.height
        }
      }
    })
    session.sampler = sampler
    sampleOnce = async () => {
      if (win._realPixelCompare !== session) return { ok: false, code: 'STOPPED' }
      const result = await sampler.sample()
      if (win._realPixelCompare !== session) return result
      const stats = sampler.getStats()
      session.lastStats = stats
      if (stats.stopped) {
        stopRealPixelCompare(win, stats.stopCode || 'failure-limit')
        return result
      }
      if (!result.ok && result.code !== 'BUSY' && result.code !== 'RATE_LIMITED') {
        // P2-03: a retryable source/display failure is counted separately inside the
        // sampler and never stops the session; only genuine capture errors reach the cap.
        if (result.retryable !== true) session.failures += 1
      }
      return result
    }
    session.sampleOnce = sampleOnce
    win._realPixelCompare = session
    win._onionMode = 'real-diff'
    // A hidden pin (workspace suspend, tray hide) cannot show a diff: stop and release.
    session.onHide = () => stopRealPixelCompare(win, 'hidden')
    if (typeof win.on === 'function') win.on('hide', session.onHide)
    if (typeof setInterval === 'function') {
      session.timer = setInterval(() => { void sampleOnce().catch(() => {}) }, realDiffIntervalMs)
      if (typeof session.timer?.unref === 'function') session.timer.unref()
    }
    sendToRenderer(win, 'pin:onion-mode', { mode: 'real-diff' })
    log('Pin real-pixel compare started:', relativeBounds)
    return {
      ok: true,
      mode: 'real-diff',
      sampleNow: sampleOnce,
      getStats: () => sampler.getStats(),
      stop: (reason) => stopRealPixelCompare(win, reason)
    }
  }

  // Send a mode request to the renderer for the locally-owned onion modes. The renderer
  // answers with an onion-state envelope (availability may downgrade the request).
  function requestOnionMode(win, target) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData) {
      return { ok: false, code: 'NO_WINDOW' }
    }
    // Leaving the real-pixel mode is an explicit mode change: tell the renderer so its
    // overlay is torn down and its badge does not keep the stale ratio.
    if (win._realPixelCompare) stopRealPixelCompare(win, 'mode-change')
    const mode = ONION_MODE_SET.has(target) ? target : 'off'
    win._onionMode = mode
    const action = mode === 'off' ? 'off' : mode === 'difference' ? 'toggle-difference' : 'toggle-flash'
    sendToRenderer(win, 'pin:onion-command', { action })
    return { ok: true, mode }
  }

  // Context-menu entry point for the whole submenu (also the direct test seam).
  function applyOnionModeSelection(win, target, imageBounds = {}) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData) {
      return { ok: false, code: 'NO_WINDOW' }
    }
    if (target === 'real-diff') {
      if (win._realPixelCompare) {
        stopRealPixelCompare(win, 'menu-off')
        return { ok: true, mode: 'off' }
      }
      // The real-pixel overlay replaces the local onion classes; clear them first.
      if (win._onionMode === 'difference' || win._onionMode === 'flash') {
        sendToRenderer(win, 'pin:onion-command', { action: 'off' })
      }
      return startRealPixelCompare(win, imageBounds)
    }
    return requestOnionMode(win, target)
  }

  // Renderer's authoritative echo (also fired by its Ctrl+Shift+D/F shortcuts).
  function applyOnionState(win, state) {
    if (!win?._pinData) return { status: 'ignored' }
    if (state.mode !== 'real-diff' && win._realPixelCompare) {
      stopRealPixelCompare(win, 'renderer-mode-off', { notify: false })
    }
    win._onionMode = state.mode
    return { status: 'ok', mode: state.mode }
  }

  // pdf-export.js owns paper math, print options and the save dialog/file write;
  // its Electron touch points are lazy (electron.dialog inside defaultShowSaveDialog,
  // webContents.printToPDF inside defaultPrintToPdf) and injectable, so importing
  // it here keeps the domain loadable in plain node. `deps.pdfExport` / `deps.printToPdf`
  // / `deps.showSaveDialog` / `deps.writeFile` are the oracle for a test that wants
  // to observe the export without Electron.
  const pdfExport = deps.pdfExport || { exportWindowToPdf, savePdfBuffer }
  const injectedPrintToPdf = typeof deps.printToPdf === 'function' ? deps.printToPdf : null
  const injectedShowSaveDialog = typeof deps.showSaveDialog === 'function' ? deps.showSaveDialog : null
  const injectedWriteFile = typeof deps.writeFile === 'function' ? deps.writeFile : null

  // Display geometry reflow (P0, plan §9.2): the pin domain used to query screens
  // only at creation/move time, so unplugging a monitor or changing the resolution
  // left pins on dead coordinates. The listeners are attached lazily with the first
  // pin window and removed when the last one closes; they are main-process globals
  // either way, so no main.js dispose call is required.
  const displayWatchers = []
  let displayWatchersAttached = false

  function ownsWindow(win) {
    return pinWindows.has(win)
  }

  function getPinnedCount() {
    return pinnedCount
  }

  function canPinMore() {
    return pinnedCount < MAX_PINNED
  }

  function acquirePinnedSlot() {
    if (pinnedCount >= MAX_PINNED) return false
    pinnedCount += 1
    return true
  }

  function releasePinnedSlot() {
    pinnedCount = Math.max(0, pinnedCount - 1)
  }

  function ensureCanPin(editingExisting = false) {
    if (!editingExisting && pinnedCount >= MAX_PINNED) {
      throw new Error(`最多固定 ${MAX_PINNED} 张图片`)
    }
  }

  function sendToRenderer(win, channel, payload) {
    const contents = win?.webContents
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return false
    contents.send(channel, payload)
    return true
  }

  // The window box is derived, never stored: the unrotated display size comes from
  // the pinned pixels + zoom (long captures are additionally capped by the work
  // area), and a quarter turn swaps the axes. Keeping one derivation means
  // move/resize/rotate/display-reflow cannot drift apart.
  function getPinWindowSize(data, { longCapture = data.longCapture, workAreaHeight } = {}) {
    const sized = computePinDisplaySize({
      baseWidth: data.baseWidth,
      baseHeight: data.baseHeight,
      zoom: data.zoom,
      longCapture,
      workAreaHeight
    })
    const rotated = getRotatedPinSize(sized.width, sized.height, data.rotation)
    return { width: rotated.width, height: rotated.height, zoom: sized.zoom, rotation: rotated.rotation }
  }

  function getDisplays(matched) {
    if (typeof screen?.getAllDisplays === 'function') {
      try {
        const displays = screen.getAllDisplays()
        if (Array.isArray(displays) && displays.length) return displays
      } catch {}
    }
    // A minimal screen fake (unit tests, a platform without display enumeration)
    // still answers getDisplayMatching; treat that one display as the whole world
    // so the reflow degrades to the clamping branch instead of doing nothing.
    return matched ? [matched] : []
  }

  function getPrimaryDisplay() {
    if (typeof screen?.getPrimaryDisplay === 'function') {
      try {
        const primary = screen.getPrimaryDisplay()
        if (primary?.workArea) return primary
      } catch {}
    }
    return getDisplays().find((display) => display?.workArea) || null
  }

  function centerOnWorkArea(size, workArea) {
    return {
      x: Math.round(workArea.x + (workArea.width - size.width) / 2),
      y: Math.round(workArea.y + (workArea.height - size.height) / 2),
      width: size.width,
      height: size.height
    }
  }

  // Display geometry reflow (P0, plan §9.2-①): re-places one pin after a display
  // was added, removed, or had its resolution/scale changed. A pin whose box no
  // longer intersects any display is treated as "its display vanished" and moves
  // to the centre of the primary display; everything else is clamped into the
  // matched work area so it cannot end up off-screen. `syncPinDisplayScale` runs
  // afterwards for the DPI part (it is a no-op when the scale factor is unchanged).
  function reflowPinWindow(win) {
    if (!win || win.isDestroyed() || !win._pinData) return false
    const data = win._pinData
    const bounds = win.getBounds()
    let matched = null
    try {
      matched = typeof screen?.getDisplayMatching === 'function' ? screen.getDisplayMatching(bounds) : null
    } catch {
      matched = null
    }
    const displays = getDisplays(matched)
    const matching = displays.filter((display) => boundsIntersectWorkArea(bounds, display.workArea))
    // A box that intersects no display no longer has a home: the display it lived
    // on was unplugged or its work area shrank away. Move it to the primary centre.
    const display = (matching.length && matched?.workArea) ? matched : (getPrimaryDisplay() || matched)
    if (!display?.workArea) return false
    const sized = getPinWindowSize(data, { workAreaHeight: display.workArea.height })
    const target = matching.length
      ? { x: bounds.x, y: bounds.y, width: sized.width, height: sized.height }
      : centerOnWorkArea(sized, display.workArea)
    data.zoom = sized.zoom
    data.rotation = sized.rotation
    // A drag in flight captured the old geometry: drop it instead of letting the
    // next pointer move fight the reflow.
    win._pinMove = null
    win.setBounds(clampPinBoundsToWorkArea(target, display.workArea), false)
    syncPinDisplayScale(win)
    return true
  }

  function reflowPinWindows() {
    let reflowed = 0
    for (const win of [...pinWindows]) {
      if (reflowPinWindow(win)) reflowed += 1
    }
    return reflowed
  }

  // The listeners are main-process globals: they die with the process, so main.js
  // needs no dispose call. They are still attached lazily (first pin) and detached
  // with the last pin, so an app that never pins anything installs nothing.
  function attachPinDisplayWatchers() {
    if (displayWatchersAttached || typeof screen?.on !== 'function') return false
    // A07: the reflow already clamps every pin into a surviving work area; the
    // notification lets a host rebuild the per-display tray groups at the same time.
    // Grouping itself is recomputed on every listPinsByDisplay() call, so a monitor
    // change can never leave a stale group behind.
    const listener = () => {
      const reflowed = reflowPinWindows()
      notifyPinLayoutChanged({ kind: 'display-change', reflowed })
    }
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(eventName, listener)
      displayWatchers.push([eventName, listener])
    }
    displayWatchersAttached = true
    return true
  }

  function detachPinDisplayWatchers() {
    if (!displayWatchersAttached) return false
    const listeners = displayWatchers.splice(0)
    if (typeof screen?.removeListener === 'function') {
      for (const [eventName, listener] of listeners) screen.removeListener(eventName, listener)
    }
    displayWatchersAttached = false
    return true
  }

  // -------------------------------------------------------------------------
  // A07 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
  // Find pins per display, snap at the end of a drag.
  //
  // Up to 20 pins can overlap, and a click-through pin cannot be clicked at all, so the
  // tray needs a per-display list plus three window-level actions. None of them touch
  // the image: imageId, opacity, zoom, rotation and the pixel size stay exactly where
  // they were (that is the ticket's acceptance, and the tests assert it). The menu is
  // built on demand from listPinsByDisplay(); no pin state is persisted.
  // -------------------------------------------------------------------------
  function notifyPinLayoutChanged(change = {}) {
    // Optional host hook (createTrayIcon when main.js wants an immediate refresh). The
    // list itself is computed on every call, so an unwired host still gets a correct
    // menu on the next rebuild instead of a stale cached copy.
    if (typeof deps.onPinLayoutChange !== 'function') return false
    try {
      deps.onPinLayoutChange(change)
    } catch (error) {
      log('Pin layout notification failed:', error.message)
    }
    return true
  }

  function findPinWindow(id) {
    if (typeof id !== 'string' || !id) return null
    for (const win of pinWindows) {
      if (!win || win.isDestroyed()) continue
      if (win._pinId === id || win._pinRecoveryKey === id) return win
    }
    return null
  }

  // Locate: bring the pin back without touching its always-on-top choice (a temporary
  // un-top must survive a locate). A pin whose display vanished outside a display event
  // is reflowed first, so this is also the manual recovery path.
  function focusPin(id) {
    const win = findPinWindow(id)
    if (!win || !win._pinData) return null
    // N05: a suspended workspace is invisible, so the tray's per-pin "locate" entry
    // is the pointer-free recovery path: resume the whole workspace, then focus the
    // requested pin exactly like any other locate.
    if (suspendedWorkspace) resumeWorkspaceNow()
    let bounds = readPinBounds(win)
    const displays = getDisplays()
    if (bounds && displays.length && !displays.some((display) => boundsIntersectWorkArea(bounds, display.workArea))) {
      reflowPinWindow(win)
      bounds = readPinBounds(win)
    }
    if (win.isDestroyed() || !win._pinData) return null
    if (typeof win.isVisible === 'function' && !win.isVisible()) {
      // Do NOT touch _pinVisible here: a pin that has not rendered yet still has to go
      // through revealPinWindow (pin:render-ready) for its opacity/focus hand-off.
      win.show()
    }
    win.moveTop()
    win.focus()
    // A drag interrupted by the focus must not replay on the next pointer move.
    win._pinMove = null
    return {
      id,
      bounds,
      alwaysOnTop: win._pinData.alwaysOnTop !== false,
      clickThrough: win._pinData.clickThrough === true
    }
  }

  function applyPinAlwaysOnTop(win, enabled) {
    if (!win || win.isDestroyed() || !win._pinData) return null
    const next = enabled !== false
    win._pinData.alwaysOnTop = next
    if (typeof win.setAlwaysOnTop === 'function') {
      if (next) win.setAlwaysOnTop(true, 'screen-saver')
      else win.setAlwaysOnTop(false)
    }
    return next
  }

  // Temporary un-top. The optional `enabled` lets the tray send the explicit value from its
  // snapshot (idempotent: a replayed click cannot flip it back), while a keyboard or
  // future settings entry can simply toggle.
  function togglePinAlwaysOnTop(id, enabled) {
    const win = findPinWindow(id)
    if (!win || !win._pinData) return null
    const current = win._pinData.alwaysOnTop !== false
    const next = typeof enabled === 'boolean' ? enabled : !current
    const applied = applyPinAlwaysOnTop(win, next)
    if (applied === null) return null
    if (applied !== current) notifyPinLayoutChanged({ kind: 'always-on-top', id })
    return applied
  }

  // Per-pin click-through exit: the counterpart of exitAllClickThrough, and the same explicit
  // boolean path (clearPinClickThrough only reports a real state change).
  function exitPinClickThrough(id) {
    const win = findPinWindow(id)
    if (!win) return false
    const exited = clearPinClickThrough(win)
    if (exited) notifyPinLayoutChanged({ kind: 'click-through', id })
    return exited
  }

  // The tray payload: one group per display that currently has pins. Group names come
  // from displayLabel (resolution/scale/primary, negative origins printed verbatim);
  // group order is stable (primary first, then left-to-right) so reopening the menu
  // does not reshuffle the screens. `actions` is part of the payload so main.js can
  // wire the whole finder with a single line.
  function listPinsByDisplay() {
    const primary = getPrimaryDisplay()
    const listed = getDisplays()
    const entries = []
    for (const win of pinWindows) {
      if (!win || win.isDestroyed() || !win._pinData) continue
      const bounds = readPinBounds(win)
      if (!bounds) continue
      entries.push({ win, bounds, ordinal: Number(win._pinOrdinal) || 0 })
    }
    entries.sort((a, b) => a.ordinal - b.ordinal)
    const extras = []
    const records = entries.map((entry, position) => {
      let matched = null
      try {
        matched = typeof screen?.getDisplayMatching === 'function' ? screen.getDisplayMatching(entry.bounds) : null
      } catch {
        matched = null
      }
      // Center ownership beats the largest-intersection match at a seam (see
      // services/pin-geometry.js); the match is the fallback for a dead coordinate.
      const display = pickDisplayForBounds(entry.bounds, listed, matched)
      if (display && !listed.some((candidate) => sameDisplay(candidate, display)) &&
        !extras.some((candidate) => sameDisplay(candidate, display))) {
        extras.push(display)
      }
      return { ...entry, index: position + 1, display }
    })
    const ordered = orderDisplays([...listed, ...extras], primary)
    const orderIndex = new Map(ordered.map((display, index) => [displayKey(display), index]))
    const groups = new Map()
    for (const record of records) {
      const display = record.display || primary || null
      const key = displayKey(display)
      let group = groups.get(key)
      if (!group) {
        group = { display, pins: [] }
        groups.set(key, group)
      }
      const data = record.win._pinData
      group.pins.push({
        id: record.win._pinId || record.win._pinRecoveryKey || '',
        index: record.index,
        bounds: { ...record.bounds },
        alwaysOnTop: data.alwaysOnTop !== false,
        clickThrough: data.clickThrough === true,
        opacity: clampPinOpacity(data.opacity),
        rotation: normalizePinRotation(data.rotation)
      })
    }
    const displayGroups = [...groups.values()]
    displayGroups.sort((a, b) => (orderIndex.get(displayKey(a.display)) ?? 0) - (orderIndex.get(displayKey(b.display)) ?? 0))
    return {
      displays: displayGroups.map((group) => {
        const display = group.display
        const order = orderIndex.get(displayKey(display)) ?? 0
        // No primary known (a minimal screen fake): leave the flag off so displayLabel
        // falls back to the first display in the ordered list instead of calling the
        // only screen "secondary".
        const labelSource = primary && display ? { ...display, primary: sameDisplay(display, primary) } : display
        return {
          key: displayKey(display),
          id: display?.id ?? null,
          label: displayLabel(labelSource, order),
          bounds: display?.bounds ? { ...display.bounds } : null,
          workArea: display?.workArea ? { ...display.workArea } : null,
          scaleFactor: Number(display?.scaleFactor) || 1,
          pins: group.pins
        }
      }),
      actions: {
        focusPin: (id) => focusPin(id),
        togglePinAlwaysOnTop: (id, enabled) => togglePinAlwaysOnTop(id, enabled),
        exitPinClickThrough: (id) => exitPinClickThrough(id)
      }
    }
  }

  // Snap on release: called exactly once per drag end (the renderer's pin:move-end),
  // never while moving. `altKey` is the explicit skip; `options.enabled === false` and
  // the injected isPinSnapEnabled() policy are the user preference (no persisted
  // setting is introduced by this ticket). Only x/y change - width/height are carried
  // through untouched, so pixels, opacity and zoom cannot move.
  //
  // U02 (review section 4.2-4): split into a pure planner and one applier. `pin:move-end` needs the
  // target box BEFORE it moves the window (the display-scale resize and the snap have to land
  // in a single setBounds), which is what planPinSnap returns.
  function planPinSnap(win, bounds, altKey = false, options = {}) {
    if (!win || win.isDestroyed() || !win._pinData || win._pinData.clickThrough === true) return null
    const source = bounds || readPinBounds(win)
    if (!source) return null
    let matched = null
    try {
      matched = typeof screen?.getDisplayMatching === 'function' ? screen.getDisplayMatching(source) : null
    } catch {
      matched = null
    }
    const displays = getDisplays(matched)
    const workAreas = displays.map((display) => display?.workArea).filter(Boolean)
    const windowEdges = []
    for (const other of pinWindows) {
      if (other === win || !other || (typeof other.isDestroyed === 'function' && other.isDestroyed())) continue
      if (!other._pinData) continue
      // A hidden pin is not an edge the user can see; snapping to it would look random.
      if (typeof other.isVisible === 'function' && other.isVisible() === false) continue
      const otherBounds = readPinBounds(other)
      if (otherBounds) windowEdges.push(otherBounds)
    }
    const policyEnabled = typeof deps.isPinSnapEnabled === 'function' ? deps.isPinSnapEnabled() !== false : true
    const result = computePinSnap({
      bounds: source,
      workAreas,
      windowEdges,
      snapDistance: options.snapDistance,
      altKey: altKey === true,
      enabled: options.enabled !== false && policyEnabled
    })
    if (!result) return null
    const changed = result.x !== source.x || result.y !== source.y
    return {
      changed,
      bounds: { x: result.x, y: result.y, width: result.width, height: result.height },
      result: {
        id: win._pinId || win._pinRecoveryKey,
        snapped: changed,
        axis: result.snapped,
        displayIndex: result.displayIndex,
        reason: result.reason,
        bounds: { x: result.x, y: result.y, width: result.width, height: result.height }
      }
    }
  }

  function applySnapOnDragEnd(id, altKey = false, options = {}) {
    const win = findPinWindow(id)
    const plan = planPinSnap(win, null, altKey, options)
    if (!plan) return null
    if (plan.changed) {
      win.setBounds(plan.bounds, false)
      notifyPinLayoutChanged({ kind: 'snap', id })
    }
    return plan.result
  }

  // U02 (review section 4.2-4): the display-scale half of a drag end, as a planner. It returns the
  // scaled/clamped target box without touching the window, so the caller can merge it with the
  // snap target and move the window once instead of twice (the old pin:move-end did
  // syncPinDisplayScale -> setBounds and then applySnapOnDragEnd -> setBounds, which on a
  // cross-DPI release produced a visible two-step jump).
  function planPinDisplayScale(win, bounds) {
    if (!win || win.isDestroyed() || !win._pinData) return null
    const data = win._pinData
    const source = bounds || readPinBounds(win)
    if (!source) return null
    let display = null
    try {
      display = typeof screen?.getDisplayMatching === 'function' ? screen.getDisplayMatching(source) : null
    } catch {
      display = null
    }
    if (!display?.workArea) return null
    const aligned = getPixelAlignedPinSize(data.pixelWidth, data.pixelHeight, display)
    if (Math.abs(aligned.scaleFactor - Number(data.displayScaleFactor || 1)) < 0.001) {
      return { changed: false, display, aligned, bounds: source }
    }
    const sized = getPinWindowSize(
      { ...data, baseWidth: aligned.width, baseHeight: aligned.height },
      { workAreaHeight: display.workArea.height }
    )
    return {
      changed: true,
      display,
      aligned,
      sized,
      bounds: clampPinBoundsToWorkArea({
        x: source.x,
        y: source.y,
        width: sized.width,
        height: sized.height
      }, display.workArea)
    }
  }

  function commitPinDisplayScale(win, plan) {
    if (!plan?.changed || !win?._pinData) return false
    const data = win._pinData
    data.displayScaleFactor = plan.aligned.scaleFactor
    data.baseWidth = plan.aligned.width
    data.baseHeight = plan.aligned.height
    data.zoom = plan.sized.zoom
    data.rotation = plan.sized.rotation
    sendToRenderer(win, 'pin:zoom-changed', Math.round(data.zoom * 100))
    return true
  }

  function syncPinDisplayScale(win) {
    const plan = planPinDisplayScale(win)
    if (!plan?.changed) return false
    win.setBounds(plan.bounds, false)
    commitPinDisplayScale(win, plan)
    return true
  }

  // The end-of-drag entry point used by `pin:move-end`. It resolves the display-scale resize and
  // the snap against the SAME pre-move box, merges both target boxes and performs at most ONE
  // win.setBounds. `win._pinMove` is cleared here so a later pointer move cannot replay the drag.
  function applyPinMoveEnd(win, altKey = false, options = {}) {
    if (!win || win.isDestroyed()) return null
    const dragged = !!win._pinMove
    win._pinMove = null
    if (!win._pinData) return { dragged, resized: false, snapped: false, applied: false }
    const bounds = readPinBounds(win)
    if (!bounds) return { dragged, resized: false, snapped: false, applied: false }
    const scalePlan = planPinDisplayScale(win, bounds)
    let target = scalePlan?.bounds || bounds
    let snapPlan = null
    if (dragged) {
      snapPlan = planPinSnap(win, target, altKey, options)
      if (snapPlan?.changed) target = snapPlan.bounds
    }
    const resized = scalePlan?.changed === true
    const snapped = snapPlan?.changed === true
    if (resized || snapped) win.setBounds(target, false)
    if (resized) commitPinDisplayScale(win, scalePlan)
    if (snapped) notifyPinLayoutChanged({ kind: 'snap', id: win._pinId || win._pinRecoveryKey })
    return {
      dragged,
      resized,
      snapped,
      applied: resized || snapped,
      bounds: target,
      scaleFactor: scalePlan?.aligned?.scaleFactor ?? null,
      snap: snapPlan?.result || null
    }
  }

  // -------------------------------------------------------------------------
  // N05 (review section 5.5): pin workspace snapshots.
  //
  // Semantics chosen for "restore" (and documented in the delivery report):
  //   * restore REPLACES the current workspace - the active pins are closed after
  //     every snapshot picture has been pre-read, so a snapshot whose files are all
  //     missing aborts before anything is closed;
  //   * a pin whose copied picture is missing is skipped and reported, the rest are
  //     rebuilt through the normal createPinWindow path with the saved placement;
  //   * suspend hides every pin and keeps the workspace in memory (the image store
  //     still owns the pixels, so resume is instant); resume is reachable from the
  //     tray's per-pin "locate" entry (focusPin) and from the existing
  //     "show/hide every pin" function (togglePinVisibility).
  // The manifest is capped at MAX_WORKSPACE_SNAPSHOTS, newest first: adding an 11th
  // evicts the oldest snapshot and its asset directory.
  // -------------------------------------------------------------------------
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now()
  let workspaceSnapshotFile = ''
  let workspaceSnapshots = []
  let workspaceSnapshotsLoaded = false
  let workspaceSnapshotsLoading = null
  let workspaceSnapshotSequence = 0
  let workspaceOperation = null
  let suspendedWorkspace = null

  function resolveWorkspaceSnapshotFile() {
    if (workspaceSnapshotFile) return workspaceSnapshotFile
    if (typeof deps.getWorkspaceSnapshotsFilePath === 'function') {
      const value = deps.getWorkspaceSnapshotsFilePath()
      if (typeof value === 'string' && value) {
        workspaceSnapshotFile = value
        return workspaceSnapshotFile
      }
    }
    // Production: the pin domain's own directory inside the app data directory.
    // (main.js does not inject the movable data root here, and pin state is local to
    // the process by design; snapshots are the first pin-domain user content.)
    try {
      const { app } = require('electron')
      if (app && typeof app.getPath === 'function') {
        workspaceSnapshotFile = path.join(app.getPath('userData'), 'pins', WORKSPACE_SNAPSHOT_FILE_NAME)
        return workspaceSnapshotFile
      }
    } catch {}
    // Plain-node fallback (tests inject a path; this only keeps a manual probe from
    // writing into the checkout).
    workspaceSnapshotFile = path.join(os.tmpdir(), 'highlighter-pin-workspace', WORKSPACE_SNAPSHOT_FILE_NAME)
    return workspaceSnapshotFile
  }

  function workspaceSnapshotDirectory() {
    return path.dirname(resolveWorkspaceSnapshotFile())
  }

  function workspaceAssetDirectory(snapshotId) {
    return path.join(workspaceSnapshotDirectory(), WORKSPACE_SNAPSHOT_ASSET_DIR, snapshotId)
  }

  function workspaceAssetPath(snapshotId, assetName) {
    if (!WORKSPACE_SNAPSHOT_ASSET.test(String(assetName || ''))) return ''
    return path.join(workspaceAssetDirectory(snapshotId), assetName)
  }

  function createWorkspaceSnapshotId() {
    if (typeof deps.createWorkspaceSnapshotId === 'function') {
      const value = deps.createWorkspaceSnapshotId()
      if (typeof value === 'string' && WORKSPACE_SNAPSHOT_ID.test(value)) return value
    }
    workspaceSnapshotSequence += 1
    const id = `ws-${clock().toString(36)}-${workspaceSnapshotSequence.toString(36)}`
    return WORKSPACE_SNAPSHOT_ID.test(id) ? id : `ws-${Date.now().toString(36)}-${workspaceSnapshotSequence.toString(36)}`
  }

  async function persistWorkspaceSnapshots() {
    await atomicWriteJson(resolveWorkspaceSnapshotFile(), {
      version: WORKSPACE_SNAPSHOT_SCHEMA,
      savedAt: new Date(clock()).toISOString(),
      snapshots: workspaceSnapshots
    })
  }

  async function ensureWorkspaceSnapshotsLoaded() {
    if (workspaceSnapshotsLoaded) return workspaceSnapshots
    if (workspaceSnapshotsLoading) return workspaceSnapshotsLoading
    workspaceSnapshotsLoading = (async () => {
      const filePath = resolveWorkspaceSnapshotFile()
      let text = null
      try {
        text = await fsp.readFile(filePath, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') log('Pin workspace snapshots read failed:', error.message)
      }
      const parsed = text == null ? { snapshots: [], corrupt: false } : parseWorkspaceSnapshotText(text)
      workspaceSnapshots = parsed.snapshots
      workspaceSnapshotsLoaded = true
      if (parsed.corrupt) {
        // Ignore + rebuild: a corrupt manifest must not disable the feature, and the
        // first successful mutation will persist the empty list anyway.
        log('Pin workspace snapshots were corrupt; rebuilding the manifest')
        await persistWorkspaceSnapshots().catch((error) => log('Pin workspace snapshot rebuild failed:', error.message))
      } else {
        await pruneWorkspaceSnapshotAssets().catch((error) => log('Pin workspace snapshot prune failed:', error.message))
      }
      return workspaceSnapshots
    })().finally(() => {
      workspaceSnapshotsLoading = null
    })
    return workspaceSnapshotsLoading
  }

  async function pruneWorkspaceSnapshotAssets() {
    const root = path.join(workspaceSnapshotDirectory(), WORKSPACE_SNAPSHOT_ASSET_DIR)
    let names = []
    try {
      names = await fsp.readdir(root)
    } catch {
      return false
    }
    const keep = new Set(workspaceSnapshots.map((snapshot) => snapshot.id))
    for (const name of names) {
      if (keep.has(name)) continue
      await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {})
    }
    return true
  }

  function listWorkspaceSnapshots() {
    return ensureWorkspaceSnapshotsLoaded().then((snapshots) => snapshots.map(describeWorkspaceSnapshot))
  }

  // One live pin as a serialisable placement. Mirrors the fields the retention
  // policy already stores, plus zoom/rotation/long-capture and the durable picture.
  function capturePinPlacement(win) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData) return null
    const data = win._pinData
    const bounds = readPinBounds(win)
    const annotations = data.annotations !== undefined ? data.annotations : data.meta?.annotations
    return {
      bounds,
      zoom: clampPinZoom(data.zoom),
      rotation: normalizePinRotation(data.rotation),
      opacity: clampPinOpacity(data.opacity),
      clickThrough: data.clickThrough === true,
      alwaysOnTop: data.alwaysOnTop !== false,
      longCapture: data.longCapture === true,
      pixelWidth: Math.max(1, Math.round(Number(data.pixelWidth) || 1)),
      pixelHeight: Math.max(1, Math.round(Number(data.pixelHeight) || 1)),
      baseWidth: Math.max(1, Math.round(Number(data.baseWidth) || Number(data.pixelWidth) || 1)),
      baseHeight: Math.max(1, Math.round(Number(data.baseHeight) || Number(data.pixelHeight) || 1)),
      displayScaleFactor: Number(data.displayScaleFactor) > 0 ? Number(data.displayScaleFactor) : 1,
      annotations: annotations === undefined ? null : cloneJsonValue(annotations),
      meta: cloneJsonValue(data.meta) || {}
    }
  }

  function orderedWorkspacePins() {
    return [...pinWindows]
      .filter((win) => win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) && win._pinData)
      .sort((left, right) => (Number(left._pinOrdinal) || 0) - (Number(right._pinOrdinal) || 0))
  }

  // Reads and copies the live pictures one at a time, so the snapshot never holds
  // every pin's bytes in memory at once (up to 20 pins, each up to the store quota).
  // The final `pins` entries are placement + asset reference, never the bytes.
  async function writeWorkspaceSnapshotPictures(snapshotId) {
    const directory = workspaceAssetDirectory(snapshotId)
    const pins = []
    try {
      await fsp.mkdir(directory, { recursive: true })
      for (const win of orderedWorkspacePins()) {
        const placement = capturePinPlacement(win)
        if (!placement) continue
        const imageId = win._pinData.imageId
        const { bytes, mime } = await pinImages.read(imageId)
        // The pin can be closed/re-annotated while the spilled pixels are read: a
        // snapshot must never mix an old placement with a newer picture.
        if (win.isDestroyed() || !win._pinData || win._pinData.imageId !== imageId || !bytes?.length) {
          throw Object.assign(new Error('Pin changed while saving the workspace'), { code: 'PIN_CHANGED' })
        }
        const asset = `pin-${pins.length + 1}.${workspaceImageExtension(mime)}`
        await writeBytesAtomic(path.join(directory, asset), bytes)
        pins.push({ ...placement, asset, mime, bytes: bytes.length })
      }
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return pins
  }

  async function saveWorkspaceSnapshot(rawName) {
    if (workspaceOperation) return { status: 'failed', code: 'BUSY' }
    const name = normalizeWorkspaceSnapshotName(rawName)
    if (!name) return { status: 'failed', code: 'NAME_REQUIRED' }
    workspaceOperation = 'save'
    try {
      await ensureWorkspaceSnapshotsLoaded()
      const id = createWorkspaceSnapshotId()
      const pins = await writeWorkspaceSnapshotPictures(id)
      if (!pins.length) {
        await fsp.rm(workspaceAssetDirectory(id), { recursive: true, force: true }).catch(() => {})
        return { status: 'failed', code: 'NO_PINS' }
      }
      const snapshot = buildWorkspaceSnapshot({ id, name, createdAt: clock(), pins })
      if (!snapshot) {
        await fsp.rm(workspaceAssetDirectory(id), { recursive: true, force: true }).catch(() => {})
        return { status: 'failed', code: 'INVALID_SNAPSHOT' }
      }
      const { snapshots, evicted } = appendWorkspaceSnapshot(workspaceSnapshots, snapshot)
      const previous = workspaceSnapshots
      workspaceSnapshots = snapshots
      try {
        await persistWorkspaceSnapshots()
      } catch (error) {
        workspaceSnapshots = previous
        throw error
      }
      for (const stale of evicted) {
        await fsp.rm(workspaceAssetDirectory(stale.id), { recursive: true, force: true }).catch(() => {})
      }
      notifyPinLayoutChanged({ kind: 'workspace-snapshot-saved', id: snapshot.id })
      return { status: 'saved', id: snapshot.id, name: snapshot.name, pinCount: snapshot.pins.length }
    } catch (error) {
      log('Pin workspace snapshot save failed:', error.message)
      return { status: 'failed', code: error.code || 'SAVE_FAILED' }
    } finally {
      workspaceOperation = null
    }
  }

  async function deleteWorkspaceSnapshot(snapshotId) {
    if (workspaceOperation) return { status: 'failed', code: 'BUSY' }
    workspaceOperation = 'delete'
    try {
      await ensureWorkspaceSnapshotsLoaded()
      const index = workspaceSnapshots.findIndex((snapshot) => snapshot.id === snapshotId)
      if (index < 0) return { status: 'failed', code: 'NOT_FOUND' }
      const previous = workspaceSnapshots
      const [removed] = workspaceSnapshots.splice(index, 1)
      try {
        await persistWorkspaceSnapshots()
      } catch (error) {
        workspaceSnapshots = previous
        throw error
      }
      await fsp.rm(workspaceAssetDirectory(removed.id), { recursive: true, force: true }).catch(() => {})
      return { status: 'deleted', id: removed.id, name: removed.name }
    } catch (error) {
      log('Pin workspace snapshot delete failed:', error.message)
      return { status: 'failed', code: error.code || 'DELETE_FAILED' }
    } finally {
      workspaceOperation = null
    }
  }

  // Placement restore shared by snapshot rebuild and suspend/resume. Order matters:
  // the stored presentation lands on _pinData first (pin:init reads it at send
  // time), then the window box is derived from it with the same helpers zoom,
  // rotation and display reflow use, then click-through/always-on-top are applied.
  function applyWorkspacePlacement(win, placement) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData || !placement) return false
    const data = win._pinData
    if (Number(placement.pixelWidth) > 0) data.pixelWidth = Math.max(1, Math.round(Number(placement.pixelWidth)))
    if (Number(placement.pixelHeight) > 0) data.pixelHeight = Math.max(1, Math.round(Number(placement.pixelHeight)))
    // The saved base size is DIP on the display the snapshot was taken on. Recompute
    // it from the source pixels for the display the pin is landing on (the same
    // helper createPinWindow and the display reflow use), so restoring across a DPI
    // change keeps the picture pixel-crisp instead of reusing stale DIP values.
    let display = null
    try {
      display = typeof screen?.getDisplayMatching === 'function'
        ? screen.getDisplayMatching(placement.bounds || readPinBounds(win))
        : null
    } catch {
      display = null
    }
    const aligned = getPixelAlignedPinSize(data.pixelWidth, data.pixelHeight, display)
    data.baseWidth = aligned.width
    data.baseHeight = aligned.height
    data.displayScaleFactor = aligned.scaleFactor
    data.zoom = clampPinZoom(placement.zoom)
    data.rotation = normalizePinRotation(placement.rotation)
    data.opacity = clampPinOpacity(placement.opacity)
    data.alwaysOnTop = placement.alwaysOnTop !== false
    if (placement.longCapture === true) data.longCapture = true
    if (placement.bounds) {
      const sized = getPinWindowSize(data, { workAreaHeight: display?.workArea?.height })
      const target = clampPinBoundsToWorkArea({
        x: placement.bounds.x,
        y: placement.bounds.y,
        width: sized.width,
        height: sized.height
      }, display?.workArea || placement.bounds)
      win.setBounds(target, false)
    }
    if (placement.clickThrough === true) setPinClickThrough(win, true)
    else if (win._pinData.clickThrough === true) setPinClickThrough(win, false)
    applyPinAlwaysOnTop(win, placement.alwaysOnTop !== false)
    return true
  }

  function snapshotRestoreMeta(pin) {
    const meta = pin.meta && typeof pin.meta === 'object' ? { ...pin.meta } : {}
    if (pin.longCapture === true) meta.longCapture = true
    // No selectionBounds here: createPinWindow treats that as a preferred display
    // size, which would size the window for the saved CROP instead of the saved
    // zoom/base pair. applyWorkspacePlacement owns position and size.
    delete meta.selectionBounds
    if (pin.annotations !== null && pin.annotations !== undefined) meta.annotations = pin.annotations
    return meta
  }

  async function closeAllPinsForWorkspaceRestore() {
    for (const win of [...pinWindows]) {
      try {
        win.close()
      } catch {}
    }
    // A real BrowserWindow emits `closed` asynchronously (the domain releases the
    // image-store reference there); wait for the registry to drain so the rebuilt
    // pins cannot hit the 20-pin budget against windows that are already closing.
    const deadline = Date.now() + 1000
    while (pinWindows.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    for (const win of [...pinWindows]) {
      try {
        win.destroy()
      } catch {}
    }
  }

  async function notifyWorkspaceRestoreSkipped(receipt) {
    try {
      const options = {
        type: receipt.restored > 0 ? 'warning' : 'error',
        title: t('pin.workspace.restore-missing-title'),
        message: t('pin.workspace.restore-missing-message', {
          restored: receipt.restored,
          total: receipt.total,
          missing: receipt.missing + (Number(receipt.failed) || 0)
        }),
        buttons: [t('common.button.ok')],
        defaultId: 0,
        noLink: true
      }
      if (typeof deps.showMessageBox === 'function') {
        await deps.showMessageBox(null, options)
        return true
      }
      const { dialog } = require('electron')
      await dialog.showMessageBox(options)
      return true
    } catch (error) {
      log('Pin workspace restore notice failed:', error.message)
      return false
    }
  }

  async function restoreWorkspaceSnapshot(snapshotId) {
    if (workspaceOperation) return { status: 'failed', code: 'BUSY' }
    workspaceOperation = 'restore'
    try {
      await ensureWorkspaceSnapshotsLoaded()
      const snapshot = workspaceSnapshots.find((entry) => entry.id === snapshotId)
      if (!snapshot) return { status: 'failed', code: 'NOT_FOUND' }
      // Validate every picture BEFORE closing anything: a snapshot whose assets are
      // all gone must be a no-op, not a destructive one. Only the paths are kept -
      // the bytes are read one at a time while rebuilding, so a 20-pin workspace is
      // never held in memory twice.
      const loaded = []
      const missing = []
      for (let index = 0; index < snapshot.pins.length; index += 1) {
        const pin = snapshot.pins[index]
        const filePath = pin.asset ? workspaceAssetPath(snapshot.id, pin.asset) : ''
        try {
          if (!filePath) throw new Error('no asset')
          const stat = await fsp.stat(filePath)
          if (!stat.isFile() || stat.size <= 0) throw new Error('empty asset')
          loaded.push({ pin, filePath, index })
        } catch {
          missing.push({ index: index + 1, code: 'IMAGE_MISSING' })
        }
      }
      if (!loaded.length) {
        return {
          status: 'failed',
          code: 'ALL_IMAGES_MISSING',
          restored: 0,
          total: snapshot.pins.length,
          missing: missing.length,
          failed: 0,
          skipped: missing
        }
      }
      suspendedWorkspace = null
      await closeAllPinsForWorkspaceRestore()
      const failed = []
      for (const item of loaded) {
        try {
          const bytes = await fsp.readFile(item.filePath)
          if (!bytes.length) throw new Error('empty asset')
          const win = createPinWindow(bytes, snapshotRestoreMeta(item.pin))
          applyWorkspacePlacement(win, item.pin)
        } catch (error) {
          log('Pin workspace snapshot pin restore failed:', error.message)
          failed.push({ index: item.index + 1, code: error.code || 'CREATE_FAILED' })
        }
      }
      const restored = loaded.length - failed.length
      const receipt = {
        status: restored > 0 ? 'restored' : 'failed',
        code: restored > 0 ? '' : 'CREATE_FAILED',
        restored,
        total: snapshot.pins.length,
        missing: missing.length,
        failed: failed.length,
        skipped: [...missing, ...failed]
      }
      if (missing.length || failed.length) await notifyWorkspaceRestoreSkipped(receipt)
      return receipt
    } catch (error) {
      log('Pin workspace snapshot restore failed:', error.message)
      return { status: 'failed', code: error.code || 'RESTORE_FAILED' }
    } finally {
      workspaceOperation = null
    }
  }

  async function restoreLatestWorkspaceSnapshot() {
    await ensureWorkspaceSnapshotsLoaded()
    const latest = workspaceSnapshots[0]
    if (!latest) return { status: 'failed', code: 'NOT_FOUND' }
    return restoreWorkspaceSnapshot(latest.id)
  }

  // Suspend/resume: no file I/O, no image copy - the live windows stay alive hidden,
  // so the image store keeps owning the pixels and resume is a placement + show.
  function suspendPinWorkspace() {
    if (suspendedWorkspace) return { status: 'noop', code: 'ALREADY_SUSPENDED', count: suspendedWorkspace.entries.length }
    const entries = []
    for (const win of orderedWorkspacePins()) {
      const placement = capturePinPlacement(win)
      if (!placement) continue
      entries.push({ win, placement })
    }
    if (!entries.length) return { status: 'failed', code: 'NO_PINS' }
    suspendedWorkspace = { savedAt: clock(), entries }
    for (const entry of entries) {
      try {
        entry.win.hide()
      } catch {}
    }
    notifyPinLayoutChanged({ kind: 'workspace-suspended', count: entries.length })
    return { status: 'suspended', count: entries.length }
  }

  function resumeWorkspaceNow() {
    if (!suspendedWorkspace) return { status: 'noop', code: 'NOT_SUSPENDED' }
    const state = suspendedWorkspace
    suspendedWorkspace = null
    let resumed = 0
    let skipped = 0
    let focused = false
    for (const entry of state.entries) {
      const win = entry.win
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData || !pinWindows.has(win)) {
        skipped += 1
        continue
      }
      applyWorkspacePlacement(win, entry.placement)
      try {
        if (win._pinVisible === true) {
          // It had already been revealed before the suspend: show() + the stored
          // opacity is the whole restore, revealPinWindow would early-return.
          win.show()
          win.setOpacity(clampPinOpacity(entry.placement.opacity))
          win.moveTop()
        } else {
          revealPinWindow(win)
        }
        if (!focused) {
          focused = true
          win.focus()
        }
      } catch {}
      resumed += 1
    }
    notifyPinLayoutChanged({ kind: 'workspace-resumed', count: resumed })
    return { status: 'resumed', resumed, skipped }
  }

  function resumePinWorkspace() {
    return resumeWorkspaceNow()
  }

  function isPinWorkspaceSuspended() {
    return suspendedWorkspace !== null
  }

  // The renderer's workspace command envelope (see WORKSPACE_COMMAND_TYPES). The
  // main process re-validates everything it receives; nothing here accepts a path.
  async function runWorkspaceCommand(win, command) {
    switch (command.type) {
      case 'workspace-save': {
        const receipt = await saveWorkspaceSnapshot(command.name)
        sendWorkspaceResult(win, 'save', receipt)
        return receipt
      }
      case 'workspace-restore': {
        const receipt = await restoreWorkspaceSnapshot(command.id)
        sendWorkspaceResult(win, 'restore', receipt)
        return receipt
      }
      case 'workspace-restore-latest': {
        const receipt = await restoreLatestWorkspaceSnapshot()
        sendWorkspaceResult(win, 'restore', receipt)
        return receipt
      }
      case 'workspace-delete': {
        const receipt = await deleteWorkspaceSnapshot(command.id)
        sendWorkspaceResult(win, 'delete', receipt)
        return receipt
      }
      case 'workspace-suspend': {
        const receipt = suspendPinWorkspace()
        sendWorkspaceResult(win, 'suspend', receipt)
        return receipt
      }
      case 'workspace-resume': {
        const receipt = resumePinWorkspace()
        sendWorkspaceResult(win, 'resume', receipt)
        return receipt
      }
      case 'workspace-list': {
        const receipt = { status: 'ok', snapshots: await listWorkspaceSnapshots() }
        sendWorkspaceResult(win, 'list', receipt)
        return receipt
      }
      default:
        return { status: 'failed', code: 'INVALID_COMMAND' }
    }
  }

  function sendWorkspaceResult(win, action, receipt) {
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false
    return sendToRenderer(win, 'pin:workspace-result', {
      action,
      ...(receipt && typeof receipt === 'object' ? receipt : {})
    })
  }

  // Opens the pin's context menu; a workspace command envelope (the optional second
  // argument) short-circuits the menu. Every menu entry is built from a locale key.
  async function handlePinContextMenu(event, imageBounds = {}, command = null) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win?._pinData) return null
    // DEV-02: the renderer-composed current-view PNG arrives as a bounded command
    // envelope on this same authorisation surface (no new IPC channel). It is answered
    // before the workspace normaliser, which only understands its own command types.
    const viewExportCommand = normalizeViewExportCommand(command)
    if (viewExportCommand) return handlePinViewExportResult(win, viewExportCommand)
    // DEV-08: the pin renderer reports its authoritative onion mode (its Ctrl+Shift+D/F
    // shortcuts can change it without the menu). Same bounded envelope, no new channel.
    const onionState = normalizeOnionStateCommand(command)
    if (onionState) return applyOnionState(win, onionState)
    const workspaceCommand = normalizeWorkspaceCommand(command)
    if (workspaceCommand) return runWorkspaceCommand(win, workspaceCommand)
    const bounds = imageBounds && typeof imageBounds === 'object' ? imageBounds : {}
    // Table/QR recognition still take a data URL, and a spilled pin now has to be
    // read asynchronously before it can be encoded. Capture the pin data so a
    // closed or re-annotated window cannot be encoded by a late read.
    const recognizeWithDataUrl = async (kind, name) => {
      const data = win._pinData
      if (!data) return
      try {
        const url = await pinDataUrl(data)
        if (win.isDestroyed() || win._pinData !== data) return
        createRecognitionWindow(kind, url, { scaleFactor: data.displayScaleFactor })
      } catch (error) {
        log(`${name} recognition failed:`, error.message)
      }
    }
    let savedSnapshots = []
    try {
      savedSnapshots = await listWorkspaceSnapshots()
    } catch (error) {
      log('Pin workspace snapshots unavailable for the menu:', error.message)
    }
    // The manifest load is asynchronous: the pin may have been closed (or have had
    // its picture replaced) while it was in flight, and a stale menu must not open.
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win._pinData) return null
    const snapshotItems = (buildItem) => (savedSnapshots.length
      ? savedSnapshots.map(buildItem)
      : [{ label: t('pin.workspace.menu-empty'), enabled: false }])
    const snapshotLabel = (snapshot) => `${snapshot.name || t('pin.workspace.untitled')} · ${t('pin.workspace.pin-count', { count: snapshot.pinCount })}`
    const menu = Menu.buildFromTemplate([
      {
        label: '重新标注',
        click: async () => {
          try {
            await startPinReannotation(win, bounds)
          } catch (error) {
            log('Reannotate pin failed:', error.message)
          }
        }
      },
      ...[['ocr', 'pin.recognition.ocr'], ['translate', 'pin.recognition.translate']].map(([action, label]) => ({
        label: t(label),
        enabled: !!getSettings().plugins.ocr && !win._pinRecognition,
        click: () => void runPinRecognition(win, action)
      })),
      {
        label: '表格识别',
        enabled: !!getSettings().plugins.ocr,
        click: () => void recognizeWithDataUrl('table', 'Table')
      },
      {
        label: '二维码识别',
        click: () => void recognizeWithDataUrl('qr', 'QR')
      },
      { type: 'separator' },
      // P1 (plan §9.3): the rotation helpers were finished and unit-tested with
      // no production caller. A quarter turn only changes the stored angle and
      // the window box; the renderer applies the CSS transform to the same
      // image. Disabled for long captures: they scroll and
      // the rotated frame in pin.css is a fixed-size overlay (see rotatePin).
      {
        label: '旋转 90°',
        enabled: !win._pinData.longCapture,
        click: () => rotatePin(win, 90)
      },
      { type: 'separator' },
      {
        label: '透明度',
        submenu: [1, 0.75, 0.5, 0.25].map((opacity) => ({
          label: `${Math.round(opacity * 100)}%`,
          type: 'radio',
          checked: Math.abs((Number(win._pinData.opacity) || 1) - opacity) < 0.005,
          click: () => setPinOpacity(win, opacity)
        }))
      },
      {
        // Same radio template as the opacity submenu: each item states the
        // value it wants, and the checked item is the current state. Once the
        // pin ignores mouse events this menu is unreachable (clicks are not
        // forwarded), which is why the batch exit below exists.
        label: '点击穿透',
        submenu: [true, false].map((enabled) => ({
          label: enabled ? '开启' : '关闭',
          type: 'radio',
          checked: (win._pinData.clickThrough === true) === enabled,
          click: () => setPinClickThrough(win, enabled)
        }))
      },
      {
        // DEV-08: onion-skin comparison, opt-in per pin. Difference and flash are the
        // shipped renderer-only modes; "real pixel compare" is the new experimental
        // adoption that samples the screen UNDER this pin (the pin itself is excluded
        // from captures while it runs, which the hint row states).
        label: t('pin.onion.menu-label'),
        submenu: [
          {
            label: t('pin.onion.mode-off'),
            type: 'radio',
            checked: (win._onionMode || 'off') === 'off',
            click: () => applyOnionModeSelection(win, 'off', bounds)
          },
          {
            label: t('pin.onion.mode-difference'),
            type: 'radio',
            checked: win._onionMode === 'difference',
            click: () => applyOnionModeSelection(win, 'difference', bounds)
          },
          {
            label: t('pin.onion.mode-flash'),
            type: 'radio',
            checked: win._onionMode === 'flash',
            click: () => applyOnionModeSelection(win, 'flash', bounds)
          },
          { type: 'separator' },
          {
            label: t('pin.onion.mode-real-diff'),
            type: 'radio',
            checked: win._onionMode === 'real-diff',
            click: () => applyOnionModeSelection(win, 'real-diff', bounds)
          },
          { label: t('pin.onion.real-diff.side-effect'), enabled: false }
        ]
      },
      { type: 'separator' },
      // B03: the two exited-from-a-pin menus used to blur together ("复制"/"保存"),
      // even though they always read the ORIGINAL stored bytes (rotation-proof).
      // They are now named that way, and the view export is a separate, explicit
      // entry below with its own preview.
      { label: t('pin.menu.copy-original'), click: () => void copyPin(win) },
      { label: t('pin.menu.save-original'), click: () => savePin(win).catch((error) => log(error.message)) },
      { type: 'separator' },
      // B03: the current rendering (rotation + zoom + the OCR overlay on screen).
      // A separate group from the original-bytes actions above, because the two
      // produce different pictures and the old shared wording could not say which.
      {
        label: t('pin.menu.export-view'),
        // A second export while the preview is open would stack two captures of the
        // same window; the guard inside exportPinView is the real gate, this is the
        // visible half of it.
        enabled: !win._pinViewExporting,
        click: () => exportPinView(win).catch((error) => log('Pin view export failed:', error.message))
      },
      // P0 (plan §0.3 #4): exportWindowToPdf had unit tests and no production
      // caller. Exporting the pin itself (not a re-render) keeps it WYSIWYG.
      {
        label: '导出 PDF…',
        click: () => exportPinToPdf(win).catch((error) => log('Pin PDF export failed:', error.message))
      },
      { type: 'separator' },
      // N05: the pin domain's own menu is the snapshot entry point (the tray is
      // assembled by main.js and must not be wired here). Restore/delete list the
      // persisted snapshots; save asks this window's renderer for a name.
      {
        label: t('pin.workspace.menu-label'),
        submenu: [
          {
            label: t('pin.workspace.menu-save'),
            click: () => sendToRenderer(win, 'pin:workspace-name-request')
          },
          {
            label: isPinWorkspaceSuspended() ? t('pin.workspace.menu-resume') : t('pin.workspace.menu-suspend'),
            click: () => {
              if (isPinWorkspaceSuspended()) resumePinWorkspace()
              else suspendPinWorkspace()
            }
          },
          {
            label: t('pin.workspace.menu-restore'),
            submenu: snapshotItems((snapshot) => ({
              label: snapshotLabel(snapshot),
              click: () => restoreWorkspaceSnapshot(snapshot.id).catch((error) => log('Pin workspace restore failed:', error.message))
            }))
          },
          {
            label: t('pin.workspace.menu-delete'),
            submenu: snapshotItems((snapshot) => ({
              label: snapshotLabel(snapshot),
              click: () => deleteWorkspaceSnapshot(snapshot.id).catch((error) => log('Pin workspace delete failed:', error.message))
            }))
          }
        ]
      },
      { type: 'separator' },
      { label: '关闭', click: () => { if (!win.isDestroyed()) win.close() } }
    ])
    menu.popup({ window: win })
    return menu
  }

  function createPinWindow(input, meta = {}, options = {}) {
    ensureCanPin(false)
    // D05 (18): a private capture carries its "do not keep" flag in the meta, so a pin that
    // is retained after an abnormal exit and later recovered still knows it must not write
    // history. The capture domain also sets the window field directly for the live window.
    const inheritedSkipHistory = meta?.skipHistory === true
    const image = preparePinImage(input)
    const { size } = image
    const selectionBounds = normalizeSelectionBounds(meta.selectionBounds)
    const display = selectionBounds
      ? screen.getDisplayMatching(selectionBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const maxWidth = Math.round(display.workArea.width * 0.55)
    const maxHeight = Math.round(display.workArea.height * 0.55)
    const longCapture = !!meta.longCapture
    const aligned = getPixelAlignedPinSize(size.width, size.height, display, selectionBounds)
    const baseWidth = aligned.width
    const baseHeight = aligned.height
    const zoom = longCapture
      ? Math.min(1, maxWidth / baseWidth)
      : (selectionBounds ? 1 : Math.min(1, maxWidth / baseWidth, maxHeight / baseHeight))
    const width = Math.max(1, Math.round(baseWidth * zoom))
    const height = longCapture
      ? Math.max(1, Math.min(maxHeight, Math.round(baseHeight * zoom)))
      : Math.max(1, Math.round(baseHeight * zoom))
    const cursor = screen.getCursorScreenPoint()
    const x = selectionBounds?.x ?? Math.round(Math.min(display.workArea.x + display.workArea.width - width, Math.max(display.workArea.x, cursor.x - width / 2)))
    const y = selectionBounds?.y ?? Math.round(Math.min(display.workArea.y + display.workArea.height - height, Math.max(display.workArea.y, cursor.y - 30)))
    const pagePath = path.join(rootDirectory, 'pin', 'pin.html')
    // Stable per-window key for the retention policy: a window may retain at most
    // once, so a second renderer crash cannot stack two tickets on one pin.
    const windowKey = `pin-window-${++pinWindowSequence}`
    const win = createLocalWindow(pagePath, {
      role: `pin:${pinnedCount + 1}`,
      width: Math.min(width, 200),
      height: Math.min(height, 160),
      x: display.bounds.x,
      y: display.bounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      opacity: 0,
      resizable: false,
      useContentSize: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-pin.js')
      }
    })
    win._pinRecoveryKey = windowKey
    // DEV-02: request sequence and in-flight state for the offscreen view export.
    win._pinViewExportSeq = 0
    win._pinViewExporting = false
    win._pinViewExportRequest = null
    // DEV-08: onion-skin state mirrored for the context-menu radio items, plus the
    // content-protection value THIS domain last set (Electron exposes no getter).
    win._onionMode = 'off'
    win._pinContentProtection = false
    win._realPixelCompare = null
    // A07: the stable id the tray uses for locate/toggle/exit-click-through.
    win._pinId = windowKey
    // A user-initiated close marks the window as normal before any teardown can
    // race the crash listener, so only abnormal exits retain pixels.
    win.on('close', () => { win._pinClosing = true })
    win.on('closed', () => {
      win._pinClosed = true
      // DEV-02: a compose in flight must settle (and release its timer) even when the
      // window disappears before answering; the deferred's only observer is exportPinView.
      cancelPinViewExport(win, 'window-closed')
      // DEV-08: closing must release the capture sampler and restore content protection.
      stopRealPixelCompare(win, 'window-closed', { notify: false })
      win._pinRecognition?.abort()
      // The domain always gives back its own reference. After a crash the policy
      // holds a second one, so this releases the window's share and the retained
      // ticket keeps the image alive until recovery/save/discard/TTL.
      pinImages.release(win._pinData?.imageId)
      // U02 / DEV-01: the in-memory editable snapshot dies with its window.
      releasePinEditable(win)
      win._pinData = null
      if (pinWindows.delete(win)) pinnedCount = Math.max(0, pinnedCount - 1)
      if (pinWindows.size === 0) detachPinDisplayWatchers()
      notifyPinLayoutChanged({ kind: 'removed', id: win._pinId || win._pinRecoveryKey })
    })
    win.webContents.on?.('render-process-gone', (_event, details) => {
      // A dead renderer will never answer a pending compose request.
      cancelPinViewExport(win, 'renderer-gone')
      // DEV-08: the diff display is gone with the renderer; release the sampler now and
      // restore content protection before the recovery/destroy path runs.
      stopRealPixelCompare(win, 'renderer-gone', { notify: false })
      handlePinRendererGone(win, details)
    })
    let retainedForWindow = null
    try {
      const settings = getSettings()
      let imageId
      if (options.reuseImageId != null) {
        // Recovery keeps the retained entry: the new window takes its own
        // reference instead of copying the pixels into a second asset.
        if (typeof pinImages.retain !== 'function' || pinImages.retain(options.reuseImageId) === false) {
          throw new Error('贴图资源已释放')
        }
        retainedForWindow = options.reuseImageId
        imageId = options.reuseImageId
      } else {
        imageId = pinImages.add(image)
      }
      if (inheritedSkipHistory) win._skipHistory = true
      win._pinData = {
        imageId,
        // Budget material for the retention policy; the store does not expose a
        // per-asset length and a byte count must survive a spill to disk.
        imageBytes: image.bytes.length,
        meta,
        opacity: settings.fixedContent.opacity,
        // A07: window-level state only - never persisted, never derived from the image.
        alwaysOnTop: true,
        zoomWithMouse: settings.fixedContent.zoomWithMouse !== false,
        // Apply click-through before the window can receive its first click.
        clickThrough: settings.pinned?.clickThrough === true,
        zoomStep: normalizePinZoomStep(settings.pinned?.zoomStep),
        rotation: 0,
        longCapture,
        pixelWidth: size.width,
        pixelHeight: size.height,
        displayScaleFactor: aligned.scaleFactor,
        baseWidth,
        baseHeight,
        zoom,
        // U02 / DEV-01: stable shape - null means this pin is a flat bitmap. Set here so
        // every reader (and test) does not have to distinguish absent from none-yet.
        pinEditable: null
      }
      retainedForWindow = null
      // U02 / DEV-01: bind the optional editable snapshot to this window's image
      // generation. A rejected/over-budget snapshot degrades to a flat bitmap, never a
      // failed pin.
      if (options.editableSnapshot) attachPinEditable(win, options.editableSnapshot)
      if (win._pinData.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
      win._pinVisible = false
      win.setPosition(display.bounds.x, display.bounds.y, false)
      win.setContentSize(width, height, false)
      win.setPosition(x, y, false)
      win.setBounds({ x, y, width, height }, false)
      pinWindows.add(win)
      pinnedCount++
      // A07: creation order is the tray's label order; the id already exists on the window.
      win._pinOrdinal = ++pinOrdinalSequence
      attachPinDisplayWatchers()
      notifyPinLayoutChanged({ kind: 'added', id: windowKey })
      win.loadFile(pagePath)?.catch((error) => {
        if (win.isDestroyed()) return
        log('Pin window failed to load:', error.message)
        win.destroy()
      })
    } catch (error) {
      // A reused image was retained just above: hand the reference back when the
      // rebuild fails before `_pinData` owns it, so a failed recovery cannot leak.
      if (retainedForWindow != null && win._pinData?.imageId !== retainedForWindow) {
        pinImages.release(retainedForWindow)
      }
      if (!win.isDestroyed()) win.destroy()
      throw error
    }
    return win
  }

  function updatePinWindow(win, input, meta = {}, options = {}) {
    if (!win || win.isDestroyed()) return null
    // DEV-02: an offscreen compose for the OLD image must not be saved once the image is
    // replaced. The deferred settles as cancelled and exportPinView reports a retryable
    // failure instead of writing stale pixels.
    cancelPinViewExport(win, 'image-changed')
    const image = preparePinImage(input)
    const { size } = image
    const currentBounds = win.getBounds()
    const targetBounds = normalizeSelectionBounds(meta.selectionBounds) || currentBounds
    const display = screen.getDisplayMatching(targetBounds)
    const aligned = getPixelAlignedPinSize(size.width, size.height, display, meta.selectionBounds)
    const previousImageId = win._pinData.imageId
    const nextData = {
      ...win._pinData,
      meta,
      pixelWidth: size.width,
      pixelHeight: size.height,
      displayScaleFactor: aligned.scaleFactor,
      baseWidth: aligned.width,
      baseHeight: aligned.height,
      zoom: 1
    }
    // Re-annotating replaces the pixels but keeps the pin's rotation (a rotated
    // pin stays rotated); the window box then has to match the rotated box.
    const sized = getPinWindowSize(nextData)
    const nextBounds = clampPinBoundsToWorkArea({
      x: targetBounds.x,
      y: targetBounds.y,
      width: sized.width,
      height: sized.height
    }, display.workArea)
    nextData.imageId = pinImages.add(image)
    nextData.imageBytes = image.bytes.length
    try {
      win.setBounds(nextBounds, false)
    } catch (error) {
      pinImages.release(nextData.imageId)
      throw error
    }
    win._pinRecognition?.abort()
    win._pinRecognition = null
    win._pinData = nextData
    pinImages.release(previousImageId)
    // U02 / DEV-01: the old snapshot belonged to the old image generation. Replacing the
    // display PNG through a re-annotation must replace BOTH artefacts or neither: when
    // the renderer sent a new snapshot attach it, otherwise the pin stays a bitmap.
    releasePinEditable(win)
    if (options.editableSnapshot) attachPinEditable(win, options.editableSnapshot)
    // The read is asynchronous now; the renderer applies whichever payload it
    // receives and ignores one for an image it already replaced.
    void sendPinImage(win, 'pin:update')
    return win
  }

  function revealPinWindow(win) {
    if (!win || win.isDestroyed() || win._pinVisible) return
    win._pinVisible = true
    // A07: a pin the user un-topped stays un-topped when it is re-shown.
    if (win._pinData?.alwaysOnTop === false) win.setAlwaysOnTop(false)
    else win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    setImmediate(() => {
      if (win.isDestroyed()) return
      win.setOpacity(Number(win._pinData?.opacity) || 1)
      win.moveTop()
      win.focus()
    })
  }

  function bringPinToFront(win) {
    if (!win || win.isDestroyed()) return
    // A07: "bring to front" means raise, not re-top: the temporary un-top survives.
    if (win._pinData?.alwaysOnTop === false) win.setAlwaysOnTop(false)
    else win.setAlwaysOnTop(true, 'screen-saver')
    win.setOpacity(Number(win._pinData?.opacity) || 1)
    win.show()
    win.moveTop()
    win.focus()
  }

  function setPinOpacity(win, opacity) {
    if (!win || win.isDestroyed()) return false
    const nextOpacity = clampPinOpacity(opacity)
    if (win._pinData) win._pinData.opacity = nextOpacity
    win.setOpacity(nextOpacity)
    // Main -> renderer receipt (like pin:click-through-changed, deliberately NOT
    // in IPC_SURFACES): the wheel path and the context-menu radio items both land
    // here, so the renderer's transient badge mirrors one authoritative value.
    sendToRenderer(win, 'pin:opacity-changed', Math.round(nextOpacity * 100))
    return nextOpacity
  }

  // Quarter-turn rotation: stores the normalised angle on _pinData, resizes the
  // window to the rotated bounding box around its centre and tells the renderer
  // to apply the CSS transform. The stored image bytes are never touched, so a
  // rotated pin still copies/saves/recognises the original image.
  // Long captures are excluded on purpose: they scroll (body.long-capture) and the
  // 90°/270° frame in pin.css is a fixed-size absolutely-positioned overlay, so the
  // combination would clip the strip. The context menu item is disabled for them.
  function rotatePin(win, delta = 90) {
    if (!win || win.isDestroyed() || !win._pinData) return 0
    const data = win._pinData
    if (data.longCapture) return Number(data.rotation) || 0
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const step = Number.isFinite(Number(delta)) && Number(delta) !== 0 ? Number(delta) : 90
    const rotation = normalizePinRotation((Number(data.rotation) || 0) + step)
    const sized = getPinWindowSize({ ...data, rotation }, { workAreaHeight: display.workArea.height })
    // Rotate around the window centre: without this the box would grow to the
    // right/down and visibly jump after the 90° turn.
    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    data.rotation = sized.rotation
    win.setBounds(clampPinBoundsToWorkArea({
      x: Math.round(centerX - sized.width / 2),
      y: Math.round(centerY - sized.height / 2),
      width: sized.width,
      height: sized.height
    }, display.workArea), false)
    sendToRenderer(win, 'pin:rotation-changed', sized.rotation)
    return sized.rotation
  }

  // Click-through is an explicit boolean, never a flip: the renderer's radio
  // item, the batch exit and (later) the settings default all state the value
  // they want, so a duplicated or replayed request cannot land on the opposite
  // state. `forward: true` keeps mouse moves arriving so the renderer's corner
  // badge stays reachable; clicks and the wheel are deliberately not forwarded.
  function setPinClickThrough(win, enabled) {
    if (!win || win.isDestroyed() || !win._pinData) return false
    const next = enabled === true
    if (win._pinData.clickThrough !== next) {
      win._pinData.clickThrough = next
      if (next) win.setIgnoreMouseEvents(true, { forward: true })
      else win.setIgnoreMouseEvents(false)
    }
    // The receipt is the authoritative echo: it also carries changes nobody in
    // this renderer asked for (batch exit, settings-driven default), so it is
    // sent even when the stored flag already matched. `pin:click-through-changed`
    // is a main -> renderer broadcast and must stay OUT of IPC_SURFACES (§2.2).
    if (win.webContents && !win.webContents.isDestroyed?.()) {
      win.webContents.send('pin:click-through-changed', next)
    }
    return true
  }

  // Returns true only when the window actually left click-through mode, so the
  // batch exit can report a meaningful count.
  function clearPinClickThrough(win) {
    if (!win || win.isDestroyed() || win._pinData?.clickThrough !== true) return false
    setPinClickThrough(win, false)
    return true
  }

  // P0-6-T4 exit path (owned by S7, called through the injected pin domain):
  // takes every pinned window out of click-through without any renderer
  // round-trip, so the global shortcut and the tray item still work when a
  // renderer is wedged. Returns how many pins left click-through mode.
  function exitAllClickThrough() {
    let exited = 0
    for (const win of pinWindows) {
      if (clearPinClickThrough(win)) exited += 1
    }
    return exited
  }

  // P0 (plan §0.3 #4 / §11.4): export the already-rendered pin window as a PDF.
  // pdf-export.js is the single owner of paper math / print options / saving, so
  // this function only chooses the content size and the file name. Following the
  // capture path's shape keeps the printer dependency-injectable: in production
  // the defaults inside pdf-export take over (electron.dialog, its own fs and
  // webContents.printToPDF); a test can pass printToPdf/showSaveDialog/writeFile.
  async function exportPinToPdf(win) {
    if (!win || win.isDestroyed() || !win._pinData) return null
    // These pins are frameless with `useContentSize: true`, so content bounds are
    // the printed pixels (getContentBounds is the precise call; getBounds is the
    // fallback for a test fake that only implements the latter).
    const contentBounds = typeof win.getContentBounds === 'function'
      ? win.getContentBounds()
      : win.getBounds()
    // WYSIWYG for the current zoom and rotation: the already-rendered window is
    // printed at its current content box. pxW/pxH must be positive integers or
    // computePaperOptions would fall back to the same window bounds anyway.
    const options = {
      pxW: Math.max(1, Math.round(contentBounds.width)),
      pxH: Math.max(1, Math.round(contentBounds.height))
    }
    if (injectedPrintToPdf) options.printToPdf = injectedPrintToPdf
    // A rotated pin's window box is the rotated bounding box, so printing the box
    // keeps the on-screen orientation (the CSS transform is part of the render).
    const pdfBuffer = await pdfExport.exportWindowToPdf(win, options)
    const saveOptions = {
      parentWindow: win,
      // Same naming convention as a captured PNG so the PDF reads as part of the
      // same capture (settings.screenshot.nameTemplate is honoured when set).
      makeName: (prefix, ext) => makeCaptureName(prefix, ext, {
        template: getSettings()?.screenshot?.nameTemplate
      })
    }
    if (injectedShowSaveDialog) saveOptions.showSaveDialog = injectedShowSaveDialog
    if (injectedWriteFile) saveOptions.writeFile = injectedWriteFile
    return pdfExport.savePdfBuffer(pdfBuffer, saveOptions)
  }

  async function startPinReannotation(win, imageBounds = {}, autoAction = '') {
    if (!win || win.isDestroyed() || !win._pinData) return null
    const createCaptureWindow = getCreateCaptureWindow?.()
    if (typeof createCaptureWindow !== 'function') {
      throw new Error('Capture factory is not ready')
    }
    const pinBounds = win.getBounds()
    // U02 / DEV-01: a pin that still owns its editable snapshot reopens the VECTOR
    // session: the base image is the unannotated crop and the annotations come back as
    // objects. Old flat pins, clipboard images and restored PNGs have no snapshot and
    // keep the shipped bitmap-only re-annotation.
    const snapshot = win._pinData.pinEditable && win._pinData.pinEditable.imageId === win._pinData.imageId
      ? win._pinData.pinEditable
      : null
    // The box the pinned image occupies on screen (DIP). `imageBounds` is the renderer's
    // image rectangle inside the pin window, so this is pin-window origin + that offset.
    const imageBox = {
      x: Math.round(pinBounds.x + (Number(imageBounds.x) || 0)),
      y: Math.round(pinBounds.y + (Number(imageBounds.y) || 0)),
      width: Math.max(1, Math.round(Number(imageBounds.width) || pinBounds.width)),
      height: Math.max(1, Math.round(Number(imageBounds.height) || pinBounds.height))
    }
    // The compact editor geometry lives in shared/editor-layout.js so the history
    // "continue editing" entry (which opens on the current crop's source-pixel size)
    // derives the exact same window box, reserved tool strip and image fit. The strip
    // height is DERIVED from the width the toolbar will actually get, not guessed -
    // see the constants comment in that file for the real-device failure that caused it.
    //
    // For a snapshot the base size is the SOURCE-pixel crop, not the rotated/zoomed
    // on-screen box: the editor always opens unrotated, and a rotated pin's sandbox
    // (axis-swapped bounding box) must not be mistaken for the picture's own size.
    const workArea = screen.getDisplayMatching(imageBox).workArea
    const layout = snapshot
      ? resolveEditorLayout({
          imageWidth: snapshot.baseImage.width,
          imageHeight: snapshot.baseImage.height,
          workArea,
          anchor: { x: pinBounds.x, y: pinBounds.y }
        })
      : resolveEditorLayout({
          imageWidth: imageBox.width,
          imageHeight: imageBox.height,
          workArea,
          // Pin's historical placement, preserved verbatim: the editor centres on the image
          // box and aligns its top edge with the image's (vertical centring would move the
          // window relative to the pin the user right-clicked).
          anchor: { x: imageBox.x, y: imageBox.y }
        })
    const sourceScaleFactor = snapshot
      ? scaleFactorFor({ displayWidth: layout.imageWidth, sourceWidth: snapshot.baseImage.width })
      : scaleFactorFor({ displayWidth: layout.imageWidth, sourceWidth: win._pinData.pixelWidth })
    const imageId = win._pinData.imageId
    win.hide()
    try {
      let imageBuffer = null
      let pinEditablePayload = null
      if (snapshot) {
        // In-memory pixels: no spill read and therefore no window in which the pin could
        // be re-annotated behind this request. The generation check below still runs.
        if (win.isDestroyed() || !win._pinData || win._pinData.pinEditable !== snapshot) {
          bringPinToFront(win)
          return null
        }
        imageBuffer = snapshot.baseImage.bytes
        pinEditablePayload = {
          schema: snapshot.schema,
          document: snapshot.document,
          crop: snapshot.document.crop,
          sourceScaleFactor
        }
      } else {
        const { bytes } = await pinImages.read(imageId)
        // The pin may have been closed or re-annotated while the spilled pixels
        // were read; do not open the editor for a stale image. A live window that
        // only changed images is brought back instead of being left hidden.
        if (win.isDestroyed() || !win._pinData) return null
        if (win._pinData.imageId !== imageId) {
          bringPinToFront(win)
          return null
        }
        imageBuffer = bytes
      }
      const captureWindow = await createCaptureWindow({
        imageBuffer,
        mode: 'image',
        autoAction,
        source: 'pin-reannotate',
        windowBounds: layout.editorBounds,
        imageBounds: layout.imageBounds,
        // The reserved strip sits outside the image, so the window must be transparent
        // in both modes - an opaque window would paint that strip in its background.
        transparent: true,
        sourceScaleFactor,
        editPin: true,
        editingPinWindow: win,
        // U02 / DEV-01: null for a flat pin; the capture renderer then keeps the shipped
        // bitmap session and will not create a new snapshot on save.
        pinEditable: pinEditablePayload
      })
      if (!captureWindow) bringPinToFront(win)
      return captureWindow
    } catch (error) {
      bringPinToFront(win)
      throw error
    }
  }

  function pinFromCapture(event, imageData, meta, recognitionAction, options = {}) {
    const captureWindow = BrowserWindow.fromWebContents(event.sender)
    const editingPinWindow = captureWindow?._editingPinWindow
    ensureCanPin(!!editingPinWindow)
    const pinWindow = editingPinWindow
      ? updatePinWindow(editingPinWindow, imageData, meta, options)
      : createPinWindow(imageData, meta, options)
    if (!editingPinWindow && ['ocr', 'translate'].includes(recognitionAction)) {
      pinWindow._pendingRecognition = recognitionAction
    }
    if (captureWindow) {
      captureWindow._pendingPinWindow = pinWindow
      captureWindow._editingPinWindow = null
    }
    return { captureWindow, pinWindow }
  }

  async function runPinRecognition(win, action) {
    if (win.isDestroyed() || win._pinRecognition || !recognizePin) return
    const pin = win._pinData
    const task = new AbortController()
    win._pinRecognition = task
    const { signal } = task
    const publish = (data) => {
      if (!signal.aborted && !win.isDestroyed()) sendToRenderer(win, 'pin:recognition', { action, ...data })
    }
    try {
      publish({ phase: 'recognizing' })
      const { bytes } = await pinImages.read(pin.imageId)
      if (signal.aborted || win.isDestroyed() || win._pinData?.imageId !== pin.imageId) return
      const outcome = await recognizePin(action, {
        imageBuffer: bytes,
        scaleFactor: pin.meta?.scaleFactor || pin.displayScaleFactor
      }, { signal, onTranslating: () => publish({ phase: 'translating' }) })
      if (signal.aborted || win.isDestroyed()) return
      if (action === 'ocr' && outcome.result) {
        const afterAction = getSettings().ocr?.afterAction
        if (['copy', 'copy-and-close'].includes(afterAction)) clipboard.writeText(outcome.result.text)
        if (afterAction === 'copy-and-close') { win.close(); return }
      }
      publish(outcome)
    } catch (error) {
      if (!signal.aborted) {
        log('Pin recognition failed:', error.message)
        publish({ phase: 'failed' })
      }
    } finally {
      if (win._pinRecognition === task) win._pinRecognition = null
    }
  }

  function togglePinVisibility() {
    // N05: with a suspended workspace there is nothing visible to toggle - the
    // existing show/hide-every-pin entry (tray/function router) is the resume path.
    if (suspendedWorkspace) {
      resumeWorkspaceNow()
      return
    }
    const shouldShow = [...pinWindows].some((win) => !win.isDestroyed() && !win.isVisible())
    pinWindows.forEach((win) => {
      if (win.isDestroyed()) return
      if (shouldShow) win.showInactive()
      else win.hide()
    })
  }

  function registerIpc() {
    ipcMain.on('pin:ready', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win?._pinData) void sendPinImage(win, 'pin:init')
    })
    ipcMain.on('pin:render-ready', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      revealPinWindow(win)
      const autoAction = win?._pendingRecognition
      if (!autoAction) return
      win._pendingRecognition = ''
      void runPinRecognition(win, autoAction)
    })
    ipcMain.on('pin:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
    ipcMain.on('pin:copy', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      void copyPin(win)
    })
    ipcMain.on('pin:save', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      // A spilled read can be rejected after the pin closed; keep that from
      // becoming an unhandled rejection in the IPC listener.
      try {
        await savePin(win)
      } catch (error) {
        log('Pin save failed:', error.message)
      }
    })
    // N05: the menu is built asynchronously because its workspace submenu lists the
    // persisted snapshots; the listener stays non-async so a rejection cannot become
    // an unhandled promise rejection through the secure IPC facade.
    ipcMain.on('pin:context-menu', (event, imageBounds = {}, command = null) => {
      handlePinContextMenu(event, imageBounds, command)
        .catch((error) => log('Pin context menu failed:', error.message))
    })
    // Renderer-side entry points for the same operations. They exist so the wheel
    // (set-opacity) and any future keyboard path do not have to round-trip through
    // the context menu; the menu items above call the same domain functions.
    // A minimal ipcMain fake (unit tests) only implements `on`; the real
    // createSecureIpcMain always provides `handle`, which `pin:export-pdf`
    // requires as a policy kind.
    if (typeof ipcMain.handle === 'function') {
      ipcMain.handle('pin:export-pdf', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        return exportPinToPdf(win)
      })
    }
    ipcMain.on('pin:resize', (event, { factor } = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !win._pinData?.zoomWithMouse) return
      // While the pin ignores mouse events the wheel is not forwarded, so this
      // is defence in depth: a stale request must not resize a click-through pin.
      if (win._pinData.clickThrough === true) return
      const bounds = win.getBounds()
      const data = win._pinData
      const currentZoom = Number(data.zoom) || 1
      const nextZoom = applyPinZoomFactor(currentZoom, factor)
      if (Math.abs(nextZoom - currentZoom) < 0.001) return
      const display = screen.getDisplayMatching(bounds)
      // Rotation survives zoom: the renderer keeps the CSS transform, so the
      // window box has to keep the rotated bounding box (a zoomed 90° pin is
      // tall, not wide).
      const sized = getPinWindowSize({ ...data, zoom: nextZoom }, { workAreaHeight: display.workArea.height })
      data.zoom = sized.zoom
      win.setBounds(clampPinBoundsToWorkArea({
        x: bounds.x,
        y: bounds.y,
        width: sized.width,
        height: sized.height
      }, display.workArea), false)
      sendToRenderer(win, 'pin:zoom-changed', Math.round(sized.zoom * 100))
    })
    // Ctrl+wheel in the renderer (plan §9.2-②). A click-through pin cannot reach
    // this handler: setIgnoreMouseEvents(true, { forward: true }) forwards mouse
    // moves only, so the wheel never arrives (see pin/pin.js). The 0.05 step is
    // shared with the context menu's 25/50/75/100 radio items.
    ipcMain.on('pin:set-opacity', (event, direction) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !win._pinData) return
      if (win._pinData.clickThrough === true) return
      setPinOpacity(win, nextPinOpacity(win._pinData.opacity, direction))
    })
    // Quarter-turn rotation (plan §9.3). The stored image is untouched: the renderer
    // draws the same pixels under a CSS transform, and only the window box (the
    // rotated bounding box) changes here. The payload echoes the new angle so the
    // renderer does not have to guess.
    ipcMain.on('pin:rotate', (event, delta = 90) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !win._pinData) return
      rotatePin(win, delta)
    })
    ipcMain.on('pin:move-start', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win._pinData?.clickThrough === true) return
      win._pinMove = { point: screen.getCursorScreenPoint(), bounds: win.getBounds() }
    })
    ipcMain.on('pin:move', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win._pinData?.clickThrough === true) return
      if (!win._pinMove) return
      const { point: start, bounds } = win._pinMove
      const point = screen.getCursorScreenPoint()
      win.setBounds({
        x: Math.round(bounds.x + point.x - start.x),
        y: Math.round(bounds.y + point.y - start.y),
        width: bounds.width,
        height: bounds.height
      }, false)
    })
    ipcMain.on('pin:move-end', (event, payload = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      // A07: the ONLY snap point in the whole flow. The renderer passes the Alt state
      // with the release event; a plain boolean payload is accepted for compatibility.
      const altKey = payload === true || (payload && typeof payload === 'object' && payload.altKey === true)
      // U02 (review section 4.2-4): the display-scale resize (syncPinDisplayScale) and the end-of-drag
      // snap (applySnapOnDragEnd) used to run back to back, each calling win.setBounds, so a
      // cross-DPI release moved the pin twice and visibly jumped. applyPinMoveEnd resolves both
      // against one box and applies them in a single setBounds; those two helpers remain for
      // the display-reflow path and the tray entry point.
      applyPinMoveEnd(win, altKey)
    })
    ipcMain.on('pin:set-click-through', (event, enabled) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !win._pinData) return
      setPinClickThrough(win, enabled === true)
    })
  }

  registerIpc()

  return {
    MAX_PINNED,
    ownsWindow,
    getPinnedCount,
    canPinMore,
    acquirePinnedSlot,
    releasePinnedSlot,
    ensureCanPin,
    createPinWindow,
    updatePinWindow,
    revealPinWindow,
    bringPinToFront,
    setPinOpacity,
    rotatePin,
    exportPinToPdf,
    // B03: "export the current view" - the rotated/zoomed/OCR rendering, never the
    // desktop. Exposed for the context menu, the tests and a future toolbar entry.
    exportPinView,
    setPinClickThrough,
    exitAllClickThrough,
    startPinReannotation,
    pinFromCapture,
    // U02 / DEV-01: exposed for the diagnostics/tests that assert the in-memory budget
    // and the image-generation binding; the re-annotation flow itself is the only caller.
    attachPinEditable,
    releasePinEditable,
    getPinSnapshotBytes: () => pinSnapshotBytes,
    // N05 / DEV-08: onion-skin compare, including the adopted opt-in real-pixel mode.
    // The context menu and the renderer command envelope are the only callers; the
    // start/stop pair is exposed for the tests that assert the protection lifecycle.
    applyOnionModeSelection,
    startRealPixelCompare,
    stopRealPixelCompare,
    captureScreenUnderPin,
    togglePinVisibility,
    // N05: pin workspace snapshots (persisted manifest + copied pictures) plus the
    // suspend/resume pair. Exposed for the context menu, the renderer shortcuts, the
    // tests and a future tray entry (the gallery is not wired into main.js here).
    saveWorkspaceSnapshot,
    listWorkspaceSnapshots,
    deleteWorkspaceSnapshot,
    restoreWorkspaceSnapshot,
    restoreLatestWorkspaceSnapshot,
    suspendPinWorkspace,
    resumePinWorkspace,
    isPinWorkspaceSuspended,
    // A07: per-display finder + window-level actions for the tray, and the one
    // end-of-drag snap entry point (also exercised by the pin:move-end IPC handler).
    listPinsByDisplay,
    focusPin,
    togglePinAlwaysOnTop,
    exitPinClickThrough,
    applySnapOnDragEnd,
    // U02: the merged end-of-drag applier (display-scale resize + snap, one setBounds).
    applyPinMoveEnd,
    syncPinDisplayScale,
    // Display-reflow internals, exposed for the Lead/diagnostics and for a future
    // main.js dispose if one ever becomes free; main.js does not call them today
    // (the listeners are process-global and die with the app).
    reflowPinWindows,
    attachPinDisplayWatchers,
    detachPinDisplayWatchers,
    // D05: the tray-facing recovery surface. `getRecoverablePins` returns
    // serialisable metadata only (no pixels, no image ids); the three actions are
    // one-shot and idempotent per ticket. Wiring: main.js passes
    // `onRecoverableChange: () => createTrayIcon()` and reads this list in
    // buildTrayMenuTemplate (see the D05 report).
    getRecoverablePins,
    trayRecoveryMenu,
    recoverPin,
    saveRecoverablePin,
    discardRecoverablePin,
    // Diagnostics/tests: the injected policy instance (fake clock in unit tests).
    windowResilience: resilience
  }
}

module.exports = {
  createPinDomain,
  // B03 pure contracts (no Electron): the current-view plan and its orientation-
  // aware size. Both are mirrored by the preview copy and by the tests.
  pinViewExportSize,
  describePinViewExport,
  PIN_VIEW_LAYERS,
  PIN_VIEW_EXCLUSIONS,
  // DEV-02 pure contracts (no Electron): the bounded renderer-composed view envelope
  // and its failure-code mapping. The domain (createPinDomain) owns the request
  // lifecycle; these are what the preload mirror and the tests assert against.
  VIEW_EXPORT_RESULT_TYPE,
  MAX_VIEW_EXPORT_PNG_BYTES,
  MAX_VIEW_EXPORT_DIMENSION,
  MAX_VIEW_EXPORT_PIXELS,
  normalizeViewExportCommand,
  pinViewExportFailureKey,
  viewExportResultCode,
  // N05 / DEV-08 pure contracts (no Electron): the onion mode vocabulary and the
  // renderer -> main state envelope. The sampling session itself lives in createPinDomain.
  ONION_MODES,
  DEFAULT_REAL_DIFF_INTERVAL_MS,
  normalizeOnionStateCommand,
  // U02 / DEV-01 pure contracts (no Electron): the in-memory editable snapshot shape
  // and its bounds. The domain (createPinDomain) owns the budget, binding to the image
  // generation and the re-annotation hand-off.
  PIN_EDITABLE_SNAPSHOT_SCHEMA,
  MAX_PIN_SNAPSHOT_BASE_BYTES,
  MAX_PIN_SNAPSHOT_DIMENSION,
  MAX_PIN_SNAPSHOT_PIXELS,
  MAX_PIN_SNAPSHOT_ANNOTATIONS,
  DEFAULT_PIN_SNAPSHOT_BUDGET_BYTES,
  normalizePinEditableSnapshot,
  // N05 pure contracts (no Electron): snapshot serialisation/normalisation, the
  // bounded newest-first list and the renderer command envelope. The file-system
  // and window halves live in createPinDomain above.
  WORKSPACE_SNAPSHOT_SCHEMA,
  MAX_WORKSPACE_SNAPSHOTS,
  MAX_WORKSPACE_SNAPSHOT_PINS,
  MAX_WORKSPACE_SNAPSHOT_NAME,
  WORKSPACE_COMMAND_TYPES,
  normalizeWorkspaceSnapshotName,
  normalizeWorkspaceSnapshotPin,
  normalizeWorkspaceSnapshot,
  normalizeWorkspaceSnapshotFile,
  parseWorkspaceSnapshotText,
  appendWorkspaceSnapshot,
  describeWorkspaceSnapshot,
  buildWorkspaceSnapshot,
  normalizeWorkspaceCommand
}
