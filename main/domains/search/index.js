'use strict'

const { windowBackdropColor, trackWindowBackdrop } = require('../../services/window-backdrop')
const { createIdleReclaimer } = require('../../services/idle-reclaimer')

// W5 (M2 step): the search window is hidden most of its life, so once it has been
// hidden for a minute it gives its renderer process back and is rebuilt on demand.
// `windowReleaseMs: 0` restores the old "hide and keep warm" behaviour.
const SEARCH_WINDOW_RELEASE_MS = 60000
// The retained query mirror is deliberately small and validated: it is restored
// into a fresh window, never written to settings.
const RESTORABLE_KEYWORD_MAX_LENGTH = 2048
// Keep in sync with search/search-utils.js SORT_OPTIONS (the renderer owns the
// labels; the main process only needs the persisted values).
const RESTORABLE_SORT_MODES = new Set([
  'modified-desc',
  'modified-asc',
  'name-asc',
  'name-desc',
  'path-asc',
  'path-desc',
  'size-asc',
  'size-desc'
])

function createSearchDomain(deps) {
  const {
    path,
    rootDirectory,
    screen,
    clipboard,
    nativeTheme,
    shell,
    BrowserWindow,
    createLocalWindow,
    getSettings,
    log,
    assertGameModeDisabled,
    isGameModeEnabled,
    getEverythingService,
    positionAutomationWindow,
    getSearchFileIcon,
    windowReleaseMs = SEARCH_WINDOW_RELEASE_MS,
    setTimer,
    clearTimer,
    now
  } = deps

  let searchWindow = null
  // W5: the last state the renderer reported. Retained across a reclaim (that is
  // what makes the rebuilt window usable) but never persisted to settings.
  let lastSearchState = null
  const releaseTimeoutMs = Number.isFinite(Number(windowReleaseMs))
    ? Math.max(0, Number(windowReleaseMs))
    : SEARCH_WINDOW_RELEASE_MS

  function reclaimSearchWindow() {
    const win = searchWindow
    searchWindow = null
    if (!win || win.isDestroyed()) return false
    let destroyed = false
    try {
      win.destroy()
      destroyed = true
    } catch (error) {
      log('Search window reclaim failed:', error.message)
    }
    // The idle reclaimer already logs reclaim-fired/reclaim-skipped; this line
    // says what the domain did with the window (or why it could not).
    log('Search window reclaimed:', { destroyed, releaseMs: releaseTimeoutMs })
    return destroyed
  }

  const windowReclaimer = createIdleReclaimer({
    name: 'search-window',
    timeoutMs: releaseTimeoutMs,
    shouldReclaim: () => searchWindow != null && !searchWindow.isDestroyed() && !searchWindow.isVisible(),
    onReclaim: () => reclaimSearchWindow(),
    setTimer,
    clearTimer,
    now,
    log
  })

  function getRestorableCategoryIds(searchSettings) {
    const categories = Array.isArray(searchSettings?.categories) ? searchSettings.categories : []
    const ids = new Set(categories
      .filter((category) => category && typeof category.id === 'string' && category.id)
      .map((category) => category.id))
    if (!ids.size) ids.add('all')
    return ids
  }

  // Per-field validation: an out-of-range/unknown field is ignored instead of
  // throwing, and the previously retained value stays. Invalid payloads must not
  // be able to crash the main process through a renderer message.
  function sanitizeSearchState(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const searchSettings = (getSettings() || {}).search || {}
    const categoryIds = getRestorableCategoryIds(searchSettings)
    const next = {
      keyword: '',
      categoryId: categoryIds.has('all') ? 'all' : [...categoryIds][0],
      sortMode: RESTORABLE_SORT_MODES.has(searchSettings.sortMode) ? searchSettings.sortMode : 'modified-desc',
      matchPath: searchSettings.matchPath !== false,
      ...(lastSearchState || {})
    }
    let accepted = false
    if (typeof payload.keyword === 'string' && payload.keyword.length <= RESTORABLE_KEYWORD_MAX_LENGTH) {
      next.keyword = payload.keyword
      accepted = true
    }
    if (typeof payload.categoryId === 'string' && categoryIds.has(payload.categoryId)) {
      next.categoryId = payload.categoryId
      accepted = true
    }
    if (typeof payload.sortMode === 'string' && RESTORABLE_SORT_MODES.has(payload.sortMode)) {
      next.sortMode = payload.sortMode
      accepted = true
    }
    if (typeof payload.matchPath === 'boolean') {
      next.matchPath = payload.matchPath
      accepted = true
    }
    return accepted ? next : null
  }

  function hideAndScheduleRelease() {
    const win = searchWindow
    if (!win || win.isDestroyed()) return false
    if (win.isVisible()) win.hide()
    // Arming twice replaces the previous timer, so a repeated hide cannot stack
    // timers (and therefore cannot destroy the window twice).
    windowReclaimer.arm()
    return true
  }

  function ownsWindow(win) {
    return win != null && win === searchWindow
  }

  function getCurrentWindow() {
    return searchWindow
  }

  function getSearchWindowInitPayload() {
    const settings = getSettings()
    return {
      mainColor: settings.mainColor || '#e5a44c',
      dark: settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors),
      search: settings.search,
      // W5: a rebuilt window gets the query/category/sort back; `null` on a fresh
      // launch keeps the renderer's existing behaviour byte-for-byte.
      restore: lastSearchState ? { ...lastSearchState } : null
    }
  }

  function positionSearchWindow(win) {
    try {
      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      const [width, height] = win.getSize()
      const area = display.workArea
      win.setPosition(
        Math.round(area.x + Math.max(0, (area.width - width) / 2)),
        Math.round(area.y + Math.max(0, (area.height - height) / 3)),
        false
      )
    } catch (error) {
      log('Search window positioning failed:', error.message)
    }
    positionAutomationWindow(win)
  }

  function showSearchWindow() {
    if (isGameModeEnabled()) return false
    // Any visible/open path cancels a pending release.
    windowReclaimer.disarm('search-window-shown')
    const win = searchWindow
    if (!win || win.isDestroyed()) return false
    win.webContents.send('search:init', getSearchWindowInitPayload())
    if (!win.isVisible()) win.show()
    win.focus()
    return true
  }

  function createSearchWindow() {
    assertGameModeDisabled()
    if (searchWindow && !searchWindow.isDestroyed()) {
      if (searchWindow.isVisible()) {
        hideAndScheduleRelease()
        return searchWindow
      }
      showSearchWindow()
      return searchWindow
    }
    const pagePath = path.join(rootDirectory, 'search', 'search.html')
    const win = createLocalWindow(pagePath, {
      role: 'search',
      width: 840,
      height: 620,
      minWidth: 620,
      minHeight: 420,
      frame: false,
      show: false,
      title: 'Highlighter 本地搜索',
      // The search shell cuts its own rounded corners, so the cut-outs show this
      // native colour: the shared --bg token, like every other window.
      backgroundColor: windowBackdropColor(getSettings(), nativeTheme),
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-search.js')
      }
    })
    searchWindow = trackWindowBackdrop(win)
    // A rebuilt window is created after a reclaim, so this payload carries the
    // retained query state (`restore`) for the renderer to apply.
    win._searchInit = getSearchWindowInitPayload()
    positionSearchWindow(win)
    win.loadFile(pagePath)
    win.on('blur', () => {
      if (searchWindow === win) hideAndScheduleRelease()
    })
    win.on('closed', () => {
      if (searchWindow === win) searchWindow = null
      windowReclaimer.disarm('search-window-closed')
    })
    return win
  }

  function hideSearchWindow() {
    return hideAndScheduleRelease()
  }

  function notifyStatusChanged(status) {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.webContents.send('search:status-changed', status)
    }
  }

  function notifySettingsChanged() {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.webContents.send('search:settings-changed', getSearchWindowInitPayload())
    }
  }

  async function openSearchTarget(target, { reveal = false } = {}) {
    const value = String(target || '').trim()
    if (!value || value.includes('\0') || !path.isAbsolute(value)) {
      throw new Error('无效的文件路径')
    }
    if (reveal) {
      shell.showItemInFolder(value)
      return { ok: true }
    }
    const result = await shell.openPath(value)
    if (result) throw new Error(result)
    return { ok: true }
  }

  function createSearchController() {
    return {
      ready: (event) => {
        const win = event.sender && BrowserWindow.fromWebContents(event.sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return
        // The payload is rebuilt on every ready so a window recreated after a
        // reclaim receives the retained `restore` state rather than a stale copy.
        windowReclaimer.disarm('search-window-ready')
        event.sender.send('search:init', getSearchWindowInitPayload())
        if (!win.isVisible()) win.show()
        win.focus()
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return
        hideAndScheduleRelease()
      },
      // W5: the renderer mirrors the query/category/sort through the preload, and
      // the domain retains it for the next rebuild. Only the search window may
      // write it; invalid fields are dropped without throwing.
      saveState: (event, payload) => {
        const sender = event && event.sender
        if (!sender) return false
        const win = BrowserWindow.fromWebContents(sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return false
        const next = sanitizeSearchState(payload)
        if (!next) return false
        lastSearchState = next
        return true
      },
      query: (_event, payload) => {
        const search = String(payload?.search ?? '')
        if (search.length > 2048) throw new Error('查询内容过长')
        return getEverythingService().query({
          search,
          maxResults: payload?.maxResults,
          sortMode: payload?.sortMode,
          matchPath: payload?.matchPath
        })
      },
      getStatus: () => getEverythingService().refreshStatus(),
      ensureReady: () => getEverythingService().ensureReady(),
      openPath: (_event, payload) => openSearchTarget(payload?.path),
      revealPath: (_event, payload) => openSearchTarget(payload?.path, { reveal: true }),
      copyPath: (_event, payload) => {
        const value = String(payload?.path || '')
        if (!value || value.includes('\0')) throw new Error('无效的文件路径')
        clipboard.writeText(value)
        return { ok: true }
      },
      getFileIcon: (_event, payload) => getSearchFileIcon(payload?.path)
    }
  }

  return {
    ownsWindow,
    getCurrentWindow,
    getLastSearchState: () => (lastSearchState ? { ...lastSearchState } : null),
    getSearchWindowInitPayload,
    createSearchWindow,
    showSearchWindow,
    hideSearchWindow,
    notifyStatusChanged,
    notifySettingsChanged,
    openSearchTarget,
    createSearchController
  }
}

module.exports = {
  createSearchDomain
}
