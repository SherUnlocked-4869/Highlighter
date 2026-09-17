'use strict'

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
    getSearchFileIcon
  } = deps

  let searchWindow = null

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
      search: settings.search
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
        searchWindow.hide()
        return searchWindow
      }
      showSearchWindow()
      return searchWindow
    }
    const pagePath = path.join(rootDirectory, 'search', 'search.html')
    const win = createLocalWindow(pagePath, {
      width: 840,
      height: 620,
      minWidth: 620,
      minHeight: 420,
      frame: false,
      show: false,
      title: 'Highlighter 本地搜索',
      backgroundColor: '#f5f6f8',
      webPreferences: {
        preload: path.join(rootDirectory, 'preload-search.js')
      }
    })
    searchWindow = win
    win._searchInit = getSearchWindowInitPayload()
    positionSearchWindow(win)
    win.loadFile(pagePath)
    win.on('blur', () => {
      if (searchWindow === win && !win.isDestroyed() && win.isVisible()) win.hide()
    })
    win.on('closed', () => { if (searchWindow === win) searchWindow = null })
    return win
  }

  function hideSearchWindow() {
    if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
      searchWindow.hide()
    }
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
        const win = event.sender && require('electron').BrowserWindow.fromWebContents(event.sender)
        if (!win || win !== searchWindow || win.isDestroyed()) return
        event.sender.send('search:init', win._searchInit || getSearchWindowInitPayload())
        if (!win.isVisible()) win.show()
        win.focus()
      },
      close: (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win && win === searchWindow && !win.isDestroyed() && win.isVisible()) win.hide()
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
