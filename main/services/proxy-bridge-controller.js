'use strict'

// Presentation policy for the tray's translation-proxy toggle.
//
// main.js stays assembly-only (scripts/check-architecture.js enforces a line
// ceiling), so "what a failed toggle looks like" lives here, where it can be
// unit-tested with a fake dialog instead of only on a real machine.

const { createTranslationProxyService } = require('./translation-proxy-service')

// Error code -> locale key. The codes come from translation-proxy-service.js and
// the copy lives in shared/locales/main.js, so this module carries no UI text of
// its own (decision D6 + the check-i18n budget).
const ERROR_KEYS = Object.freeze({
  'port-in-use': 'main.proxy.port-in-use',
  'listen-failed': 'main.proxy.listen-failed',
  'upstream-invalid': 'main.proxy.upstream-invalid'
})

function createProxyBridgeController(deps = {}) {
  const {
    getSettings = () => ({}),
    log = () => {},
    t = (key) => key,
    dialog = null,
    createTrayIcon = () => {},
    getMainWindow = () => null,
    // Main -> renderer push channel. Like `i18n:language` it is deliberately
    // absent from IPC_SURFACES: it carries no renderer-supplied arguments.
    statusChannel = 'proxy:status',
    service = null
  } = deps

  const proxy = service || createTranslationProxyService({
    getSettings,
    log,
    // The tray template is a snapshot, so every state change has to rebuild it or
    // the checkbox keeps showing the previous value.
    onChange: () => {
      refreshTray()
      broadcast()
    }
  })

  // A tray rebuild failure must not turn a successful start into a rejected
  // promise: the click handler in main.js does not await this controller.
  function refreshTray() {
    try {
      createTrayIcon()
    } catch (error) {
      log('Translation proxy tray refresh failed:', error.message)
    }
  }

  function getStatus(override) {
    return proxy.getStatus(override)
  }

  // `override` is the settings snapshot the tray already read, so a menu rebuild
  // does not trigger a second SettingsService read.
  function menuState(override) {
    const status = getStatus(override)
    return { running: status.running, busy: status.busy }
  }

  // The settings page listens for this so an open card follows a tray toggle
  // instead of going stale until the next re-render.
  function broadcast() {
    const win = getMainWindow()
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.()) return false
    try {
      win.webContents.send(statusChannel, getStatus())
      return true
    } catch (error) {
      log('Translation proxy status broadcast failed:', error.message)
      return false
    }
  }

  function describe(error) {
    const key = ERROR_KEYS[error?.code] || 'main.proxy.unavailable'
    const detail = [t(key), error?.message].filter(Boolean).join('\n\n')
    return { message: t('main.proxy.toggle-failed'), detail }
  }

  function report(error) {
    log('Translation proxy toggle failed:', error?.code || '', error?.message || error)
    const copy = describe(error)
    if (!dialog || typeof dialog.showMessageBox !== 'function') return copy
    // showMessageBox rather than showErrorBox: a modal error box on a tray action
    // is hostile, and by this point the entry is already back in a usable state.
    Promise.resolve(dialog.showMessageBox({ type: 'warning', message: copy.message, detail: copy.detail }))
      .catch((failure) => log('Translation proxy dialog failed:', failure.message))
    return copy
  }

  // Never rejects: the tray click cannot await, and every failure has already been
  // reported to the user by the time this settles.
  function setEnabled(enabled) {
    const action = enabled === true ? proxy.start() : proxy.stop()
    return action
      .catch((error) => {
        report(error)
        return getStatus()
      })
      .finally(() => refreshTray())
  }

  // Reconcile the reported state with the actual listener (the relay is
  // in-process, so this only catches a server that died unexpectedly).
  function refresh() {
    return proxy.refresh().catch((error) => {
      log('Translation proxy refresh failed:', error.message)
      return getStatus()
    })
  }

  // Opt-in on purpose (settings.proxy.autoStart defaults to false), so a plain
  // `npm start`, a test run or CI never opens a listening socket behind the
  // operator's back.
  function startIfConfigured() {
    if (getSettings()?.proxy?.autoStart !== true) return Promise.resolve(getStatus())
    return setEnabled(true)
  }

  // The relay lives in this process, so quitting the app always closes it; there
  // is nothing to opt out of and nothing to adopt on the next launch.
  function dispose() {
    return proxy.dispose()
  }

  return {
    service: proxy,
    getStatus,
    menuState,
    setEnabled,
    refresh,
    startIfConfigured,
    broadcast,
    dispose
  }
}

module.exports = {
  createProxyBridgeController,
  ERROR_KEYS
}
