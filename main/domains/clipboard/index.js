'use strict'
const path = require('node:path')
const fsDefault = require('node:fs')
const { randomUUID } = require('node:crypto')
const { ClipboardService } = require('../../services/clipboard-service')
const { registerClipboardPublisher, resetClipboardPublisher } = require('../../services/clipboard-publish')
const { POLL_REVISION_FRESH_MS } = require('../../services/clipboard-poll-policy')
const { registerClipboardIpc } = require('../../ipc/clipboard-ipc')
const { t } = require('../../services/i18n-bootstrap')
const { createPasteFeedback } = require('../../services/clipboard-paste-feedback')
const { windowBackdropColor, trackWindowBackdrop } = require('../../services/window-backdrop')
const { createThumbnailCache } = require('../../services/clipboard-thumbnail-cache')
const { computeCapacity, emptySkipSession, nextSkipSession } = require('../../services/clipboard-capacity')
// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2):
// one-click image actions. The OCR/table/pin capabilities are main-process work;
// the pure table builder and the workbook writer already ship for the recognition
// window, and the save target derives from the same naming source as a capture.
const { resolveSaveDirectory } = require('../../services/image-file-save')
const { CAPTURE_PREFIX, makeCaptureName } = require('../../services/capture-naming')
const { buildXlsxBuffer: defaultBuildXlsxBuffer } = require('../../services/table-workbook')
const { buildTableFromOcr: defaultBuildTableFromOcr } = require('../../../capture/recognition-utils')

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

// N02 image actions. The original attachment ceiling matches the native store
// (native/clipboard/src/limits.rs MAX_ENCODED_IMAGE_BYTES); the OCR text is capped
// at the store's text ceiling so one absurd recognition cannot become a 100 MiB IPC
// reply. OCR_ACTION_IDLE_MS bounds the duplicate sidecar discussed in
// resolveOcrService(): it is reclaimed shortly after the last action.
const IMAGE_ACTION_MAX_BYTES = 16 * 1024 * 1024
const OCR_TEXT_MAX_BYTES = 1024 * 1024
const OCR_ACTION_IDLE_MS = 15000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// A stored attachment is content-addressed: its file name is the payload hash.
const STORED_IMAGE_FILE = /^[0-9a-f]{64}\.png$/
const failure = (code) => Object.assign(new Error(code), { code })

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
// F05: only a definitive "this record/payload is gone" answer may evict a cached
// thumbnail; a transport or backpressure error must not poison the cache.
function thumbnailMissing(error) {
  const code = error?.code || error?.message
  return code === 'NOT_FOUND' || code === 'ATTACHMENT_MISSING'
}

function createClipboardDomain({ app, BrowserWindow, screen, nativeTheme, session, dialog, powerMonitor, ipcMain, rootDirectory, directory, getSettings, updateSettings, getHook, createLocalWindow, positionAutomationWindow, isGameModeEnabled, isMigrationInProgress, automation = false,
  // N02 seams. main.js does not pass these today (it is at its H05 line ceiling and
  // outside this ticket's write scope), so the OCR service is created locally on
  // first use and the pin action degrades to a clipboard copy. Tests inject all of
  // them; a future main.js wiring is a one-line addition per resolver - see the
  // handover note in docs/reviews/2026-11-26-code-review-and-optimization-report.md
  // section 5.2 and the "wiring suggestion" block at the end of this domain.
  getOcrService, getPinDomain, clipboard: electronClipboard, writeClipboardText,
  buildTableFromOcr = defaultBuildTableFromOcr, buildXlsxBuffer = defaultBuildXlsxBuffer,
  fs: fileSystem = fsDefault }) {
  const executable = path.join(app.isPackaged ? process.resourcesPath : rootDirectory, 'native', 'clipboard', ...(app.isPackaged ? [] : ['bin']), 'HighlighterClipboard.exe')
  const service = new ClipboardService({ executable, directory, getHook })
  // B01 (plan item 05): the capture domain publishes private screenshots through this.
  registerClipboardPublisher((input) => service.publishImage(input))
  let win = null; let generation = null; let releaseTimer = null; let panelSession = null
  let confirmationOpen = false; let readyToShow = false; let disposed = false
  let wantsVisible = false; let hiddenAt = null
  let targetId = null; let presentation = 0; let opening = false
  let pasteInProgress = false; let releaseAfterPaste = false; let pasteFeedback = null
  let shutdownPromise = null; let shutdownComplete = false
  // N02: one long image action at a time, plus the locally-owned OCR sidecar. The
  // renderer disables its controls, but the domain is the authority: two parallel
  // decodes would each spawn/copy pixels and a second save dialog could open over
  // the first.
  let imageActionInFlight = false
  let localOcrService = null
  let localOcrOwned = false
  const tokens = new Map(); const clearTokens = new Map(); const powerListeners = []
  const thumbnails = createThumbnailCache({ maxBytes: 8 * 1024 * 1024, maxEntries: PREVIEW_TOKEN_LIMIT })
  // Bumped on every cache invalidation. An in-flight native read captured the
  // epoch when it started; if the epoch moved, the read must not write its bytes
  // back, otherwise a hide/history/delete invalidation would be undone by a
  // response that was already on the wire.
  let cacheEpoch = 0
  // F05 (report report section 3.5): thumbnail bytes are content-addressed and an item id is
  // immutable, so a new clipboard record (or a pin toggle) cannot change an
  // existing item's thumbnail. The old code called `thumbnails.clear()` on every
  // `history` event, which made the panel re-read every visible thumbnail after
  // each copy. Entries now carry the history revision they were read under and
  // are revalidated lazily; only an explicit delete/clear or a hide drops the
  // whole table. Any read started before a history event is invalidated by the
  // epoch bump below instead.
  const initialRevision = service.snapshot()?.revision
  let latestRevision = Number.isSafeInteger(initialRevision) && initialRevision >= 0 ? initialRevision : null
  const thumbnailRevisions = new Map()
  function noteHistory(value) {
    const revision = value?.revision
    latestRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : latestRevision
    send('clipboard:history-changed', value)
    cacheEpoch++
  }
  function clearThumbnails() { cacheEpoch++; thumbnailRevisions.clear(); thumbnails.clear() }
  // Targeted eviction: drop exactly these content-addressed keys. Used when the
  // native side reports a record gone and when an entry is found stale.
  function dropThumbnails(ids) {
    for (const id of ids) { thumbnailRevisions.delete(id); thumbnails.delete(id) }
  }
  function cacheThumbnail(id, entry) { thumbnailRevisions.set(id, latestRevision); thumbnails.set(id, entry) }
  function cachedThumbnail(id) {
    const entry = thumbnails.get(id)
    if (!entry) return undefined
    if (thumbnailRevisions.get(id) === latestRevision) return entry
    // The revision moved since this entry was read: the native retention pass may
    // have removed the record. Drop only this key and let the caller re-read; a
    // natively deleted id then answers NOT_FOUND instead of serving stale bytes.
    dropThumbnails([id])
    return undefined
  }
  // B05: status.skipped is the sidecar's per-process counter map. The observer
  // turns successive observations into this run's totals plus the most recent
  // reason, so the settings page can explain a rejected copy. It is deliberately
  // in memory only: no sidecar method and no persisted "statistics" are added.
  let skipSession = emptySkipSession(Date.now())
  function observeStatus(value) {
    // Seed the history revision from the first status that carries one, so a
    // cache filled before the first `history` event is tagged with the current
    // revision instead of looking stale immediately.
    if (latestRevision === null && Number.isSafeInteger(value?.revision) && value.revision >= 0) latestRevision = value.revision
    skipSession = nextSkipSession(skipSession, value?.skipped, Date.now())
    return value
  }
  function capacityView(value) {
    return computeCapacity({ status: value, settings: getSettings().clipboard, session: skipSession })
  }
  function statusWithCapacity(value) {
    return { ...value, capacity: capacityView(value) }
  }
  function statusSnapshot() { return statusWithCapacity(service.snapshot()) }
  // The settings window opens a page and immediately wants current aggregates;
  // the panel is already refreshed by setPanelVisible(true). A non-panel caller
  // may therefore ask for one status round trip, but only when the cached
  // revision is older than the paint budget. Failures fall back to the cached
  // snapshot so a wedged sidecar cannot keep the settings page from rendering.
  async function statusSnapshotFor(event) {
    const fresh = Number(Date.now()) - (service.lastRefreshAt || 0) < POLL_REVISION_FRESH_MS
    if (!panelVisible(event) && !fresh && typeof service.refresh === 'function') await service.refresh().catch(() => {})
    return statusSnapshot()
  }
  const feedback = createPasteFeedback({ getWindow: () => win, screen, expire: () => hide() })
  const ownsWindow = (target) => target != null && target === win
  function send(channel, value) { if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send(channel, value) }
  // C03 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the
  // panel's visibility is the status-poll scheduler's primary input. Callers do
  // not await it - a window handler must never block on a status round trip, and
  // a failure surfaces through the status phase instead. present() uses the
  // returned promise only to bound how long it waits for a fresh revision.
  function notePanelVisibility(visible) {
    return (async () => {
      try { return await service.setPanelVisible(visible) } catch { return service.snapshot() }
    })()
  }
  // Cap the wait for a fresh revision at the paint budget: a wedged sidecar must
  // not keep the panel closed. The request keeps running in the background and
  // the next status broadcast carries whatever it found.
  function waitForRevision(refresh) {
    let timer
    return Promise.race([
      refresh,
      new Promise((resolve) => { timer = setTimeout(resolve, POLL_REVISION_FRESH_MS) })
    ]).finally(() => clearTimeout(timer))
  }
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
  function revokePreviews() { tokens.clear(); clearThumbnails() }
  service.on('status', (value) => send('clipboard:status-changed', statusWithCapacity(observeStatus(value))))
  // Tokens are NOT cleared here: a new copy in another app must not blank every
  // tile that is already on screen. F05: neither is the byte cache - an item id is
  // immutable and its thumbnail is content-addressed, so only an explicit
  // delete/clear or a hide can invalidate an entry. A revision change only
  // revalidates entries lazily (see `cachedThumbnail`), so a new record or a pin
  // toggle no longer makes the panel re-read every visible thumbnail.
  service.on('history', (value) => noteHistory(value))
  function appearance() {
    const settings = getSettings()
    // A05: the panel follows the global compact layout; the renderer already keys its row
    // height off `compact` (and keeps the grid gap), so this is the only missing input.
    return { language: settings.language, compact: settings.compact === true, dark: settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors), mainColor: settings.mainColor, generation, status: statusWithCapacity(service.snapshot()) }
  }
  function release(reason = 'forced') {
    clearTimeout(releaseTimer); releaseTimer = null
    feedback.clear(false)
    notePanelVisibility(false)
    if (pasteInProgress) {
      if (reason === 'forced' || !releaseAfterPaste) releaseAfterPaste = reason
      targetId = null; ++presentation; wantsVisible = false; opening = false
      revokePreviews(); clearTokens.clear()
      if (win && !win.isDestroyed()) { win.webContents.send('clipboard:hidden'); win.hide() }
      return
    }
    hiddenAt = null; revokePreviews(); clearTokens.clear()
    const previous = win; win = null; generation = null; readyToShow = false; wantsVisible = false
    targetId = null; ++presentation; opening = false
    service.command('paste.clear').catch(() => {})
    if (previous && !previous.isDestroyed()) previous.destroy()
    if (panelSession) { panelSession.protocol.unhandle('highlighter-clipboard'); panelSession = null }
  }
  function armRelease(timeout) {
    clearTimeout(releaseTimer); releaseTimer = null
    if (hiddenAt === null || !win || win.isDestroyed() || wantsVisible || feedback.active) return
    const remaining = timeout - (Date.now() - hiddenAt)
    if (remaining <= 0) {
      if (!pasteInProgress) release()
      else if (!releaseAfterPaste) releaseAfterPaste = 'idle'
    } else {
      if (releaseAfterPaste === 'idle') releaseAfterPaste = false
      releaseTimer = setTimeout(() => release('idle'), remaining)
      releaseTimer.unref?.()
    }
  }
  function hide() {
    feedback.clear()
    notePanelVisibility(false)
    wantsVisible = false
    targetId = null; ++presentation; opening = false
    if (!pasteInProgress) service.command('paste.clear').catch(() => {})
    if (!win || win.isDestroyed()) return
    win.webContents.send('clipboard:hidden'); win.hide(); revokePreviews(); clearTokens.clear()
    hiddenAt ??= Date.now()
    armRelease(getSettings().clipboard.releaseAfterMs)
  }
  async function present() {
    if (!win || !readyToShow || !wantsVisible || opening || pasteInProgress) return
    const created = win; const ticket = ++presentation; opening = true; targetId = null
    // C03: the current revision is fetched while paste.capture runs below, so the
    // open path pays no extra round trip. The snapshot this ends up in is what
    // clipboard:init carries.
    const revision = notePanelVisibility(true)
    const stillWanted = () => ticket === presentation && created === win && !created.isDestroyed() && wantsVisible && !disposed && !isGameModeEnabled() && !isMigrationInProgress() && getSettings().clipboard.enabled
    try {
      // A hidden BrowserWindow has not taken input focus yet. Capture the
      // external foreground now; never accept HWNDs or target IDs from a page.
      const handle = created.getNativeWindowHandle()
      const panelWindow = (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(16)
      const value = await service.command('paste.capture', { panelWindow, parentPid: process.pid })
      if (ticket === presentation) targetId = value.targetId || null
    } catch {} // History/copy remain usable when there is no paste target.
    finally { if (ticket === presentation) opening = false }
    if (!stillWanted()) return
    // Bounded by the paint budget only when the status request is slow; a fast
    // one resolves before the capture above does.
    await waitForRevision(revision)
    if (!stillWanted()) return
    hiddenAt = null
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
      let entry = cachedThumbnail(token.id)
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
        if (epoch === cacheEpoch) cacheThumbnail(token.id, entry)
      }
      if (entry.mime !== 'image/png' || entry.bytes.length > PREVIEW_MAX_BYTES) return fail()
      return new Response(entry.bytes, { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } })
    } catch (error) {
      // F05: targeted eviction - only a definitive missing record drops this key.
      if (thumbnailMissing(error)) dropThumbnails([token.id])
      return fail()
    }
  }
  function show() {
    if (disposed || pasteInProgress || isMigrationInProgress() || isGameModeEnabled()) return false
    if (!getSettings().clipboard.enabled) return false
    clearTimeout(releaseTimer); releaseTimer = null
    if (win && !win.isDestroyed()) {
      if (feedback.active) { hide(); clearTimeout(releaseTimer); releaseTimer = null; if (win) { wantsVisible = true; notePanelVisibility(true); present() } else return show() }
      else if (win.isVisible() || wantsVisible) hide()
      else if (readyToShow) { wantsVisible = true; notePanelVisibility(true); present() }
      else { wantsVisible = true; notePanelVisibility(true) }
      return true
    }
    wantsVisible = true
    // The window still has to load, so start the status refresh now instead of
    // waiting for present(): the revision is warm by the time the page is ready.
    notePanelVisibility(true)
    generation = randomUUID()
    panelSession = session.fromPartition('highlighter-clipboard-panel', { cache: false })
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
    const created = createLocalWindow(page, { role: 'clipboard-panel', width, height, minWidth: Math.min(380, width), minHeight: Math.min(420, height),
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
        clearTimeout(releaseTimer); releaseTimer = null; wantsVisible = false; releaseAfterPaste = false; hiddenAt = null
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
      const cached = cachedThumbnail(id)
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
          if (epoch === cacheEpoch) cacheThumbnail(id, entry)
          return { entry }
        }).catch((error) => {
          // F05: a natively deleted id evicts exactly its own cached thumbnail;
          // transport failures leave the cache untouched.
          if (thumbnailMissing(error)) dropThumbnails([id])
          return { error: previewFailure(error) }
        }))
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

  // ---------------------------------------------------------------------------
  // N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2):
  // one-click OCR / Excel / pin for an image record.
  //
  // Contract: the renderer submits ONLY the record id. The main process reads the
  // pixels from its own store, runs OCR and the table builder here, and owns every
  // filesystem decision (save dialog + write). Results are plain values - no byte
  // buffer, no path and no capability URL ever crosses back to the page.
  //
  // Every path is read-only for the clipboard history: a failed or cancelled action
  // cannot create, delete or reorder a record. The single native write is the pin
  // fallback's `copy`, which is the same exclusion-marked publication as the Copy
  // button, so it cannot add a history entry either.
  // ---------------------------------------------------------------------------

  function requireImageAction(event) {
    if (!panelVisible(event)) throw failure('WINDOW_NOT_VISIBLE')
    if (isGameModeEnabled() || isMigrationInProgress()) throw failure('IMAGE_ACTIONS_UNAVAILABLE')
    if (!getSettings().clipboard?.enabled) throw failure('FEATURE_DISABLED')
  }

  // One long action at a time. A second click (or a second renderer) must not start
  // a parallel OCR decode or stack a second save dialog; the renderer disables its
  // controls too, but this domain stays the authority.
  function withImageAction(event, work) {
    requireImageAction(event)
    if (imageActionInFlight) throw failure('OPERATION_BUSY')
    imageActionInFlight = true
    return Promise.resolve().then(work).finally(() => { imageActionInFlight = false })
  }

  // Stable codes for the renderer's copy table. Native codes that mean "this
  // record/payload is gone" collapse into IMAGE_UNAVAILABLE so the page never has
  // to know the sidecar's vocabulary.
  async function imageCommand(method, args) {
    try { return await service.command(method, args) } catch (error) {
      const code = error?.code || error?.message
      if (code === 'BACKPRESSURE') throw failure('OPERATION_BUSY')
      throw failure('IMAGE_UNAVAILABLE')
    }
  }

  async function imageRecord(id) {
    const detail = await imageCommand('detail', { id })
    if (detail?.kind !== 'image') throw failure('NOT_IMAGE')
    const declared = Number(detail.byteLength)
    if (Number.isFinite(declared) && declared > IMAGE_ACTION_MAX_BYTES) throw failure('IMAGE_TOO_LARGE')
    return detail
  }

  // The native protocol exposes the 240 px thumbnail (`thumbnail`) but not the
  // original attachment. The store is content-addressed and the thumbnail file name
  // IS the payload hash, so matching the bytes already in hand locates
  // attachments/<hash>.png without a new native method and without touching the
  // system clipboard. If the thumbnail was regenerated in memory (thumbnail budget)
  // the attachment is absent: fall back to the thumbnail bytes and flag the lower
  // resolution instead of failing the action.
  async function originalImageBytes(thumbnailBytes) {
    const thumbnailDirectory = path.join(directory, 'thumbnails')
    const attachmentDirectory = path.join(directory, 'attachments')
    let names
    try { names = await fileSystem.promises.readdir(thumbnailDirectory) } catch { return null }
    for (const name of names) {
      if (!STORED_IMAGE_FILE.test(name)) continue
      try {
        const thumbnailPath = path.join(thumbnailDirectory, name)
        const thumbnailStat = await fileSystem.promises.stat(thumbnailPath)
        if (!thumbnailStat.isFile() || thumbnailStat.size !== thumbnailBytes.length) continue
        const stored = await fileSystem.promises.readFile(thumbnailPath)
        if (!stored.equals(thumbnailBytes)) continue
        const attachmentPath = path.join(attachmentDirectory, name)
        const attachmentStat = await fileSystem.promises.stat(attachmentPath)
        if (!attachmentStat.isFile() || attachmentStat.size <= 0 || attachmentStat.size > IMAGE_ACTION_MAX_BYTES) continue
        const bytes = await fileSystem.promises.readFile(attachmentPath)
        if (bytes.length > IMAGE_ACTION_MAX_BYTES) continue
        if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) continue
        return bytes
      } catch { /* a pruned or racing entry: keep looking */ }
    }
    return null
  }

  async function imageActionBytes(id) {
    await imageRecord(id)
    const answer = await imageCommand('thumbnail', { id })
    const bytes = Buffer.isBuffer(answer?.bytes) ? answer.bytes : Buffer.from(answer?.bytes || [])
    if (answer?.value?.mime !== 'image/png' || !bytes.length || bytes.length > PREVIEW_MAX_BYTES) throw failure('IMAGE_UNAVAILABLE')
    const original = await originalImageBytes(bytes)
    return original ? { bytes: original, source: 'original' } : { bytes, source: 'thumbnail' }
  }

  // N02 wiring note: main.js constructs this domain without getOcrService (it is at
  // its H05 line ceiling and outside this ticket's write scope), so a locally owned
  // instance is created on first use. It is deliberately short-lived because
  // main.js may already keep its own hot-started sidecar for the capture window;
  // OCR_ACTION_IDLE_MS reclaims it shortly after the last action and dispose() stops
  // it outright. When a future main.js passes `getOcrService: () => getOcrService()`
  // the injected service wins and this fallback disappears. getPinDomain follows the
  // same resolver pattern (see the "wiring suggestion" block at the end of this domain).
  function resolveOcrService() {
    if (typeof getOcrService === 'function') {
      let supplied = null
      try { supplied = getOcrService() } catch { supplied = null }
      if (!supplied || typeof supplied.recognize !== 'function') throw failure('OCR_UNAVAILABLE')
      return supplied
    }
    if (!localOcrService) {
      try {
        const resourceRoot = app.isPackaged ? process.resourcesPath : rootDirectory
        const { OcrService } = require('../../services/ocr-service')
        localOcrService = new OcrService({
          sidecarPath: path.join(resourceRoot, 'native', 'ocr', 'HighlighterOcrSidecar.exe'),
          modelDir: path.join(resourceRoot, 'ocr', 'models', 'ppocr-v4-ch'),
          tempDir: path.join(app.getPath('temp'), 'Highlighter', 'ocr'),
          idleTimeoutMs: OCR_ACTION_IDLE_MS,
          log: () => {}
        })
        localOcrOwned = true
      } catch {
        localOcrService = null
        throw failure('OCR_UNAVAILABLE')
      }
    }
    return localOcrService
  }
  function stopLocalOcr() {
    if (!localOcrOwned || !localOcrService) return
    try { localOcrService.stop() } catch {}
    localOcrService = null
    localOcrOwned = false
  }

  async function recognizeForImageAction(id) {
    const settings = getSettings()
    if (!settings.plugins?.ocr) throw failure('OCR_DISABLED')
    const payload = await imageActionBytes(id)
    const ocr = resolveOcrService()
    const status = typeof ocr.getStatus === 'function' ? ocr.getStatus() : null
    if (status && status.available === false) throw failure('OCR_UNAVAILABLE')
    let result
    try {
      result = await ocr.recognize(payload.bytes, {
        scaleFactor: 1,
        detectAngle: settings.ocr?.detectAngle === true,
        maxSide: 2048,
        minConfidence: Number.isFinite(Number(settings.ocr?.minConfidence)) ? Number(settings.ocr.minConfidence) : undefined
      })
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : ''
      if (code.startsWith('OCR_')) throw error
      throw failure('OCR_FAILED')
    }
    const text = String(result?.text || '').slice(0, OCR_TEXT_MAX_BYTES)
    return {
      text,
      lineCount: text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0,
      lowResolution: payload.source === 'thumbnail',
      cached: result?.cached === true,
      textBlocks: Array.isArray(result?.textBlocks) ? result.textBlocks : []
    }
  }

  function imageOcr(event, id) {
    return withImageAction(event, async () => {
      const recognized = await recognizeForImageAction(id)
      // The OCR text is the whole answer; the coordinates are an implementation
      // detail of table building and are never shipped to the page.
      const { textBlocks: _textBlocks, ...value } = recognized
      return value
    })
  }

  async function pickImageTableTarget() {
    if (!dialog || typeof dialog.showSaveDialog !== 'function') throw failure('TABLE_FAILED')
    const settings = getSettings()
    let preferredDirectory = ''
    try { preferredDirectory = resolveSaveDirectory(settings) } catch { preferredDirectory = '' }
    const isTaken = typeof fileSystem.existsSync === 'function'
      ? (name) => { try { return fileSystem.existsSync(path.join(preferredDirectory, name)) } catch { return false } }
      : undefined
    const defaultName = makeCaptureName(CAPTURE_PREFIX, 'xlsx', { template: settings.screenshot?.nameTemplate, isTaken })
    const options = {
      title: t('clipboard.table-dialog-title'),
      defaultPath: preferredDirectory ? path.join(preferredDirectory, defaultName) : defaultName,
      filters: [{ name: t('clipboard.table-dialog-filter'), extensions: ['xlsx'] }]
    }
    const created = win
    const parent = created && !created.isDestroyed() ? created : null
    // The save dialog takes focus away from the panel; the blur handler would hide
    // and release the window (and its renderer) mid-action. This is the same guard
    // the clear-confirmation dialog uses.
    confirmationOpen = true
    try {
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (!result || result.canceled || typeof result.filePath !== 'string' || !result.filePath) return null
      return result.filePath
    } catch { throw failure('TABLE_FAILED') } finally { confirmationOpen = false }
  }

  function imageTable(event, id) {
    return withImageAction(event, async () => {
      const recognized = await recognizeForImageAction(id)
      const settings = getSettings()
      const minConfidence = Number.isFinite(Number(settings.ocr?.minConfidence)) ? Number(settings.ocr.minConfidence) : undefined
      let table = null
      try { table = buildTableFromOcr({ text: recognized.text, textBlocks: recognized.textBlocks }, { minConfidence }) } catch { table = null }
      // buildTableFromOcr() answers null unless there are at least two rows and two
      // columns. A returned-but-degenerate model is rejected by the same rule, so a
      // one-cell "workbook" can never be written and mislabelled as a table.
      if (!table || !Array.isArray(table.rows) || table.rows.length < 2 ||
          !table.rows.some((row) => Array.isArray(row) && row.length >= 2)) throw failure('NO_TABLE')
      let buffer
      try {
        buffer = buildXlsxBuffer(table.rows, {
          merges: Array.isArray(table.merges) ? table.merges : undefined,
          sheetName: t('clipboard.table-sheet-name')
        })
      } catch { throw failure('TABLE_FAILED') }
      const filePath = await pickImageTableTarget()
      if (!filePath) return { canceled: true }
      try { await fileSystem.promises.writeFile(filePath, buffer) } catch { throw failure('TABLE_FAILED') }
      const columns = Number(table.columnCount) || table.rows.reduce((max, row) => Math.max(max, row.length), 0)
      // Only the base name crosses back to the page; the directory stays in main.
      return { saved: true, name: path.basename(filePath), rows: table.rows.length, columns }
    })
  }

  function resolvePinDomainApi() {
    if (typeof getPinDomain !== 'function') return null
    let pin = null
    try { pin = getPinDomain() } catch { return null }
    return pin && typeof pin.createPinWindow === 'function' ? pin : null
  }

  function imagePin(event, id) {
    return withImageAction(event, async () => {
      const payload = await imageActionBytes(id)
      const pin = resolvePinDomainApi()
      if (pin) {
        if (typeof pin.canPinMore === 'function' && pin.canPinMore() !== true) throw failure('PIN_LIMIT')
        try { pin.createPinWindow(payload.bytes, { source: 'clipboard' }) } catch (error) {
          if (/最多固定|PIN_LIMIT/.test(String(error?.message || ''))) throw failure('PIN_LIMIT')
          throw failure('PIN_FAILED')
        }
        return { pinned: true, fallback: null, copied: false }
      }
      // Documented degradation: no pin-domain resolver is injected, so a desktop
      // pin cannot be created from here. Put the exact record image on the system
      // clipboard instead so the user can pin it from the capture window. The
      // native copy carries the Windows exclusion markers, so it stays out of the
      // clipboard history and this fallback has no history side effect.
      let copied = false
      try {
        const value = await service.command('copy', { id, operationId: randomUUID() })
        copied = value?.copied !== false
      } catch { throw failure('PIN_UNAVAILABLE') }
      return { pinned: false, fallback: 'copied', copied }
    })
  }

  function resolveClipboardWriter() {
    if (typeof writeClipboardText === 'function') return writeClipboardText
    if (electronClipboard && typeof electronClipboard.writeText === 'function') return (value) => electronClipboard.writeText(value)
    try {
      const value = require('electron').clipboard
      if (value && typeof value.writeText === 'function') return (text) => value.writeText(text)
    } catch {}
    return null
  }

  // The OCR result sheet's Copy button. The payload is already the OCR text the
  // panel is showing; the main process owns the system clipboard so the sandboxed
  // page needs neither a permission nor a write capability of its own.
  function copyText(event, text) {
    return withImageAction(event, () => {
      const writer = resolveClipboardWriter()
      if (!writer) throw failure('CLIPBOARD_UNAVAILABLE')
      try { writer(text) } catch { throw failure('CLIPBOARD_UNAVAILABLE') }
      return true
    })
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
    const settings = getSettings().clipboard
    if (!settings.enabled) release()
    else armRelease(settings.releaseAfterMs)
    await service.apply(settings)
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
  // N02 (report section 5.2): four value-only image-action handlers join the same
  // registration. They are attached afterwards so the pre-existing registration
  // line keeps its exact shape (test/clipboard-capacity-ui.test.js pins it).
  const ipcDomain = { ready, interactive, hide, paste, previews, revokePreviews, prepareClear, commitClear, statusSnapshot, statusSnapshotFor }
  Object.assign(ipcDomain, { imageOcr, imageTable, imagePin, copyText })
  registerClipboardIpc({ ipcMain, service, domain: ipcDomain,
    setPaused: async (paused) => { if (isMigrationInProgress()) throw new Error('QUIESCING'); updateSettings({ clipboard: { paused } }); await applySettings(); return service.snapshot() } })
  // `thumbnails` is exposed alongside `service`: both are seams for the unit
  // tests, which replace the backend and assert on the byte cache directly.
  return { service, thumbnails, ownsWindow, show, hide, applySettings, start,
    // B01 (plan item 05): the private clipboard publication used by screenshots. It is a
    // direct native write (no history entry, works with history disabled) and it answers a
    // receipt, so the capture domain never has to guess whether the pixels landed.
    publishImage(input = {}) {
      return service.publishImage(input)
    },
    canPublishImage: () => typeof service.publishImage === 'function',
    // B05: the status IPC and clipboard:init both carry the derived capacity
    // view; nothing in the native protocol changed.
    statusSnapshot,
    statusSnapshotFor,
    requiresSelectionHook: () => Boolean(service.child),
    applyGameMode(enabled) { if (enabled) hide(); return service.setReason('game-mode', enabled) },
    notifyAppearance() { if (!feedback.active) send('clipboard:init', appearance()) },
    async quiesce() { release(); await service.quiesce() },
    // C03: a finished migration is one of the out-of-band events; once the
    // serialized reconcile is done, ask for one immediate health check so the
    // next open cannot show a revision older than the migrated dataset.
    async resume() { await service.setReason('migration', false); return service.notifyHealth('migration') },
    isShutdownComplete: () => shutdownComplete,
    dispose() {
      if (shutdownPromise) return shutdownPromise
      disposed = true; release()
      // The locally owned OCR sidecar is not known to main.js, so this domain is
      // the only owner that can stop it; the injected service (tests / a future
      // main.js wiring) is left alone because its owner disposes it.
      stopLocalOcr()
      resetClipboardPublisher()
      for (const [event, listener] of powerListeners) powerMonitor.removeListener(event, listener)
      shutdownPromise = service.dispose().finally(() => { shutdownComplete = true })
      return shutdownPromise
    }
  }
}

// N02 wiring suggestion (main.js is Lead-owned and outside this ticket's write
// scope; it is at its H05 ceiling of 1205 lines, so one line has to be freed before
// wiring):
//   createClipboardDomain({
//     ...,
//     getPinDomain: () => pinDomain,        // makes the pin action create a real desktop pin
//     getOcrService: () => getOcrService()  // reuses the hot-started OCR sidecar, no duplicate
//   })
// With both resolvers injected the two fallbacks in this domain become dead code:
// imagePin() calls pinDomain.createPinWindow(bytes, { source: 'clipboard' }) and
// resolveOcrService() returns the shared service. Until then the pin action degrades
// to the exclusion-marked clipboard copy described next to imagePin(), and OCR runs
// on a short-lived local OcrService instance bounded by OCR_ACTION_IDLE_MS.
module.exports = { createClipboardDomain, PREVIEW_CONCURRENCY, PREVIEW_TOKEN_LIMIT, PREVIEW_TTL_MS }
