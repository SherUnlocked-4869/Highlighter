const path = require('node:path')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '..')
const electronPath = require('electron')

function formatConsoleMessage(message) {
  try { return `${message.type()}: ${message.text()}` } catch { return String(message || '') }
}

async function launchHighlighter({ dataRoot, artifactsDir }) {
  if (!path.isAbsolute(dataRoot)) throw new Error('Highlighter E2E requires an absolute data root')
  const issues = []
  const savePath = path.join(dataRoot, 'diagnostics.zip')
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [projectRoot],
    cwd: projectRoot,
    artifactsDir,
    chromiumSandbox: true,
    timeout: 40_000,
    env: {
      ...process.env,
      HIGHLIGHTER_E2E: '1',
      HIGHLIGHTER_E2E_DATA_ROOT: dataRoot
    }
  })

  await electronApp.evaluate(({ app, dialog }, options) => {
    globalThis.__highlighterE2eProcessFailures = []
    app.on('render-process-gone', (_event, webContents, details) => {
      globalThis.__highlighterE2eProcessFailures.push({
        type: 'renderer',
        reason: details.reason,
        exitCode: details.exitCode,
        url: webContents?.getURL?.() || ''
      })
    })
    app.on('child-process-gone', (_event, details) => {
      globalThis.__highlighterE2eProcessFailures.push({
        type: details.type || 'child',
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: options.savePath })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, { savePath })

  const attachPage = (page) => {
    if (page.__highlighterIssueCaptureAttached) return
    page.__highlighterIssueCaptureAttached = true
    page.on('console', (message) => {
      if (message.type() === 'error') issues.push({ type: 'renderer-console', message: formatConsoleMessage(message) })
    })
    page.on('pageerror', (error) => issues.push({ type: 'pageerror', message: error.message || String(error) }))
    page.on('crash', () => issues.push({ type: 'page-crash', message: page.url() }))
  }
  electronApp.on('window', attachPage)
  electronApp.on('console', (message) => {
    if (message.type() === 'error') issues.push({ type: 'main-console', message: formatConsoleMessage(message) })
  })
  electronApp.windows().forEach(attachPage)

  let mainWindow = electronApp.windows().find((page) => page.url().includes('/config/config.html'))
  if (!mainWindow) {
    mainWindow = await electronApp.waitForEvent('window', {
      predicate: (page) => page.url().includes('/config/config.html'),
      timeout: 30_000
    })
  }
  attachPage(mainWindow)
  await mainWindow.locator('.window-shell').waitFor({ state: 'visible' })

  return {
    electronApp,
    mainWindow,
    dataRoot,
    savePath,
    async getUnexpectedErrors() {
      const processFailures = await electronApp.evaluate(() => globalThis.__highlighterE2eProcessFailures || [])
      return [...issues, ...processFailures]
    },
    async isMainWindowVisible() {
      return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => (
        win.webContents.getURL().includes('/config/config.html') && win.isVisible()
      )))
    },
    async activate() {
      await electronApp.evaluate(({ app }) => app.emit('activate'))
    },
    async close() {
      await electronApp.close().catch(() => {})
    }
  }
}

module.exports = { launchHighlighter }
