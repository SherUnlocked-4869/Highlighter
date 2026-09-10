'use strict'

const {
  applyPinZoomFactor,
  clampPinOpacity,
  computePinDisplaySize,
  getPixelAlignedPinSize,
  normalizeSelectionBounds
} = require('./geometry')

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
    const sized = computePinDisplaySize({
      baseWidth: data.baseWidth,
      baseHeight: data.baseHeight,
      zoom: data.zoom,
      longCapture: data.longCapture,
      workAreaHeight: display.workArea.height
    })
    data.zoom = sized.zoom
    win.setBounds({ x: bounds.x, y: bounds.y, width: sized.width, height: sized.height }, false)
    win.webContents.send('pin:zoom-changed', Math.round(data.zoom * 100))
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
      clickThrough: false,
      longCapture,
      pixelWidth: size.width,
      pixelHeight: size.height,
      displayScaleFactor: aligned.scaleFactor,
      baseWidth,
      baseHeight,
      zoom
    }
    win._pinVisible = false
    win.setPosition(display.bounds.x, display.bounds.y, false)
    win.setContentSize(width, height, false)
    win.setPosition(x, y, false)
    win.setBounds({ x, y, width, height }, false)
    pinWindows.add(win)
    pinnedCount++
    win.loadFile(pagePath)
    win.on('closed', () => {
      pinWindows.delete(win)
      pinnedCount = Math.max(0, pinnedCount - 1)
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
    const nextBounds = {
      ...targetBounds,
      width: Math.max(1, Math.round(aligned.width)),
      height: Math.max(1, Math.round(aligned.height))
    }
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
    if (!win || win.isDestroyed()) return
    const nextOpacity = clampPinOpacity(opacity)
    if (win._pinData) win._pinData.opacity = nextOpacity
    win.setOpacity(nextOpacity)
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
    const isRecognitionEditor = autoAction === 'ocr' || autoAction === 'translate'
    let editorBounds = editBounds
    let editorImageBounds = null
    let sourceScaleFactor = Math.max(0.25, imageSize.width / editBounds.width)
    if (isRecognitionEditor) {
      const workArea = screen.getDisplayMatching(editBounds).workArea
      const actionSpace = 62
      const toolbarSpace = 900
      const scale = Math.min(
        1,
        workArea.width / editBounds.width,
        Math.max(1, workArea.height - actionSpace) / editBounds.height
      )
      const imageWidth = Math.max(1, Math.round(editBounds.width * scale))
      const imageHeight = Math.max(1, Math.round(editBounds.height * scale))
      const width = Math.min(workArea.width, Math.max(toolbarSpace, Math.max(420, imageWidth)))
      const height = Math.min(workArea.height, imageHeight + actionSpace)
      const x = Math.round(Math.max(workArea.x, Math.min(
        editBounds.x + (editBounds.width - width) / 2,
        workArea.x + workArea.width - width
      )))
      const y = Math.round(Math.max(workArea.y, Math.min(
        editBounds.y,
        workArea.y + workArea.height - height
      )))
      editorBounds = { x, y, width, height }
      editorImageBounds = {
        x: Math.round((width - imageWidth) / 2),
        y: 0,
        width: imageWidth,
        height: imageHeight
      }
      sourceScaleFactor = Math.max(0.25, imageSize.width / imageWidth)
    }
    win.hide()
    try {
      const captureWindow = await createCaptureWindow({
        imageBuffer: dataUrlToBuffer(win._pinData.dataUrl),
        mode: 'image',
        autoAction,
        source: 'pin-reannotate',
        windowBounds: editorBounds,
        imageBounds: editorImageBounds,
        transparent: isRecognitionEditor,
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
        {
          label: '透明度',
          submenu: [1, 0.75, 0.5, 0.25].map((opacity) => ({
            label: `${Math.round(opacity * 100)}%`,
            type: 'radio',
            checked: Math.abs((Number(win._pinData.opacity) || 1) - opacity) < 0.005,
            click: () => setPinOpacity(win, opacity)
          }))
        },
        { type: 'separator' },
        { label: '复制', click: () => clipboard.writeImage(nativeImage.createFromDataURL(win._pinData.dataUrl)) },
        { label: '保存', click: () => saveDataUrl(win._pinData.dataUrl).catch((error) => log(error.message)) },
        { type: 'separator' },
        { label: '关闭', click: () => { if (!win.isDestroyed()) win.close() } }
      ])
      menu.popup({ window: win })
    })
    ipcMain.on('pin:resize', (event, { factor } = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || !win._pinData?.zoomWithMouse) return
      const bounds = win.getBounds()
      const data = win._pinData
      const currentZoom = Number(data.zoom) || 1
      const nextZoom = applyPinZoomFactor(currentZoom, factor)
      if (Math.abs(nextZoom - currentZoom) < 0.001) return
      const sized = computePinDisplaySize({
        baseWidth: data.baseWidth,
        baseHeight: data.baseHeight,
        zoom: nextZoom,
        longCapture: false
      })
      data.zoom = nextZoom
      win.setBounds({ x: bounds.x, y: bounds.y, width: sized.width, height: sized.height }, false)
      win.webContents.send('pin:zoom-changed', Math.round(nextZoom * 100))
    })
    ipcMain.on('pin:move-start', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win._pinMove = { point: screen.getCursorScreenPoint(), bounds: win.getBounds() }
    })
    ipcMain.on('pin:move', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win?._pinMove) return
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
    ipcMain.on('pin:toggle-click-through', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win._pinData.clickThrough = !win._pinData.clickThrough
      win.setIgnoreMouseEvents(win._pinData.clickThrough, { forward: true })
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
    startPinReannotation,
    pinFromCapture,
    togglePinVisibility,
    syncPinDisplayScale
  }
}

module.exports = {
  createPinDomain
}
