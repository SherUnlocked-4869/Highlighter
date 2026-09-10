'use strict'

function createLongCaptureDomain(deps) {
  const {
    app,
    desktopCapturer,
    path,
    screen,
    dialog,
    clipboard,
    nativeImage,
    fs,
    rootDirectory,
    createLocalWindow,
    getSettings,
    log,
    assertManagedDataWritable,
    isMigrationInProgress,
    LongCaptureSession,
    getLongCaptureTempRoot,
    captureDomain,
    pinDomain,
    persistHistoryFile,
    ensureDirectory,
    makeCaptureName,
    LONG_CAPTURE_PREFIX,
    updateSettings
  } = deps

  let currentLongCapture = null

  function isTaskActive() {
    return !!currentLongCapture
  }

  function getState() {
    return currentLongCapture
  }

  function ownsControllerWindow(win) {
    return win != null && win === currentLongCapture?.controllerWindow
  }

  function ownsOverlayWindow(win) {
    return win != null && win === currentLongCapture?.overlayWindow
  }

  async function getDesktopSourceForDisplay(display) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
    if (!source) throw new Error('无法创建长截图屏幕采集源')
    return source
  }

  function placeLongCaptureController(display, selectionBounds, width = 420, height = 570) {
    const area = display.workArea
    const gap = 10
    const candidates = [
      { x: selectionBounds.x + selectionBounds.width + gap, y: selectionBounds.y },
      { x: selectionBounds.x - width - gap, y: selectionBounds.y },
      { x: selectionBounds.x, y: selectionBounds.y + selectionBounds.height + gap },
      { x: selectionBounds.x, y: selectionBounds.y - height - gap }
    ]
    const fits = (bounds) => bounds.x >= area.x && bounds.y >= area.y && bounds.x + width <= area.x + area.width && bounds.y + height <= area.y + area.height
    const candidate = candidates.find(fits)
    if (candidate) return { ...candidate, width, height }
    return {
      x: Math.max(area.x, area.x + area.width - width - gap),
      y: Math.max(area.y, area.y + area.height - height - gap),
      width,
      height
    }
  }

  function closeLongCapture() {
    const state = currentLongCapture
    if (!state || state.closing) return
    state.closing = true
    currentLongCapture = null
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.close()
    if (state.controllerWindow && !state.controllerWindow.isDestroyed()) state.controllerWindow.close()
    state.session.cleanup()
  }

  function setLongOverlayEditing(state, enabled, axis, hasContent) {
    if (!state || state.overlayWindow.isDestroyed() || state.controllerWindow.isDestroyed()) return false
    state.selectionEditing = !!enabled
    state.overlayWindow.setFocusable(state.selectionEditing)
    state.overlayWindow.setIgnoreMouseEvents(!state.selectionEditing, { forward: true })
    state.overlayWindow.webContents.send('long-overlay:editing', {
      enabled: state.selectionEditing,
      lockedAxis: state.selectionEditing && hasContent ? (axis === 'horizontal' ? 'horizontal' : 'vertical') : ''
    })
    if (state.selectionEditing) {
      state.overlayWindow.moveTop()
      state.overlayWindow.focus()
      setImmediate(() => {
        if (!state.controllerWindow.isDestroyed()) state.controllerWindow.moveTop()
      })
    } else {
      state.controllerWindow.focus()
    }
    return true
  }

  async function createLongCaptureFromSelection(captureWindow, payload = {}) {
    if (isMigrationInProgress?.()) throw new Error('数据目录正在迁移，请稍候')
    if (!captureWindow || captureWindow.isDestroyed() || !captureDomain?.ownsWindow(captureWindow)) throw new Error('截图选区已失效')
    const selected = payload.selection || {}
    const captureBounds = captureWindow._captureInit?.captureBounds
    if (!captureBounds) throw new Error('缺少截图显示器信息')
    const selectionBounds = {
      x: Math.round(captureBounds.x + Number(selected.x || 0)),
      y: Math.round(captureBounds.y + Number(selected.y || 0)),
      width: Math.max(1, Math.round(Number(selected.w || 0))),
      height: Math.max(1, Math.round(Number(selected.h || 0)))
    }
    if (selectionBounds.width < 80 || selectionBounds.height < 80) throw new Error('长截图选区至少需要 80 × 80 像素')

    closeLongCapture()
    const display = screen.getDisplayMatching(selectionBounds)
    const source = await getDesktopSourceForDisplay(display)
    assertManagedDataWritable()
    const settings = getSettings()
    const session = new LongCaptureSession({
      tempRoot: getLongCaptureTempRoot(),
      axis: settings.screenshot.longCaptureDirection
    })
    const overlayPagePath = path.join(rootDirectory, 'long-capture', 'overlay.html')
    const controllerPagePath = path.join(rootDirectory, 'long-capture', 'long-capture.html')
    const overlayWindow = createLocalWindow(overlayPagePath, {
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      focusable: false,
      resizable: false,
      movable: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-long-overlay.js'),
        backgroundThrottling: false
      }
    })
    const controllerBounds = placeLongCaptureController(display, selectionBounds)
    const controllerWindow = createLocalWindow(controllerPagePath, {
      ...controllerBounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-long-capture.js'),
        backgroundThrottling: false
      }
    })
    const init = {
      sourceId: source.id,
      displayBounds: display.bounds,
      selectionBounds,
      scaleFactor: display.scaleFactor || 1,
      settings
    }
    currentLongCapture = { session, overlayWindow, controllerWindow, init, closing: false, finishing: false, selectionEditing: false }
    overlayWindow._longCaptureRole = 'overlay'
    controllerWindow._longCaptureRole = 'controller'
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    controllerWindow.setContentProtection(true)
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    controllerWindow.setAlwaysOnTop(true, 'screen-saver')
    overlayWindow.on('closed', () => {
      if (currentLongCapture?.overlayWindow === overlayWindow) closeLongCapture()
    })
    controllerWindow.on('closed', () => {
      if (currentLongCapture?.controllerWindow === controllerWindow) closeLongCapture()
    })

    try {
      await Promise.all([
        overlayWindow.loadFile(overlayPagePath),
        controllerWindow.loadFile(controllerPagePath)
      ])
      if (captureWindow.isDestroyed() || currentLongCapture?.controllerWindow !== controllerWindow) throw new Error('长截图窗口初始化已取消')
      captureWindow.close()
      overlayWindow.showInactive()
      controllerWindow.show()
      controllerWindow.focus()
      return true
    } catch (error) {
      closeLongCapture()
      throw error
    }
  }

  async function finishLongCapture(action, fast = false) {
    const state = currentLongCapture
    if (!state || state.finishing) throw new Error('长截图会话不可用')
    state.finishing = true
    try {
      const size = state.session.getSize()
      const outputPath = await state.session.render()
      const meta = {
        source: 'long-capture',
        action,
        width: size.width,
        height: size.height,
        scaleFactor: state.init.scaleFactor,
        selectionBounds: state.init.selectionBounds,
        longCapture: true,
        axis: state.session.axis
      }
      if (action === 'save') {
        const settings = getSettings()
        const preferredDirectory = settings.screenshot.saveDirectory
        let filePath = ''
        if (fast && preferredDirectory) {
          ensureDirectory(preferredDirectory)
          filePath = path.join(preferredDirectory, makeCaptureName(LONG_CAPTURE_PREFIX))
        } else {
          const result = await dialog.showSaveDialog({
            title: '保存长截图',
            defaultPath: path.join(preferredDirectory || app.getPath('pictures'), makeCaptureName(LONG_CAPTURE_PREFIX)),
            filters: [{ name: 'PNG 图片', extensions: ['png'] }]
          })
          if (result.canceled || !result.filePath) {
            state.finishing = false
            return { canceled: true }
          }
          filePath = result.filePath
        }
        await fs.promises.copyFile(outputPath, filePath)
        await persistHistoryFile(outputPath, { ...meta, action: 'save' })
      } else {
        if (Math.max(size.width, size.height) > 65535 || size.width * size.height > 80000000) {
          throw new Error('长截图过大，当前仅支持保存为文件')
        }
        const image = nativeImage.createFromPath(outputPath)
        if (image.isEmpty()) throw new Error('长截图图片解码失败')
        if (action === 'copy') clipboard.writeImage(image)
        else if (action === 'pin') {
          pinDomain.createPinWindow(image.toDataURL(), meta)
        } else throw new Error('不支持的长截图操作')
        await persistHistoryFile(outputPath, meta)
      }
      setImmediate(closeLongCapture)
      return { ok: true }
    } catch (error) {
      state.finishing = false
      throw error
    }
  }

  function createLongCaptureController() {
    return {
      longReady: (event) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents) return
        event.sender.send('long-capture:init', state.init)
      },
      longOverlayReady: (event) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.overlayWindow.webContents) return
        event.sender.send('long-overlay:init', {
          displayBounds: state.init.displayBounds,
          selectionBounds: state.init.selectionBounds,
          mainColor: state.init.settings.mainColor
        })
      },
      longOverlayActive: (event, active) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents || state.overlayWindow.isDestroyed()) return
        state.overlayWindow.webContents.send('long-overlay:active', !!active)
      },
      longAddStrip: (event, { arrayBuffer, metadata } = {}) => {
        if (isMigrationInProgress?.()) throw new Error('数据目录正在迁移，请稍候')
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
        if (!state.session.strips.length && ['vertical', 'horizontal'].includes(metadata?.axis)) {
          state.session.axis = metadata.axis
          updateSettings({ screenshot: { longCaptureDirection: metadata.axis } })
        }
        return state.session.addStrip(Buffer.from(arrayBuffer), metadata)
      },
      longSetTrim: (event, { start, end } = {}) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
        return state.session.setTrim(start, end)
      },
      longSetSelectionEditing: (event, { enabled, axis, hasContent } = {}) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents || state.finishing) throw new Error('长截图会话不可用')
        return setLongOverlayEditing(state, enabled, axis, hasContent)
      },
      longOverlayBoundsChanged: (event, proposed = {}) => {
        const state = currentLongCapture
        if (!state || event.sender !== state.overlayWindow.webContents || !state.selectionEditing || state.finishing) return
        const display = state.init.displayBounds
        const previous = state.init.selectionBounds
        let next = {
          x: Math.round(Number(proposed.x) || display.x),
          y: Math.round(Number(proposed.y) || display.y),
          width: Math.max(80, Math.round(Number(proposed.width) || previous.width)),
          height: Math.max(80, Math.round(Number(proposed.height) || previous.height))
        }
        if (state.session.strips.length) {
          if (state.session.axis === 'vertical') next = { ...previous, y: next.y }
          else next = { ...previous, x: next.x }
        }
        next.width = Math.min(display.width, next.width)
        next.height = Math.min(display.height, next.height)
        next.x = Math.max(display.x, Math.min(display.x + display.width - next.width, next.x))
        next.y = Math.max(display.y, Math.min(display.y + display.height - next.height, next.y))
        state.init.selectionBounds = next
        if (!state.controllerWindow.isDestroyed()) state.controllerWindow.webContents.send('long-capture:selection-updated', next)
      },
      longFinish: (event, { action, fast } = {}) => {
        if (isMigrationInProgress?.()) throw new Error('数据目录正在迁移，请稍候')
        const state = currentLongCapture
        if (!state || event.sender !== state.controllerWindow.webContents) throw new Error('长截图会话不可用')
        const finishingPromise = finishLongCapture(action, fast)
        state.finishingPromise = finishingPromise
        return finishingPromise.finally(() => {
          if (state.finishingPromise === finishingPromise) state.finishingPromise = null
        })
      },
      longClose: (event) => {
        const state = currentLongCapture
        if (state && event.sender === state.controllerWindow.webContents) closeLongCapture()
      }
    }
  }

  async function shutdown() {
    const longCapture = currentLongCapture
    if (longCapture?.finishingPromise) {
      await longCapture.finishingPromise.catch((error) => log('Long capture shutdown failed:', error.message))
    }
    closeLongCapture()
  }

  return {
    isTaskActive,
    getState,
    ownsControllerWindow,
    ownsOverlayWindow,
    closeLongCapture,
    createLongCaptureFromSelection,
    finishLongCapture,
    createLongCaptureController,
    shutdown,
    setLongOverlayEditing
  }
}

module.exports = {
  createLongCaptureDomain
}
