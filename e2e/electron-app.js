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
      HIGHLIGHTER_E2E_DATA_ROOT: dataRoot,
      HIGHLIGHTER_E2E_FAKE_EVERYTHING: '1',
      // The usage page only scans after the user enables it, but when a spec does
      // enable it the scan must read the committed fixture home, never the real
      // %USERPROFILE%. The feature honors this override before app.getPath().
      HIGHLIGHTER_USAGE_HOME: path.join(projectRoot, 'test', 'fixtures', 'usage', 'home')
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
  // D2-2（S14）把设置页拆成 18 个脚本后，"静态外壳可见"与"路由已接线"之间出现了一个可观测的
  // 窗口：`.window-shell` 是 config.html 里的静态节点，HTML 一解析完就可见，而导航点击处理与
  // renderRoute() 要等最后一个脚本（config.js）跑完、且 getSettings() 回来后才装上。
  // 只等静态外壳会让"第一次点击导航"偶发落空（#pageTitle 一直不变）。
  // 首页真正渲染出内容（.function-row 由 renderHome 生成）才证明整条链路已就绪。
  await mainWindow.locator('#view .function-row').first().waitFor({ state: 'visible', timeout: 30_000 })

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
