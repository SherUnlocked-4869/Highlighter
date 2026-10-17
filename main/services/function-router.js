'use strict'

const { resolveSaveDirectory } = require('./image-file-save')
// P0-1-T6: the image-picker filter label is rendered by the OS dialog, so it is
// UI copy. The "unknown feature" error below is deliberately untouched: decision
// D6 keeps every main-process error message out of this release, and
// test/function-router.test.js asserts on its Chinese text.
const { t } = require('./i18n-bootstrap')

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
    // Injected as a getter because the pin domain is assembled after the
    // router; the click-through fallback entry (P0-6-T4) is its only consumer.
    getPinDomain,
    // Same lazy-getter reason as getPinDomain: the proxy bridge controller is
    // assembled after the router, and the tray keeps a direct reference of its own.
    getProxyBridge,
    getSettings,
    persistHistory,
    assertGameModeDisabled,
    log
  } = deps

  function createCapture(options) {
    return captureDomain.createCaptureWindow(options).then(() => true)
  }

  const handlers = {
    openClipboardHistory: () => deps.getClipboardDomain?.()?.show() || false,
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
    // P0-7-T3: the two save shortcuts preset the save intent of the capture they
    // open. `saveMode` reaches the renderer through `capture:init` (P0-7-T4,
    // S9a) and decides fast-save vs the save dialog there; `autoAction: 'save'`
    // is the same convention `screenshotFullScreen({ save: true })` uses.
    screenshotQuickSave: () => createCapture({ mode: 'region', autoAction: 'save', saveMode: 'fast', source: 'quick-save' }),
    screenshotSaveAs: () => createCapture({ mode: 'region', autoAction: 'save', saveMode: 'dialog', source: 'save-as' }),
    async screenshotFocusedWindow() {
      const dataUrl = await captureDomain.captureFocusedWindow()
      clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
      persistHistory(dataUrl, { action: 'copy', source: 'focused-window' })
      return true
    },
    async fixedContent() {
      const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: t('main.dialog.image-filter'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] })
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
    // P0-6-T4: a pin in click-through mode receives no clicks and Esc is
    // unreliable, so this bulk exit is the mandatory recovery path (up to 20
    // pins). The count of pins that left click-through is passed through; a pin
    // domain that does not expose the interface yet degrades to 0 with one log
    // line instead of throwing inside a global-shortcut callback.
    async togglePinClickThrough() {
      const domain = typeof getPinDomain === 'function' ? getPinDomain() : null
      if (!domain || typeof domain.exitAllClickThrough !== 'function') {
        log('Click-through exit unavailable: pin domain does not expose exitAllClickThrough')
        return 0
      }
      const exited = await domain.exitAllClickThrough()
      return Number.isFinite(exited) ? exited : 0
    },
    async showOrHideMainWindow() {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide()
      else createMainWindow('home')
      return true
    },
    async openImageSaveFolder() {
      // Matches where a screenshot actually lands: the remembered directory
      // (P0-7B) wins over the configured one.
      const directory = resolveSaveDirectory(getSettings()) || app.getPath('pictures')
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
    // Shortcut/IPC entry for the tray's proxy checkbox. The controller owns the
    // failure copy and the tray refresh, so this stays a two-line delegation.
    // Game mode still refuses it (executeFunction asserts that above), which is
    // fine: the tray entry is the always-available path, exactly like the
    // click-through exit.
    async toggleTranslationProxy() {
      const bridge = typeof getProxyBridge === 'function' ? getProxyBridge() : null
      if (!bridge) {
        log('Translation proxy toggle unavailable: proxy bridge controller is missing')
        return false
      }
      const status = await bridge.setEnabled(bridge.getStatus().running !== true)
      return status.running === true
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
