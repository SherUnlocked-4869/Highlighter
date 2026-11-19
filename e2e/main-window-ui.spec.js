const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')
const { test, expect } = require('./fixtures')

const routes = {
  home: '.function-launch', translation: '#translateNow', chat: '#sendChat', history: '#historyResults',
  recording: '#recordingStartButton', 'selection-toolbar': '#saveSelectionToolbar', 'local-search': '#categoryEditor',
  'clipboard-history': '#clipboard-save', usage: '.usage-page', 'settings-general': '#theme',
  'settings-function': '#nameTemplate', models: '#addModelProvider', 'settings-system': '#dataRoot', about: '.about'
}

async function navigate(page, route) {
  const tab = page.locator(`[data-route="${route}"]`)
  await tab.click()
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await expect(page.locator(routes[route]).first()).toBeAttached()
}

async function resizeMain(electronApp, width, zoom) {
  await electronApp.evaluate(({ BrowserWindow }, dimensions) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/config/config.html'))
    win.setSize(dimensions.width, 720)
    win.webContents.setZoomFactor(dimensions.zoom)
  }, { width, zoom })
}

async function expectControlsToFit(page, label) {
  const { overflow, clipped } = await page.locator('#view').evaluate((view) => {
    const right = view.getBoundingClientRect().left + view.clientWidth
    const clipped = [...view.querySelectorAll('.button, [role="switch"], .function-launch')].filter((control) =>
      control.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && control.getBoundingClientRect().right > right + 1
    ).map((control) => control.id || control.textContent.trim())
    return { overflow: view.scrollWidth - view.clientWidth, clipped }
  })
  expect(overflow, label).toBeLessThanOrEqual(1)
  expect(clipped, label).toEqual([])
}

test('main-window controls fit across routes, themes, languages and densities', async ({ highlighter }, testInfo) => {
  test.setTimeout(120_000)
  const { electronApp, mainWindow: page } = highlighter
  for (const variant of [
    { theme: 'dark', language: 'zh-CN', compact: false, width: 1120, zoom: 1 },
    { theme: 'light', language: 'en-US', compact: true, width: 880, zoom: 1 },
    { theme: 'light', language: 'en-US', compact: true, width: 880, zoom: 1.25 },
    { theme: 'dark', language: 'zh-TW', compact: false, width: 880, zoom: 1 }
  ]) {
    const { width, zoom, ...appearance } = variant
    await resizeMain(electronApp, width, zoom)
    await page.evaluate((patch) => updateSettings(patch, ''), appearance)
    await expect(page.locator('body')).toHaveClass(appearance.theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
    await expect(page.locator('body')).toHaveClass(appearance.compact ? /\bcompact\b/ : /^(?!.*\bcompact\b)/)
    await expect.poll(() => page.evaluate(() => t('config.chat.send'))).toBe({ 'zh-CN': '发送', 'en-US': 'Send', 'zh-TW': '送出' }[appearance.language])
    for (const route of Object.keys(routes)) {
      await navigate(page, route)
      await expectControlsToFit(page, `${appearance.language} ${zoom} ${route}`)
      if (appearance.language !== 'zh-TW' && zoom === 1) {
        await page.screenshot({ path: testInfo.outputPath(`${appearance.language}-${route}.png`), scale: 'css', animations: 'disabled' })
      }
      const attribute = { home: 'data-home-tab', models: 'data-models-tab', 'settings-function': 'data-function-tab' }[route]
      if (zoom === 1.25 && attribute) {
        const tabs = await page.locator(`[${attribute}]`).evaluateAll((buttons, key) => buttons.map((button) => button.getAttribute(key)), attribute)
        for (const value of [...tabs.slice(1), tabs[0]]) {
          const toggle = page.locator(`[${attribute}="${value}"]`)
          await toggle.press('Enter')
          await expect(toggle).toHaveAttribute('aria-pressed', 'true')
          await expect(toggle).toBeFocused()
          await expectControlsToFit(page, `${route}/${value}`)
        }
      }
    }
  }
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('chat grows independently of Send and preserves composition and the next draft', async ({ highlighter }) => {
  const { electronApp, mainWindow: page } = highlighter
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:complete')
    ipcMain.handle('ai:complete', () => new Promise((resolve) => { globalThis.finishUiAuditChat = resolve }))
  })
  await navigate(page, 'chat')
  const input = page.getByRole('textbox', { name: '消息' })
  const send = page.locator('#sendChat')
  const initial = await input.boundingBox()
  const button = await send.boundingBox()
  await input.fill('第一行\n第二行\n第三行\n第四行')
  expect((await input.boundingBox()).height).toBeGreaterThan(initial.height)
  expect((await send.boundingBox()).height).toBe(button.height)
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })
  await expect(page.locator('.message.user')).toHaveCount(0)
  await input.press('Control+Enter')
  await expect(send).toBeDisabled()
  await expect(input).toBeFocused()
  await input.fill('下一条草稿')
  await expect.poll(() => electronApp.evaluate(() => typeof globalThis.finishUiAuditChat)).toBe('function')
  await electronApp.evaluate(() => globalThis.finishUiAuditChat('fixture reply'))
  await expect(page.locator('.message.assistant')).toHaveText('fixture reply')
  await expect(input).toHaveValue('下一条草稿')
  await expect(send).toBeEnabled()
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('history pagination, selection and anchored actions keep their state', async ({ highlighter }) => {
  const { dataRoot, mainWindow: page } = highlighter
  const image = path.join(dataRoot, 'ui-fixture.png')
  await sharp({ create: { width: 32, height: 18, channels: 3, background: '#715843' } }).png().toFile(image)
  const configPath = path.join(dataRoot, 'config.json')
  const stored = JSON.parse(await fs.readFile(configPath, 'utf8'))
  stored.captureHistory = Array.from({ length: 41 }, (_, index) => ({
    id: `ui-audit-${index}`, filePath: image, thumbnailPath: image, width: 32, height: 18,
    source: 'capture', createdAt: Date.now() - index * 1000
  }))
  await fs.writeFile(configPath, JSON.stringify(stored))
  await navigate(page, 'history')
  const batch = page.locator('#historyBatchActions')
  const card = page.locator('.history-item').first()
  const more = card.locator('.history-more-trigger')
  const popup = card.locator('[popover]')
  const loadMore = page.locator('#loadMoreHistory')
  await expect(batch).toBeHidden()
  await card.getByRole('checkbox').check()
  await expect(batch).toBeVisible()
  await card.getByRole('checkbox').uncheck()
  await expect(batch).toBeHidden()
  await more.press('Enter')
  await expect(popup).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(popup.locator('[data-history-action="open"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(more).toBeFocused()
  await page.evaluate(() => {
    window.confirm = (message) => {
      document.body.dataset.auditConfirm = message
      return false
    }
  })
  await more.click()
  await popup.locator('[data-history-action="delete"]').click()
  await expect(page.locator('body')).toHaveAttribute('data-audit-confirm', '确定删除这项截图及其文件？')
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.getHistory({ limit: 1 })).totalCount)).toBe(41)
  await expect(page.locator('.history-item')).toHaveCount(40)
  await more.click()
  await page.locator('#historySearch').click()
  await expect(popup).toBeHidden()
  await expect(loadMore).toBeVisible()
  await loadMore.press('Enter')
  await expect(page.locator('.history-item')).toHaveCount(41)
  await expect(loadMore).toBeHidden()
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('keyboard switches preserve immediate and explicit save behavior', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'settings-general')
  const compact = page.locator('[data-switch="compact"]')
  await expect(compact).toHaveAttribute('aria-checked', 'false')
  await compact.press('Space')
  await expect(compact).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('body')).toHaveClass(/compact/)
  await navigate(page, 'clipboard-history')
  const captureText = page.locator('#clipboard-captureText')
  const readCaptureText = () => page.evaluate(async () => (await window.electronAPI.getSettings()).clipboard.captureText)
  const before = await readCaptureText()
  await captureText.press('Space')
  expect(await captureText.isChecked()).toBe(!before)
  expect(await readCaptureText()).toBe(before)
  await page.locator('#clipboard-save').press('Enter')
  await expect.poll(readCaptureText).toBe(!before)
  await expect(page.locator('#clipboard-save')).toBeFocused()
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('provider actions have one highlight and the native modal returns focus', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'models')
  const add = page.locator('#addModelProvider')
  const save = page.locator('#saveProviderSettings')
  const provider = page.locator('[data-expand-provider]').first()
  await expect(add).toHaveClass(/primary/)
  await expect(save).not.toHaveClass(/primary/)
  await provider.press('Enter')
  await expect(provider).toBeFocused()
  await expect(add).not.toHaveClass(/primary/)
  await expect(save).toHaveClass(/primary/)
  const nameInput = page.locator('[data-provider-name]').first()
  await nameInput.fill('Edited provider name')
  await provider.press('Enter')
  await expect(save).toHaveClass(/primary/)
  await provider.press('Enter')
  await expect(nameInput).toHaveValue('Edited provider name')
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.getSettings()).providers[0].name)).not.toBe('Edited provider name')
  await add.press('Enter')
  const dialog = page.locator('dialog.modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[command="close"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(add).toBeFocused()
  await add.press('Enter')
  await dialog.locator('[command="close"]').press('Enter')
  await expect(dialog).toBeHidden()
  await expect(add).toBeFocused()
  await add.press('Enter')
  await page.evaluate(() => navigate('home'))
  await expect(dialog).toBeHidden()
  await expect(page.locator('[data-route="home"]')).toHaveAttribute('aria-current', 'page')
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

test('expanded usage data controls wrap at minimum width and 125% zoom', async ({ highlighter }) => {
  const { electronApp, mainWindow: page } = highlighter
  await page.evaluate(() => updateSettings({ language: 'en-US', theme: 'light', compact: true }, ''))
  await resizeMain(electronApp, 880, 1.25)
  await navigate(page, 'usage')
  await page.locator('[data-usage-enable]').click()
  await page.locator('#usageSources > summary').click()
  const clear = page.locator('[data-usage-clear]')
  await expect(clear).toBeVisible()
  const fits = await clear.evaluate((element) => {
    const view = document.querySelector('#view')
    return element.getBoundingClientRect().right <= view.getBoundingClientRect().left + view.clientWidth + 1 &&
      view.scrollWidth <= view.clientWidth + 1
  })
  expect(fits).toBe(true)
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
