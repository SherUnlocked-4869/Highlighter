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
    clearTimer = clearTimeout
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
    this.toolbarWindow = null
    this.actionWindow = null
    this.actionWindows = []
    this.lastToolbarPosition = null
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
      if (this.toolbarWindow === win) this.toolbarWindow = null
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
      : '#1677ff'
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
    const win = this.createToolbarWindow()
    win.setSize(width, this.toolbarHeight)
    this.lastToolbarPosition = position
    win.setPosition(position.x, position.y)
    win.showInactive()
    this.queueToolbarSelection(win, { text, actions, appearance: this.getAppearance() })
    return win
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
