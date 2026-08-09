const path = require('path')
const { fileURLToPath } = require('url')

const LOCKED_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false
})

const secureWindowRegistrations = new WeakMap()

function createSecureWebPreferences(webPreferences = {}) {
  const preload = webPreferences.preload
  if (typeof preload !== 'string' || !path.isAbsolute(preload)) {
    throw new TypeError('Secure windows require an absolute preload path')
  }
  return {
    ...webPreferences,
    preload,
    ...LOCKED_WEB_PREFERENCES
  }
}

function normalizeAllowedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeFileTarget(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'file:') return null
    return normalizeAllowedPath(fileURLToPath(url))
  } catch {
    return null
  }
}

function isAllowedLocalUrl(value, allowedFilePaths) {
  const target = normalizeFileTarget(value)
  if (!target) return false
  return allowedFilePaths.some((allowedPath) => normalizeAllowedPath(allowedPath) === target)
}

function isSafeExternalUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(String(value || '')).protocol)
  } catch {
    return false
  }
}

function summarizeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol === 'file:') return 'file://<blocked>'
    if (['http:', 'https:'].includes(url.protocol)) return `${url.origin}${url.pathname}`
    return `${url.protocol}<blocked>`
  } catch {
    return '<invalid-url>'
  }
}

function reportBlocked(onBlocked, url, reason) {
  if (typeof onBlocked !== 'function') return
  onBlocked({ url: summarizeUrl(url), reason })
}

function installWindowSecurity(win, { allowedFilePaths, onBlocked } = {}) {
  if (!win?.webContents) throw new TypeError('A BrowserWindow with webContents is required')
  const allowed = Array.isArray(allowedFilePaths) ? allowedFilePaths.filter(Boolean) : []
  if (!allowed.length || allowed.some((filePath) => !normalizeAllowedPath(filePath))) {
    throw new TypeError('At least one absolute local page path is required')
  }

  const handleNavigation = (event, url) => {
    if (isAllowedLocalUrl(url, allowed)) return
    event.preventDefault()
    reportBlocked(onBlocked, url, 'blocked-navigation')
  }

  win.webContents.on('will-navigate', handleNavigation)
  win.webContents.on('will-redirect', handleNavigation)
  win.webContents.on('will-attach-webview', (event, _webPreferences, params) => {
    event.preventDefault()
    reportBlocked(onBlocked, params?.src, 'blocked-webview')
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    reportBlocked(onBlocked, url, 'blocked-window-open')
    return { action: 'deny' }
  })
  return win
}

function createSecureWindow({ BrowserWindow, pagePath, options = {}, onBlocked }) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow constructor is required')
  if (!normalizeAllowedPath(pagePath)) throw new TypeError('An absolute local page path is required')
  const { webPreferences = {}, ...windowOptions } = options
  const win = new BrowserWindow({
    ...windowOptions,
    webPreferences: createSecureWebPreferences(webPreferences)
  })
  installWindowSecurity(win, { allowedFilePaths: [pagePath], onBlocked })
  secureWindowRegistrations.set(win.webContents, {
    window: win,
    pagePath: normalizeAllowedPath(pagePath)
  })
  return win
}

function getSecureWindowRegistration(webContents) {
  return webContents && typeof webContents === 'object'
    ? secureWindowRegistrations.get(webContents) || null
    : null
}

module.exports = {
  LOCKED_WEB_PREFERENCES,
  createSecureWebPreferences,
  createSecureWindow,
  getSecureWindowRegistration,
  installWindowSecurity,
  isAllowedLocalUrl,
  isSafeExternalUrl
}
