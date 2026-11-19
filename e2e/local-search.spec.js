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

test('search categories adapt to narrow space and keep the save flow keyboard accessible', async ({ highlighter }, testInfo) => {
  const { mainWindow } = highlighter
  await mainWindow.locator('[data-route="local-search"]').click()

  const section = mainWindow.getByRole('region', { name: '搜索分类' })
  const columns = section.locator('.category-columns')
  const rows = section.locator('.category-row')
  const firstName = rows.first().getByRole('textbox', { name: '名称', exact: true })
  const firstRule = rows.first().getByRole('textbox', { name: '规则', exact: true })
  const save = section.getByRole('button', { name: '保存分类' })
  const add = section.getByRole('button', { name: '添加分类' })
  const reset = section.getByRole('button', { name: '恢复默认分类' })

  await expect(columns).toBeVisible()
  await expect(rows.first()).toHaveCSS('grid-template-columns', /^subgrid\b/)
  expect((await firstName.boundingBox()).y).toBeCloseTo((await firstRule.boundingBox()).y, 0)
  expect((await save.boundingBox()).height).toBeCloseTo(30, 1)

  await mainWindow.evaluate(() => updateSettings({ theme: 'dark' }, ''))
  await save.scrollIntoViewIfNeeded()
  await mainWindow.screenshot({ path: testInfo.outputPath('categories-dark.png'), scale: 'css', animations: 'disabled' })

  await section.evaluate((element) => { element.style.inlineSize = '360px' })
  await expect(columns).toBeHidden()
  expect((await firstRule.boundingBox()).y).toBeGreaterThan((await firstName.boundingBox()).y)
  expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await mainWindow.evaluate(() => updateSettings({ theme: 'light' }, ''))
  await save.scrollIntoViewIfNeeded()
  await mainWindow.screenshot({ path: testInfo.outputPath('categories-narrow-light.png'), scale: 'css', animations: 'disabled' })

  const initialCount = await rows.count()
  await add.click()
  await expect(rows).toHaveCount(initialCount + 1)
  const last = rows.last()
  await last.getByRole('textbox', { name: '名称', exact: true }).fill('E2E category')
  await last.getByRole('textbox', { name: '规则', exact: true }).fill('ext:txt')
  await add.focus()
  await mainWindow.keyboard.press('Tab')
  await expect(reset).toBeFocused()
  await mainWindow.keyboard.press('Tab')
  await expect(save).toBeFocused()
  await expect(save).toHaveCSS('outline-style', 'solid')
  expect(await save.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThanOrEqual(1.5)
  await mainWindow.keyboard.press('Enter')
  const savedCategories = () => mainWindow.evaluate(async () => (await window.electronAPI.getSettings()).search.categories)
  await expect.poll(savedCategories).toContainEqual(expect.objectContaining({ label: 'E2E category', rule: 'ext:txt' }))

  await last.getByRole('button', { name: '删除' }).click()
  await expect(rows).toHaveCount(initialCount)
  await reset.click()
  await expect.poll(savedCategories).toHaveLength(initialCount)
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
