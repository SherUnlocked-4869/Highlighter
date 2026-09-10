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
    performanceMonitor
  } = deps

  let recordWindow = null
  let recordFrameWindow = null

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
      frameRate
    }

    for (const win of [frameWindow, controlWindow]) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setContentProtection(true)
    }
    restoreRecordFramePassthrough(frameWindow)
    controlWindow.on('closed', () => {
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
        }))
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
