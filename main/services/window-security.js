const path = require('path')
const { fileURLToPath } = require('url')

const LOCKED_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false
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

function normalizeFileTarget(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'file:') return null
    const normalized = path.resolve(fileURLToPath(url))
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  } catch {
    return null
  }
}

function normalizeAllowedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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

function reportBlocked(onBlocked, url, reason, error) {
  if (typeof onBlocked !== 'function') return
  onBlocked({
    url: summarizeUrl(url),
    reason,
    error: error ? (error.message || String(error)) : ''
  })
}

function handOffExternalUrl(url, openExternal, onBlocked) {
  if (!isSafeExternalUrl(url) || typeof openExternal !== 'function') {
    reportBlocked(onBlocked, url, 'blocked-url')
    return
  }
  Promise.resolve()
    .then(() => openExternal(url))
    .catch((error) => reportBlocked(onBlocked, url, 'external-open-failed', error))
}

function installWindowSecurity(win, {
  allowedFilePaths,
  openExternal,
  onBlocked
} = {}) {
  if (!win?.webContents) throw new TypeError('A BrowserWindow with webContents is required')
  const allowed = Array.isArray(allowedFilePaths) ? allowedFilePaths.filter(Boolean) : []
  if (!allowed.length || allowed.some((filePath) => !normalizeAllowedPath(filePath))) {
    throw new TypeError('At least one absolute local page path is required')
  }

  const handleNavigation = (event, url) => {
    if (isAllowedLocalUrl(url, allowed)) return
    event.preventDefault()
    handOffExternalUrl(url, openExternal, onBlocked)
  }

  win.webContents.on('will-navigate', handleNavigation)
  win.webContents.on('will-redirect', handleNavigation)
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault()
    reportBlocked(onBlocked, params?.src, 'blocked-webview')
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    handOffExternalUrl(url, openExternal, onBlocked)
    return { action: 'deny' }
  })
  return win
}

function createSecureWindow({
  BrowserWindow,
  pagePath,
  options = {},
  openExternal,
  onBlocked
}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow constructor is required')
  if (!normalizeAllowedPath(pagePath)) throw new TypeError('An absolute local page path is required')
  const { webPreferences = {}, ...windowOptions } = options
  const win = new BrowserWindow({
    ...windowOptions,
    webPreferences: createSecureWebPreferences(webPreferences)
  })
  installWindowSecurity(win, {
    allowedFilePaths: [pagePath],
    openExternal,
    onBlocked
  })
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
