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
const { exportWindowToPdf, savePdfBuffer } = require('../../services/pdf-export')

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
    saveDataUrl,
    createRecognitionWindow,
    getCreateCaptureWindow,
    dataUrlToBuffer,
    bufferToDataUrl,
    log,
    ipcMain
  } = deps

  if (!ipcMain) throw new Error('Pin domain requires ipcMain')
  if (!createLocalWindow) throw new Error('Pin domain requires createLocalWindow')

  const MAX_PINNED = 20
  const pinWindows = new Set()
  let pinnedCount = 0

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
    const listener = () => reflowPinWindows()
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

  function createPinWindow(dataUrl, meta = {}) {
    ensureCanPin(false)
    const image = nativeImage.createFromDataURL(dataUrl)
    const size = image.getSize()
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
    const win = createLocalWindow(pagePath, {
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
    win._pinData = {
      dataUrl,
      meta,
      opacity: getSettings().fixedContent.opacity,
      zoomWithMouse: getSettings().fixedContent.zoomWithMouse !== false,
      // The frozen `pinned.clickThrough` key (settings-defaults.js) is the
      // default state of a new pin; it is applied below, before the window is
      // ever shown, so a click-through pin does not swallow its first click.
      clickThrough: getSettings().pinned?.clickThrough === true,
      // P1 (plan §9.1): one wheel notch scales by 1 + zoomStep (0.1 = the old
      // hardcoded 1.1). Read once at creation: a live change would make an
      // already-open pin jump. normalizePinZoomStep also covers a store written
      // before the key existed (or a test fake that omits it).
      zoomStep: normalizePinZoomStep(getSettings().pinned?.zoomStep),
      // P1 (plan §9.3): quarter-turn rotation, rendered as a CSS transform and
      // reflected in the window box by getRotatedPinSize. dataUrl is never
      // re-encoded; the renderer rotates the same pixels.
      rotation: 0,
      longCapture,
      pixelWidth: size.width,
      pixelHeight: size.height,
      displayScaleFactor: aligned.scaleFactor,
      baseWidth,
      baseHeight,
      zoom
    }
    if (win._pinData.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
    win._pinVisible = false
    win.setPosition(display.bounds.x, display.bounds.y, false)
    win.setContentSize(width, height, false)
    win.setPosition(x, y, false)
    win.setBounds({ x, y, width, height }, false)
    pinWindows.add(win)
    pinnedCount++
    attachPinDisplayWatchers()
    win.loadFile(pagePath)
    win.on('closed', () => {
      pinWindows.delete(win)
      pinnedCount = Math.max(0, pinnedCount - 1)
      if (pinWindows.size === 0) detachPinDisplayWatchers()
    })
    return win
  }

  function updatePinWindow(win, dataUrl, meta = {}) {
    if (!win || win.isDestroyed()) return null
    const image = nativeImage.createFromDataURL(dataUrl)
    const size = image.getSize()
    const currentBounds = win.getBounds()
    const targetBounds = normalizeSelectionBounds(meta.selectionBounds) || currentBounds
    const display = screen.getDisplayMatching(targetBounds)
    const aligned = getPixelAlignedPinSize(size.width, size.height, display, meta.selectionBounds)
    win._pinData = {
      ...win._pinData,
      dataUrl,
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
    const sized = getPinWindowSize(win._pinData)
    const nextBounds = clampPinBoundsToWorkArea({
      x: targetBounds.x,
      y: targetBounds.y,
      width: sized.width,
      height: sized.height
    }, display.workArea)
    win.setBounds(nextBounds, false)
    win.setBounds(nextBounds, false)
    win.webContents.send('pin:update', win._pinData)
    return win
  }

  function revealPinWindow(win) {
    if (!win || win.isDestroyed() || win._pinVisible) return
    win._pinVisible = true
    win.setAlwaysOnTop(true, 'screen-saver')
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
    win.setAlwaysOnTop(true, 'screen-saver')
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
  // to apply the CSS transform. The pixels (dataUrl) are never touched, so a
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
    const editBounds = {
      x: Math.round(pinBounds.x + (Number(imageBounds.x) || 0)),
      y: Math.round(pinBounds.y + (Number(imageBounds.y) || 0)),
      width: Math.max(1, Math.round(Number(imageBounds.width) || pinBounds.width)),
      height: Math.max(1, Math.round(Number(imageBounds.height) || pinBounds.height))
    }
    const imageSize = nativeImage.createFromDataURL(win._pinData.dataUrl).getSize()
    // The editor always reserves a strip BELOW the image for the tool strip (and the OCR
    // result bar), in every mode. The region capture shows its strip below the region, so
    // a re-annotate editor that was exactly the size of the pinned image had nowhere to
    // put it: the renderer fell back to clamping, which dropped the strip inside the top
    // of the image and clipped it.
    //
    // The strip height is DERIVED, not guessed: the strip wraps when the window is
    // narrower than the main row (capture/capture.css gives every icon button a 30px
    // minimum plus 7px padding, so one row needs ROW_MIN_CONTENT px), and a wrapped row
    // is taller. Guessing 100px here is what made the strip cover the image as soon as
    // the rectangle tool added the options row to an already wrapped row.
    // test/capture-floating-placement.test.js re-derives these numbers from
    // capture.html/capture.css and fails when the UI outgrows them.
    const ROW_MIN_CONTENT = 1040 // single-line minimum of the main row (measured 1019 today)
    const STRIP_ROW_HEIGHT = 34 // 30px button + 3px row gap, rounded up
    const OPTIONS_ROW_HEIGHT = 30
    const STRIP_CHROME = 14 // 6px toolbar padding x2 + 1px borders x2
    const STRIP_SLACK = 22 // 10px gap below the image + 6px viewport padding + 6px margin
    // Wide enough that the main row stays on ONE line (like the region capture); the
    // strip then only needs the two-row height.
    const toolbarSpace = 1088
    const workArea = screen.getDisplayMatching(editBounds).workArea
    const width = Math.min(workArea.width, Math.max(toolbarSpace, Math.max(420, editBounds.width)))
    const stripRows = Math.max(1, Math.ceil(ROW_MIN_CONTENT / Math.max(1, width - STRIP_CHROME)))
    const actionSpace = stripRows * STRIP_ROW_HEIGHT + OPTIONS_ROW_HEIGHT + STRIP_CHROME + STRIP_SLACK
    const scale = Math.min(
      1,
      workArea.width / editBounds.width,
      Math.max(1, workArea.height - actionSpace) / editBounds.height
    )
    const imageWidth = Math.max(1, Math.round(editBounds.width * scale))
    const imageHeight = Math.max(1, Math.round(editBounds.height * scale))
    const height = Math.min(workArea.height, imageHeight + actionSpace)
    const x = Math.round(Math.max(workArea.x, Math.min(
      editBounds.x + (editBounds.width - width) / 2,
      workArea.x + workArea.width - width
    )))
    const y = Math.round(Math.max(workArea.y, Math.min(
      editBounds.y,
      workArea.y + workArea.height - height
    )))
    const editorBounds = { x, y, width, height }
    const editorImageBounds = {
      x: Math.round((width - imageWidth) / 2),
      y: 0,
      width: imageWidth,
      height: imageHeight
    }
    const sourceScaleFactor = Math.max(0.25, imageSize.width / imageWidth)
    win.hide()
    try {
      const captureWindow = await createCaptureWindow({
        imageBuffer: dataUrlToBuffer(win._pinData.dataUrl),
        mode: 'image',
        autoAction,
        source: 'pin-reannotate',
        windowBounds: editorBounds,
        imageBounds: editorImageBounds,
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

  function pinFromCapture(event, imageData, meta) {
    const captureWindow = BrowserWindow.fromWebContents(event.sender)
    const editingPinWindow = captureWindow?._editingPinWindow
    ensureCanPin(!!editingPinWindow)
    const dataUrl = typeof imageData === 'string' ? imageData : bufferToDataUrl(imageData)
    const pinWindow = editingPinWindow
      ? updatePinWindow(editingPinWindow, dataUrl, meta)
      : createPinWindow(dataUrl, meta)
    if (captureWindow) {
      captureWindow._pendingPinWindow = pinWindow
      captureWindow._editingPinWindow = null
    }
    return { captureWindow, pinWindow }
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
      if (win?._pinData) event.sender.send('pin:init', win._pinData)
    })
    ipcMain.on('pin:render-ready', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      revealPinWindow(win)
      const autoAction = win?._pendingReannotateAction
      if (!autoAction) return
      win._pendingReannotateAction = ''
      setTimeout(() => {
        startPinReannotation(win, {}, autoAction).catch((error) => {
          log('Auto reannotate pin failed:', error.message)
          bringPinToFront(win)
        })
      }, 80)
    })
    ipcMain.on('pin:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
    ipcMain.on('pin:copy', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win?._pinData) clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl))
    })
    ipcMain.on('pin:save', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win?._pinData) await saveDataUrl(win._pinData.dataUrl)
    })
    ipcMain.on('pin:context-menu', (event, imageBounds = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win?._pinData) return
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
        {
          label: '文本识别',
          enabled: !!getSettings().plugins.ocr,
          click: async () => {
            try {
              await startPinReannotation(win, imageBounds, 'ocr')
            } catch (error) {
              log('OCR pin failed:', error.message)
            }
          }
        },
        {
          label: '表格识别',
          enabled: !!getSettings().plugins.ocr,
          click: () => {
            try {
              createRecognitionWindow('table', win._pinData.dataUrl, { scaleFactor: win._pinData.displayScaleFactor })
            } catch (error) {
              log('Table recognition failed:', error.message)
            }
          }
        },
        {
          label: '二维码识别',
          click: () => {
            try {
              createRecognitionWindow('qr', win._pinData.dataUrl, { scaleFactor: win._pinData.displayScaleFactor })
            } catch (error) {
              log('QR recognition failed:', error.message)
            }
          }
        },
        { type: 'separator' },
        // P1 (plan §9.3): the rotation helpers were finished and unit-tested with
        // no production caller. A quarter turn only changes the stored angle and
        // the window box; the renderer applies the CSS transform to the same
        // dataUrl (never re-encoded). Disabled for long captures: they scroll and
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
        { label: '复制', click: () => clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl)) },
        { label: '保存', click: () => saveDataUrl(win._pinData.dataUrl).catch((error) => log(error.message)) },
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
    // Quarter-turn rotation (plan §9.3). The dataUrl is untouched: the renderer
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
    ipcMain.on('pin:move-end', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        win._pinMove = null
        syncPinDisplayScale(win)
      }
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
    setPinClickThrough,
    exitAllClickThrough,
    startPinReannotation,
    pinFromCapture,
    togglePinVisibility,
    syncPinDisplayScale,
    // Display-reflow internals, exposed for the Lead/diagnostics and for a future
    // main.js dispose if one ever becomes free; main.js does not call them today
    // (the listeners are process-global and die with the app).
    reflowPinWindows,
    attachPinDisplayWatchers,
    detachPinDisplayWatchers
  }
}

module.exports = {
  createPinDomain
}
