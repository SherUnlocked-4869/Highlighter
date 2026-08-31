const path = require('node:path')
const { test, expect } = require('./fixtures')

const SCREENSHOT_DIR = path.join('test-results', 'local-search')

test('local search window queries Everything and renders results', async ({ highlighter }, testInfo) => {
  const { electronApp, mainWindow } = highlighter

  const searchPagePromise = electronApp.waitForEvent('window', {
    predicate: (page) => page.url().includes('/search/search.html'),
    timeout: 20_000
  })
  await mainWindow.evaluate(() => window.electronAPI.executeFunction('localSearch'))
  const searchPage = await searchPagePromise

  await expect(searchPage.locator('#searchInput')).toBeVisible()
  await expect(searchPage.locator('.category-tab').first()).toBeVisible()
  await expect(searchPage.locator('.category-tab', { hasText: '全部' })).toBeVisible()
  await expect(searchPage.locator('#emptyState')).toHaveText('输入关键字开始搜索')
  await expect(searchPage.locator('#statusText')).toContainText(/Everything 已就绪|正在|检测/, { timeout: 30_000 })
  await searchPage.screenshot({ path: path.join(SCREENSHOT_DIR, `${testInfo.project.name || 'e2e'}-initial.png`) })

  await searchPage.locator('#searchInput').fill('package.json')
  await expect(searchPage.locator('.result-row').first()).toBeVisible({ timeout: 20_000 })
  await expect(searchPage.locator('#countText')).toContainText(/共 \d+ 条结果/)
  await expect(searchPage.locator('.row-name').first()).toContainText('package.json', { ignoreCase: true })
  const resultCount = await searchPage.locator('.result-row').count()
  expect(resultCount).toBeGreaterThan(0)

  await searchPage.locator('#sortSelect').selectOption('name-asc')
  await expect(searchPage.locator('.result-row').first()).toBeVisible({ timeout: 20_000 })
  await searchPage.waitForTimeout(300)
  await searchPage.screenshot({ path: path.join(SCREENSHOT_DIR, `${testInfo.project.name || 'e2e'}-results.png`) })

  // Category tab switching re-runs the query; the folder category needs a
  // keyword that actually matches directory names.
  await searchPage.locator('#searchInput').fill('Highlighter')
  await searchPage.locator('.category-tab', { hasText: '文件夹' }).click()
  await expect(searchPage.locator('.result-row').first()).toBeVisible({ timeout: 20_000 })
  await searchPage.locator('.category-tab', { hasText: '全部' }).click()
  await expect(searchPage.locator('.result-row').first()).toBeVisible({ timeout: 20_000 })

  // Esc hides the window (frameless launcher behavior).
  await searchPage.locator('#searchInput').press('Escape')
  const visibleAfterEscape = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('/search/search.html'))
    return win ? win.isVisible() : null
  })
  expect(visibleAfterEscape).toBe(false)

  // Config page exposes the local search settings route with live status.
  await mainWindow.locator('[data-route="local-search"]').click()
  await expect(mainWindow.locator('#pageTitle')).toHaveText('本地搜索')
  await expect(mainWindow.locator('#searchStatus')).toBeVisible({ timeout: 15_000 })
  await expect(mainWindow.locator('#categoryEditor .form-row').first()).toBeVisible()
  await mainWindow.screenshot({ path: path.join(SCREENSHOT_DIR, `${testInfo.project.name || 'e2e'}-settings.png`) })

  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
