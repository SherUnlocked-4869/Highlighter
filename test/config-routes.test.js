'use strict'

// S14 / D2-2 + D2-3：设置页路由拆分的接线契约。
//
// 这条测试守的是拆分后的**唯一真实失效模式**：主壳 `routes` 分派表的 key 与
// `config/routes/*.js` 里 `window.configRoutes['...']` 的登记键不一致时，
// `renderRoute()` 会在某个路由上静默 no-op —— 页面点开是空白，而 npm test /
// npm run check 都看不出来（渲染发生在真实 Electron 里）。同时核对 config.html
// 真的把每个路由文件都挂上了（漏挂同样是静默失败）。

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { readConfigShell, configSourceFiles } = require('./helpers/config-source')
const ROOT = path.join(__dirname, '..')

const shell = readConfigShell()
const html = fs.readFileSync(path.join(ROOT, 'config', 'config.html'), 'utf8')
const sharedSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'shared.js'), 'utf8')

function dispatchKeys () {
  // 只取 routes 表里 `{ key: '...' }` 的取值；表外的 key 字面量不会匹配。
  // CRLF 陷阱：`\s+` 会先吃掉 `\r` 导致后面的字面量对不上；这里用 `[ \t]+` 只吃空格/
  // 制表符，并用 `\r?\n` 显式吃掉行尾，三种行尾（CRLF/LF/CR）都能命中。
  return [...shell.matchAll(/\r?\n?[ \t]+key: '([A-Za-z]+)'/g)].map((match) => match[1])
}

function registeredKeys () {
  const keys = []
  for (const file of configSourceFiles()) {
    if (!file.includes(`${path.sep}routes${path.sep}`)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/window\.configRoutes\['([A-Za-z]+)'\]\s*=/g)) keys.push(match[1])
  }
  return keys
}

function loadedRouteFiles () {
  return [...html.matchAll(/<script src="(routes\/[^"]+)"><\/script>/g)].map((match) => match[1])
}

test('every dispatched route is registered and every registration is dispatched', () => {
  const dispatched = dispatchKeys()
  const registered = registeredKeys()
  assert.ok(dispatched.length >= 12, `expected at least 12 routes, got ${dispatched.length}`)
  // 逐条给出差集，失败时报出具体是哪个路由会静默 no-op。
  assert.deepEqual(
    [...new Set(dispatched)].filter((key) => !registered.includes(key)),
    [],
    'routes present in the shell dispatch table but never registered in config/routes/*.js'
  )
  assert.deepEqual(
    registered.filter((key) => !dispatched.includes(key)),
    [],
    'window.configRoutes entries that no route dispatches to'
  )
})

test('config.html loads every route file, shared helpers first and the shell last', () => {
  const loaded = loadedRouteFiles()
  const onDisk = fs.readdirSync(path.join(ROOT, 'config', 'routes'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `routes/${name}`)
  // 双向：磁盘上的路由文件都要被挂上，反之 HTML 不得引用不存在的文件。
  assert.deepEqual(loaded.slice().sort(), onDisk.slice().sort())
  assert.equal(loaded[0], 'routes/shared.js', 'shared helpers must load first')
  assert.equal(loaded[1], 'routes/model-helpers.js', 'pure model helpers come right after shared')
  // 主壳必须最后：它在顶层读 window.configRoutes，且路由文件在顶层登记。
  assert.ok(html.lastIndexOf('<script src="config.js"></script>') > html.lastIndexOf('src="routes/'))
  // CSP 里 config.html 不能有内联脚本（window-security.test.js 同口径），因此
  // configRoutes 容器只能由第一个路由文件 shared.js 建立。
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'config.html must stay inline-script free')
  assert.match(sharedSource, /window\.configRoutes = window\.configRoutes \|\| \{\}/)
})

test('the shell keeps no render function of its own', () => {
  for (const name of ['renderHome', 'renderTranslation', 'renderChat', 'renderHistory',
    'renderAppearance', 'renderPlugins', 'renderGeneralSettings', 'renderModels',
    'renderFunctionSettings', 'renderSelectionToolbarSettings', 'renderLocalSearch',
    'renderHotkeySettings', 'renderSystemSettings', 'renderAbout']) {
    assert.doesNotMatch(shell, new RegExp(`function ${name}\\s*\\(`), `${name} must live in config/routes/*.js`)
  }
})

test('window.configShared exports exactly the shared surface named in this test', () => {
  // 对象字面量在 shared.js 载入时求值，所以它只能登记 shared.js 自己声明的名字
  // （引用别的路由文件里的 const 会当场 TDZ 报错）；本清单即任务规定的共享 helper 面。
  const expected = [
    'escapeHtml', 'errorMessage', 'iconMarkup', 'toolbarIconMarkup', 'toast', 'applyAppearance',
    'updateSettings', 'refreshShortcutStatuses', 'shortcutPresentation', 'shortcutButton',
    'pageHeader', 'OCR_PROFILE_LABELS', 'statusRailCell', 'refreshStatusRail', 'formatBytes',
    'switchMarkup', 'bindSwitches', 'modalOverlay', 'closeModal', 'openModal', 'openDocs',
    'TOOLBAR_ICON_NAME', 'TOOLBAR_ICON_FALLBACK', 'SEARCH_DEFAULT_CATEGORIES',
    'selectionToolbarBuiltinMeta'
  ]
  const block = sharedSource.match(/window\.configShared = \{([\s\S]*?)\}/)
  assert.ok(block, 'shared.js must expose window.configShared')
  const exported = block[1].split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)
  assert.deepEqual(exported.slice().sort(), expected.slice().sort())
  for (const name of expected) {
    assert.match(sharedSource, new RegExp(`(function|const|let) ${name}\\b`), `${name} must be declared in shared.js`)
  }
})
