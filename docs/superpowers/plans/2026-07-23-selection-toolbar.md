# Selection Toolbar Actions and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add copy and configurable web search actions to the text-selection toolbar, plus a settings page that controls the toolbar, its four buttons, and the search engine.

**Architecture:** Keep selection-toolbar policy in a small CommonJS helper that can be tested without Electron. The main process remains the authority for settings, clipboard access, URL construction, window sizing, and external navigation; the isolated preload only forwards the selected text and action metadata to the toolbar renderer.

**Tech Stack:** Electron 33, CommonJS JavaScript, HTML/CSS, `electron-store`, Node.js built-in `node:test`.

---

## File Map

- Create `toolbar/toolbar-utils.js`: defaults, supported action order, search URL construction, and width calculation.
- Create `test/toolbar-utils.test.js`: pure unit tests for defaults, button filtering, fallback behavior, URL encoding, and width.
- Modify `package.json`: expose `npm test` and include the new JavaScript files in syntax checking.
- Modify `main.js`: merge toolbar defaults, respect visibility settings, resize/reposition the toolbar, and route local copy/search actions before AI checks.
- Modify `preload-toolbar.js`: expose a generic action sender and selection-state subscription through context isolation.
- Modify `toolbar/toolbar.html`: render only enabled actions with fixed-size controls and separators.
- Modify `config/config.html`: add the “划词工具” navigation item.
- Modify `config/config.js`: add the route and basic configuration form.

### Task 1: Testable Toolbar Policy

**Files:**
- Create: `test/toolbar-utils.test.js`
- Create: `toolbar/toolbar-utils.js`
- Modify: `package.json`

- [ ] **Step 1: Add the test command and write failing policy tests**

Add `"test": "node --test test/*.test.js"` to `scripts`, then create tests that require the not-yet-created helper:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_SELECTION_TOOLBAR,
  buildSearchUrl,
  getToolbarWidth,
  getVisibleToolbarActions
} = require('../toolbar/toolbar-utils')

test('default selection toolbar enables all actions with Bing search', () => {
  assert.deepEqual(DEFAULT_SELECTION_TOOLBAR, {
    enabled: true,
    buttons: { copy: true, search: true, translate: true, explain: true },
    searchEngine: 'bing'
  })
  assert.deepEqual(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR), [
    'copy', 'search', 'translate', 'explain'
  ])
})

test('disabled toolbar and disabled buttons produce no visible actions', () => {
  assert.deepEqual(getVisibleToolbarActions({ enabled: false }), [])
  assert.deepEqual(getVisibleToolbarActions({
    enabled: true,
    buttons: { copy: false, search: false, translate: false, explain: false }
  }), [])
})

test('visible actions retain the fixed product order', () => {
  assert.deepEqual(getVisibleToolbarActions({
    enabled: true,
    buttons: { explain: true, copy: true, search: false, translate: true }
  }), ['copy', 'translate', 'explain'])
})

test('search URLs encode text and unknown engines fall back to Bing', () => {
  const query = '划词 a&b'
  assert.equal(buildSearchUrl('bing', query), 'https://www.bing.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('baidu', query), 'https://www.baidu.com/s?wd=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('google', query), 'https://www.google.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('unknown', query), 'https://www.bing.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
})

test('toolbar width grows by one stable action slot', () => {
  assert.equal(getToolbarWidth([]), 0)
  assert.equal(getToolbarWidth(['copy']), 90)
  assert.equal(getToolbarWidth(['copy', 'search', 'translate', 'explain']), 300)
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `rtk npm test`

Expected: FAIL with `Cannot find module '../toolbar/toolbar-utils'`.

- [ ] **Step 3: Add the minimal toolbar policy helper**

Create `toolbar/toolbar-utils.js`:

```js
const DEFAULT_SELECTION_TOOLBAR = Object.freeze({
  enabled: true,
  buttons: Object.freeze({ copy: true, search: true, translate: true, explain: true }),
  searchEngine: 'bing'
})

const TOOLBAR_ACTION_ORDER = Object.freeze(['copy', 'search', 'translate', 'explain'])
const SEARCH_URLS = Object.freeze({
  bing: ['https://www.bing.com/search?q=', ''],
  baidu: ['https://www.baidu.com/s?wd=', ''],
  google: ['https://www.google.com/search?q=', '']
})

function getVisibleToolbarActions(config = DEFAULT_SELECTION_TOOLBAR) {
  if (!config?.enabled) return []
  const buttons = config.buttons || {}
  return TOOLBAR_ACTION_ORDER.filter((action) => buttons[action] !== false)
}

function buildSearchUrl(engine, text) {
  const [prefix, suffix] = SEARCH_URLS[engine] || SEARCH_URLS.bing
  return `${prefix}${encodeURIComponent(String(text || ''))}${suffix}`
}

function getToolbarWidth(actions) {
  const count = Array.isArray(actions) ? actions.length : 0
  return count ? 20 + count * 70 : 0
}

module.exports = {
  DEFAULT_SELECTION_TOOLBAR,
  TOOLBAR_ACTION_ORDER,
  buildSearchUrl,
  getToolbarWidth,
  getVisibleToolbarActions
}
```

Extend `npm run check` with `node --check toolbar/toolbar-utils.js`, `node --check preload-toolbar.js`, and `node --check test/toolbar-utils.test.js`.

- [ ] **Step 4: Run tests and syntax checks to verify GREEN**

Run: `rtk npm test`

Expected: 5 tests pass.

Run: `rtk npm run check`

Expected: exit code 0 with no syntax errors.

- [ ] **Step 5: Commit the policy slice**

```powershell
rtk git add package.json toolbar/toolbar-utils.js test/toolbar-utils.test.js
rtk git commit -m "test: define selection toolbar policy"
```

### Task 2: Main Process and Toolbar Renderer

**Files:**
- Modify: `main.js`
- Modify: `preload-toolbar.js`
- Modify: `toolbar/toolbar.html`
- Test: `test/toolbar-utils.test.js`

- [ ] **Step 1: Extend the failing tests for action classification**

Add `isAiToolbarAction` and `isLocalToolbarAction` to the destructured imports, then add:

```js
test('toolbar actions are classified before dispatch', () => {
  assert.equal(isLocalToolbarAction('copy'), true)
  assert.equal(isLocalToolbarAction('search'), true)
  assert.equal(isLocalToolbarAction('translate'), false)
  assert.equal(isAiToolbarAction('translate'), true)
  assert.equal(isAiToolbarAction('explain'), true)
  assert.equal(isAiToolbarAction('unknown'), false)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk node --test --test-name-pattern "classified before dispatch" test/toolbar-utils.test.js`

Expected: FAIL with `isLocalToolbarAction is not a function`.

- [ ] **Step 3: Integrate policy and local actions in the main process**

Import the helper and use its defaults:

```js
const {
  DEFAULT_SELECTION_TOOLBAR,
  buildSearchUrl,
  getToolbarWidth,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction
} = require('./toolbar/toolbar-utils')
```

Use four-action width as the initial window width and accept a width in position calculation:

Insert `selectionToolbar: DEFAULT_SELECTION_TOOLBAR,` in `DEFAULT_SETTINGS` immediately after `customCss: '',`.

Add these functions and exports to `toolbar/toolbar-utils.js`:

```js
const LOCAL_TOOLBAR_ACTIONS = new Set(['copy', 'search'])
const AI_TOOLBAR_ACTIONS = new Set(['translate', 'explain'])

function isLocalToolbarAction(action) {
  return LOCAL_TOOLBAR_ACTIONS.has(action)
}

function isAiToolbarAction(action) {
  return AI_TOOLBAR_ACTIONS.has(action)
}

module.exports = {
  DEFAULT_SELECTION_TOOLBAR, TOOLBAR_ACTION_ORDER, buildSearchUrl,
  getToolbarWidth, getVisibleToolbarActions, isAiToolbarAction, isLocalToolbarAction
}
```

```js
const TOOLBAR_W = getToolbarWidth(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR))

function calculateToolbarPosition(refPoint, orientation, toolbarWidth = TOOLBAR_W) {
  let x = refPoint.x - toolbarWidth / 2
  let y = refPoint.y
  if (orientation === 'topRight') { x = refPoint.x; y = refPoint.y - TOOLBAR_H }
  if (orientation === 'bottomLeft') x = refPoint.x - toolbarWidth
  if (orientation === 'bottomRight') x = refPoint.x
  const workArea = screen.getDisplayNearestPoint(refPoint).workArea
  x = Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - toolbarWidth)))
  y = Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - TOOLBAR_H)))
  return { x, y }
}
```

Filter and resize on selection:

```js
const actions = getVisibleToolbarActions(getSettings().selectionToolbar)
if (!actions.length) return
const toolbarWidth = getToolbarWidth(actions)
const position = calculateToolbarPosition(result.refPoint, result.orientation, toolbarWidth)
if (!toolbarWindow || toolbarWindow.isDestroyed()) createToolbarWindow()
toolbarWindow.setSize(toolbarWidth, TOOLBAR_H)
lastToolbarPos = position
toolbarWindow.setPosition(position.x, position.y)
toolbarWindow.showInactive()
toolbarWindow.webContents.send('selection:text', { text, actions })
```

Route local actions before the API Key check and allowlist AI actions:

```js
ipcMain.on('toolbar:action', async (_event, { action, text }) => {
  if (isProcessing || !text) return
  if (isLocalToolbarAction(action)) {
    hideToolbar()
    if (action === 'copy') clipboard.writeText(text)
    else {
      const url = buildSearchUrl(getSettings().selectionToolbar.searchEngine, text)
      try { await shell.openExternal(url) } catch (error) { log('Toolbar search failed:', error.message) }
    }
    return
  }
  if (!isAiToolbarAction(action)) return
  if (!getSettings().apiKey) { createMainWindow('settings-function'); hideToolbar(); return }
  isProcessing = true
  currentStreamController = { cancelled: false }
  hideToolbar()
  const win = createActionWindow()
  if (lastToolbarPos) {
    const workArea = screen.getDisplayNearestPoint(lastToolbarPos).workArea
    const [width, height] = win.getSize()
    const x = Math.round(Math.max(workArea.x, Math.min(lastToolbarPos.x - width / 2, workArea.x + workArea.width - width)))
    let y = lastToolbarPos.y + 48
    if (y + height > workArea.y + workArea.height) y = lastToolbarPos.y - height - 12
    win.setPosition(x, Math.round(Math.max(workArea.y, y)))
  }
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('action:start', { type: action, text })
    streamToWindow(win, action, text)
  })
  win.show()
  win.focus()
})
```

- [ ] **Step 4: Replace the static toolbar bridge and markup**

In `preload-toolbar.js`, retain `currentText`, store one renderer callback, and expose:

```js
let selectionListener = null

ipcRenderer.on('selection:text', (_event, data) => {
  currentText = data.text || ''
  selectionListener?.({ actions: Array.isArray(data.actions) ? data.actions : [] })
})

contextBridge.exposeInMainWorld('toolbarAPI', {
  onSelection: (callback) => { selectionListener = callback },
  action: (action) => ipcRenderer.send('toolbar:action', { action, text: currentText })
})
```

In `toolbar/toolbar.html`, use fixed action labels and dynamic buttons:

```js
const actionMeta = {
  copy: ['⧉', '复制'],
  search: ['⌕', '搜索'],
  translate: ['译', '翻译'],
  explain: ['?', '解释']
}

window.toolbarAPI.onSelection(({ actions }) => {
  const toolbar = document.getElementById('toolbar')
  toolbar.replaceChildren()
  actions.forEach((action, index) => {
    if (index) { const separator = document.createElement('span'); separator.className = 'sep'; toolbar.append(separator) }
    const button = document.createElement('button')
    button.className = `btn btn-${action}`
    button.title = actionMeta[action][1]
    button.textContent = `${actionMeta[action][0]} ${actionMeta[action][1]}`
    button.onclick = () => window.toolbarAPI.action(action)
    toolbar.append(button)
  })
})
```

Set `.toolbar` to `width: 100%`, give `.btn` a stable `width: 64px`, reduce horizontal padding, and retain the existing colors and hover states.

- [ ] **Step 5: Run tests and syntax checks**

Run: `rtk npm test`

Expected: 6 tests pass.

Run: `rtk npm run check`

Expected: exit code 0.

- [ ] **Step 6: Commit the toolbar behavior**

```powershell
rtk git add main.js preload-toolbar.js toolbar/toolbar.html test/toolbar-utils.test.js
rtk git commit -m "feat: add copy and search toolbar actions"
```

### Task 3: Selection Toolbar Settings Page

**Files:**
- Modify: `config/config.html`
- Modify: `config/config.js`

- [ ] **Step 1: Add a failing source-contract test**

Add `test/selection-toolbar-settings.test.js` using real source files:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
const script = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')

test('config app exposes the selection toolbar route and controls', () => {
  assert.match(html, /data-route="selection-toolbar"/)
  assert.match(script, /function renderSelectionToolbarSettings\(/)
  assert.match(script, /id="searchEngine"/)
  for (const action of ['copy', 'search', 'translate', 'explain']) {
    assert.match(script, new RegExp(`data-toolbar-button="${action}"`))
  }
})
```

Update the test script to `node --test test/*.test.js`; it already includes both test files through the glob.

- [ ] **Step 2: Run the settings test and verify RED**

Run: `rtk node --test test/selection-toolbar-settings.test.js`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Add navigation and route dispatch**

Add under the Settings group in `config/config.html`:

```html
<button class="nav-item" data-route="selection-toolbar"><i>划</i><span>划词工具</span></button>
```

Add the title and dispatch in `config/config.js`:

```js
'selection-toolbar': '划词工具',
```

```js
else if (currentRoute === 'selection-toolbar') renderSelectionToolbarSettings()
```

- [ ] **Step 4: Implement the basic configuration form**

Add a page with total and per-action switches plus the search-engine selector:

```js
function renderSelectionToolbarSettings() {
  const toolbar = settings.selectionToolbar
  const actions = [
    ['copy', '复制', '复制划词内容到系统剪贴板'],
    ['search', '搜索', '使用默认浏览器搜索划词内容'],
    ['translate', '翻译', '调用翻译服务处理划词内容'],
    ['explain', '解释', '调用 AI 解释划词内容']
  ]
  view.innerHTML = `<div class="page">${pageHeader('划词工具', '管理划词后显示的工具栏及其操作。')}<section class="section"><h2 class="section-title">工具栏</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>启用划词工具栏</b><small>选中文本后显示快捷操作</small></div>${switchMarkup(toolbar.enabled, 'enabled', 'selectionToolbar')}</div>${actions.map(([key, label, description]) => `<div class="form-row"><div class="form-label"><b>${label}</b><small>${description}</small></div><div class="switch ${toolbar.buttons[key] ? 'on' : ''}" data-toolbar-button="${key}"></div></div>`).join('')}</div></section><section class="section"><h2 class="section-title">搜索</h2><div class="card form-card"><div class="form-row"><div class="form-label"><b>搜索引擎</b><small>搜索按钮使用系统默认浏览器打开</small></div><select id="searchEngine"><option value="bing">Bing</option><option value="baidu">百度</option><option value="google">Google</option></select></div></div></section><button class="button primary" id="saveSelectionToolbar">保存</button></div>`
  document.getElementById('searchEngine').value = toolbar.searchEngine || 'bing'
  bindSwitches()
  document.querySelectorAll('[data-toolbar-button]').forEach((element) => element.onclick = async () => {
    const key = element.dataset.toolbarButton
    const value = !element.classList.contains('on')
    await updateSettings({ selectionToolbar: { buttons: { [key]: value } } })
    element.classList.toggle('on', value)
  })
  document.getElementById('saveSelectionToolbar').onclick = () => updateSettings({
    selectionToolbar: { searchEngine: document.getElementById('searchEngine').value }
  })
}
```

- [ ] **Step 5: Run all tests and checks**

Run: `rtk npm test`

Expected: 7 tests pass.

Run: `rtk npm run check`

Expected: exit code 0.

- [ ] **Step 6: Commit the configuration page**

```powershell
rtk git add config/config.html config/config.js test/selection-toolbar-settings.test.js
rtk git commit -m "feat: add selection toolbar settings page"
```

### Task 4: End-to-End Verification

**Files:**
- Verify all changed files

- [ ] **Step 1: Verify the complete automated suite**

Run: `rtk npm test`

Expected: all tests pass with no failures.

Run: `rtk npm run check`

Expected: exit code 0 with no syntax errors.

Run: `rtk git diff --check HEAD~3..HEAD`

Expected: no whitespace errors.

- [ ] **Step 2: Start the Electron app without rebuilding native helpers**

Run: `rtk .\node_modules\.bin\electron.cmd .`

Expected: the Highlighter main window opens and the new “划词工具” navigation item is visible.

- [ ] **Step 3: Verify user-visible behavior**

Check all of the following:

- The settings page persists the total switch, four action switches, and Bing/百度/Google selection.
- Selecting text shows only enabled actions and the toolbar width follows the enabled count.
- Copy writes the exact selected text and closes the toolbar.
- Search opens an encoded Bing result in the system default browser by default and closes the toolbar.
- Translation and explanation still open the existing AI result window.
- Disabling the toolbar or all four actions prevents it from appearing.

- [ ] **Step 4: Review final repository state**

Run: `rtk git status --short`

Expected: no unintended changes; any implementation-plan file is the only documentation change not already committed.
