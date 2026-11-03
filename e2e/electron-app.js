const path = require('node:path')
const { _electron: electron } = require('playwright')

const projectRoot = path.resolve(__dirname, '..')
const electronPath = require('electron')

function formatConsoleMessage(message) {
  try { return `${message.type()}: ${message.text()}` } catch { return String(message || '') }
}

async function launchHighlighter({ dataRoot, artifactsDir, extraEnv = {}, savePaths = [] }) {
  if (!path.isAbsolute(dataRoot)) throw new Error('Highlighter E2E requires an absolute data root')
  if (extraEnv && typeof extraEnv !== 'object') throw new Error('Highlighter E2E extraEnv must be an object')
  const issues = []
  const savePath = path.join(dataRoot, 'diagnostics.zip')
  // Extra save-dialog targets, consumed in order. An empty queue keeps the historical
  // diagnostics.zip fallback, so every existing spec is unaffected. The recording spec
  // queues `<dataRoot>/exports/recording-N.mp4` entries before clicking Export.
  const initialSavePaths = Array.isArray(savePaths)
    ? savePaths.filter((item) => typeof item === 'string' && path.isAbsolute(item))
    : []
  // This development host is a confined session where Chromium's own sandbox
  // cannot start. A normal desktop/CI shell keeps the sandbox on; the opt-in
  // escape hatch below is never enabled by the product code.
  const noSandbox = process.env.HIGHLIGHTER_E2E_NO_SANDBOX === '1'
  const launchArgs = noSandbox ? ['--no-sandbox', projectRoot] : [projectRoot]
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: launchArgs,
    cwd: projectRoot,
    artifactsDir,
    chromiumSandbox: !noSandbox,
    timeout: 40_000,
    env: {
      ...process.env,
      HIGHLIGHTER_E2E: '1',
      HIGHLIGHTER_E2E_DATA_ROOT: dataRoot,
      HIGHLIGHTER_E2E_FAKE_EVERYTHING: '1',
      // The recording spec opts into the main-process synthetic capture source for the
      // same reason the sandbox is disabled: this automation host cannot initialise DXGI
      // desktop duplication, so a real getDisplayMedia stream always fails here.
      ...extraEnv,
      // The usage page only scans after the user enables it, but when a spec does
      // enable it the scan must read the committed fixture home, never the real
      // %USERPROFILE%. The feature honors this override before app.getPath().
      HIGHLIGHTER_USAGE_HOME: path.join(projectRoot, 'test', 'fixtures', 'usage', 'home')
    }
  })

  await electronApp.evaluate(({ app, dialog }, options) => {
    globalThis.__highlighterE2eProcessFailures = []
    globalThis.__highlighterE2eSaveQueue = options.savePaths.slice()
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
    dialog.showSaveDialog = async () => {
      const next = globalThis.__highlighterE2eSaveQueue.shift()
      return { canceled: false, filePath: next || options.savePath }
    }
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, { savePath, savePaths: initialSavePaths })

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

  const pagesMatching = (urlFragment) => electronApp.windows().filter((page) => page.url().includes(urlFragment))

  // Waits for a window whose URL contains `urlFragment`, attaches the issue capture, and
  // returns the Playwright page. Used by the recording spec for the control bar window and
  // the editor window, both of which are created on demand.
  async function waitForWindow(urlFragment, timeout = 30_000) {
    const existing = pagesMatching(urlFragment)
    const page = existing.length
      ? existing[existing.length - 1]
      : await electronApp.waitForEvent('window', {
          predicate: (candidate) => candidate.url().includes(urlFragment),
          timeout
        })
    attachPage(page)
    return page
  }

  return {
    electronApp,
    mainWindow,
    dataRoot,
    savePath,
    pagesMatching,
    waitForWindow,
    async queueSavePaths(paths) {
      const absolute = (Array.isArray(paths) ? paths : []).filter((item) => typeof item === 'string' && path.isAbsolute(item))
      await electronApp.evaluate((_electron, next) => {
        globalThis.__highlighterE2eSaveQueue.push(...next)
      }, absolute)
    },
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
