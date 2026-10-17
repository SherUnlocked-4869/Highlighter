const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')
const { version } = require('../package.json')

async function navigate(page, route, title) {
  await page.locator(`[data-route="${route}"]`).click()
  await expect(page.locator('#pageTitle')).toHaveText(title)
}

test('first startup renders navigation, empty history, About version, and shortcut state', async ({ highlighter }) => {
  const { electronApp, mainWindow: page, dataRoot } = highlighter
  await expect(page.locator('#pageTitle')).toHaveText('快捷功能')
  await expect(page.locator('.function-row')).not.toHaveCount(0)
  expect(await electronApp.evaluate(({ app }) => app.getPath('userData'))).toBe(path.resolve(dataRoot))
  expect(fs.existsSync(path.join(dataRoot, 'config.json'))).toBe(true)

  await navigate(page, 'history', '截图历史')
  await expect(page.locator('#historyResults .empty')).toHaveText('没有符合条件的截图历史')
  await expect(page.locator('#historyLoadedCount')).toHaveText('0 项')

  await navigate(page, 'home', '快捷功能')
  await page.locator('[data-home-tab="shortcuts"]').click()
  await expect(page.locator('[data-shortcut="screenshot"]')).toHaveText('F1')

  await navigate(page, 'about', '关于')
  await expect(page.locator('.about')).toContainText(`版本 ${version}`)
  await expect(page.locator('.about')).toContainText('开发环境')
  await expect(page.locator('.about')).toContainText('软件更新已移至')

  // P3: the update card moved from About to Settings > General > Software update.
  await navigate(page, 'settings-general', '通用')
  await expect(page.locator('.update-card')).toContainText('当前运行方式不支持应用内更新')
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('selection toolbar renderer crash destroys the dead BrowserWindow', async ({ highlighter }) => {
  const { electronApp } = highlighter
  const result = await electronApp.evaluate(({ BrowserWindow }) => new Promise((resolve) => {
    const toolbar = BrowserWindow.getAllWindows().find((win) => (
      win.webContents.getURL().includes('/toolbar/toolbar.html')
    ))
    if (!toolbar) return resolve({ found: false })
    const toolbarId = toolbar.id
    const timeout = setTimeout(() => resolve({ found: true, closed: false, toolbarId }), 10000)
    toolbar.once('closed', () => {
      clearTimeout(timeout)
      setImmediate(() => resolve({
        found: true,
        closed: true,
        toolbarId,
        stillOpen: BrowserWindow.getAllWindows().some((win) => win.id === toolbarId)
      }))
    })
    toolbar.webContents.forcefullyCrashRenderer()
  }))

  expect(result).toEqual({
    found: true,
    closed: true,
    toolbarId: result.toolbarId,
    stillOpen: false
  })
})

test('settings persist through the real preload and authorized IPC surface', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'settings-general', '通用')
  await page.locator('#theme').selectOption('dark')
  await page.locator('#mainColor').fill('#2563eb')
  // Settings save on change: a blur commits the colour input.
  await page.locator('#mainColor').blur()
  await expect(page.locator('#toast')).toHaveText('设置已保存')

  const persisted = await page.evaluate(() => window.electronAPI.getSettings())
  expect(persisted.theme).toBe('dark')
  expect(persisted.mainColor).toBe('#2563eb')

  await navigate(page, 'home', '快捷功能')
  await navigate(page, 'settings-general', '通用')
  await expect(page.locator('#theme')).toHaveValue('dark')
  await expect(page.locator('#mainColor')).toHaveValue('#2563eb')
  await expect(page.locator('body')).toHaveClass(/dark/)
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('main-context dialog stubs support diagnostics and the close button hides cleanly', async ({ highlighter }) => {
  const { mainWindow: page, savePath } = highlighter
  await navigate(page, 'settings-system', '系统与数据')
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.locator('#diagnosticsPreview')).toBeVisible()
  await expect(page.locator('#diagnosticsPreview')).toContainText('"offline": true')

  await page.getByRole('button', { name: '导出 ZIP' }).click()
  await expect.poll(() => fs.existsSync(savePath)).toBe(true)
  await expect(page.locator('#toast')).toContainText('诊断包已导出')

  await page.locator('#close').click()
  await expect.poll(() => highlighter.isMainWindowVisible()).toBe(false)
  await highlighter.activate()
  await expect.poll(() => highlighter.isMainWindowVisible()).toBe(true)
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

// D2-2/D2-3/D2-5（S14）：render 函数拆到 config/routes/*.js 后，每个路由都要真的
// 能渲染。主壳的 renderRoute() 按 window.configRoutes 的 key 分派；漏挂一个文件或
// key 拼错都会退化成"点开是空白页"，而 npm test（纯 Node）看不到真实渲染结果。
test('every settings route renders content after the D2-2 route split', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  const routes = [
    ['home', '快捷功能', '.function-row'],
    ['translation', '翻译', '#translateNow'],
    ['chat', 'AI 对话', '#sendChat'],
    ['history', '截图历史', '#historyResults'],
    ['selection-toolbar', '划词工具', '#saveSelectionToolbar'],
    ['local-search', '本地搜索', '#searchStatus'],
    ['settings-general', '通用', '#theme'],
    ['settings-function', '截图与录制', '#nameTemplate'],
    ['models', 'AI 与模型', '#addModelProvider'],
    ['settings-system', '系统与数据', '#dataRoot'],
    ['about', '关于', '.about']
  ]
  for (const [route, title, selector] of routes) {
    await page.locator(`[data-route="${route}"]`).click()
    await expect(page.locator('#pageTitle')).toHaveText(title)
    await expect(page.locator(selector).first()).toBeVisible()
  }
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
