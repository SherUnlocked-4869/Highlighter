'use strict'
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ClipboardService } = require('../../services/clipboard-service')
const { registerClipboardIpc } = require('../../ipc/clipboard-ipc')
const { t } = require('../../services/i18n-bootstrap')

function createClipboardDomain({ app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor, ipcMain, rootDirectory, directory, getSettings, updateSettings, getHook, createLocalWindow, positionAutomationWindow, isGameModeEnabled, isMigrationInProgress, automation = false }) {
  const executable = path.join(app.isPackaged ? process.resourcesPath : rootDirectory, 'native', 'clipboard', ...(app.isPackaged ? [] : ['bin']), 'HighlighterClipboard.exe')
  const service = new ClipboardService({ executable, directory, getHook })
  let win = null; let generation = null; let releaseTimer = null; let panelSession = null
  let confirmationOpen = false; let readyToShow = false; let disposed = false
  let wantsVisible = false
  const tokens = new Map(); const clearTokens = new Map(); const powerListeners = []
  const ownsWindow = (target) => target != null && target === win
  function send(channel, value) { if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send(channel, value) }
  function revokePreviews() { tokens.clear() }
  service.on('status', (value) => send('clipboard:status-changed', value))
  service.on('history', (value) => { revokePreviews(); send('clipboard:history-changed', value) })
  function appearance() {
    const settings = getSettings()
    return { language: settings.language, dark: settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors), mainColor: settings.mainColor, generation, status: service.snapshot() }
  }
  function release() {
    clearTimeout(releaseTimer); releaseTimer = null; revokePreviews(); clearTokens.clear()
    const previous = win; win = null; generation = null; readyToShow = false; wantsVisible = false
    if (previous && !previous.isDestroyed()) previous.destroy()
    if (panelSession) { panelSession.protocol.unhandle('highlighter-clipboard'); panelSession = null }
  }
  function hide() {
    wantsVisible = false
    if (!win || win.isDestroyed()) return
    win.webContents.send('clipboard:hidden'); win.hide(); revokePreviews(); clearTokens.clear()
    clearTimeout(releaseTimer)
    const timeout = getSettings().clipboard.releaseAfterMs
    if (!timeout) release()
    else { releaseTimer = setTimeout(release, timeout); releaseTimer.unref?.() }
  }
  async function handleResource(request) {
    const fail = () => new Response(null, { status: 404 })
    let url
    try { url = new URL(request.url) } catch { return fail() }
    if (request.method !== 'GET' || url.hostname !== 'preview' || url.search || url.hash) return fail()
    const token = tokens.get(url.pathname.slice(1))
    if (!token || token.generation !== generation || token.expires < Date.now() || !win?.isVisible() || win.webContents.id !== token.owner) return fail()
    try {
      const { bytes, value } = await service.command('thumbnail', { id: token.id })
      if (!tokens.has(url.pathname.slice(1)) || token.generation !== generation || !win?.isVisible() || value.mime !== 'image/png' || value.byteLength !== bytes.length || bytes.length > 256 * 1024) return fail()
      return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } })
    } catch { return fail() }
  }
  function show() {
    if (disposed || isMigrationInProgress() || isGameModeEnabled()) return false
    if (!getSettings().clipboard.enabled) return false
    clearTimeout(releaseTimer); releaseTimer = null
    if (win && !win.isDestroyed()) {
      if (win.isVisible() || wantsVisible) hide()
      else if (readyToShow) { wantsVisible = true; win.show(); win.focus(); win.webContents.send('clipboard:init', appearance()) }
      else wantsVisible = true
      return true
    }
    wantsVisible = true
    generation = randomUUID()
    panelSession = session.fromPartition(`clipboard-${generation}`, { cache: false })
    panelSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    panelSession.setPermissionCheckHandler(() => false)
    panelSession.protocol.handle('highlighter-clipboard', handleResource)
    const page = path.join(rootDirectory, 'clipboard', 'clipboard.html')
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = Math.min(480, area.width); const height = Math.min(640, area.height)
    const created = createLocalWindow(page, { width, height, minWidth: Math.min(380, width), minHeight: Math.min(420, height),
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 3),
      frame: false, show: false, title: 'Highlighter', backgroundColor: '#f5f6f8',
      webPreferences: { preload: path.join(rootDirectory, 'preload-clipboard.js'), session: panelSession } })
    win = created
    positionAutomationWindow(created)
    created.on('blur', () => { if (!confirmationOpen && created === win) hide() })
    created.on('closed', () => { if (created === win) release() })
    created.webContents.on('render-process-gone', () => { if (created === win) release() })
    created.loadFile(page).catch(() => { if (created === win) release() })
    return true
  }
  function ready(event) {
    if (!win || event.sender !== win.webContents) return
    readyToShow = true
    if (!wantsVisible || isGameModeEnabled() || isMigrationInProgress() || !getSettings().clipboard.enabled) return
    win.show(); win.focus(); event.sender.send('clipboard:init', appearance())
  }
  function interactive(event, token) { if (win && event.sender === win.webContents && token === generation) win._clipboardInteractiveAt = Date.now() }
  function preview(event, id) {
    if (!win || event.sender !== win.webContents || !win.isVisible()) throw new Error('WINDOW_NOT_VISIBLE')
    revokePreviews()
    const token = randomUUID()
    tokens.set(token, { id, owner: event.sender.id, generation, expires: Date.now() + 60000 })
    return { url: `highlighter-clipboard://preview/${token}` }
  }
  async function prepareClear(event, scope) {
    if (!['ordinary', 'all'].includes(scope)) throw new Error('INVALID_SCOPE')
    await service.command('list', { search: '', kind: '', pinnedOnly: false, limit: 1 })
    const state = await service.refresh()
    const count = scope === 'all' ? state.itemCount : state.itemCount - state.pinnedCount
    if (!count) return { canceled: true, count: 0 }
    confirmationOpen = true
    let result
    try { result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), { type: 'warning', buttons: [t('clipboard.cancel'), t('clipboard.clear')], defaultId: 0, cancelId: 0,
      message: t(scope === 'all' ? 'clipboard.clear-all-confirm' : 'clipboard.clear-confirm', { count }) }) }
    finally { confirmationOpen = false }
    if (result.response !== 1 || event.sender.isDestroyed()) return { canceled: true }
    const token = randomUUID()
    if (clearTokens.size >= 16) clearTokens.clear()
    clearTokens.set(token, { owner: event.sender.id, scope, revision: state.revision, dataset: state.datasetId, expires: Date.now() + 30000 })
    return { token, count }
  }
  async function commitClear(event, token, operationId) {
    const claim = clearTokens.get(token); clearTokens.delete(token)
    if (!claim || claim.owner !== event.sender.id || claim.expires < Date.now() || service.snapshot().datasetId !== claim.dataset) throw new Error('INVALID_CLEAR_TOKEN')
    return service.command('clear', { includePinned: claim.scope === 'all', revision: claim.revision, operationId })
  }
  async function applySettings() {
    if (automation) return
    if (!getSettings().clipboard.enabled) release()
    await service.apply(getSettings().clipboard)
    send('clipboard:init', appearance())
  }
  function start() {
    if (automation || process.platform !== 'win32') return
    for (const [event, reason, pause] of [['suspend', 'suspend', true], ['resume', 'suspend', false], ['lock-screen', 'locked', true], ['unlock-screen', 'locked', false]]) {
      const listener = () => { if (pause) hide(); service.setReason(reason, pause) }
      powerMonitor.on(event, listener); powerListeners.push([event, listener])
    }
    service.setReason('game-mode', isGameModeEnabled())
    applySettings()
  }
  registerClipboardIpc({ ipcMain, service, domain: { ready, interactive, hide, preview, revokePreviews, prepareClear, commitClear },
    setPaused: async (paused) => { if (isMigrationInProgress()) throw new Error('QUIESCING'); updateSettings({ clipboard: { paused } }); await applySettings(); return service.snapshot() } })
  return { service, ownsWindow, show, hide, applySettings, start,
    applyGameMode(enabled) { if (enabled) hide(); return service.setReason('game-mode', enabled) },
    notifyAppearance() { send('clipboard:init', appearance()) },
    async quiesce() { release(); await service.quiesce() },
    async resume() { await service.setReason('migration', false) },
    async dispose() { disposed = true; release(); for (const [event, listener] of powerListeners) powerMonitor.removeListener(event, listener); await service.dispose() }
  }
}
module.exports = { createClipboardDomain }
