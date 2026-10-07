const path = require('path')

class SelectionWindowManager {
  constructor({
    createWindow,
    rootDirectory,
    isWindows,
    nativeTheme,
    getSettings,
    updateSettings,
    toolbarWidth,
    toolbarHeight,
    actionMinWidth,
    actionMinHeight,
    sizeSaveDelayMs,
    onActionWindowClosed = () => {},
    onActionWindowBlur = () => {},
    log = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
    // A presentation check that fails twice in a row must not rebuild twice:
    // one selection may legitimately arrive while a rebuild is still settling.
    toolbarRebuildCooldownMs = 5000
  }) {
    if (typeof createWindow !== 'function') throw new TypeError('Selection windows require a window factory')
    if (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)) {
      throw new TypeError('Selection windows require an absolute application root')
    }
    this.createWindow = createWindow
    this.rootDirectory = rootDirectory
    this.isWindows = isWindows
    this.nativeTheme = nativeTheme
    this.getSettings = getSettings
    this.updateSettings = updateSettings
    this.toolbarWidth = toolbarWidth
    this.toolbarHeight = toolbarHeight
    this.actionMinWidth = actionMinWidth
    this.actionMinHeight = actionMinHeight
    this.sizeSaveDelayMs = sizeSaveDelayMs
    this.onActionWindowClosed = onActionWindowClosed
    this.onActionWindowBlur = onActionWindowBlur
    this.log = log
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.now = now
    this.toolbarRebuildCooldownMs = toolbarRebuildCooldownMs
    this.toolbarWindow = null
    this.actionWindow = null
    this.actionWindows = []
    this.lastToolbarPosition = null
    this.toolbarCreatedAt = 0
    this.lastToolbarRebuildAt = null
    this.lastPresentationFailureLogAt = null
    this.toolbarPresentationReport = null
  }

  isWindowHealthy(win) {
    if (!win || win.isDestroyed()) return false
    const contents = win.webContents
    if (!contents) return false
    try {
      if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return false
      if (typeof contents.isCrashed === 'function' && contents.isCrashed()) return false
    } catch {
      return false
    }
    return true
  }

  destroyUnavailableWindow(win, kind, reason) {
    if (!win || win.isDestroyed()) return false
    this.log(`Selection ${kind} window unavailable; recreating:`, reason)
    try {
      win.destroy()
      return true
    } catch (error) {
      this.log(`Failed to destroy selection ${kind} window:`, error.message || String(error))
      return false
    }
  }

  loadWindow(win, pagePath, kind) {
    let loadPromise
    try {
      loadPromise = win.loadFile(pagePath)
    } catch (error) {
      this.destroyUnavailableWindow(win, kind, `load failed: ${error.message || String(error)}`)
      return
    }
    Promise.resolve(loadPromise).catch((error) => {
      this.destroyUnavailableWindow(win, kind, `load failed: ${error.message || String(error)}`)
    })
  }

  handleRendererGone(win, details = {}) {
    const kind = this.ownsToolbarWindow(win)
      ? 'toolbar'
      : this.ownsActionWindow(win) ? 'action' : ''
    if (!kind) return false
    const reason = details.reason || 'unknown'
    const exitCode = Number.isInteger(details.exitCode) ? ` (${details.exitCode})` : ''
    this.destroyUnavailableWindow(win, kind, `renderer ${reason}${exitCode}`)
    return true
  }

  createToolbarWindow() {
    if (this.isWindowHealthy(this.toolbarWindow)) return this.toolbarWindow
    if (this.toolbarWindow) this.destroyUnavailableWindow(this.toolbarWindow, 'toolbar', 'failed health check')
    const pagePath = path.join(this.rootDirectory, 'toolbar', 'toolbar.html')
    const win = this.createWindow(pagePath, {
      width: this.toolbarWidth,
      height: this.toolbarHeight,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: !this.isWindows,
      show: false,
      resizable: false,
      webPreferences: { preload: path.join(this.rootDirectory, 'preload-toolbar.js') }
    })
    this.toolbarWindow = win
    this.toolbarCreatedAt = this.now()
    this.toolbarPresentationReport = null
    win._toolbarRendererReady = false
    win._pendingToolbarSelection = null
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.once('did-finish-load', () => {
      if (this.toolbarWindow !== win || !this.isWindowHealthy(win)) return
      win._toolbarRendererReady = true
      win.webContents.send('toolbar:appearance', this.getAppearance())
      const pending = win._pendingToolbarSelection
      win._pendingToolbarSelection = null
      if (pending) win.webContents.send('selection:text', pending)
    })
    win.on('closed', () => {
      if (this.toolbarWindow !== win) return
      this.toolbarWindow = null
      this.toolbarCreatedAt = 0
      this.toolbarPresentationReport = null
    })
    this.loadWindow(win, pagePath, 'toolbar')
    return win
  }

  createActionWindow() {
    const appearance = this.getAppearance()
    const size = this.getSettings().selectionToolbar.resultWindow
    const pagePath = path.join(this.rootDirectory, 'action', 'action.html')
    const win = this.createWindow(pagePath, {
      width: size.width,
      height: size.height,
      minWidth: this.actionMinWidth,
      minHeight: this.actionMinHeight,
      title: 'Highlighter',
      autoHideMenuBar: true,
      backgroundColor: appearance.resolvedTheme === 'dark' ? '#121316' : '#f5f5f5',
      webPreferences: { preload: path.join(this.rootDirectory, 'preload-action.js') }
    })
    win._isPinned = false
    win._actionRendererReady = false
    win._pendingActionMessages = []
    win.webContents.once('did-finish-load', () => this.flushActionMessages(win))
    win.on('resize', () => this.scheduleActionWindowSizeSave(win))
    win.on('close', () => this.flushActionWindowSizeSave(win))
    this.actionWindows.push(win)
    win.on('closed', () => {
      this.clearTimer(win._actionWindowSizeSaveTimer)
      win._actionWindowSizeSaveTimer = null
      const index = this.actionWindows.indexOf(win)
      if (index >= 0) this.actionWindows.splice(index, 1)
      if (this.actionWindow === win) this.actionWindow = null
      this.onActionWindowClosed(win, { wasPinned: win._isPinned === true })
    })
    win.on('blur', () => {
      if (win._isPinned || win.isDestroyed()) return
      this.onActionWindowBlur(win)
      this.flushActionWindowSizeSave(win)
      win.hide()
    })
    this.actionWindow = win
    this.loadWindow(win, pagePath, 'action')
    return win
  }

  getOrCreateActionWindow() {
    if (this.actionWindow) {
      if (!this.isWindowHealthy(this.actionWindow)) {
        this.destroyUnavailableWindow(this.actionWindow, 'action', 'failed health check')
      } else if (!this.actionWindow._isPinned) {
        return this.actionWindow
      }
    }
    return this.createActionWindow()
  }

  // Unlike getOrCreateActionWindow this never opens a new window: the tray entry
  // that brings a hidden conversation back must not create an empty one.
  getActionWindow() {
    if (!this.actionWindow) return null
    return this.isWindowHealthy(this.actionWindow) ? this.actionWindow : null
  }

  showActionWindow() {
    const win = this.getActionWindow()
    if (!win) return false
    win.show()
    win.focus()
    return true
  }

  queueActionMessage(win, channel, payload) {
    if (!win || win.isDestroyed()) return
    if (win._actionRendererReady) {
      win.webContents.send(channel, payload)
      return
    }
    win._pendingActionMessages.push([channel, payload])
  }

  flushActionMessages(win) {
    if (!win || win.isDestroyed()) return
    win._actionRendererReady = true
    const pending = win._pendingActionMessages
    win._pendingActionMessages = []
    for (const [channel, payload] of pending) win.webContents.send(channel, payload)
  }

  queueToolbarSelection(win, payload) {
    if (!win || win.isDestroyed()) return
    if (win._toolbarRendererReady) {
      win.webContents.send('selection:text', payload)
      return
    }
    win._pendingToolbarSelection = payload
  }

  persistActionWindowSize(win) {
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getSize()
    const current = this.getSettings().selectionToolbar.resultWindow
    if (width === current.width && height === current.height) return
    try {
      this.updateSettings({ selectionToolbar: { resultWindow: { width, height } } })
    } catch (error) {
      this.log('Failed to save selection result window size:', error.message || String(error))
    }
  }

  scheduleActionWindowSizeSave(win) {
    this.clearTimer(win._actionWindowSizeSaveTimer)
    win._actionWindowSizeSaveTimer = this.setTimer(() => {
      win._actionWindowSizeSaveTimer = null
      this.persistActionWindowSize(win)
    }, this.sizeSaveDelayMs)
  }

  flushActionWindowSizeSave(win) {
    this.clearTimer(win?._actionWindowSizeSaveTimer)
    if (win) win._actionWindowSizeSaveTimer = null
    this.persistActionWindowSize(win)
  }

  getAppearance(settings = this.getSettings()) {
    const theme = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
    const resolvedTheme = theme === 'system'
      ? (this.nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : theme
    const mainColor = /^#[0-9a-f]{6}$/i.test(settings.mainColor || '')
      ? settings.mainColor
      : '#e5a44c'
    return { theme, resolvedTheme, mainColor }
  }

  broadcastAppearance(settings = this.getSettings()) {
    const appearance = this.getAppearance(settings)
    if (this.isWindowHealthy(this.toolbarWindow)) {
      this.toolbarWindow.webContents.send('toolbar:appearance', appearance)
    }
    for (const win of this.actionWindows) {
      if (this.isWindowHealthy(win)) win.webContents.send('action:appearance', appearance)
    }
  }

  showToolbarSelection({ text, actions, position, width }) {
    const payload = { text, actions, appearance: this.getAppearance() }
    let win = this.createToolbarWindow()
    this.applyToolbarGeometry(win, position, width)
    win.showInactive()
    this.queueToolbarSelection(win, payload)
    const report = this.inspectToolbarPresentation(win, { width, height: this.toolbarHeight })
    this.toolbarPresentationReport = report
    if (!report.ok) {
      this.logPresentationFailure(report)
      // One rebuild per show, and never two rebuilds inside the cooldown: a
      // window that still fails afterwards is reported rather than recreated
      // in a loop.
      if (this.canRebuildToolbar()) {
        win = this.rebuildToolbarWindow(`presentation:${report.reason}`)
        this.applyToolbarGeometry(win, position, width)
        win.showInactive()
        this.queueToolbarSelection(win, payload)
        this.toolbarPresentationReport = { ...report, rebuilt: true }
      }
    }
    return win
  }

  applyToolbarGeometry(win, position, width) {
    win.setSize(width, this.toolbarHeight)
    this.lastToolbarPosition = position
    win.setPosition(position.x, position.y)
  }

  /**
   * Best-effort presentation check.
   *
   * The failure this guards against (2026-10-07) cannot be detected directly:
   * the window was WS_VISIBLE, TOPMOST, uncloaked and its renderer painted, yet
   * nothing reached the display. What it *did* expose was a native size that no
   * longer matched what the code set, so the size is compared here too. Every
   * signal is optional: an unknown signal (a fake window in tests, a method that
   * is missing) must not report a failure it cannot prove.
   */
  inspectToolbarPresentation(win, { width, height, tolerance = 2 } = {}) {
    const report = {
      ok: true,
      reason: '',
      requestedSize: [width, height],
      actualSize: null,
      visible: null,
      crashed: false,
      ageMs: this.toolbarCreatedAt ? Math.max(0, this.now() - this.toolbarCreatedAt) : 0,
      rebuilt: false
    }
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      return { ...report, ok: false, reason: 'destroyed' }
    }
    try {
      if (typeof win.isVisible === 'function') report.visible = win.isVisible() === true
    } catch {
      report.visible = null
    }
    try {
      if (typeof win.webContents?.isCrashed === 'function') report.crashed = win.webContents.isCrashed() === true
    } catch {
      report.crashed = false
    }
    try {
      if (typeof win.getSize === 'function') {
        const size = win.getSize()
        if (Array.isArray(size) && size.length === 2 && size.every(Number.isFinite)) report.actualSize = [size[0], size[1]]
      }
    } catch {
      report.actualSize = null
    }
    if (report.visible === false) return { ...report, ok: false, reason: 'not-visible' }
    if (report.crashed) return { ...report, ok: false, reason: 'renderer-crashed' }
    if (report.actualSize
      && (Math.abs(report.actualSize[0] - width) > tolerance || Math.abs(report.actualSize[1] - height) > tolerance)) {
      return { ...report, ok: false, reason: 'size-mismatch' }
    }
    return report
  }

  logPresentationFailure(report) {
    if (this.lastPresentationFailureLogAt !== null
      && this.now() - this.lastPresentationFailureLogAt < this.toolbarRebuildCooldownMs) return
    this.lastPresentationFailureLogAt = this.now()
    this.log('Selection toolbar presentation check failed:', report)
  }

  canRebuildToolbar() {
    if (this.lastToolbarRebuildAt === null) return true
    return this.now() - this.lastToolbarRebuildAt >= this.toolbarRebuildCooldownMs
  }

  rebuildToolbarWindow(reason) {
    this.lastToolbarRebuildAt = this.now()
    this.destroyUnavailableWindow(this.toolbarWindow, 'toolbar', reason)
    return this.createToolbarWindow()
  }

  /**
   * Drop the cached toolbar window without waiting for a crash.
   *
   * The window is normally created once at startup and reused for the rest of
   * the session. Events that can invalidate its compositor surface (session
   * unlock, display changes, a restarted GPU process) therefore recycle it so
   * the next selection builds a fresh one. `lastToolbarPosition` is kept: the
   * rebuilt window still belongs at the last anchor.
   */
  recycleToolbarWindow(reason = 'recycle') {
    const win = this.toolbarWindow
    this.toolbarWindow = null
    this.toolbarCreatedAt = 0
    this.toolbarPresentationReport = null
    if (!win) return false
    this.log('Selection toolbar window recycled:', reason)
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return true
    try {
      win.destroy()
    } catch (error) {
      this.log('Failed to recycle selection toolbar window:', error.message || String(error))
    }
    return true
  }

  getToolbarPresentationReport() {
    return this.toolbarPresentationReport
  }

  positionActionWindow(win, screen) {
    if (!this.lastToolbarPosition) return false
    const workArea = screen.getDisplayNearestPoint(this.lastToolbarPosition).workArea
    const [width, height] = win.getSize()
    const x = Math.round(Math.max(
      workArea.x,
      Math.min(this.lastToolbarPosition.x - width / 2, workArea.x + workArea.width - width)
    ))
    let y = this.lastToolbarPosition.y + 48
    if (y + height > workArea.y + workArea.height) y = this.lastToolbarPosition.y - height - 12
    win.setPosition(x, Math.round(Math.max(workArea.y, y)))
    return true
  }

  hideToolbar() {
    if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) this.toolbarWindow.hide()
  }

  getToolbarWindow() {
    return this.toolbarWindow
  }

  ownsToolbarWindow(win) {
    return !!win && win === this.toolbarWindow
  }

  ownsActionWindow(win) {
    return this.actionWindows.includes(win)
  }
}

module.exports = { SelectionWindowManager }
