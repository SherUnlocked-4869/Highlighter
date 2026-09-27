'use strict'

// The shortcut/tray/IPC feature entry point. Each name maps to one handler, so
// the dispatcher is a lookup rather than a growing switch; the ownership of the
// actual work stays in the domains, which arrive injected along with the shell
// and settings accessors this layer needs.
function createFunctionRouter(deps) {
  const {
    app,
    clipboard,
    dialog,
    nativeImage,
    screen,
    shell,
    captureDomain,
    pinDomain,
    recordDomain,
    searchDomain,
    selectionDomain,
    getMainWindow,
    createMainWindow,
    getSettings,
    persistHistory,
    assertGameModeDisabled,
    log
  } = deps

  function createCapture(options) {
    return captureDomain.createCaptureWindow(options).then(() => true)
  }

  const handlers = {
    screenshot: () => createCapture({ mode: 'region', source: 'region' }),
    screenshotDelay(payload) {
      const seconds = Math.max(0, Number(payload.seconds ?? 3))
      setTimeout(() => captureDomain.createCaptureWindow({ mode: 'region', source: 'delay' }).catch((error) => log(error.message)), seconds * 1000)
      return { scheduled: true, seconds }
    },
    screenshotFixed: () => createCapture({ mode: 'region', autoAction: 'pin', source: 'fixed' }),
    screenshotOcr: () => createCapture({ mode: 'region', autoAction: 'ocr', source: 'ocr' }),
    screenshotTable: () => createCapture({ mode: 'region', autoAction: 'table', source: 'table' }),
    screenshotQr: () => createCapture({ mode: 'region', autoAction: 'qr', source: 'qr' }),
    screenshotOcrTranslate: () => createCapture({ mode: 'region', autoAction: 'translate', source: 'ocr-translate' }),
    screenshotCopy: () => createCapture({ mode: 'region', autoAction: 'copy', source: 'copy' }),
    screenshotLong: () => createCapture({ mode: 'region', autoAction: 'long', source: 'long-capture' }),
    screenshotFullScreen: (payload) => createCapture({
      mode: 'fullscreen',
      autoAction: payload.save ? 'save' : 'copy',
      source: 'fullscreen'
    }),
    async screenshotFocusedWindow() {
      const dataUrl = await captureDomain.captureFocusedWindow()
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
      persistHistory(dataUrl, { action: 'copy', source: 'focused-window' })
      return true
    },
    async fixedContent() {
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] })
      if (result.canceled || !result.filePaths[0]) return false
      const image = nativeImage.createFromPath(result.filePaths[0])
      const dataUrl = image.toDataURL()
      pinDomain.createPinWindow(dataUrl, { source: 'file' })
      persistHistory(dataUrl, { source: 'file', action: 'pin' })
      return true
    },
    async videoRecord() {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      await recordDomain.createRecordWindow({ display, selectionBounds: display.bounds })
      return true
    },
    fullScreenDraw: () => createCapture({ mode: 'canvas', source: 'canvas' }),
    async toggleFixedContentVisibility() {
      pinDomain.togglePinVisibility()
      return true
    },
    async showOrHideMainWindow() {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
      else createMainWindow('home')
      return true
    },
    async openImageSaveFolder() {
      const directory = getSettings().screenshot.saveDirectory || app.getPath('pictures')
      await shell.openPath(directory)
      return true
    },
    async openCaptureHistory() {
      createMainWindow('history')
      return true
    },
    async localSearch() {
      searchDomain.createSearchWindow()
      return true
    },
    async translation() {
      createMainWindow('translation')
      return true
    },
    async chat() {
      createMainWindow('chat')
      return true
    },
    async explainClipboard() {
      // Read-only clipboard path: never write or empty the clipboard.
      const text = String(clipboard.readText() || '').trim()
      if (!text) return false
      if (text.length > 10000) {
        log('Explain clipboard skipped: text too long', text.length)
        return false
      }
      selectionDomain.hideToolbar()
      return selectionDomain.openToolbarAiAction('explain', text)
    }
  }

  async function executeFunction(name, payload = {}) {
    assertGameModeDisabled()
    // hasOwn, not truthiness: the table is a plain object, so a name such as
    // "toString" would otherwise resolve to Object.prototype and silently
    // succeed instead of reporting an unknown feature.
    if (!Object.hasOwn(handlers, name)) throw new Error(`未知功能：${name}`)
    return handlers[name](payload)
  }

  return {
    executeFunction,
    functionNames: () => Object.keys(handlers)
  }
}

module.exports = {
  createFunctionRouter
}
