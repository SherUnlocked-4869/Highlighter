'use strict'
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ClipboardService } = require('../../services/clipboard-service')
const { registerClipboardIpc } = require('../../ipc/clipboard-ipc')
const { t } = require('../../services/i18n-bootstrap')
const { createPasteFeedback } = require('../../services/clipboard-paste-feedback')
const { windowBackdropColor, trackWindowBackdrop } = require('../../services/window-backdrop')
const { createThumbnailCache } = require('../../services/clipboard-thumbnail-cache')

// One screen of tiles plus scroll-back and page margins. The limit must stay
// below 16: ClipboardService.request() rejects with BACKPRESSURE once
// `pending.size >= 16`, and it also has to leave slots for the 2 s status poll.
const PREVIEW_CONCURRENCY = 8
// Bounded token table per window. 128 = one visible screen (16) + one screen of
// scroll-back + a page of rows + margin; the LRU entry cap uses the same value.
const PREVIEW_TOKEN_LIMIT = 128
// The URL is a capability, not a resource: visibility + owner + generation are
// the real gates (see handleResource). The TTL is only a backstop; hide and
// release still revoke everything.
const PREVIEW_TTL_MS = 300000
const PREVIEW_MAX_BYTES = 256 * 1024

// Fixed-size worker pool. Every worker drains the same queue, so the number of
// concurrent native calls never exceeds `limit`. Workers never reject: per-item
// failures are values, because one broken id must not fail the whole batch.
async function eachLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const drain = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain))
  return results
}

// The contract enumerates exactly four per-item failures, so unexpected native
// or transport errors collapse into UNSUPPORTED rather than leaking through.
function previewFailure(error) {
  const code = error?.code || error?.message
  if (code === 'BACKPRESSURE') return 'BACKPRESSURE'
  if (code === 'NOT_FOUND' || code === 'ATTACHMENT_MISSING') return 'NOT_FOUND'
  return 'UNSUPPORTED'
}

function createClipboardDomain({ app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor, ipcMain, rootDirectory, directory, getSettings, updateSettings, getHook, createLocalWindow, positionAutomationWindow, isGameModeEnabled, isMigrationInProgress, automation = false }) {
  const executable = path.join(app.isPackaged ? process.resourcesPath : rootDirectory, 'native', 'clipboard', ...(app.isPackaged ? [] : ['bin']), 'HighlighterClipboard.exe')
  const service = new ClipboardService({ executable, directory, getHook })
  let win = null; let generation = null; let releaseTimer = null; let panelSession = null
  let confirmationOpen = false; let readyToShow = false; let disposed = false
  let wantsVisible = false
  let targetId = null; let presentation = 0; let opening = false
  let pasteInProgress = false; let releaseAfterPaste = false; let pasteFeedback = null
  let shutdownPromise = null; let shutdownComplete = false
  const tokens = new Map(); const clearTokens = new Map(); const powerListeners = []
  const thumbnails = createThumbnailCache({ maxBytes: 8 * 1024 * 1024, maxEntries: PREVIEW_TOKEN_LIMIT })
  // Bumped on every cache invalidation. An in-flight native read captured the
  // epoch when it started; if the epoch moved, the read must not write its bytes
  // back, otherwise a hide/history/delete invalidation would be undone by a
  // response that was already on the wire.
  let cacheEpoch = 0
  function invalidateThumbnails() { cacheEpoch++; thumbnails.clear() }
  const feedback = createPasteFeedback({ getWindow: () => win, screen, expire: () => hide() })
  const ownsWindow = (target) => target != null && target === win
  function send(channel, value) { if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send(channel, value) }
  function panelVisible(event) {
    if (!win) return false
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
    if (win.isVisible() !== true) return false
    if (!event?.sender) return true
    return event.sender === win.webContents
  }
  function remember(key, token) {
    // Insertion order is the eviction order: the oldest token goes first.
    while (tokens.size >= PREVIEW_TOKEN_LIMIT) tokens.delete(tokens.keys().next().value)
    tokens.set(key, token)
  }
  function revokePreviews() { tokens.clear(); invalidateThumbnails() }
  service.on('status', (value) => send('clipboard:status-changed', value))
  // Tokens are NOT cleared here: a new copy in another app must not blank every
  // tile that is already on screen. The byte cache is cleared instead, because
  // the native side prunes records by retention without a precise invalidation
  // signal - without this, a deleted item's thumbnail would stay readable from
  // cache. After the clear the next protocol hit goes back to native and a
  // deleted id answers NOT_FOUND, which becomes a 404.
  service.on('history', (value) => { invalidateThumbnails(); send('clipboard:history-changed', value) })
  function appearance() {
    const settings = getSettings()
    return { language: settings.language, dark: settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors), mainColor: settings.mainColor, generation, status: service.snapshot() }
  }
  function release() {
    feedback.clear(false)
    if (pasteInProgress) {
      releaseAfterPaste = true; targetId = null; ++presentation; wantsVisible = false; opening = false
      revokePreviews(); clearTokens.clear()
      if (win && !win.isDestroyed()) { win.webContents.send('clipboard:hidden'); win.hide() }
      return
    }
    clearTimeout(releaseTimer); releaseTimer = null; revokePreviews(); clearTokens.clear()
    const previous = win; win = null; generation = null; readyToShow = false; wantsVisible = false
    targetId = null; ++presentation; opening = false
    service.command('paste.clear').catch(() => {})
    if (previous && !previous.isDestroyed()) previous.destroy()
    if (panelSession) { panelSession.protocol.unhandle('highlighter-clipboard'); panelSession = null }
  }
  function hide() {
    feedback.clear()
    wantsVisible = false
    targetId = null; ++presentation; opening = false
    if (!pasteInProgress) service.command('paste.clear').catch(() => {})
    if (!win || win.isDestroyed()) return
    win.webContents.send('clipboard:hidden'); win.hide(); revokePreviews(); clearTokens.clear()
    clearTimeout(releaseTimer)
    const timeout = getSettings().clipboard.releaseAfterMs
    if (!timeout) { if (pasteInProgress) releaseAfterPaste = true; else release() }
    else { releaseTimer = setTimeout(release, timeout); releaseTimer.unref?.() }
  }
  async function present() {
    if (!win || !readyToShow || !wantsVisible || opening || pasteInProgress) return
    const created = win; const ticket = ++presentation; opening = true; targetId = null
    try {
      // A hidden BrowserWindow has not taken input focus yet. Capture the
      // external foreground now; never accept HWNDs or target IDs from a page.
      const handle = created.getNativeWindowHandle()
      const panelWindow = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16)
      const value = await service.command('paste.capture', { panelWindow, parentPid: process.pid })
      if (ticket === presentation) targetId = value.targetId || null
    } catch {} // History/copy remain usable when there is no paste target.
    finally { if (ticket === presentation) opening = false }
    if (ticket !== presentation || created !== win || created.isDestroyed() || !wantsVisible || disposed || isGameModeEnabled() || isMigrationInProgress() || !getSettings().clipboard.enabled) return
    created.show(); created.focus(); created.webContents.send('clipboard:init', appearance())
    pasteFeedback = null
  }
  // Every pre-existing check stays here. The byte source changed (LRU first),
  // but token, generation, TTL, visibility, owner, the post-await re-checks and
  // the mime/length guards are unchanged - they are what keeps a capability URL
  // from outliving the window that owns it.
  async function handleResource(request) {
    const fail = () => new Response(null, { status: 404 })
    let url
    try { url = new URL(request.url) } catch { return fail() }
    if (request.method !== 'GET' || url.hostname !== 'preview' || url.search || url.hash) return fail()
    const key = url.pathname.slice(1)
    const token = tokens.get(key)
    if (!token || token.generation !== generation || token.expires < Date.now() || !win?.isVisible() || win.webContents.id !== token.owner) return fail()
    try {
      // The batch pipeline already read and cached these bytes, so a hit sends
      // no RPC at all. A miss means the entry was evicted; read once from native
      // and cache it again, and give up (404) if that read fails.
      const epoch = cacheEpoch
      let entry = thumbnails.get(token.id)
      if (!entry) {
        const { bytes, value } = await service.command('thumbnail', { id: token.id })
        if (value?.mime !== 'image/png' || value?.byteLength !== bytes.length || bytes.length > PREVIEW_MAX_BYTES) return fail()
        entry = { mime: value.mime, bytes }
        // Re-check after the await BEFORE caching: the window may have hidden, the
        // panel may have been released, the token may have expired, or a
        // hide/history/delete may have invalidated the cache while the native read
        // was in flight. Writing first and validating second would let a stale
        // response repopulate a cache that had just been cleared.
        if (!tokens.has(key) || token.generation !== generation || token.expires < Date.now() || !win?.isVisible() || win.webContents.id !== token.owner) return fail()
        if (epoch === cacheEpoch) thumbnails.set(token.id, entry)
      }
      if (entry.mime !== 'image/png' || entry.bytes.length > PREVIEW_MAX_BYTES) return fail()
      return new Response(entry.bytes, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } })
    } catch { return fail() }
  }
  function show() {
    if (disposed || pasteInProgress || isMigrationInProgress() || isGameModeEnabled()) return false
    if (!getSettings().clipboard.enabled) return false
    clearTimeout(releaseTimer); releaseTimer = null
    if (win && !win.isDestroyed()) {
      if (feedback.active) { hide(); clearTimeout(releaseTimer); releaseTimer = null; if (win) { wantsVisible = true; present() } else return show() }
      else if (win.isVisible() || wantsVisible) hide()
      else if (readyToShow) { wantsVisible = true; present() }
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
    // Match the shared design-token base (--bg) before the first paint. The panel
    // is the only window users open on top of arbitrary content; a light backdrop
    // would flash white when the dark theme opens it.
    const settings = getSettings()
    const created = createLocalWindow(page, { width, height, minWidth: Math.min(380, width), minHeight: Math.min(420, height),
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 3),
      frame: false, show: false, title: 'Highlighter', backgroundColor: windowBackdropColor(settings, nativeTheme),
      webPreferences: { preload: path.join(rootDirectory, 'preload-clipboard.js'), session: panelSession } })
    win = created
    trackWindowBackdrop(created)
    positionAutomationWindow(created)
    created.on('blur', () => { if (!feedback.active && !confirmationOpen && created === win && created.isVisible()) hide() })
    created.on('closed', () => { if (created === win) release() })
    created.webContents.on('render-process-gone', () => { if (created === win) release() })
    created.loadFile(page).catch(() => { if (created === win) release() })
    return true
  }
  function ready(event) {
    if (!win || event.sender !== win.webContents) return
    readyToShow = true
    if (!wantsVisible || isGameModeEnabled() || isMigrationInProgress() || !getSettings().clipboard.enabled) return
    present()
  }
  async function paste(event, id, operationId) {
    const created = win; const ticket = presentation; const savedTarget = targetId
    if (!created || event.sender !== created.webContents || !created.isVisible() || !created.isFocused()) throw new Error('WINDOW_NOT_VISIBLE')
    if (pasteInProgress) throw new Error('OPERATION_BUSY')
    if (isGameModeEnabled() || isMigrationInProgress()) throw new Error('PASTE_UNAVAILABLE')
    pasteInProgress = true; pasteFeedback = null
    let hiddenByPaste = false
    try {
      const prepared = await service.command('paste.prepare', { id, operationId, targetId: savedTarget })
      let value = prepared
      if (prepared.ticket) {
        const unchanged = created === win && !created.isDestroyed() && created.isVisible() && created.isFocused() && presentation === ticket && !disposed && !isGameModeEnabled() && !isMigrationInProgress()
        if (unchanged) { service.allowPasteForeground(); hide(); hiddenByPaste = true }
        value = await service.command(unchanged ? 'paste.commit' : 'paste.cancel', { ticket: prepared.ticket })
      }
      pasteFeedback = { outcome: value.outcome, reason: value.reason }
      return { copied: value.copied === true, ...pasteFeedback }
    } catch (error) {
      pasteFeedback = { error: error.code || error.message }
      throw error
    } finally {
      pasteInProgress = false
      if (hiddenByPaste && presentation === ticket + 1 && created === win && !created.isDestroyed() && !disposed && !isGameModeEnabled() && !isMigrationInProgress() && getSettings().clipboard.enabled && pasteFeedback?.outcome !== 'injected') {
        // Show fallback feedback without taking keyboard focus from the user.
        clearTimeout(releaseTimer); releaseTimer = null; wantsVisible = false; releaseAfterPaste = false
        feedback.show({ ...appearance(), pasteFeedback })
      }
      else if (releaseAfterPaste) { releaseAfterPaste = false; release() }
    }
  }
  function interactive(event, token) { if (win && event.sender === win.webContents && token === generation) win._clipboardInteractiveAt = Date.now() }
  // Batch form of the old single-token preview(). Bytes are read here, in the
  // main process, so per-item NOT_FOUND/UNSUPPORTED can be returned to the
  // renderer immediately instead of surfacing as a silent <img> 404. It never
  // throws for a per-item problem and never throws at all for a hidden window:
  // a batch has to answer for every id it was given.
  async function previews(event, ids) {
    const owner = event?.sender?.id
    const visible = panelVisible(event)
    if (!visible) return ids.map((id) => ({ id, error: 'WINDOW_NOT_VISIBLE' }))
    const unique = [...new Set(ids)]
    const epoch = cacheEpoch
    const reads = new Map()
    const read = (id) => {
      const cached = thumbnails.get(id)
      if (cached) return Promise.resolve({ entry: cached })
      if (!reads.has(id)) {
        // No per-item timeout on purpose: ClipboardService's timeout path calls
        // failChild() and kills the whole sidecar, so 5000 ms stays the only one.
        reads.set(id, service.command('thumbnail', { id }).then(({ bytes, value }) => {
          if (value?.mime !== 'image/png' || value?.byteLength !== bytes.length || bytes.length > PREVIEW_MAX_BYTES) return { error: 'UNSUPPORTED' }
          // Re-check the cache epoch before writing: a hide/history/delete may
          // have cleared the cache while this read was in flight, and caching the
          // bytes afterwards would resurrect an entry the invalidation removed.
          const entry = { mime: value.mime, bytes }
          if (epoch === cacheEpoch) thumbnails.set(id, entry)
          return { entry }
        }).catch((error) => ({ error: previewFailure(error) })))
      }
      return reads.get(id)
    }
    const results = await eachLimit(unique, PREVIEW_CONCURRENCY, async (id) => {
      if (!panelVisible(event)) return { id, error: 'WINDOW_NOT_VISIBLE' }
      const { entry, error } = await read(id)
      if (!entry) return { id, error: error || 'UNSUPPORTED' }
      // A hide/release that landed while the read was in flight must not leak a
      // usable URL: the token would point at a window that is already gone.
      if (!panelVisible(event)) return { id, error: 'WINDOW_NOT_VISIBLE' }
      const key = randomUUID()
      remember(key, { id, owner, generation, expires: Date.now() + PREVIEW_TTL_MS })
      return { id, url: `highlighter-clipboard://preview/${key}` }
    })
    // Detached native reads must not surface as unhandled rejections if the
    // panel goes away mid-batch.
    for (const pending of reads.values()) pending.catch(() => {})
    // Return one entry per requested id, in the caller's order. Deduplicated ids
    // were only read (and only signed) once, then mapped back; returning the
    // deduplicated list instead would break the positional contract with the
    // renderer, which pairs results to tiles by index.
    const byId = new Map(results.map((entry) => [entry.id, entry]))
    return ids.map((id) => byId.get(id) || { id, error: 'UNSUPPORTED' })
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
    if (!feedback.active) send('clipboard:init', appearance())
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
  registerClipboardIpc({ ipcMain, service, domain: { ready, interactive, hide, paste, previews, revokePreviews, prepareClear, commitClear },
    setPaused: async (paused) => { if (isMigrationInProgress()) throw new Error('QUIESCING'); updateSettings({ clipboard: { paused } }); await applySettings(); return service.snapshot() } })
  // `thumbnails` is exposed alongside `service`: both are seams for the unit
  // tests, which replace the backend and assert on the byte cache directly.
  return { service, thumbnails, ownsWindow, show, hide, applySettings, start,
    applyGameMode(enabled) { if (enabled) hide(); return service.setReason('game-mode', enabled) },
    notifyAppearance() { if (!feedback.active) send('clipboard:init', appearance()) },
    async quiesce() { release(); await service.quiesce() },
    async resume() { await service.setReason('migration', false) },
    isShutdownComplete: () => shutdownComplete,
    dispose() {
      if (shutdownPromise) return shutdownPromise
      disposed = true; release()
      for (const [event, listener] of powerListeners) powerMonitor.removeListener(event, listener)
      shutdownPromise = service.dispose().finally(() => { shutdownComplete = true })
      return shutdownPromise
    }
  }
}
module.exports = { createClipboardDomain, PREVIEW_CONCURRENCY, PREVIEW_TOKEN_LIMIT, PREVIEW_TTL_MS }
