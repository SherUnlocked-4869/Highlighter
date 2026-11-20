'use strict'

const path = require('node:path')
const { registerDeviceBatteryIpc } = require('../ipc/device-battery-ipc')
const { createDeviceBatteryService, resolveDeviceBatteryExecutable } = require('./device-battery-service')

const ROUTE = 'device-battery'
const FEED = 'device-battery:changed'

function install({ ipcMain, app, powerMonitor, windowState, getMainWindow, stateDirectory, appRoot, log, spawnProcess, e2eContext, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let window = null
  let route = null
  let releaseWindow = () => {}
  let suspended = false
  let resumeTimer = null
  let disposed = false
  let quitting = false

  function visibleBatteryPage() {
    return !disposed && route === ROUTE && window && window === getMainWindow() &&
      !window.isDestroyed() && !window.webContents.isDestroyed() && window.isVisible() && !window.isMinimized()
  }

  const service = createDeviceBatteryService({
    getExecutable: () => resolveDeviceBatteryExecutable({ appRoot, resourcesPath: process.resourcesPath, packaged: app.isPackaged }),
    getStateDirectory: () => path.join(stateDirectory, 'device-battery'),
    spawnProcess: spawnProcess || (!app.isPackaged && e2eContext?.enabled && e2eContext.fakeDeviceBattery
      ? require('./e2e-fake-device-battery').spawnFakeDeviceBattery : undefined),
    log,
    setTimer,
    clearTimer,
    onSnapshot(snapshot) {
      if (!visibleBatteryPage()) return
      try { window.webContents.send(FEED, snapshot) } catch { /* window closed before delivery */ }
    }
  })

  function synchronize() { service.setActive(!suspended && Boolean(visibleBatteryPage())) }

  function invalidate() {
    route = null
    synchronize()
  }

  function attachWindow(win) {
    releaseWindow()
    window = win
    const contents = win.webContents
    const navigate = (event, _url, inPage, mainFrame) => {
      if ((event.isMainFrame ?? mainFrame) && !(event.isInPlace ?? inPage)) invalidate()
    }
    const detached = () => {
      releaseWindow()
      window = null
      invalidate()
    }
    const bindings = [
      ...['show', 'hide', 'minimize', 'restore'].map((event) => [win, event, synchronize]),
      [win, 'closed', detached],
      [contents, 'destroyed', detached],
      [contents, 'did-start-navigation', navigate],
      [contents, 'render-process-gone', invalidate]
    ]
    for (const [target, event, listener] of bindings) target.on(event, listener)
    releaseWindow = () => {
      for (const [target, event, listener] of bindings) target.removeListener(event, listener)
      releaseWindow = () => {}
    }
  }

  // Only reports which passed window:renderer-state validation reach here.
  // The route gate limits hardware work; the security boundary is secureIpcMain.
  const unsubscribe = windowState.subscribe((state) => {
    const win = getMainWindow()
    if (disposed || !win || win.isDestroyed()) return invalidate()
    if (win !== window) attachWindow(win)
    route = state.route
    synchronize()
  })

  function suspend() {
    suspended = true
    clearTimer(resumeTimer)
    synchronize()
  }

  function resume() {
    clearTimer(resumeTimer)
    if (!suspended) return
    // Windows device reconnection can lag resume. Don't enumerate while asleep.
    resumeTimer = setTimer(() => {
      suspended = false
      synchronize()
    }, 2_000)
  }

  function attachPowerEvents() {
    if (disposed) return
    powerMonitor.on('suspend', suspend)
    powerMonitor.on('resume', resume)
  }
  if (app.isReady()) attachPowerEvents()
  else app.once('ready', attachPowerEvents)

  registerDeviceBatteryIpc({
    ipcMain,
    getSnapshot: () => { synchronize(); return service.getSnapshot() },
    refresh: () => { synchronize(); return service.refresh() }
  })

  function shutdownBeforeQuit(event) {
    if (quitting) { event.preventDefault(); return true }
    if (disposed) return false
    disposed = true
    unsubscribe()
    releaseWindow()
    window = null
    clearTimer(resumeTimer)
    app.removeListener('ready', attachPowerEvents)
    if (app.isReady()) {
      powerMonitor.removeListener('suspend', suspend)
      powerMonitor.removeListener('resume', resume)
    }
    const drain = service.dispose()
    if (!drain) return false
    event.preventDefault()
    quitting = true
    const done = () => {
      if (!quitting) return
      quitting = false
      clearTimer(quitTimer)
      app.quit()
    }
    const quitTimer = setTimer(done, 3_200) // helper has a separate earlier kill deadline
    void drain.then(done)
    return true
  }

  return { beforeNavigate: (target) => { if (target !== ROUTE) invalidate() }, shutdownBeforeQuit }
}

module.exports = { install, FEED }
