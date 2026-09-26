'use strict'

const {
  createSmartSelectSessionClass,
  convertSmartSelectRects
} = require('./smart-select')

const NATIVE_CAPTURE_TIMEOUT_MS = 5000

function createCaptureDomain(deps) {
  const {
    app,
    spawn,
    execFile,
    fs,
    path,
    screen,
    BrowserWindow,
    desktopCapturer,
    nativeImage,
    clipboard,
    dialog,
    performance,
    rootDirectory,
    isWin,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    screenshotDesktop,
    listNativeDisplays,
    findNativeDisplay,
    getNativeDisplayBounds,
    readPngSize,
    shouldFilterApp,
    pinDomain,
    createRecordWindow,
    createLongCaptureFromSelection,
    createRecognitionWindow,
    persistHistory,
    saveImageBuffer,
    imageDataToBuffer,
    dataUrlToBuffer,
    bufferToDataUrl,
    performanceMonitor
  } = deps

  const SmartSelectSession = createSmartSelectSessionClass({ spawn, log })
  let currentCaptureWindow = null
  let nativeDisplayListPromise = null
  let captureCreateSeq = 0

  async function createSmartSelectSession() {
    if (!isWin) return null
    const executablePath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'smart-select', 'SmartSelect.exe')
      : path.join(rootDirectory, 'native', 'smart-select', 'SmartSelect.exe')
    if (!fs.existsSync(executablePath)) {
      log('Smart select helper missing:', executablePath)
      return null
    }
    const session = new SmartSelectSession(executablePath)
    try {
      await session.waitUntilReady()
      return session
    } catch (error) {
      log('Smart select unavailable:', error.message)
      session.dispose()
      return null
    }
  }

  function isBlankCapture(image) {
    if (!image || image.isEmpty()) return true
    const size = image.getSize()
    const sample = image.resize({
      width: Math.max(1, Math.min(32, size.width)),
      height: Math.max(1, Math.min(32, size.height)),
      quality: 'good'
    }).toBitmap()
    if (!sample.length) return true
    for (let index = 0; index + 2 < sample.length; index += 4) {
      if (sample[index] > 2 || sample[index + 1] > 2 || sample[index + 2] > 2) return false
    }
    return true
  }

  async function getDesktopCapture(display, scaleFactor) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
          height: Math.max(1, Math.round(display.bounds.height * scaleFactor))
        }
      })
      const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
      if (source && !source.thumbnail.isEmpty() && !isBlankCapture(source.thumbnail)) {
        return { imageBuffer: source.thumbnail.toPNG(), sourceId: source.id, scaleFactor }
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('屏幕捕获连续返回空白画面')
  }

  async function getDisplayCapture(display) {
    const scaleFactor = display.scaleFactor || 1
    if (isWin) {
      try {
        if (!nativeDisplayListPromise) nativeDisplayListPromise = listNativeDisplays(screenshotDesktop.parseDisplaysOutput)
        const nativeDisplays = await nativeDisplayListPromise
        const physicalBounds = screen.dipToScreenRect(null, display.bounds)
        const nativeDisplay = findNativeDisplay(
          nativeDisplays,
          physicalBounds,
          Math.max(1, Math.ceil(scaleFactor))
        )
        if (nativeDisplay) {
          // The capture helper is an external cmd.exe pipeline with no timeout of
          // its own; without this guard a hung spawn would wedge window creation.
          const buffer = await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`原生抓屏超时（${NATIVE_CAPTURE_TIMEOUT_MS}ms）`)),
              NATIVE_CAPTURE_TIMEOUT_MS
            )
            screenshotDesktop({ format: 'png', screen: nativeDisplay.id }).then(
              (result) => { clearTimeout(timer); resolve(result) },
              (error) => { clearTimeout(timer); reject(error) }
            )
          })
          const nativeBounds = getNativeDisplayBounds(nativeDisplay)
          // Read the dimensions straight out of the PNG IHDR chunk so a
          // wrong-sized capture fails without decoding a full-screen bitmap.
          const pngSize = readPngSize(buffer)
          if (!pngSize || pngSize.width !== nativeBounds.width || pngSize.height !== nativeBounds.height) {
            throw new Error(`原生抓屏尺寸异常：${pngSize ? `${pngSize.width}x${pngSize.height}` : '未知'}`)
          }
          if (isBlankCapture(nativeImage.createFromBuffer(buffer))) throw new Error('原生抓屏返回空白画面')
          return {
            imageBuffer: buffer,
            sourceId: `native:${nativeDisplay.id}`,
            scaleFactor
          }
        }
      } catch (error) {
        nativeDisplayListPromise = null
        log('Native capture fallback:', error.message)
      }
    }
    return getDesktopCapture(display, scaleFactor)
  }

  async function captureFocusedWindow() {
    let title = ''
    if (isWin) {
      title = await new Promise((resolve) => {
        const script = `$sig='[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);'; Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native; $h=[Native.Win32]::GetForegroundWindow(); $b=New-Object System.Text.StringBuilder 1024; [void][Native.Win32]::GetWindowText($h,$b,$b.Capacity); $b.ToString()`
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000 }, (_error, stdout) => resolve(String(stdout || '').trim()))
      })
    }
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: true })
    const source = sources.find((item) => title && (item.name === title || title.includes(item.name) || item.name.includes(title))) || sources.find((item) => !shouldFilterApp(item.name))
    if (!source || source.thumbnail.isEmpty()) throw new Error('无法捕获焦点窗口')
    return source.thumbnail.toDataURL()
  }

  function warmUpNativeDisplays() {
    return listNativeDisplays(screenshotDesktop.parseDisplaysOutput)
      .then((displays) => { nativeDisplayListPromise = Promise.resolve(displays) })
      .catch((error) => log('Display discovery warm-up failed:', error))
  }

  function sendCaptureInit(win) {
    if (
      !win ||
      win.isDestroyed() ||
      !win._captureRendererReady ||
      !win._captureInit ||
      win._captureInitSent
    ) return false
    win._captureInitSent = true
    win.webContents.send('capture:init', win._captureInit)
    return true
  }

  function revealCaptureWindow(win) {
    if (!win || win.isDestroyed() || win._captureVisible) return
    clearTimeout(win._renderTimeout)
    win._captureVisible = true
    win.setOpacity(1)
    win.showInactive()
    setImmediate(() => {
      if (win.isDestroyed()) return
      win.focus()
    })
  }

  async function createCaptureWindow(options = {}) {
    assertGameModeDisabled()
    const createSeq = ++captureCreateSeq
    const performanceStartedAt = performance.now()
    const performanceTiming = {
      startedAt: performanceStartedAt,
      mode: options.mode || 'region',
      captureMs: 0,
      smartSelectMs: 0,
      windowLoadMs: 0
    }
    const mode = options.mode || 'region'
    const requestedBounds = options.windowBounds && {
      x: Math.round(options.windowBounds.x),
      y: Math.round(options.windowBounds.y),
      width: Math.max(1, Math.round(options.windowBounds.width)),
      height: Math.max(1, Math.round(options.windowBounds.height))
    }
    const display = options.display || (requestedBounds
      ? screen.getDisplayMatching(requestedBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    const captureBounds = requestedBounds || display.bounds
    const suppliedImageBuffer = options.imageBuffer
      ? imageDataToBuffer(options.imageBuffer)
      : options.imageDataUrl
        ? dataUrlToBuffer(options.imageDataUrl)
        : null
    const rawCapturePromise = suppliedImageBuffer || options.mode === 'canvas'
      ? Promise.resolve({
          imageBuffer: suppliedImageBuffer || Buffer.alloc(0),
          sourceId: '',
          scaleFactor: Number(options.sourceScaleFactor) || display.scaleFactor || 1
        })
      : getDisplayCapture(display)
    const capturePromise = Promise.resolve(rawCapturePromise).then((capture) => {
      performanceTiming.captureMs = Math.round((performance.now() - performanceStartedAt) * 100) / 100
      return capture
    })
    const smartSelectStartedAt = performance.now()
    const smartSelectPromise = (mode === 'region' ? createSmartSelectSession() : Promise.resolve(null)).then((session) => {
      performanceTiming.smartSelectMs = Math.round((performance.now() - smartSelectStartedAt) * 100) / 100
      return session
    })
    const smartSelectSession = await smartSelectPromise
    if (createSeq !== captureCreateSeq) {
      smartSelectSession?.dispose()
      capturePromise.catch(() => {})
      return null
    }
    if (currentCaptureWindow && !currentCaptureWindow.isDestroyed()) currentCaptureWindow.close()
    const transparent = mode === 'canvas' || !!options.transparent
    const pagePath = path.join(rootDirectory, 'capture', 'capture.html')
    const captureWindow = createLocalWindow(pagePath, {
      x: captureBounds.x,
      y: captureBounds.y,
      width: Math.min(captureBounds.width, 800),
      height: Math.min(captureBounds.height, 600),
      frame: false,
      transparent,
      backgroundColor: transparent ? '#00ffffff' : '#000000',
      fullscreenable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      opacity: 0,
      resizable: false,
      movable: false,
      hasShadow: !transparent,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-capture.js'),
        backgroundThrottling: false
      }
    })
    currentCaptureWindow = captureWindow
    captureWindow._editingPinWindow = options.editingPinWindow || null
    captureWindow._captureVisible = false
    captureWindow._captureInitSent = false
    captureWindow._captureRendererReady = false
    captureWindow._performanceTiming = performanceTiming
    captureWindow._smartSelectContext = smartSelectSession
      ? {
          session: smartSelectSession,
          captureBounds,
          physicalBounds: screen.dipToScreenRect(null, captureBounds)
        }
      : null
    captureWindow.setAlwaysOnTop(true, 'screen-saver')
    captureWindow.setPosition(display.bounds.x, display.bounds.y, false)
    captureWindow.setBounds(captureBounds, false)
    captureWindow.setResizable(false)

    const loadStartedAt = performance.now()
    const loadPromise = captureWindow.loadFile(pagePath).then((result) => {
      performanceTiming.windowLoadMs = Math.round((performance.now() - loadStartedAt) * 100) / 100
      return result
    })
    captureWindow.on('closed', () => {
      clearTimeout(captureWindow._renderTimeout)
      captureWindow._smartSelectContext?.session.dispose()
      captureWindow._smartSelectContext = null
      if (currentCaptureWindow === captureWindow) currentCaptureWindow = null
      const pinWindow = captureWindow._pendingPinWindow || captureWindow._editingPinWindow
      setImmediate(() => pinDomain?.bringPinToFront(pinWindow))
    })
    captureWindow._renderTimeout = setTimeout(() => {
      if (captureWindow.isDestroyed() || captureWindow._captureVisible) return
      const init = captureWindow._captureInit
      log('Capture render timeout:', init ? 'renderer-stalled' : 'initializing', JSON.stringify({
        expected: init?.captureBounds || null,
        window: captureWindow.getBounds(),
        content: captureWindow.getContentBounds()
      }))
      captureWindow.close()
    }, 8000)

    try {
      const [capture] = await Promise.all([capturePromise, loadPromise])
      if (captureWindow.isDestroyed()) return null
      captureWindow._captureInit = {
        imageBuffer: capture.imageBuffer || Buffer.alloc(0),
        mode,
        autoAction: options.autoAction || '',
        source: options.source || 'region',
        displayBounds: display.bounds,
        captureBounds,
        imageBounds: options.imageBounds || null,
        scaleFactor: capture.scaleFactor,
        editPin: !!options.editPin,
        smartSelect: !!captureWindow._smartSelectContext,
        cursorPosition: (() => {
          const point = screen.getCursorScreenPoint()
          return { x: point.x - captureBounds.x, y: point.y - captureBounds.y }
        })(),
        settings: getSettings()
      }
      sendCaptureInit(captureWindow)
      return captureWindow
    } catch (error) {
      if (!captureWindow.isDestroyed()) captureWindow.close()
      throw error
    }
  }

  function ownsWindow(win) {
    return win != null && win === currentCaptureWindow
  }

  function getCurrentWindow() {
    return currentCaptureWindow
  }

  function isTaskActive() {
    return !!(currentCaptureWindow && !currentCaptureWindow.isDestroyed())
  }

  function createCaptureController() {
    return {
      ready: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) return
        win._captureRendererReady = true
        sendCaptureInit(win)
      },
      renderReady: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        revealCaptureWindow(win)
        if (win?._captureInit) {
          const timing = win._performanceTiming
          if (timing) {
            const bounds = win._captureInit.captureBounds || {}
            performanceMonitor.record('capture.interactive', performance.now() - timing.startedAt, {
              mode: timing.mode,
              captureMs: timing.captureMs,
              smartSelectMs: timing.smartSelectMs,
              windowLoadMs: timing.windowLoadMs,
              width: Number(bounds.width) || 0,
              height: Number(bounds.height) || 0,
              scaleFactor: Number(win._captureInit.scaleFactor) || 1
            })
            performanceMonitor.snapshot('capture-interactive', { mode: timing.mode })
            win._performanceTiming = null
          }
          win._captureInit.imageBuffer = null
        }
      },
      renderError: (event, message) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win.isDestroyed()) return
        log('Capture render failed:', message || 'image decode failed')
        win.close()
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        win?.close()
      },
      startRegionRecording: async (event, { selectionBounds } = {}) => {
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        if (!captureWindow || captureWindow !== currentCaptureWindow || captureWindow.isDestroyed()) {
          throw new Error('无效的截图窗口')
        }
        const bounds = {
          x: Number(selectionBounds?.x),
          y: Number(selectionBounds?.y),
          width: Number(selectionBounds?.width),
          height: Number(selectionBounds?.height)
        }
        if (!Object.values(bounds).every(Number.isFinite)) throw new Error('录制区域无效')
        const display = screen.getDisplayMatching(bounds)
        await createRecordWindow({ display, selectionBounds: bounds })
        if (!captureWindow.isDestroyed()) captureWindow.close()
        return true
      },
      startLong: (event, payload) => createLongCaptureFromSelection(BrowserWindow.fromWebContents(event.sender), payload),
      smartSelect: async (event, point = {}) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const context = win?._smartSelectContext
        if (!context || win.isDestroyed()) return []
        const localX = Math.max(0, Math.min(context.captureBounds.width, Number(point.x) || 0))
        const localY = Math.max(0, Math.min(context.captureBounds.height, Number(point.y) || 0))
        const physicalX = context.physicalBounds.x + localX * context.physicalBounds.width / context.captureBounds.width
        const physicalY = context.physicalBounds.y + localY * context.physicalBounds.height / context.captureBounds.height
        let rects = await context.session.query(physicalX, physicalY)
        if (!rects.length) rects = context.session.findWindowAt(physicalX, physicalY)
        const candidates = convertSmartSelectRects(rects, context)
        return candidates.length
          ? candidates
          : [{ x: 0, y: 0, w: context.captureBounds.width, h: context.captureBounds.height }]
      },
      copy: (_event, { imageBuffer, dataUrl, meta } = {}) => {
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (!buffer.length) throw new Error('截图图片数据为空')
        const image = nativeImage.createFromBuffer(buffer)
        clipboard.writeImage(image)
        const persistMeta = { ...meta, action: 'copy', image }
        const persistStarted = Date.now()
        setImmediate(() => {
          try {
            persistHistory(buffer, persistMeta)
            performanceMonitor.record('capture.history-persist', Date.now() - persistStarted, { action: 'copy' })
          } catch (error) {
            log('Capture history persist failed:', error.message)
          }
        })
        if (getSettings().screenshot.autoSaveOnCopy && getSettings().screenshot.saveDirectory) {
          saveImageBuffer(buffer, { fast: true }).catch((error) => log(error.message))
        }
        return null
      },
      save: (event, { imageBuffer, dataUrl, meta, fast } = {}) => {
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        setImmediate(async () => {
          try {
            if (!buffer.length) throw new Error('截图图片数据为空')
            const filePath = await saveImageBuffer(buffer, { fast: !!fast })
            if (filePath) persistHistory(buffer, { ...meta, action: 'save' })
          } catch (error) {
            log('Capture save failed:', error.message)
            dialog.showErrorBox('保存截图失败', error.message || String(error))
          }
        })
      },
      pin: (event, { imageBuffer, dataUrl, meta } = {}) => {
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        pinDomain.pinFromCapture(event, buffer, meta)
        const persistMeta = { ...meta, action: 'pin' }
        const persistStarted = Date.now()
        setImmediate(() => {
          try {
            persistHistory(buffer, persistMeta)
            performanceMonitor.record('capture.history-persist', Date.now() - persistStarted, { action: 'pin' })
          } catch (error) {
            log('Capture history persist failed:', error.message)
          }
        })
        return null
      },
      pinReannotate: (event, { imageBuffer, dataUrl, meta, action } = {}) => {
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        const { captureWindow, pinWindow } = pinDomain.pinFromCapture(event, buffer, meta)
        pinWindow._pendingReannotateAction = ['ocr', 'translate'].includes(action) ? action : ''
        setImmediate(() => {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        })
        const persistMeta = { ...meta, action: 'pin' }
        setImmediate(() => {
          try {
            persistHistory(buffer, persistMeta)
          } catch (error) {
            log('Capture history persist failed:', error.message)
          }
        })
        return null
      },
      openRecognition: (event, { type, imageBuffer, dataUrl, meta } = {}) => {
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        createRecognitionWindow(type, bufferToDataUrl(buffer), { scaleFactor: meta?.scaleFactor })
        setImmediate(() => {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        })
        return persistHistory(buffer, { ...meta, action: type })
      },
      recordHistory: (_event, { imageBuffer, dataUrl, meta } = {}) => persistHistory(imageBuffer ?? dataUrl, meta)
    }
  }

  return {
    createCaptureWindow,
    sendCaptureInit,
    revealCaptureWindow,
    createSmartSelectSession,
    convertSmartSelectRects,
    createCaptureController,
    getDisplayCapture,
    captureFocusedWindow,
    warmUpNativeDisplays,
    ownsWindow,
    getCurrentWindow,
    isTaskActive
  }
}

module.exports = {
  createCaptureDomain
}
