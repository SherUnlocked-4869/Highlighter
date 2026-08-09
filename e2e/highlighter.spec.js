const fs = require('node:fs')
const path = require('node:path')
const { test, expect } = require('./fixtures')

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

  await navigate(page, 'settings-hotkeys', '热键设置')
  await expect(page.locator('[data-shortcut="screenshot"]')).toHaveText('F1')

  await navigate(page, 'about', '关于')
  await expect(page.locator('.about')).toContainText('版本 2.1.0-beta.0')
  await expect(page.locator('.about')).toContainText('开发环境')
  await expect(page.locator('.update-card')).toContainText('当前运行方式不支持应用内更新')
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('settings persist through the real preload and authorized IPC surface', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'appearance', '外观配色')
  await page.locator('#theme').selectOption('dark')
  await page.locator('#mainColor').fill('#2563eb')
  await page.getByRole('button', { name: '保存外观' }).click()
  await expect(page.locator('#toast')).toHaveText('设置已保存')

  const persisted = await page.evaluate(() => window.electronAPI.getSettings())
  expect(persisted.theme).toBe('dark')
  expect(persisted.mainColor).toBe('#2563eb')

  await navigate(page, 'home', '快捷功能')
  await navigate(page, 'appearance', '外观配色')
  await expect(page.locator('#theme')).toHaveValue('dark')
  await expect(page.locator('#mainColor')).toHaveValue('#2563eb')
  await expect(page.locator('body')).toHaveClass(/dark/)
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('main-context dialog stubs support diagnostics and the close button hides cleanly', async ({ highlighter }) => {
  const { mainWindow: page, savePath } = highlighter
  await navigate(page, 'settings-system', '系统设置')
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
