const { test, expect } = require('./fixtures')

test('the device battery route shows native-style readings only while the main window is visible', async ({ highlighter }) => {
  const { mainWindow: page, electronApp } = highlighter
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.getDeviceBatterySnapshot()).status)).toBe('paused')
  const battery = page.locator('.nav-item[data-route="device-battery"]')
  await battery.click()
  await expect(battery).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#deviceBatterySystem')).toContainText('本机无电池')
  const devices = page.locator('#deviceBatteryDevices')
  const mouse = devices.getByRole('listitem').filter({ hasText: 'Fixture Mouse <USB>' })
  await expect(mouse).toContainText('0%')
  await expect(mouse).toContainText('罗技')
  for (const [name, iconFile] of [
    ['Fixture Mouse <USB>', 'mouse.svg'], ['Fixture Keyboard', 'keyboard.svg'],
    ['Fixture Headphones', 'headphones.svg'], ['Fixture Earbuds', 'earbuds.svg'], ['Fixture Unknown', 'laptop.svg']
  ]) {
    const icon = devices.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) }).locator('.device-battery-icon')
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(await icon.evaluate((element) => getComputedStyle(element).maskImage)).toContain(`/config/icons/${iconFile}`)
  }
  await expect(devices.getByText('未报告电量', { exact: true })).toBeVisible()
  await expect(devices.getByText('充电盒', { exact: true })).toBeVisible()
  await expect(devices.getByText('85%', { exact: true })).toBeVisible()
  const keyboard = devices.getByRole('listitem').filter({ hasText: 'Fixture Keyboard' })
  await expect(keyboard.locator('.device-battery-charge-badge')).toBeVisible()
  await expect(keyboard.locator('.device-battery-arc')).toHaveCSS('--battery-angle', '0.44turn')
  await expect(mouse.locator('.device-battery-arc')).toHaveCSS('--battery-angle', '')
  await expect(page.locator('#deviceBatteryUpdated')).toContainText('上次检查：')

  const rowCount = () => devices.locator(':scope > li').evaluateAll((tiles) => new Set(tiles.map((tile) => tile.offsetTop)).size)
  const gridFits = () => devices.evaluate((grid) => grid.scrollWidth <= grid.clientWidth)
  const resizeWindow = (width) => electronApp.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/config/config.html'))
    win.setSize(width, 760)
  }, width)
  expect(await gridFits()).toBe(true)
  await resizeWindow(1120)
  await expect.poll(rowCount).toBe(1)
  await resizeWindow(880)
  await expect.poll(rowCount).toBe(2)
  expect(await gridFits()).toBe(true)

  const refresh = page.locator('#deviceBatteryRefresh')
  const refreshIcon = refresh.locator('.svg-icon')
  await expect(refresh).toHaveAccessibleName('刷新')
  await expect(refreshIcon).toHaveAttribute('aria-hidden', 'true')
  await expect(refreshIcon).toHaveCSS('width', '16px')
  await expect(refreshIcon).toHaveCSS('height', '16px')
  await expect(refreshIcon).toHaveCSS('mask-image', /\/config\/icons\/refresh\.svg/)
  await refresh.focus()
  await refresh.press('Enter')
  await expect(mouse.locator('.device-battery-percent')).toHaveText('1%')
  await expect(battery).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#deviceBatteryFeedback')).toContainText('已刷新')
  await expect(refresh).toHaveAttribute('aria-disabled', 'false')
  await expect(refresh).toBeFocused()

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/config/config.html'))
    win.hide()
  })
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.getDeviceBatterySnapshot()).status)).toBe('paused')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/config/config.html'))
    win.showInactive()
  })
  await expect(mouse).toContainText('0%')
  await page.locator('.nav-item[data-route="home"]').click()
  await expect(devices).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.getDeviceBatterySnapshot()).status)).toBe('paused')
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
