const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const Store = require('electron-store')

// --- Logging ---
function log(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  console.log(msg)
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// --- Single instance ---
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) { app.quit(); process.exit(0) }
app.on('second-instance', () => createConfigWindow())

// --- Store ---
const store = new Store({ defaults: { apiKey: '' } })

// --- State ---
let configWindow = null
let toolbarWindow = null
let actionWindow = null
let selectionHook = null
let isProcessing = false
let currentStreamController = null
let tray = null
let lastToolbarPos = null
let pinnedCount = 0
let actionWindows = []  // Track action windows for pin management
const MAX_PINNED = 3

const TOOLBAR_W = 180
const TOOLBAR_H = 40
const isWin = process.platform === 'win32'

// --- Tray ---
function createTrayIcon() {
  var iconPath = path.join(__dirname, 'assets', 'icon.png')
  var icon
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (!icon || icon.isEmpty()) throw new Error('empty')
  } catch (e) { icon = nativeImage.createEmpty() }
  tray = new Tray(icon.resize({ width: 32, height: 32 }))
  tray.setToolTip('划词助手')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开配置', click: createConfigWindow },
    { type: 'separator' },
    { label: '退出', click: () => { if (selectionHook) { selectionHook.cleanup(); selectionHook = null } app.quit() } }
  ]))
  tray.on('double-click', createConfigWindow)
}

// --- Windows ---
function createConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) { configWindow.focus(); return }
  configWindow = new BrowserWindow({
    width: 480, height: 460, resizable: false,
    title: '划词助手 - 配置', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  configWindow.loadFile(path.join(__dirname, 'config', 'config.html'))
  configWindow.on('closed', () => { configWindow = null })
}

function createToolbarWindow() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) return
  // Match Cherry Studio: frameless, transparent, focusable:false on Win
  toolbarWindow = new BrowserWindow({
    width: TOOLBAR_W, height: TOOLBAR_H,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    focusable: !isWin,
    show: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload-toolbar.js'), contextIsolation: true, nodeIntegration: false }
  })
  toolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  toolbarWindow.setAlwaysOnTop(true, 'screen-saver')
  toolbarWindow.loadFile(path.join(__dirname, 'toolbar', 'toolbar.html'))
}

function createActionWindow() {
  var win = new BrowserWindow({
    width: 550, height: 520, minWidth: 380, minHeight: 300,
    title: '划词助手', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.loadFile(path.join(__dirname, 'action', 'action.html'))
  win._isPinned = false
  win.on('closed', () => {
    if (win._isPinned) { pinnedCount--; win._isPinned = false }
    if (isProcessing && actionWindow === win) {
      if (currentStreamController) currentStreamController.cancelled = true
      isProcessing = false; currentStreamController = null
    }
    if (actionWindow === win) actionWindow = null
  })
  win.on('blur', () => {
    if (!win._isPinned && win && !win.isDestroyed()) win.close()
  })
  actionWindow = win
  return win
}

// --- Selection Hook ---
function initSelectionHook() {
  try {
    const SelectionHook = require('selection-hook')
    if (selectionHook && selectionHook.isRunning()) return true
    selectionHook = new SelectionHook()
    selectionHook.on('text-selection', handleTextSelection)
    selectionHook.on('mouse-down', (data) => {
      // Only hide if click is outside toolbar
      if (toolbarWindow && toolbarWindow.isVisible()) {
        const bounds = toolbarWindow.getBounds()
        const mx = data.x, my = data.y
        // Convert to logical pixels on Windows
        let checkX = mx, checkY = my
        if (isWin) {
          const pt = screen.screenToDipPoint({ x: mx, y: my })
          checkX = pt.x; checkY = pt.y
        }
        const inside = checkX >= bounds.x && checkX <= bounds.x + bounds.width &&
                        checkY >= bounds.y && checkY <= bounds.y + bounds.height
        if (!inside) hideToolbar()
      }
    })
    selectionHook.on('key-down', () => hideToolbar())
    selectionHook.on('mouse-wheel', () => hideToolbar())
    selectionHook.on('error', (err) => log('Hook error:', err.message))
    selectionHook.start({ debug: false, enableClipboard: true })
    log('Selection hook started')
    return true
  } catch (err) { log('Hook start failed:', err.message); return false }
}

function shouldFilterApp(programName) {
  if (!programName) return false
  var name = programName.toLowerCase()
  // Only filter our own windows
  if (name.includes('划词助手') || name.includes('huacizhushou')) return true
  return false
}

function showToolbar(x, y, text) {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) createToolbarWindow()
  lastToolbarPos = { x, y }
  log('showToolbar at', x, y, 'text:', text.substring(0, 30))
  toolbarWindow.setPosition(Math.round(x), Math.round(y))
  toolbarWindow.showInactive()
  toolbarWindow.webContents.send('selection:text', { text })
}

function hideToolbar() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.hide()
}

// === Cherry Studio Positioning (exact match) ===

function handleTextSelection(data) {
  if (isProcessing) return
  if (!data || !data.text) return
  const text = data.text.trim()
  if (!text || text.length > 5000) return
  if (shouldFilterApp(data.programName)) return

  const result = getRefPointAndOrientation(data)
  if (!result) return
  const pos = calculateToolbarPosition(result.refPoint, result.orientation)
  showToolbar(pos.x, pos.y, text)
}

function getRefPointAndOrientation(data) {
  const cursor = screen.getCursorScreenPoint()
  let refX = cursor.x, refY = cursor.y
  let orientation = 'bottomMiddle'
  const pl = data.posLevel || 0

  if (pl === 0 /* NONE */) {
    orientation = 'bottomMiddle'
  } else if (pl === 1 /* MOUSE_SINGLE */) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y + 16 }
    orientation = 'bottomMiddle'
  } else if (pl === 2 /* MOUSE_DUAL */) {
    if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
      const d = data.endBottom.y - data.startBottom.y
      if (d > 10) orientation = 'bottomLeft'
      else if (d < -10) orientation = 'topRight'
      else orientation = 'bottomRight'
    }
  } else /* SEL_FULL/DETAILED */ {
    if (validCoord(data.endBottom)) { refX = data.endBottom.x; refY = data.endBottom.y + 4 }
    else if (validCoord(data.mousePosEnd)) { refX = data.mousePosEnd.x; refY = data.mousePosEnd.y }
    if (validCoord(data.startBottom) && validCoord(data.endBottom)) {
      const d = data.endBottom.y - data.startBottom.y
      if (d > 0) orientation = 'bottomLeft'
      else if (d < 0) orientation = 'topRight'
      else orientation = 'bottomRight'
    }
  }

  // Convert physical to logical pixels on Windows (like Cherry Studio does)
  if (isWin) {
    const pt = screen.screenToDipPoint({ x: refX, y: refY })
    refX = pt.x; refY = pt.y
  }

  return { refPoint: { x: refX, y: refY }, orientation }
}

function validCoord(p) { return p && p.x > -90000 && p.x < 90000 && p.y > -90000 && p.y < 90000 }

function calculateToolbarPosition(refPoint, orientation) {
  const tw = TOOLBAR_W, th = TOOLBAR_H
  let x, y

  switch (orientation) {
    case 'topLeft': x = refPoint.x - tw; y = refPoint.y - th; break
    case 'topRight': x = refPoint.x; y = refPoint.y - th; break
    case 'topMiddle': x = refPoint.x - tw / 2; y = refPoint.y - th; break
    case 'bottomLeft': x = refPoint.x - tw; y = refPoint.y; break
    case 'bottomRight': x = refPoint.x; y = refPoint.y; break
    case 'bottomMiddle': x = refPoint.x - tw / 2; y = refPoint.y; break
    default: x = refPoint.x - tw / 2; y = refPoint.y - th / 2
  }

  const display = screen.getDisplayNearestPoint(refPoint)
  const { x: sx, y: sy, width: sw, height: sh } = display.workArea

  const exceedsTop = y < sy
  const exceedsBottom = y > sy + sh - th

  x = Math.round(Math.max(sx, Math.min(x, sx + sw - tw)))
  y = Math.round(Math.max(sy, Math.min(y, sy + sh - th)))

  if (exceedsTop) y += 32
  if (exceedsBottom) y -= 32

  return { x, y }
}

// === Stream ===
async function streamToWindow(win, action, text) {
  const { createTranslateStream, createExplainStream } = require('./deepseek')
  const apiKey = store.get('apiKey', '')
  const isTranslate = action === 'translate'
  log('Starting stream:', action, 'text length:', text.length)

  try {
    const stream = await (isTranslate ? createTranslateStream(apiKey, text) : createExplainStream(apiKey, text))
    for await (const chunk of stream) {
      if (currentStreamController?.cancelled) return
      const d = chunk.choices?.[0]?.delta
      if (!isTranslate && d?.reasoning_content) win.webContents.send('stream:reasoning', { content: d.reasoning_content })
      if (d?.content) win.webContents.send('stream:data', { content: d.content })
    }
    win.webContents.send('stream:done')
    log('Stream done')
  } catch (err) {
    log('Stream error:', err.message)
    win.webContents.send('stream:error', { error: err.message || '请求失败' })
  }
}

// === IPC ===
ipcMain.handle('config:get-api-key', () => store.get('apiKey', ''))
ipcMain.handle('config:save-api-key', (_e, key) => { store.set('apiKey', key); return true })
ipcMain.handle('config:test-connection', async (_e, key) => {
  try { return await require('./deepseek').validateApiKey(key) } catch { return false }
})
ipcMain.handle('shell:open-external', (_e, url) => { shell.openExternal(url) })

ipcMain.on('toolbar:action', (_e, { action, text }) => {
  log('toolbar:action received:', action, 'text:', text ? text.substring(0, 30) : '(none)')
  try {
    if (isProcessing) { log('Already processing, ignoring'); return }
    const apiKey = store.get('apiKey', '')
    if (!apiKey) { log('No API key'); createConfigWindow(); hideToolbar(); return }

    isProcessing = true
    currentStreamController = { cancelled: false }
    hideToolbar()

    const win = createActionWindow()

    // Position near where the toolbar was
    if (lastToolbarPos) {
      const display = screen.getDisplayNearestPoint(lastToolbarPos)
      const { width: sw, height: sh, x: sx, y: sy } = display.workArea
      const [ww, wh] = win.getSize()
      let ax = lastToolbarPos.x - ww / 2
      let ay = lastToolbarPos.y + 48
      // Clamp to screen
      if (ay + wh > sy + sh) ay = lastToolbarPos.y - wh - 12
      ax = Math.max(sx, Math.min(ax, sx + sw - ww))
      ay = Math.max(sy, Math.min(ay, sy + sh - wh))
      win.setPosition(Math.round(ax), Math.round(ay))
    }

    win.webContents.send('action:start', { type: action, text })
    log('action:start sent, window created')

    streamToWindow(win, action, text)
    win.show()
    win.focus()
    log('Window shown')
  } catch (err) {
    log('toolbar:action error:', err.message, err.stack)
    isProcessing = false; currentStreamController = null
  }
})

ipcMain.on('toolbar:close', hideToolbar)
ipcMain.on('window:toggle-pin', (event, shouldPin) => {
  var win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (shouldPin) {
    if (pinnedCount >= MAX_PINNED) {
      event.sender.send('window:pin-denied', { max: MAX_PINNED })
      return
    }
    if (!win._isPinned) {
      win._isPinned = true
      pinnedCount++
      win.setAlwaysOnTop(true, 'floating')
    }
  } else {
    if (win._isPinned) {
      win._isPinned = false
      pinnedCount--
      win.setAlwaysOnTop(false)
    }
  }
})
ipcMain.on('debug:text-received', (_e, data) => {
  log('DEBUG: toolbar received text, length:', data.len)
})
ipcMain.on('stream:cancel', () => {
  if (currentStreamController) currentStreamController.cancelled = true
  isProcessing = false; currentStreamController = null
})
ipcMain.on('stream:finish', () => {
  isProcessing = false; currentStreamController = null
})
ipcMain.on('config:start-hook', (_e, key) => {
  store.set('apiKey', key)
  if (!selectionHook || !selectionHook.isRunning()) initSelectionHook()
})

// === App ===
app.whenReady().then(() => {
  log('App ready')
  createTrayIcon()
  createToolbarWindow()
  createConfigWindow()
  const apiKey = store.get('apiKey', '')
  if (apiKey) {
    initSelectionHook()
    if (configWindow && !configWindow.isDestroyed()) configWindow.close()
  }
})

app.on('window-all-closed', () => {})
app.on('activate', createConfigWindow)
app.on('before-quit', () => {
  if (tray) { tray.destroy(); tray = null }
  if (selectionHook) { selectionHook.cleanup(); selectionHook = null }
})
