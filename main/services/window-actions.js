'use strict'

// Window- and shell-level actions that used to be inlined in main.js: opening an
// external URL, the display-diagnostics snapshot, the directory pickers, the
// "open this folder" entries and the e2e-only window placement.
//
// Every Electron handle is injected (no `require('electron')` at module scope),
// so this stays unit-testable outside Electron — the repo rule for main/services.
//
// Behaviour is byte-identical to the previous main.js block. Notes on the two
// deps that are providers rather than handles:
//   getDataRoot        the active data root, or userData before the portable
//                      bootstrap picked one. main.js keeps that expression.
//   isAutomationEnabled  the e2e flag; positionAutomationWindow is a no-op
//                      outside an e2e run, exactly as before.
// `log` is accepted for symmetry with the other service factories (window-actions
// never logged before, so nothing here changed to start logging).

const { isSafeExternalUrl } = require('./window-security')
const { resolveSaveDirectory } = require('./image-file-save')

function createWindowActions({
  app,
  shell,
  screen,
  desktopCapturer,
  dialog,
  isWin = process.platform === 'win32',
  getSettings = () => ({}),
  getDataRoot = () => app.getPath('userData'),
  isAutomationEnabled = () => false,
  log = () => {}
} = {}) {
  function openExternal(value) {
    if (!isSafeExternalUrl(value)) throw new Error('仅支持打开 HTTP 或 HTTPS 链接')
    return shell.openExternal(new URL(String(value)).toString())
  }

  async function getDisplayDiagnostics() {
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label,
      bounds: display.bounds,
      workArea: display.workArea,
      size: display.size,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal,
      physicalBounds: isWin ? screen.dipToScreenRect(null, display.bounds) : display.bounds
    }))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 4096, height: 4096 } })
    return {
      cursor: screen.getCursorScreenPoint(),
      displays,
      sources: sources.map((source) => ({ id: source.id, displayId: source.display_id, name: source.name, thumbnailSize: source.thumbnail.getSize() }))
    }
  }

  async function chooseDirectory() {
    return pickDirectory()
  }

  async function pickDirectory(options = {}) {
    const result = await dialog.showOpenDialog({
      ...(options.title ? { title: options.title } : {}),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? '' : result.filePaths[0]
  }

  function openDataDirectory() {
    return shell.openPath(getDataRoot())
  }

  function openSaveDirectory() {
    return shell.openPath(resolveSaveDirectory(getSettings()) || app.getPath('pictures'))
  }

  // e2e only: centre a window on the secondary display so a visible automation
  // window never covers the primary one. Returns false when the run is not an
  // e2e run, the window is gone, or there is no secondary display.
  function positionAutomationWindow(win) {
    if (!isAutomationEnabled() || !win || win.isDestroyed()) return false
    const primary = screen.getPrimaryDisplay()
    const secondary = screen.getAllDisplays().find((display) => display.id !== primary.id)
    if (!secondary) return false
    const [width, height] = win.getSize()
    const area = secondary.workArea
    win.setPosition(
      Math.round(area.x + Math.max(0, (area.width - width) / 2)),
      Math.round(area.y + Math.max(0, (area.height - height) / 2)),
      false
    )
    return true
  }

  return {
    openExternal,
    getDisplayDiagnostics,
    chooseDirectory,
    pickDirectory,
    openDataDirectory,
    openSaveDirectory,
    positionAutomationWindow
  }
}

module.exports = { createWindowActions }
