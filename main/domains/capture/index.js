'use strict'

const {
  createSmartSelectSessionClass,
  convertSmartSelectRects
} = require('./smart-select')
const {
  DEFAULT_IMAGE_DPI,
  exportPdfBuffer,
  savePdfBuffer: writePdfBuffer
} = require('../../services/pdf-export')
// P0-7B（§17.6）：目录解析与保存模块同源，避免"自动保存"与此前落点判断不一致。
const { resolveSaveDirectory } = require('../../services/image-file-save')
// §17.5 的 PDF 默认名决定（S9a）：与截图保存共用同一套模板命名。
const { makeCaptureName } = require('../../services/capture-naming')

const NATIVE_CAPTURE_TIMEOUT_MS = 5000
// P0-2（S9b）：光标查询的兜底预算。provider 自身的查询超时是 350ms，比抓屏慢得多，
// 这里再压一道硬预算，保证截图窗口不会被"取光标"拖住；超时按"不画"处理。
const CURSOR_QUERY_BUDGET_MS = 120

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
    performanceMonitor,
    // P0-2（S9b）：可选注入。main.js 已注入；未注入时等价于"永远不画光标"。
    cursorProvider
  } = deps

  // P0-4：可选注入，便于单测 mock；主进程不注入时由 pdf-export 自解析 Electron 依赖，
  // 因此本特性不需要任何 main.js 接线（§2.2 规则 3）。
  const printToPdf = typeof deps.printToPdf === 'function' ? deps.printToPdf : null
  const savePdfBuffer = typeof deps.savePdfBuffer === 'function' ? deps.savePdfBuffer : writePdfBuffer

  const SmartSelectSession = createSmartSelectSessionClass({ spawn, log })
  let currentCaptureWindow = null
  let nativeDisplayListPromise = null
  let captureCreateSeq = 0
  // P0-7-T7 精确接续（2026-10-10 真机验收修正）：主进程记的是"上一张实际用掉的最后一个序号"，
  // 而不是"第几次截图"。窗口新建时下发这个值，渲染层每落一个序号就自增，并在完成动作时
  // 通过既有通道的 meta.serialNumber 回报（不新增通道）；这里只接受前进。
  let captureSerialSeq = 1

  // 渲染层回报的序号是本张图"下一个该用的号"，比当前值大才推进 —— 同一张图可能经多条
  // 路径回报（保存/贴图/导出 PDF/关窗），重复回报不会把计数推过头。
  function reportCaptureSerial(meta) {
    const reported = Math.round(Number(meta?.serialNumber))
    if (Number.isFinite(reported) && reported > captureSerialSeq) captureSerialSeq = reported
  }

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

  // P0-2（S9b）：只有"截图带光标"开关打开、且 deps 里真的注入了 provider 时才查询。
  // provider 是懒启动的（`query()` 是拉起 SmartSelect.exe 的唯一入口），所以开关关闭时
  // 连 helper 进程都不会被创建 —— 这就是"关 = 零开销"的证明点。
  // 必须 `fresh: true`：provider 默认复用 250ms 内的形状缓存，而截图要的是"此刻"的位置。
  // 任何失败（拒绝 / 超时 / provider 抛错）都降级成 null = 不画光标，绝不影响抓屏。
  function queryCursorSnapshot() {
    if (!cursorProvider || typeof cursorProvider.query !== 'function') return Promise.resolve(null)
    if (getSettings()?.screenshot?.captureCursor !== true) return Promise.resolve(null)
    let timer = null
    const providerPromise = Promise.resolve()
      .then(() => cursorProvider.query({ fresh: true }))
      .then((snapshot) => snapshot || null, () => null)
    const budgetPromise = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CURSOR_QUERY_BUDGET_MS) })
    return Promise.race([providerPromise, budgetPromise]).then((snapshot) => {
      clearTimeout(timer)
      return snapshot || null
    }, () => null)
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
    // P0-2（S9b）：光标查询与抓屏并行；开关关闭时 queryCursorSnapshot() 立刻解析成 null，
    // 不产生任何进程/IO 开销。
    const cursorPromise = queryCursorSnapshot()
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
        backgroundThrottling: false,
        // P0-7-T5：快门音由渲染层 play() 触发，截图窗口没有用户手势，
        // 必须放开自动播放策略，否则 play() 会被 Autoplay Policy 拒绝。
        autoplayPolicy: 'no-user-gesture-required'
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
      // 中间那项是 loadPromise 的结果（loadFile），本函数不用它，故留空位。
      const [capture, , cursorSnapshot] = await Promise.all([capturePromise, loadPromise, cursorPromise])
      if (captureWindow.isDestroyed()) return null
      const settings = getSettings()
      // P0-7-T7：每次截图都是新窗口，序号默认从 1 开始（显式下发）；
      // screenshot.keepSerialAcrossCaptures 打开时下发"上一张用掉的最后一个序号 + 1"，
      // 由渲染层在动作完成时回报（reportCaptureSerial），因此这里不再自增。
      const serialNumber = settings?.screenshot?.keepSerialAcrossCaptures === true ? captureSerialSeq : 1
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
        // P0-7-T4：快捷保存 / 另存为调用方下发的保存模式；空值时渲染层回落到设置项。
        saveMode: options.saveMode || '',
        serialNumber,
        // P0-2（S9b）：截图带光标的合成载荷。开关关闭 / provider 不可用 / 查询失败都是 null，
        // 渲染层据此"一行都不画"，与旧版逐像素一致。physicalPoint 是**物理像素**，
        // 渲染层贴图前必须按 scaleFactor 换回 DIP（见 shared/cursor-geometry.js 头注释）。
        cursor: cursorSnapshot
          ? {
              png: cursorSnapshot.png,
              dataUrl: cursorSnapshot.dataUrl,
              width: cursorSnapshot.width,
              height: cursorSnapshot.height,
              hotspot: { x: cursorSnapshot.hotspot.x, y: cursorSnapshot.hotspot.y },
              physicalPoint: { x: cursorSnapshot.physicalPoint.x, y: cursorSnapshot.physicalPoint.y }
            }
          : null,
        settings
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
      close: (event, payload = {}) => {
        // ✕ / Esc 关窗时也带着已落过的序号（P0-7-T7 精确接续）：落过就推进。
        reportCaptureSerial(payload)
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
        // P0-7B（§17.6）：保存落点可能是记忆目录（screenshot.lastSaveDirectory），
        // 因此"配置了固定目录或已有记忆目录"任一成立即可自动保存。
        const settings = getSettings()
        if (settings.screenshot.autoSaveOnCopy && resolveSaveDirectory(settings)) {
          saveImageBuffer(buffer, { fast: true }).catch((error) => log(error.message))
        }
        return null
      },
      save: (event, { imageBuffer, dataUrl, meta, fast } = {}) => {
        reportCaptureSerial(meta)
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
        reportCaptureSerial(meta)
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
        reportCaptureSerial(meta)
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
        reportCaptureSerial(meta)
        const captureWindow = BrowserWindow.fromWebContents(event.sender)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        createRecognitionWindow(type, bufferToDataUrl(buffer), { scaleFactor: meta?.scaleFactor })
        setImmediate(() => {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
        })
        return persistHistory(buffer, { ...meta, action: type })
      },
      recordHistory: (_event, { imageBuffer, dataUrl, meta } = {}) => {
        reportCaptureSerial(meta)
        return persistHistory(imageBuffer ?? dataUrl, meta)
      },
      exportPdf: async (event, { imageBuffer, dataUrl, meta, mode } = {}) => {
        reportCaptureSerial(meta)
        const buffer = imageDataToBuffer(imageBuffer ?? dataUrl)
        if (!buffer.length) throw new Error('截图图片数据为空')
        // 以 PNG 头部为准：meta.width/height 属于导出坐标系，PNG 才是真正要打印的像素。
        const pngSize = readPngSize(buffer)
        const pxW = pngSize?.width || Number(meta?.width)
        const pxH = pngSize?.height || Number(meta?.height)
        if (!pxW || !pxH) throw new Error('导出 PDF 需要 PNG 截图数据或有效的图片尺寸')
        const parentWindow = BrowserWindow.fromWebContents(event.sender)
        const pdfBuffer = await exportPdfBuffer(buffer, {
          createPrintWindow: createLocalWindow,
          rootDirectory,
          pxW,
          pxH,
          dataUrl: typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : undefined,
          // 截图是物理像素：96 × scaleFactor 还原 1:1 的 CSS 尺寸，避免 DPI 尺寸偏差（§4.3 风险②）。
          dpi: DEFAULT_IMAGE_DPI * Math.max(1, Number(meta?.scaleFactor) || 1),
          mode,
          printToPdf,
          log
        })
        return savePdfBuffer(pdfBuffer, {
          parentWindow: parentWindow && !parentWindow.isDestroyed() ? parentWindow : null,
          dialog,
          fs,
          // §17.5 交 S9a 决定：PDF 默认名跟随 screenshot.nameTemplate（空模板 = 旧格式，
          // 与截图保存完全同源）。重名仍由保存对话框兜底，与改动前一致。
          makeName: (prefix, ext) => makeCaptureName(prefix, ext, { template: getSettings()?.screenshot?.nameTemplate })
        })
      }
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
