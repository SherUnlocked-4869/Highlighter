'use strict'

const {
  calculateFrameBounds,
  calculateRecordControlSize,
  calculateTranscodeProgress,
  normalizeFrameRate,
  normalizeSelectionBounds,
  pickDesktopSource
} = require('../../../record/recording-utils')
const {
  sanitizeAnnotationCommand,
  sanitizeAnnotationSnapshot
} = require('../../../record/annotation-utils')

function createRecordDomain(deps) {
  const {
    app,
    desktopCapturer,
    path,
    screen,
    dialog,
    BrowserWindow,
    rootDirectory,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    assertManagedDataWritable,
    getRecordingService,
    peekRecordingService,
    managedRecordingWriters,
    makeCaptureName,
    VIDEO_CAPTURE_PREFIX,
    performanceMonitor,
    // Feature B (plan §5.1/§5.2): the remembered-region write is a DOMAIN-INTERNAL action, which is
    // why it is injected here instead of exposed as a channel. A resolver, because the service is
    // created inside initializeStore() after this domain.
    getRegionPreferences = () => null
  } = deps

  let recordWindow = null
  let recordFrameWindow = null

  // Records the region a recording actually started with (plan §5.1: the record-mode last region is
  // updated when a recording successfully STARTS; a cancelled selection must not overwrite it).
  // `selectionBounds` is Electron DIP window bounds - the DIP->pixel conversion is `region-preferences`'
  // job (recordFromDisplaySelection), so it cannot be forgotten here. A missing display descriptor
  // only means "no remembered region yet"; it must never break starting a recording.
  // Builds the display descriptor `region-preferences` needs without assuming Electron's native-rect
  // probe exists: `screen.dipToScreenRect` is the accurate source when available, and `scaleFactor`
  // is the documented fallback (see main/ipc/region-ipc-controller.js describeDisplay).
  function describeDisplayForRegion(display) {
    const bounds = display?.bounds || {}
    const boundsDip = {
      x: Math.round(Number(bounds.x) || 0),
      y: Math.round(Number(bounds.y) || 0),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0))
    }
    const scaleFactor = Number(display?.scaleFactor) || 1
    let pixelSize = null
    if (screen && typeof screen.dipToScreenRect === 'function') {
      try {
        const native = screen.dipToScreenRect(null, bounds)
        const width = Math.round(Number(native?.width) || 0)
        const height = Math.round(Number(native?.height) || 0)
        if (width > 0 && height > 0) pixelSize = { width, height }
      } catch {
        pixelSize = null
      }
    }
    if (!pixelSize) {
      pixelSize = {
        width: Math.max(1, Math.round(boundsDip.width * scaleFactor)),
        height: Math.max(1, Math.round(boundsDip.height * scaleFactor))
      }
    }
    return {
      key: display?.id === undefined || display?.id === null ? `${boundsDip.x}:${boundsDip.y}` : String(display.id),
      boundsDip,
      pixelSize,
      scaleFactor
    }
  }

  function rememberRecordRegion(display, selectionBounds) {    let preferences
    try {
      preferences = typeof getRegionPreferences === 'function' ? getRegionPreferences() : null
    } catch (error) {
      log('Region preferences unavailable:', error?.message || error)
      return
    }
    if (!preferences || typeof preferences.recordFromDisplaySelection !== 'function') return
    try {
      const result = preferences.recordFromDisplaySelection({
        mode: 'record',
        display: display || {},
        selectionBounds
      })
      if (!result?.ok && result?.code !== 'selection-unusable') {
        log('Remembered record region rejected:', result?.code || 'unknown')
      }
    } catch (error) {
      log('Remembered record region failed:', error?.message || error)
    }
  }

  function isTaskActive() {
    return !!(recordWindow && !recordWindow.isDestroyed())
  }

  function ownsControlWindow(win) {
    return win != null && win === recordWindow
  }

  function ownsFrameWindow(win) {
    return win != null && win === recordFrameWindow && win._recordOwner === recordWindow
  }

  async function cleanupRecordSession(win, service = null, allowBlocked = false) {
    const sessionId = win?._recordSessionId
    if (!sessionId) return false
    const activeService = service || getRecordingService()
    win._recordSessionId = null
    return managedRecordingWriters.track(() => activeService.cleanupSession(sessionId), { allowBlocked })
  }

  function restoreRecordFramePassthrough(frame = recordFrameWindow) {
    if (!frame || frame.isDestroyed()) return false
    frame.setIgnoreMouseEvents(true, { forward: true })
    return true
  }

  async function closeRecordFlow(service = null, allowBlockedCleanup = false) {
    const control = recordWindow
    const frame = recordFrameWindow
    if (recordWindow === control) recordWindow = null
    if (recordFrameWindow === frame) recordFrameWindow = null
    await cleanupRecordSession(control, service, allowBlockedCleanup).catch((error) => log('Recording cleanup failed:', error.message))
    restoreRecordFramePassthrough(frame)
    if (control && !control.isDestroyed()) control.close()
    if (frame && !frame.isDestroyed()) frame.close()
  }

  async function getDesktopSource(display) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
      const source = pickDesktopSource(sources, display.id)
      if (!source) throw new Error('未找到匹配显示器的桌面源')
      return source
    } catch (error) {
      throw new Error(`无法获取桌面录制源：${error.message || error}`)
    }
  }

  function getRecordControlBounds(selectionBounds, workArea) {
    const { width, height } = calculateRecordControlSize(workArea)
    const minX = workArea.x
    const maxX = workArea.x + workArea.width - width
    const minY = workArea.y
    const maxY = workArea.y + workArea.height - height
    const x = Math.max(minX, Math.min(maxX, Math.round(selectionBounds.x + (selectionBounds.width - width) / 2)))
    let y = selectionBounds.y + selectionBounds.height + 12
    if (y > maxY) y = selectionBounds.y - height - 12
    return { x, y: Math.max(minY, Math.min(maxY, Math.round(y))), width, height }
  }

  async function createRecordWindow(options = {}) {
    assertGameModeDisabled()
    await closeRecordFlow()
    const requestedBounds = options.selectionBounds && {
      x: Math.round(Number(options.selectionBounds.x)),
      y: Math.round(Number(options.selectionBounds.y)),
      width: Math.round(Number(options.selectionBounds.width)),
      height: Math.round(Number(options.selectionBounds.height))
    }
    const display = options.display || (requestedBounds
      ? screen.getDisplayMatching(requestedBounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    const selectionBounds = normalizeSelectionBounds(requestedBounds || display.bounds, display.bounds)
    const source = await getDesktopSource(display)
    const frameRate = normalizeFrameRate(getSettings().record.frameRate)
    const recordSettings = getSettings().record
    const frameBounds = calculateFrameBounds(selectionBounds, 2)
    const controlBounds = getRecordControlBounds(selectionBounds, display.workArea)

    const framePagePath = path.join(rootDirectory, 'record', 'frame.html')
    const controlPagePath = path.join(rootDirectory, 'record', 'record.html')
    const frameWindow = createLocalWindow(framePagePath, {
      ...frameBounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-record-frame.js'),
        backgroundThrottling: false
      }
    })
    const controlWindow = createLocalWindow(controlPagePath, {
      ...controlBounds,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-record.js'),
        backgroundThrottling: false
      }
    })
    recordFrameWindow = frameWindow
    recordWindow = controlWindow
    frameWindow._recordOwner = controlWindow
    controlWindow._recordControlBounds = controlBounds
    controlWindow._recordFrameState = 'idle'
    controlWindow._recordAnnotationCommand = sanitizeAnnotationCommand({})
    controlWindow._recordInit = {
      sourceId: source.id,
      displayBounds: display.bounds,
      selectionBounds,
      // Feature B (plan §5.1): the descriptor the remembered-region write needs (key + DIP bounds +
      // measured pixel size). Captured at window creation, while `display` is in scope. Resolved
      // defensively: a host without a native rect probe (tests, and any non-Windows platform where
      // dipToScreenRect is unavailable) still gets a working descriptor from scaleFactor.
      display: describeDisplayForRegion(display),
      frameRate,
      // P0-3-T2: the recorder renderer reads these four frozen keys to decide which audio
      // buses to request; the renderer falls back to the same defaults when they are absent.
      audioSystem: recordSettings.audioSystem,
      audioMicrophone: recordSettings.audioMicrophone,
      audioSystemGain: recordSettings.audioSystemGain,
      audioMicrophoneGain: recordSettings.audioMicrophoneGain
    }

    // P0-3-T2: the renderer acquires the desktop through getDisplayMedia, which Electron
    // only grants from this handler. getDisplayMedia cannot pin a source by deviceId, so the
    // display is selected here with the same pickDesktopSource the legacy path used; the
    // system-audio track is offered only when the renderer actually asked for audio, which
    // is what keeps the "system sound off" contract (settings-defaults.js:71) honest.
    const recordSession = controlWindow.webContents.session
    recordSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        // 只服务录制窗自己的主帧：该 handler 注册在**共享默认 session** 上，若不校验来源，
        // 任何渲染进程（含将来新增的窗口）调用 getDisplayMedia 都能拿到屏幕 + loopback 音频。
        if (request.frame && request.frame !== controlWindow.webContents.mainFrame) return callback({})
        if (!request.videoRequested) return callback({})
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        const target = pickDesktopSource(sources, display.id)
        if (!target) return callback({})
        const audio = request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined
        callback(audio ? { video: target, audio } : { video: target })
      } catch (error) {
        log('Display media request failed:', error.message)
        callback({})
      }
    })

    for (const win of [frameWindow, controlWindow]) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setContentProtection(true)
    }
    restoreRecordFramePassthrough(frameWindow)
    controlWindow.on('closed', () => {
      // 注销共享 session 上的 display-media handler：否则窗口关闭后它仍存活并指向旧 display。
      try { recordSession.setDisplayMediaRequestHandler(null) } catch (error) { log('Display media handler cleanup failed:', error.message) }
      cleanupRecordSession(controlWindow).catch((error) => log('Recording cleanup failed:', error.message))
      if (recordWindow === controlWindow) recordWindow = null
      if (recordFrameWindow?._recordOwner === controlWindow) {
        const ownedFrame = recordFrameWindow
        recordFrameWindow = null
        if (!ownedFrame.isDestroyed()) ownedFrame.close()
      }
    })
    frameWindow.on('closed', () => {
      if (recordFrameWindow === frameWindow) recordFrameWindow = null
    })
    await Promise.all([
      frameWindow.loadFile(framePagePath),
      controlWindow.loadFile(controlPagePath)
    ])
    frameWindow.showInactive()
    controlWindow.show()
    return controlWindow
  }

  function requireRecordSender(event) {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== recordWindow || win.isDestroyed()) throw new Error('无效的录制窗口')
    return win
  }

  function requireRecordFrameSender(event) {
    const frame = BrowserWindow.fromWebContents(event.sender)
    if (!frame || frame !== recordFrameWindow || frame.isDestroyed() || frame._recordOwner !== recordWindow) {
      throw new Error('无效的录制标注窗口')
    }
    return frame
  }

  function sendRecordAnnotationCommand(control, payload = {}) {
    const frame = recordFrameWindow
    if (!control || control !== recordWindow || control.isDestroyed() || !frame || frame.isDestroyed() || frame._recordOwner !== control) return false
    const sanitized = sanitizeAnnotationCommand({ ...control._recordAnnotationCommand, ...payload })
    const enabled = ['recording', 'paused'].includes(control._recordFrameState)
    const message = { ...sanitized, enabled, tool: enabled ? sanitized.tool : 'pointer' }
    control._recordAnnotationCommand = { ...sanitized, action: '' }
    frame.setIgnoreMouseEvents(message.tool === 'pointer', { forward: true })
    frame.webContents.send('record-frame:command', message)
    return message
  }

  function requireRecordSession(win, sessionId) {
    if (!sessionId || win._recordSessionId !== sessionId) throw new Error('录制会话不匹配')
    return sessionId
  }

  function createRecordingController() {
    return {
      ready: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win === recordWindow && win?._recordInit) event.sender.send('record:init', win._recordInit)
      },
      frameReady: (event) => {
        const frame = requireRecordFrameSender(event)
        sendRecordAnnotationCommand(frame._recordOwner)
      },
      frameSnapshot: (event, snapshot = {}) => {
        const frame = requireRecordFrameSender(event)
        const control = frame._recordOwner
        const bounds = control._recordInit.selectionBounds
        const clean = sanitizeAnnotationSnapshot(snapshot, { width: bounds.width, height: bounds.height })
        control.webContents.send('record:annotation-snapshot', clean)
      },
      performance: (event, metrics = {}) => {
        requireRecordSender(event)
        const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(metrics.durationMs) || 0))
        const targetFrameRate = normalizeFrameRate(metrics.targetFrameRate)
        const callbacks = Math.max(0, Math.min(100000000, Math.round(Number(metrics.callbacks) || 0)))
        const renderedFrames = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.renderedFrames) || 0)))
        const skippedCallbacks = Math.max(0, Math.min(callbacks, Math.round(Number(metrics.skippedCallbacks) || 0)))
        const scheduler = metrics.scheduler === 'video-frame' ? 'video-frame' : 'timer'
        performanceMonitor.record('record.compositor', durationMs, {
          targetFrameRate,
          callbacks,
          renderedFrames,
          skippedCallbacks,
          scheduler,
          effectiveFrameRate: durationMs > 0 ? Math.round(renderedFrames * 100000 / durationMs) / 100 : 0
        })
        performanceMonitor.snapshot('record-compositor', { targetFrameRate, scheduler })
      },
      setAnnotationCommand: (event, command = {}) => {
        const control = requireRecordSender(event)
        return sendRecordAnnotationCommand(control, command)
      },
      startSession: async (event) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        const service = getRecordingService()
        await cleanupRecordSession(win, service)
        managedRecordingWriters.assertOpen()
        const session = await managedRecordingWriters.track(() => service.startSession())
        win._recordSessionId = session.id
        // Plan §5.1: the record-mode last region is updated when a recording successfully STARTS, so
        // a cancelled selection never overwrites it. `selectionBounds` on the window's init payload is
        // Electron DIP; recordFromDisplaySelection owns the DIP->pixel conversion.
        const init = win._recordInit || {}
        if (init.selectionBounds) rememberRecordRegion(init.display, init.selectionBounds)
        return { id: session.id }
      },
      appendChunk: async (event, { sessionId, arrayBuffer } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const service = getRecordingService()
        await managedRecordingWriters.track(service.appendChunk(sessionId, Buffer.from(arrayBuffer || [])))
        return true
      },
      finishSession: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const service = getRecordingService()
        return managedRecordingWriters.track(service.finishSession(sessionId))
      },
      saveMp4: async (event, { sessionId, durationMs } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        const settings = getSettings()
        const directory = settings.record.saveDirectory || app.getPath('videos')
        let result
        win.setAlwaysOnTop(false)
        try {
          result = await dialog.showSaveDialog(win, {
            title: '保存 MP4 录屏',
            defaultPath: path.join(directory, makeCaptureName(VIDEO_CAPTURE_PREFIX).replace('.png', '.mp4')),
            filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
          })
        } finally {
          if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
        }
        if (result.canceled || !result.filePath) return ''
        assertManagedDataWritable()
        const duration = Math.max(1, Number(durationMs) || 1)
        const service = getRecordingService()
        const outputPath = await managedRecordingWriters.track(service.transcode(sessionId, result.filePath, (elapsedMicroseconds) => {
          if (win.isDestroyed()) return
          const percent = calculateTranscodeProgress(elapsedMicroseconds, duration)
          win.webContents.send('record:save-progress', percent)
        }, { audio: !!(settings.record.audioSystem || settings.record.audioMicrophone) }))
        if (!win.isDestroyed()) win.webContents.send('record:save-progress', 100)
        win._recordSessionId = null
        await managedRecordingWriters.track(service.cleanupSession(sessionId))
        return outputPath
      },
      cancelSession: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        requireRecordSession(win, sessionId)
        win._recordSessionId = null
        const service = getRecordingService()
        await managedRecordingWriters.track(service.cleanupSession(sessionId))
        return true
      },
      setFrameState: (event, state = 'idle') => {
        const control = requireRecordSender(event)
        const frame = recordFrameWindow
        if (!frame || frame.isDestroyed()) return false
        control._recordFrameState = ['recording', 'paused'].includes(state) ? state : 'idle'
        sendRecordAnnotationCommand(control)
        if (state === 'hidden') {
          restoreRecordFramePassthrough(frame)
          frame.hide()
        } else {
          frame.showInactive()
          frame.webContents.send('record-frame:state', ['recording', 'paused'].includes(state) ? state : 'idle')
        }
        return true
      },
      resizePreview: (event) => {
        const win = requireRecordSender(event)
        const display = screen.getDisplayMatching(win._recordInit.selectionBounds)
        const width = Math.min(760, display.workArea.width)
        const height = Math.min(560, display.workArea.height)
        win.setBounds({
          x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
          y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
          width,
          height
        }, false)
        return true
      },
      restart: async (event, { sessionId } = {}) => {
        assertManagedDataWritable()
        const win = requireRecordSender(event)
        if (sessionId) requireRecordSession(win, sessionId)
        await cleanupRecordSession(win, getRecordingService())
        win.setBounds(win._recordControlBounds, false)
        if (recordFrameWindow && !recordFrameWindow.isDestroyed()) {
          win._recordFrameState = 'idle'
          const resetVersion = Number(win._recordAnnotationCommand?.resetVersion || 0) + 1
          sendRecordAnnotationCommand(win, { action: 'reset', resetVersion })
          restoreRecordFramePassthrough(recordFrameWindow)
          recordFrameWindow.showInactive()
          recordFrameWindow.webContents.send('record-frame:state', 'idle')
        }
        return true
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win !== recordWindow) return
        closeRecordFlow().catch((error) => log('Recording close failed:', error.message))
      }
    }
  }

  async function shutdown() {
    const activeService = typeof peekRecordingService === 'function'
      ? peekRecordingService()
      : null
    await closeRecordFlow(activeService, true)
    if (activeService) await activeService.dispose()
  }

  return {
    isTaskActive,
    ownsControlWindow,
    ownsFrameWindow,
    createRecordWindow,
    cleanupRecordSession,
    closeRecordFlow,
    restoreRecordFramePassthrough,
    createRecordingController,
    shutdown
  }
}

module.exports = {
  createRecordDomain
}
