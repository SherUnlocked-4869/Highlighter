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
  await expect(page.locator('#loadMoreHistory')).toBeHidden()
  await expect(page.locator('#historyBatchActions')).toBeHidden()

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

// N02 follow-up (real-device verification, 2026-11-27): a Chinese IME composition in the
// history search box used to be destroyed by the page's own re-render. Chromium fires an
// `input` event for every intermediate pinyin keystroke, the old 220 ms debounce then ran the
// full page render, and replacing the focused <input> aborted the composition - leaving only
// the raw letters in the box. This is the renderer-level reproduction: while a composition is
// open, mid-composition input events must not replace the input node at all, and the tag
// filter must be a dropdown over existing tags rather than typed text.
test('history search survives an IME composition and exposes the tag dropdown', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'history', '截图历史')
  const search = page.locator('#historySearch')
  await expect(search).toBeVisible()
  // The tag filter is a <select> with the "all tags" placeholder; the free-text box stays for
  // image text / file names.
  const tagSelect = page.locator('#historyTag')
  await expect(tagSelect).toBeVisible()
  await expect(tagSelect.locator('option')).toHaveText(['全部标签'])
  // The page-level OCR bar is silent for an empty history (nothing to index, nothing running).
  await expect(page.locator('#historyOcrBar')).toBeHidden()

  await search.focus()
  await search.evaluate((element) => { window.__e2eHistorySearch = element })
  await search.dispatchEvent('compositionstart')
  // The exact shape Chromium emits for a pinyin keystroke: an `input` event with
  // isComposing=true while the value is still the raw letters.
  await search.evaluate((element) => {
    element.value = 'nihao'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'o' }))
  })
  // Longer than the old search debounce: the pre-fix page would have re-rendered here and
  // replaced this very node (and the result grid with it).
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => document.getElementById('historySearch') === window.__e2eHistorySearch)).toBe(true)
  expect(await search.inputValue()).toBe('nihao')

  // Committing the composition searches the committed value through the results-only path; the
  // input must survive that too.
  await search.evaluate((element) => {
    element.value = '你好'
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: '你好' }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
  })
  await expect.poll(() => page.evaluate(() => document.getElementById('historySearch') === window.__e2eHistorySearch)).toBe(true)
  expect(await search.inputValue()).toBe('你好')
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
  // The system page now also carries the local-backup "预览备份包" button, whose
  // accessible name contains 预览; target the diagnostics control by id so the
  // locator cannot go ambiguous as more previews appear on the page.
  await page.locator('#previewDiagnostics').click()
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
test('every main window route renders content', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  const routes = [
    ['home', '快捷功能', '.function-row'],
    ['translation', '翻译', '#translateNow'],
    ['chat', 'AI 对话', '#sendChat'],
    ['history', '截图历史', '#historyResults'],
    ['recording', '录屏', '#recordingStartButton'],
    ['selection-toolbar', '划词工具', '#saveSelectionToolbar'],
    ['local-search', '本地搜索', '#searchStatus'],
    ['clipboard-history', '剪贴板历史', '#clipboard-save'],
    ['settings-general', '通用', '#theme'],
    ['settings-function', '截图与录制', '#nameTemplate'],
    ['models', 'AI 与模型', '#addModelProvider'],
    ['settings-system', '系统与数据', '#dataRoot'],
    ['usage', '用量', '.usage-page'],
    ['about', '关于', '.about']
  ]
  for (const [route, title, selector] of routes) {
    await page.locator(`[data-route="${route}"]`).click()
    await expect(page.locator('#pageTitle')).toHaveText(title)
    await expect(page.locator(selector).first()).toBeVisible()
  }
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

// N06 follow-up (real-device verification, 2026-11-28): the sidebar search box
// rendered but did nothing. `config.js` booted the wiring behind bare globals
// (`typeof initSettingsSearch === 'function'`) while `routes/settings-search.js`
// is UMD and only publishes `window.settingsSearch`, so both guards were false,
// no listener was ever attached, and Ctrl+K plus typing were silent no-ops. The
// Node tests stayed green because they drive the module directly; this is the
// renderer-level contract: from an unrelated route, Ctrl+K focuses the box,
// typing opens the real index, and a click lands on the settings page.
test('Ctrl+K settings search focuses the box, filters the index and jumps to the target', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  // Start somewhere that is not the destination, so the jump is observable.
  await navigate(page, 'about', '关于')

  await page.keyboard.press('Control+k')
  const searchInput = page.locator('#settingsSearchInput')
  await expect(searchInput).toBeFocused()

  await searchInput.fill('备份')
  const results = page.locator('#settingsSearchResults .search-result')
  await expect(results.first()).toBeVisible()
  await expect(results.first()).toContainText('备份')

  await results.first().click()
  // Every indexed backup entry belongs to the system/data route.
  await expect(page.locator('#pageTitle')).toHaveText('系统与数据')
  await expect(page.locator('#settingsSearchResults')).toBeHidden()
  await expect(searchInput).toHaveValue('')
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

// B1/B4 integration: the usage page is opt-in, and once enabled it must scan the
// committed fixture home end to end (worker -> SQLite -> IPC -> page) and render
// the TokenTracker-parity numbers without touching the real user home.
test('usage page guides opt-in and scans the fixture home end to end', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'usage', '用量')
  await expect(page.locator('.usage-page')).toHaveAttribute('data-usage-state', 'disabled')
  await expect(page.locator('[data-usage-enable]')).toBeVisible()

  await page.locator('[data-usage-enable]').click()
  // The scan runs in a utilityProcess; poll the real IPC until the fixture totals
  // are committed (golden: 11 buckets / 52,590 billable across the three tools).
  await expect.poll(async () => page.evaluate(async () => {
    const summary = await window.electronAPI.usageSummary({ period: 'total', tz: 'Asia/Shanghai' })
    return summary?.totals?.billable_total_tokens ?? -1
  }), { timeout: 45_000 }).toBe(52_590)

  await page.locator('[data-usage-tab="total"]').click()
  await expect(page.locator('#usageTotal')).not.toHaveText('')
  const status = await page.evaluate(() => window.electronAPI.usageStatus())
  for (const source of ['codex', 'dsh', 'opencode']) {
    const entry = status.sources.find((candidate) => candidate.source === source)
    expect(entry?.state).toBe('ok')
  }
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})

// Regression (2026-10-23): the page used to render once and then sit on whatever
// the DB held, because only the header button ever sent a scan trigger; the
// "last scan" line froze at whatever the consent click had produced.
//
// This covers the user-visible half. The scan trigger itself cannot be observed
// from here: `contextBridge` exposes a frozen API (verified: Object.isFrozen is
// true), so the renderer cannot spy on it, and the collector's 5 minute floor
// correctly answers an immediate re-entry with `throttled`. The trigger wiring is
// therefore pinned by test/usage-auto-refresh.test.js, which runs the real route
// script against fake timers; what this test proves is that the page arms that
// lifecycle on entry and survives focus/disconnect/re-entry at the DOM level.
test('an enabled usage page arms its background refresh, and the label shows staleness', async ({ highlighter }) => {
  const { mainWindow: page } = highlighter
  await navigate(page, 'usage', '用量')
  await page.locator('[data-usage-enable]').click()
  await expect.poll(async () => page.evaluate(async () => {
    const status = await window.electronAPI.usageStatus()
    return status?.lastScanAt ?? null
  }), { timeout: 45_000 }).not.toBeNull()

  // The consent click itself already asked for a page-open scan; the collector's
  // 5-minute floor then throttles an immediate re-entry. What must hold is that
  // the page still asks (the IPC accepting the throttled answer is invisible in
  // the DOM), so the assertion below covers the rendered contract, and the
  // runtime test (test/usage-auto-refresh.test.js) covers the trigger wiring.
  await navigate(page, 'home', '快捷功能')
  await navigate(page, 'usage', '用量')
  // The dashboard is mounted either way; its state banner depends on whether the
  // fixture home yielded rows for the selected period (here it is the fixture's
  // "month" window, so the page sits in its empty state — still a live dashboard).
  await expect(page.locator('.usage-dashboard')).toBeVisible()

  // Relative freshness copy: the coverage strip must say how old the reading is,
  // not only its absolute timestamp.
  const coverage = page.locator('#usageCoverage')
  await expect(coverage).toContainText('上次扫描')
  await expect(coverage).toContainText(/刚刚|分钟前|小时前|昨天|天前/)

  // A focus event must not throw or blank the page; the handler is bound while
  // the route is active and is meant to be a no-op when throttled.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(400)
  await expect(page.locator('.usage-dashboard')).toBeVisible()

  // Leaving the page tears the lifecycle down; returning re-arms it. The observable
  // guarantee is that the route keeps working after both transitions.
  await navigate(page, 'home', '快捷功能')
  await navigate(page, 'usage', '用量')
  await expect(page.locator('.usage-dashboard')).toBeVisible()
  expect(await highlighter.getUnexpectedErrors()).toEqual([])
})
