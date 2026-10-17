const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
const { assertSettingsPatch } = require('../main/services/settings-validation')
const { isRecordableShortcut } = require('../shared/shortcut-keys')
const { readConfigSource } = require('./helpers/config-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const settingsDefaults = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'settings-defaults.js'), 'utf8')
const functionRouter = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'function-router.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8')
const config = readConfigSource()
const styles = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.css'), 'utf8')

test('main process delegates shortcut registration and exposes status through preload', () => {
  assert.match(main, /new ShortcutService\(\{[\s\S]*globalShortcut[\s\S]*executeFunction/)
  assert.match(main, /function registerShortcuts\(\)[\s\S]*shortcutService\.suspendAll\(shortcuts, 'game-mode'\)[\s\S]*shortcutService\.registerAll\(shortcuts\)/)
  assert.match(main, /registerShortcutIpc\(\{[\s\S]*shortcutService/)
  assert.match(main, /app\.on\('will-quit',[\s\S]*shortcutService\.dispose\(\)/)
  assert.match(preload, /getShortcutStatuses:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('shortcuts:status'\)/)
})

test('settings UI refreshes and clearly marks unavailable shortcuts', () => {
  assert.match(config, /await window\.electronAPI\.getShortcutStatuses\(\)/)
  assert.match(config, /status\.reason === 'duplicate'/)
  assert.match(config, /status\.reason === 'unavailable'/)
  assert.match(config, /status\.reason === 'game-mode'/)
  assert.match(config, /className: 'set unavailable'/)
  assert.match(config, /红色警告表示快捷键冲突或不可用/)
  assert.match(styles, /\.shortcut\.unavailable\{/)
})

test('shortcut changes refresh registration status before user feedback', () => {
  assert.match(config, /if \(patch\.shortcuts\) await refreshShortcutStatuses\(\)/)
  assert.match(config, /const presentation = shortcutPresentation\(shortcutName, accelerator\)[\s\S]*renderRoute\(\)[\s\S]*toast\(presentation\.message \|\| t\('config\.shortcut\.updated'\)\)/)
})

test('explainClipboard shortcut reads clipboard only and opens the explain window', () => {
  assert.match(settingsDefaults, /explainClipboard:\s*'Ctrl\+Alt\+E'/)
  assert.match(functionRouter, /async explainClipboard\(\) \{[\s\S]*clipboard\.readText\(\)[\s\S]*openToolbarAiAction\('explain', text\)/)
  // Must not write or empty the clipboard in this path.
  const explainCase = functionRouter.match(/async explainClipboard\(\) \{[\s\S]*?\n    \},?/)?.[0] || ''
  assert.ok(explainCase, 'explainClipboard handler present')
  assert.doesNotMatch(explainCase, /clipboard\.write/)
  assert.doesNotMatch(explainCase, /EmptyClipboard|clipboard\.clear/)
  // P0-1-T3（S1，批次 C）：functionGroups 文案键化后，键名本身即是契约。
  assert.match(config, /\['explainClipboard', 'config\.function\.explain-clipboard'/)
})

test('the two save shortcuts and the click-through exit are frozen keys with router handlers', () => {
  // settings-defaults.js is frozen after Wave 0: these keys default to '' on
  // purpose (Ctrl+S / Ctrl+Shift+S are heavily used by other applications, so
  // registration stays best-effort and opt-in).
  assert.equal(DEFAULT_SETTINGS.shortcuts.screenshotQuickSave, '')
  assert.equal(DEFAULT_SETTINGS.shortcuts.screenshotSaveAs, '')
  assert.equal(DEFAULT_SETTINGS.shortcuts.togglePinClickThrough, '')
  assert.match(settingsDefaults, /screenshotQuickSave: ''/)
  assert.match(settingsDefaults, /screenshotSaveAs: ''/)
  assert.match(settingsDefaults, /togglePinClickThrough: ''/)

  // The handler names must be exactly the settings keys: ShortcutService
  // dispatches the key name straight into the router.
  assert.match(functionRouter, /screenshotQuickSave: \(\) => createCapture\(\{[^}]*saveMode: 'fast'/)
  assert.match(functionRouter, /screenshotSaveAs: \(\) => createCapture\(\{[^}]*saveMode: 'dialog'/)
  assert.match(functionRouter, /async togglePinClickThrough\(\) \{[\s\S]*exitAllClickThrough\(\)/)
  assert.match(functionRouter, /getPinDomain/)
})

test('the settings page exposes the new capture rows through the shared update path', () => {
  // P0-7-T3: functionGroups feeds both the quick-function tabs and the hotkey
  // rows, so the two save shortcuts and the click-through exit need no extra
  // renderer wiring — the settings page picks them up from the same table S7's
  // router handlers are named after.
  // P0-1-T3（S1，批次 C）：functionGroups 的第 2/4 项改为语言表的键
  // （形状仍是 [名称, 文案键, 图标, 描述键]，图标契约不变），文案本体在
  // shared/locales/config.js —— readConfigSource() 已把它拼进来。
  assert.ok(config.includes("['screenshotQuickSave', 'config.function.screenshot-quick-save', '../capture/icons/save.svg', 'config.function.screenshot-quick-save-description']"))
  assert.ok(config.includes("['screenshotSaveAs', 'config.function.screenshot-save-as', '../capture/icons/save.svg', 'config.function.screenshot-save-as-description']"))
  assert.ok(config.includes("['togglePinClickThrough', 'config.function.toggle-pin-click-through', '../capture/icons/pin.svg', 'config.function.toggle-pin-click-through-description']"))

  // Since the settings IA reorg the flattened table lives in the quick-function
  // page's "shortcuts" tab (routes/home.js); the old standalone hotkey route is
  // gone. Read that file so the assertion still pins "the hotkey list is derived
  // from functionGroups and renders each stored accelerator".
  const homeRoute = fs.readFileSync(path.join(__dirname, '..', 'config', 'routes', 'home.js'), 'utf8')
  const shortcutsTab = homeRoute.slice(homeRoute.indexOf("homeTab === 'shortcuts'"), homeRoute.indexOf('function bindShortcutRecorders()'))
  assert.ok(shortcutsTab.includes('Object.values(functionGroups).flat()'), 'the shortcuts tab flattens functionGroups')
  assert.ok(shortcutsTab.includes("shortcutButton(name, settings.shortcuts[name] || '')"), 'every entry renders its stored hotkey')

  // S7's handlers emit these two source values (function-router.js), and the
  // history source filter labels them through this map.
  assert.ok(config.includes("'quick-save': 'config.history.source.quick-save'"))
  assert.ok(config.includes("'save-as': 'config.history.source.save-as'"))

  // Switch rows ride the shared switchMarkup/bindSwitches path: one level of
  // group nesting, so pinned.clickThrough must carry its own group name.
  assert.ok(config.includes("switchMarkup(settings.screenshot.shutterSound, 'shutterSound', 'screenshot')"))
  assert.ok(config.includes("switchMarkup(settings.screenshot.keepSerialAcrossCaptures, 'keepSerialAcrossCaptures', 'screenshot')"))
  assert.ok(config.includes("switchMarkup(settings.pinned.clickThrough, 'clickThrough', 'pinned')"))
  // D2-2（S14）：bindSwitches 移到 routes/shared.js，而 selectionToolbarCustomKey 移到
  // routes/selection-toolbar-editor.js，两者不再同文件 —— 原来的"到下一个函数为止"
  // 切片会把整条拼接源码都算进去，失去边界意义。改为切出 bindSwitches 自身的函数体。
  // CRLF：用 [\s\S]*? 配 \r?\n\}，不能用 [^\n]*\n 那类写法。
  const switchBinder = config.match(/function bindSwitches\(\) \{[\s\S]*?\r?\n\}/)[0]
  assert.ok(switchBinder.includes("document.querySelectorAll('[data-switch]')"), 'bindSwitches binds every rendered switch')
  assert.ok(switchBinder.includes('await updateSettings({ [group]: { [key]: value } })'), 'a switch submits one nested group')
  assert.ok(switchBinder.includes("element.classList.toggle('on', value)"), 'the switch reflects the stored value back')

  // S10b (Wave 7.5) lands the record audio rows and the screenshot cursor row on
  // that same switchMarkup/bindSwitches path, so neither renderer needs extra
  // wiring: bindSwitches already submits `{ record: { audioSystem: next } }`.
  assert.ok(config.includes("switchMarkup(settings.record.audioSystem !== false, 'audioSystem', 'record')"))
  assert.ok(config.includes("switchMarkup(settings.record.audioMicrophone === true, 'audioMicrophone', 'record')"))
  assert.ok(config.includes("switchMarkup(settings.screenshot.captureCursor === true, 'captureCursor', 'screenshot')"))
  // The rows render the frozen defaults (system sound on, microphone off, cursor
  // off) instead of carrying a default of their own.
  assert.equal(DEFAULT_SETTINGS.record.audioSystem, true)
  assert.equal(DEFAULT_SETTINGS.record.audioMicrophone, false)
  assert.equal(DEFAULT_SETTINGS.screenshot.captureCursor, false)
  // C2: the validator accepts exactly the patches those three switches submit.
  for (const patch of [
    { record: { audioSystem: false } },
    { record: { audioMicrophone: true } },
    { screenshot: { captureCursor: true } }
  ]) {
    assert.doesNotThrow(() => assertSettingsPatch(patch, DEFAULT_SETTINGS), JSON.stringify(patch))
  }

  // The text row round-trips like the neighbouring saveDirectory row: the
  // template renders from stored settings and the save button submits it.
  assert.ok(config.includes('id="nameTemplate" type="text" value="${escapeHtml(settings.screenshot.nameTemplate'))
  assert.ok(config.includes("nameTemplate: document.getElementById('nameTemplate').value.trim()"))
  // An empty template must be documented as "keep the legacy shape", because the
  // ownership regex in capture-naming.js predates the template.
  assert.ok(config.includes('留空沿用 Highlighter_&lt;date&gt;_&lt;time&gt;.png 旧格式'))
  assert.ok(config.includes('可用变量 {app}、{date}、{time}、{datetime}'))

  // Out of scope on purpose: the remembered directory is memory, not a row. The
  // record.* and captureCursor rows did land later (S10b), but they ride
  // data-switch, so no id-addressed "recordAudioSystem" input exists to find.
  assert.ok(!config.includes('id="lastSaveDirectory"'), 'lastSaveDirectory is a memory value, not a row')
  assert.ok(!/id="record(AudioSystem|CaptureCursor)"/.test(config), 'the record rows are switches, not id-addressed inputs')

  // C2 / the "new key" trap: the patch validator rejects keys that are missing
  // from the frozen template, so prove every new row's payload is accepted.
  for (const patch of [
    { screenshot: { shutterSound: false } },
    { screenshot: { nameTemplate: '{date}-{time}' } },
    { screenshot: { keepSerialAcrossCaptures: true } },
    { pinned: { clickThrough: true } }
  ]) {
    assert.doesNotThrow(() => assertSettingsPatch(patch, DEFAULT_SETTINGS), JSON.stringify(patch))
  }
  // Negative controls: the defaults the rows render are the frozen ones, and the
  // validator would still reject an unknown key or a wrong type.
  assert.equal(DEFAULT_SETTINGS.screenshot.shutterSound, true)
  assert.equal(DEFAULT_SETTINGS.screenshot.nameTemplate, '')
  assert.equal(DEFAULT_SETTINGS.screenshot.keepSerialAcrossCaptures, false)
  assert.equal(DEFAULT_SETTINGS.pinned.clickThrough, false)
  assert.throws(() => assertSettingsPatch({ screenshot: { notAFrozenKey: true } }, DEFAULT_SETTINGS), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ screenshot: { shutterSound: 'yes' } }, DEFAULT_SETTINGS), /类型无效/)

  // Acceptance §6.1-②: the three rows are recordable through the same patch the
  // recorder submits, while their empty default keeps them off the system.
  for (const key of ['screenshotQuickSave', 'screenshotSaveAs', 'togglePinClickThrough']) {
    assert.equal(DEFAULT_SETTINGS.shortcuts[key], '', key + ' must stay empty by default')
    assert.doesNotThrow(() => assertSettingsPatch({ shortcuts: { [key]: 'Ctrl+Shift+5' } }, DEFAULT_SETTINGS), key)
  }
  // A bare printable key never reaches the patch: the recorder refuses it.
  assert.equal(isRecordableShortcut('a'), false)
  assert.equal(isRecordableShortcut('Ctrl+Shift+5'), true)
})

test('the tray offers the mandatory bulk click-through exit', () => {
  const calls = []
  const template = buildTrayMenuTemplate({
    gameMode: true,
    executeFunction: (name) => calls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {}
  })
  const item = template.find((entry) => entry.label === '取消全部穿透')
  assert.ok(item, 'the tray entry exists')
  // Esc is unreliable in click-through mode, so this recovery entry must stay
  // reachable even while game mode disables the feature entries.
  assert.equal(item.enabled, true)
  item.click()
  assert.deepEqual(calls, [['execute', 'togglePinClickThrough']])

  const direct = []
  const injected = buildTrayMenuTemplate({
    executeFunction: () => direct.push('router'),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    exitClickThrough: () => direct.push('domain'),
    quit: () => {}
  }).find((entry) => entry.label === '取消全部穿透')
  injected.click()
  assert.deepEqual(direct, ['domain'], 'an injected domain exit is preferred over the router')
})

test('the main process wires the pin domain click-through exit into the router and the tray', () => {
  assert.match(main, /createFunctionRouter\(\{[\s\S]*getPinDomain/, 'the router can resolve the pin domain for the fallback shortcut')
  assert.match(main, /buildTrayMenuTemplate\(\{[\s\S]*exitClickThrough/, 'the tray entry calls the domain directly so it survives game mode')
})
test('the tray wires the Index-Translate proxy bridge through the optional menu entry', () => {
  assert.match(
    main,
    /const proxyState = proxyBridgeController \? proxyBridgeController\.menuState\(settings\) : null/,
    'the menu state reuses the settings snapshot the tray already read'
  )
  assert.match(
    main,
    /translationProxy: proxyState,[\s\S]*setTranslationProxyEnabled: \(enabled\) => proxyBridgeController\.setEnabled\(enabled\)/,
    'the tray entry is wired in main.js'
  )
  assert.match(main, /createProxyBridgeController\(\{[\s\S]*createTrayIcon[\s\S]*getMainWindow/, 'the controller owns the tray refresh and the status push')
  assert.match(main, /proxyBridgeController\.refresh\(\)\.finally\(\(\) => createTrayIcon\(\)\)/, 'startup reconciles the tray state')
  assert.match(main, /proxyBridgeController\?\.startIfConfigured\(\)/, 'autostart stays opt-in')
  assert.match(main, /if \(proxyBridgeController\) \{ proxyBridgeController\.dispose\(\); proxyBridgeController = null \}/, 'quitting kills the proxy')
})

test('the proxy settings group is part of the frozen validation template', () => {
  // The bridge is an in-process relay: no interpreter, no script path, no child
  // process to keep alive, so none of those may be configurable any more.
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS.proxy).sort(), [
    'apiBase',
    'autoStart',
    'host',
    'port'
  ])
  // Off by default: a plain `npm start`, a test run or CI must not open a port.
  assert.equal(DEFAULT_SETTINGS.proxy.autoStart, false)
  assert.equal(DEFAULT_SETTINGS.proxy.port, 8080)
  // The handoff document's red line: loopback only unless the user says otherwise.
  assert.equal(DEFAULT_SETTINGS.proxy.host, '127.0.0.1')
  // Empty means the built-in cloud endpoint.
  assert.equal(DEFAULT_SETTINGS.proxy.apiBase, '')

  for (const patch of [
    { proxy: { autoStart: true } },
    { proxy: { port: 8088 } },
    { proxy: { host: '0.0.0.0' } },
    { proxy: { apiBase: 'http://127.0.0.1:8000/v1' } }
  ]) {
    assert.doesNotThrow(() => assertSettingsPatch(patch, DEFAULT_SETTINGS), JSON.stringify(patch))
  }
  // Negative controls: the validator still rejects an unknown key or a wrong type,
  // and the fields the script-based bridge used to persist are now unknown.
  assert.throws(() => assertSettingsPatch({ proxy: { notAFrozenKey: true } }, DEFAULT_SETTINGS), /不支持的设置项/)
  assert.throws(() => assertSettingsPatch({ proxy: { port: '8080' } }, DEFAULT_SETTINGS), /类型无效/)
  for (const legacyKey of ['repoDirectory', 'scriptPath', 'pythonPath', 'keepRunningOnExit']) {
    assert.throws(() => assertSettingsPatch({ proxy: { [legacyKey]: '' } }, DEFAULT_SETTINGS), /不支持的设置项/, legacyKey)
  }
})

test('the proxy toggle is reachable from the hotkey page, the router and the settings card', () => {
  assert.equal(DEFAULT_SETTINGS.shortcuts.toggleTranslationProxy, '')
  assert.match(settingsDefaults, /toggleTranslationProxy: ''/)
  assert.match(functionRouter, /async toggleTranslationProxy\(\) \{[\s\S]*getProxyBridge[\s\S]*setEnabled/)
  assert.doesNotThrow(() => assertSettingsPatch({ shortcuts: { toggleTranslationProxy: 'Ctrl+Shift+9' } }, DEFAULT_SETTINGS))
  assert.ok(config.includes("['toggleTranslationProxy', 'config.function.toggle-translation-proxy', 'icons/lightning.svg', 'config.function.toggle-translation-proxy-description']"))

  // The card rides the shared switchMarkup/bindSwitches path for its switch and
  // the frozen `proxy` group for the text rows.
  assert.ok(config.includes("switchMarkup(settings.proxy.autoStart === true, 'autoStart', 'proxy')"))
  assert.ok(config.includes('id="proxyPort"'))
  assert.ok(config.includes('id="proxyApiBase"'))
  // Rows that belonged to the python script must be gone, not just hidden.
  for (const removed of ['proxyRepoDirectory', 'proxyScriptPath', 'proxyPythonPath', 'id="proxyKeepRunningOnExit"']) {
    assert.equal(config.includes(removed), false, `${removed} should no longer be rendered`)
  }
  assert.match(config, /await window\.electronAPI\.executeFunction\('toggleTranslationProxy'\)/)
  assert.match(config, /window\.electronAPI\.onProxyStatus\(renderProxyStatus\)/)
  assert.match(config, /navigator\.clipboard\.writeText\(t\('config\.settings-system\.proxy-copy-template'/)
})

test('the proxy status channel rides the existing main IPC surface', () => {
  const ipcSecurity = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'ipc-security.js'), 'utf8')
  const appIpc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'app-ipc.js'), 'utf8')
  assert.ok(ipcSecurity.includes("'app:get-proxy-status'"), 'the channel has a sender policy')
  assert.match(appIpc, /ipcMain\.handle\('app:get-proxy-status', \(\) => controller\.getProxyStatus\(\)\)/)
  assert.match(preload, /getProxyStatus: \(\) => ipcRenderer\.invoke\('app:get-proxy-status'\)/)
  assert.match(preload, /onProxyStatus: \(callback\) =>/)
  assert.match(main, /getProxyStatus: \(\) => proxyBridgeController\.getStatus\(\)/)
})

test('recording defers to the shared key rules and stored values are repaired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
  const validation = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'settings-validation.js'), 'utf8')
  const shortcutService = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'shortcut-service.js'), 'utf8')
  const migration = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'shortcut-migration.js'), 'utf8')

  // The renderer needs the shared module before config.js runs. D2-2（S14）：路由文件
  // 插在共享模块与主壳之间（中间还有说明注释），因此按**顺序**断言：
  // shared/shortcut-keys.js 先于 routes/shared.js，后者先于主壳 config.js。
  assert.ok(html.indexOf('<script src="../shared/shortcut-keys.js"></script>') < html.indexOf('<script src="routes/shared.js"></script>'))
  assert.ok(html.indexOf('<script src="routes/shared.js"></script>') < html.lastIndexOf('<script src="config.js"></script>'))
  // The recorder must not rebuild an accelerator by hand again: it asks the
  // shared module, waits out input-method compositions, and reports rejections.
  assert.match(config, /keys\.isIgnoredRecordingEvent\(keyEvent\)/)
  assert.match(config, /keys\.isRecordableShortcut\(accelerator\)/)
  assert.match(config, /keys\.describeShortcutRejection\(/)
  assert.doesNotMatch(config, /keyEvent\.key\.length === 1 \? keyEvent\.key\.toUpperCase\(\)/)
  // Both the patch validator and the registry refuse a value that cannot register.
  assert.match(validation, /isValidAccelerator\(value\)/)
  assert.match(shortcutService, /!isValidAccelerator\(accelerator\)/)
  assert.match(migration, /isValidAccelerator\(raw\)/)
  assert.match(main, /migrateShortcutSettings\(appearance\.settings, \{ log \}\)/)
})
