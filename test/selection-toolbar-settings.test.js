const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const html = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.html'), 'utf8')
const script = readConfigSource()
const actionMeta = fs.readFileSync(path.join(__dirname, '..', 'toolbar', 'toolbar-action-meta.js'), 'utf8')
const { CONVERSATION_TURN_LIMITS } = require('../toolbar/toolbar-utils')

test('settings page wires the follow-up switch and a turn limit matching the whitelist', () => {
  assert.match(script, /id="conversationEnabled"/)
  assert.match(script, /id="conversationTurns"/)
  assert.match(script, /id="conversationPersist"/)
  assert.match(script, /追问开关/)
  assert.match(script, /追问轮数/)
  assert.match(script, /保存对话到本地/)
  // conversation is a nested object and bindSwitches only builds one level, so
  // this switch has to be hand-wired; a data-switch here would send
  // { selectionToolbar: { conversation: false } } and get rejected as a type error.
  assert.doesNotMatch(script, /switchMarkup\([^)]*conversation/)
  // P0-1-T3（S1，批次 C）：toast 文案改为语言表取键（文案本体在
  // shared/locales/config.js，readConfigSource() 已拼接它）。
  assert.match(script, /updateSettings\(\{ selectionToolbar: \{ conversation: \{ enabled: value \} \} \}, t\('config\.selection-toolbar\.conversation-enabled-updated'\)\)/)
  assert.match(script, /conversationTurns\.onchange = \(\) => updateSettings\(\{ selectionToolbar: \{ conversation: \{ maxFollowUpTurns: Number\(conversationTurns\.value\) \} \} \}, t\('config\.selection-toolbar\.conversation-turns-updated'\)\)/)
  // A selectable option outside the whitelist would be silently reset on the
  // next normalization; a missing one would make that value unreachable.
  const options = [...script.matchAll(/<option value="(\d+)">\$\{t\('config\.selection-toolbar\.conversation-turns-option', \{ count: \d+ \}\)\}<\/option>/g)].map((match) => Number(match[1]))
  assert.deepEqual(options, [...CONVERSATION_TURN_LIMITS])
})

test('config app exposes the selection toolbar route and controls', () => {
  assert.match(html, /data-route="selection-toolbar"/)
  assert.match(script, /function renderSelectionToolbarSettings\(/)
  assert.match(script, /id="searchEngine"/)
  assert.match(script, /id="translatePrompt"/)
  assert.match(script, /id="explainPrompt"/)
  assert.match(script, /id="translateSourceLanguage"/)
  assert.match(script, /id="translateTargetLanguage"/)
  assert.match(script, /翻译原语言/)
  assert.match(script, /翻译目标语言/)
  assert.match(script, /id="addCustomToolbar"/)
  assert.match(script, /剪贴板兼容模式/)
  assert.match(script, /switchMarkup\(toolbar\.clipboardFallback, 'clipboardFallback', 'selectionToolbar'\)/)
  assert.match(script, /data-custom-name/)
  assert.match(script, /data-custom-prompt/)
  assert.match(script, /data-delete-custom-toolbar/)
  assert.match(script, /data-move-toolbar/)
  assert.match(script, /draggable="true"/)
  assert.match(script, /ondrop/)
  // Action metadata moved to toolbar/toolbar-action-meta.js so the main process
  // and the settings page share one definition; the page reads it via the UMD
  // global that config.html loads first.
  assert.match(html, /<script src="\.\.\/toolbar\/toolbar-action-meta\.js"><\/script>/)
  assert.match(script, /window\.toolbarActionMeta\.TOOLBAR_ACTION_META/)
  for (const action of ['copy', 'search', 'translate', 'explain']) {
    assert.match(actionMeta, new RegExp(`${action}: Object\\.freeze\\(\\{ id: '${action}', label:`))
  }
})

test('main process normalizes toolbar settings and routes configured custom prompts', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const normalizer = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'settings-normalize.js'), 'utf8')
  const settingsEffects = fs.readFileSync(path.join(__dirname, '..', 'main/domains/settings-effects/index.js'), 'utf8')
  const selectionDomain = fs.readFileSync(path.join(__dirname, '..', 'main/domains/selection/index.js'), 'utf8')
  const router = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'ai-feature-router.js'), 'utf8')
  const deepseek = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'ai', 'client.js'), 'utf8')
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar', 'toolbar.js'), 'utf8')
  const action = fs.readFileSync(path.join(__dirname, '..', 'action', 'action.js'), 'utf8')

  assert.match(normalizer, /normalized\.selectionToolbar = normalizeSelectionToolbar/)
  assert.match(selectionDomain, /enableClipboard: getSettings\(\)\.selectionToolbar\.clipboardFallback/)
  assert.match(settingsEffects, /updateStartOptions\(\{\s*enableClipboard: settings\.selectionToolbar\.clipboardFallback/)
  assert.match(main, /settingsEffects\.applyUpdate/)
  assert.match(main, /consoleLike: app\.isPackaged \? null : console/)
  assert.match(selectionDomain, /getVisibleToolbarActionDefinitions/)
  assert.match(selectionDomain, /getToolbarActionDefinition\(toolbarConfig, action\)/)
  assert.match(selectionDomain, /createToolbarActionStream\(\{ settings: currentSettings, action, text, requestOptions \}\)/)
  assert.match(router, /clients\.createTranslateStream\(provider, text, action\.prompt, languages, requestOptions\)/)
  assert.match(router, /settings\.selectionToolbar\?\.translateLanguages/)
  assert.match(router, /clients\.createExplainStream\(provider, text, action\.prompt, requestOptions\)/)
  assert.match(router, /clients\.createCustomStream\(provider, text, action\.prompt, requestOptions\)/)
  assert.match(selectionDomain, /label: actionDefinition\.label/)
  assert.match(deepseek, /role: 'system', content: prompt/)
  assert.match(toolbar, /action\.label/)
  assert.match(toolbar, /toolbarAPI\.action\(action\.id\)/)
  // P0-1-T5（S12，批次 C）：兜底标签改为语言表取键并抽成具名常量，
  // 断言随之改为"该常量存在 + 取自语言表"。
  assert.match(action, /const EXPLAIN_LABEL = t\('action\.answer\.label\.explain'\)/)
  assert.match(action, /const label = data\.label \? t\(data\.label\) : EXPLAIN_LABEL/)
})

test('selection toolbar appearance avoids a clipped rectangular shadow', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'selection-window-manager.js'), 'utf8')
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar', 'toolbar.html'), 'utf8')

  assert.match(manager, /createToolbarWindow\(\)[\s\S]*?hasShadow: false/)
  assert.match(toolbar, /\.toolbar \{[\s\S]*?box-shadow: inset/)
  assert.match(toolbar, /\.toolbar \{[\s\S]*?height: 40px/)
  assert.doesNotMatch(toolbar, /box-shadow: 0 4px 24px/)
})
