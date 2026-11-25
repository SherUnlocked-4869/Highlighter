'use strict'

const {
  applyPinZoomFactor,
  clampPinOpacity,
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
// pixels come from webContents.capturePage of this window, not from the screen), the
// last one is why exportPinView hides the transient badges before capturing.
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
      const { imageId: _imageId, ...presentation } = win._pinData
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
  // B03: "export the current view" (the counterpart of the original-bytes
  // copy/save above). Electron touch points are injected the same way as the
  // PDF export: main.js passes none of them, so production falls back to a lazy
  // require('electron') inside the default helpers and the domain stays loadable
  // in plain node.
  // -------------------------------------------------------------------------
  const injectedShowMessageBox = typeof deps.showMessageBox === 'function' ? deps.showMessageBox : null
  const injectedShowErrorBox = typeof deps.showErrorBox === 'function' ? deps.showErrorBox : null
  const injectedCapturePage = typeof deps.capturePage === 'function' ? deps.capturePage : null

  // The preview must show the same pixels the file will contain. Electron's
  // capturePage renders this window's own page - never the screen behind it - so
  // the desktop and every other window are excluded structurally. The transient
  // chrome (zoom/opacity badges, recognition status and its tool strip, the plain
  // text panel and the 1px inner highlight) is hidden for the capture only: it is
  // window feedback, not part of the picture. #pinOcrOverlay is deliberately left
  // visible - whether it is part of "the view" is a real user question, and the
  // preview says which answer it got.
  const VIEW_EXPORT_STYLE_ID = 'pin-view-export-chrome'
  const VIEW_EXPORT_HIDE_CSS = 'body::after{display:none!important}' +
    '#zoomBadge,#opacityBadge,#clickThroughTag,#pinRecognitionStatus,#pinRecognitionTools,#pinRecognizedText{visibility:hidden!important}'

  function viewExportPrepareScript() {
    // Two frames after the style lands: capturePage grabs the last PAINTED frame, so
    // hiding the transient badges has to be on screen before the shot is taken.
    return '(function(){' +
      'var id=' + JSON.stringify(VIEW_EXPORT_STYLE_ID) + ';' +
      'if(!document.getElementById(id)){' +
      'var style=document.createElement("style");style.id=id;' +
      'style.textContent=' + JSON.stringify(VIEW_EXPORT_HIDE_CSS) + ';' +
      '(document.head||document.documentElement).appendChild(style);}' +
      'var overlay=document.getElementById("pinOcrOverlay");' +
      'var state={ocrOverlay:!!overlay&&overlay.childElementCount>0};' +
      // Bounded: an occluded window can throttle rAF, and a promise that never settles
      // would leave the export flag stuck. 160ms is enough for two frames at 60Hz.
      'return new Promise(function(resolve){' +
      'var done=false;function finish(){if(done)return;done=true;resolve(state);}' +
      'setTimeout(finish,160);' +
      'requestAnimationFrame(function(){requestAnimationFrame(finish);});' +
      '});' +
      '})()'
  }

  function viewExportRestoreScript() {
    return '(function(){var el=document.getElementById(' + JSON.stringify(VIEW_EXPORT_STYLE_ID) + ');' +
      'if(el&&el.parentNode)el.parentNode.removeChild(el);return true;})()'
  }

  function defaultShowMessageBox(win, options) {
    const { dialog } = require('electron')
    return dialog.showMessageBox(win, options)
  }

  function defaultShowErrorBox(message, detail) {
    const { dialog } = require('electron')
    dialog.showErrorBox(message, detail)
  }

  function defaultCapturePage(contents) {
    return contents.capturePage()
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
    const contents = win.webContents
    try {
      if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) {
        return { status: 'failed', code: 'NO_CONTENTS' }
      }
      // A hidden pin has nothing to capture; saying so beats writing an empty PNG.
      if (typeof win.isVisible === 'function' && !win.isVisible()) {
        reportViewExportFailure(t('pin.view-export.not-visible'))
        return { status: 'hidden', code: 'NOT_VISIBLE' }
      }
      let ocrOverlay = false
      if (typeof contents.executeJavaScript === 'function') {
        try {
          const state = await contents.executeJavaScript(viewExportPrepareScript())
          ocrOverlay = state?.ocrOverlay === true
        } catch (error) {
          // A failed probe must not block the export: report the conservative answer
          // (no overlay) and capture without hiding the transient chrome.
          log('Pin view export could not prepare the window:', error.message)
        }
      }
      let image = null
      const capture = injectedCapturePage || defaultCapturePage
      try {
        image = await capture(contents)
      } finally {
        // Always attempt the restore: the prepare script may have injected the style and
        // then failed, and removing a missing style is a no-op.
        if (typeof contents.executeJavaScript === 'function') {
          try {
            await contents.executeJavaScript(viewExportRestoreScript())
          } catch (error) {
            log('Pin view export could not restore the window:', error.message)
          }
        }
      }
      if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
        reportViewExportFailure(t('pin.view-export.empty'))
        return { status: 'failed', code: 'EMPTY' }
      }
      const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
      const plan = describePinViewExport({
        rotation: win._pinData.rotation,
        zoom: win._pinData.zoom,
        ocrOverlay,
        width: size.width,
        height: size.height
      })
      const accepted = await confirmViewExport(win, image, plan)
      if (!accepted) return { status: 'cancelled', plan }
      const png = typeof image.toPNG === 'function' ? image.toPNG() : null
      if (!png || !png.length) {
        reportViewExportFailure(t('pin.view-export.empty'))
        return { status: 'failed', code: 'EMPTY' }
      }
      const filePath = await saveImageBuffer(png)
      // A cancelled save dialog is not an error: the user asked for the preview,
      // saw it and backed out.
      return filePath ? { status: 'saved', filePath, plan } : { status: 'cancelled', plan }
    } catch (error) {
      log('Pin view export failed:', error.message)
      reportViewExportFailure(error.message || String(error))
      return { status: 'failed', code: 'FAILED', message: error.message || String(error) }
    } finally {
      win._pinViewExporting = false
    }
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
  function applySnapOnDragEnd(id, altKey = false, options = {}) {
    const win = findPinWindow(id)
    if (!win || !win._pinData || win._pinData.clickThrough === true) return null
    const bounds = readPinBounds(win)
    if (!bounds) return null
    let matched = null
    try {
      matched = typeof screen?.getDisplayMatching === 'function' ? screen.getDisplayMatching(bounds) : null
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
      bounds,
      workAreas,
      windowEdges,
      snapDistance: options.snapDistance,
      altKey: altKey === true,
      enabled: options.enabled !== false && policyEnabled
    })
    if (!result) return null
    const changed = result.x !== bounds.x || result.y !== bounds.y
    if (changed) {
      win.setBounds({ x: result.x, y: result.y, width: result.width, height: result.height }, false)
      notifyPinLayoutChanged({ kind: 'snap', id })
    }
    return {
      id,
      snapped: changed,
      axis: result.snapped,
      displayIndex: result.displayIndex,
      reason: result.reason,
      bounds: { x: result.x, y: result.y, width: result.width, height: result.height }
    }
  }

  function syncPinDisplayScale(win) {
    if (!win || win.isDestroyed() || !win._pinData) return false
    const data = win._pinData
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const aligned = getPixelAlignedPinSize(data.pixelWidth, data.pixelHeight, display)
    if (Math.abs(aligned.scaleFactor - Number(data.displayScaleFactor || 1)) < 0.001) return false
    data.displayScaleFactor = aligned.scaleFactor
    data.baseWidth = aligned.width
    data.baseHeight = aligned.height
    const sized = getPinWindowSize(data, { workAreaHeight: display.workArea.height })
    data.zoom = sized.zoom
    data.rotation = sized.rotation
    win.setBounds(clampPinBoundsToWorkArea({
      x: bounds.x,
      y: bounds.y,
      width: sized.width,
      height: sized.height
    }, display.workArea), false)
    sendToRenderer(win, 'pin:zoom-changed', Math.round(data.zoom * 100))
    return true
  }

  function createPinWindow(input, meta = {}, options = {}) {
    ensureCanPin(false)
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
    // A07: the stable id the tray uses for locate/toggle/exit-click-through.
    win._pinId = windowKey
    // A user-initiated close marks the window as normal before any teardown can
    // race the crash listener, so only abnormal exits retain pixels.
    win.on('close', () => { win._pinClosing = true })
    win.on('closed', () => {
      win._pinClosed = true
      win._pinRecognition?.abort()
      // The domain always gives back its own reference. After a crash the policy
      // holds a second one, so this releases the window's share and the retained
      // ticket keeps the image alive until recovery/save/discard/TTL.
      pinImages.release(win._pinData?.imageId)
      win._pinData = null
      if (pinWindows.delete(win)) pinnedCount = Math.max(0, pinnedCount - 1)
      if (pinWindows.size === 0) detachPinDisplayWatchers()
      notifyPinLayoutChanged({ kind: 'removed', id: win._pinId || win._pinRecoveryKey })
    })
    win.webContents.on?.('render-process-gone', (_event, details) => {
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
        zoom
      }
      retainedForWindow = null
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

  function updatePinWindow(win, input, meta = {}) {
    if (!win || win.isDestroyed()) return null
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
    const workArea = screen.getDisplayMatching(imageBox).workArea
    const layout = resolveEditorLayout({
      imageWidth: imageBox.width,
      imageHeight: imageBox.height,
      workArea,
      // Pin's historical placement, preserved verbatim: the editor centres on the image
      // box and aligns its top edge with the image's (vertical centring would move the
      // window relative to the pin the user right-clicked).
      anchor: { x: imageBox.x, y: imageBox.y }
    })
    const sourceScaleFactor = scaleFactorFor({
      displayWidth: layout.imageWidth,
      sourceWidth: win._pinData.pixelWidth
    })
    const imageId = win._pinData.imageId
    win.hide()
    try {
      const { bytes } = await pinImages.read(imageId)
      // The pin may have been closed or re-annotated while the spilled pixels
      // were read; do not open the editor for a stale image. A live window that
      // only changed images is brought back instead of being left hidden.
      if (win.isDestroyed() || !win._pinData) return null
      if (win._pinData.imageId !== imageId) {
        bringPinToFront(win)
        return null
      }
      const captureWindow = await createCaptureWindow({
        imageBuffer: bytes,
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
        editingPinWindow: win
      })
      if (!captureWindow) bringPinToFront(win)
      return captureWindow
    } catch (error) {
      bringPinToFront(win)
      throw error
    }
  }

  function pinFromCapture(event, imageData, meta, recognitionAction) {
    const captureWindow = BrowserWindow.fromWebContents(event.sender)
    const editingPinWindow = captureWindow?._editingPinWindow
    ensureCanPin(!!editingPinWindow)
    const pinWindow = editingPinWindow
      ? updatePinWindow(editingPinWindow, imageData, meta)
      : createPinWindow(imageData, meta)
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
    ipcMain.on('pin:context-menu', (event, imageBounds = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win?._pinData) return
      // Table/QR recognition still take a data URL, and a spilled pin now has to
      // be read asynchronously before it can be encoded. Capture the pin data so
      // a closed or re-annotated window cannot be encoded by a late read.
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
      const menu = Menu.buildFromTemplate([
        {
          label: '重新标注',
          click: async () => {
            try {
              await startPinReannotation(win, imageBounds)
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
        { label: '关闭', click: () => { if (!win.isDestroyed()) win.close() } }
      ])
      menu.popup({ window: win })
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
      const dragged = !!win._pinMove
      win._pinMove = null
      // DPI first: a cross-display drop may resize the window, and the snap has to be
      // measured on the box the user actually released, not the old one.
      syncPinDisplayScale(win)
      if (!dragged) return
      // A07: the ONLY snap point in the whole flow. The renderer passes the Alt state
      // with the release event; a plain boolean payload is accepted for compatibility.
      const altKey = payload === true || (payload && typeof payload === 'object' && payload.altKey === true)
      applySnapOnDragEnd(win._pinId || win._pinRecoveryKey, altKey)
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
    togglePinVisibility,
    // A07: per-display finder + window-level actions for the tray, and the one
    // end-of-drag snap entry point (also exercised by the pin:move-end IPC handler).
    listPinsByDisplay,
    focusPin,
    togglePinAlwaysOnTop,
    exitPinClickThrough,
    applySnapOnDragEnd,
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
  PIN_VIEW_EXCLUSIONS
}
