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
  // 热切换修复：标签改为在 renderHeader() 里用 t() 现场解析（见下方新用例），
  // 因此这条断言跟踪的是那行渲染期解析，而不是 onActionStart 里的一次性句子。
  assert.match(action, /const EXPLAIN_LABEL = t\('action\.answer\.label\.explain'\)/)
  assert.match(action, /const label = conversation\.labelSource \? t\(conversation\.labelSource\) : t\('action\.answer\.label\.explain'\)/)
})

// 热切换修复（批次 C 遗留）：表头原先在 onActionStart 里被写成一句已经翻译好的话，
// 语言切换时 applyTranslations() 先把静态 markup 放回去，表头就退回"翻译中…"。
// 现在表头保存原始动作标识（type + label 键），由 renderHeader() 在广播里重画。
test('the action header re-renders in the active language after a language switch', () => {
  const action = fs.readFileSync(path.join(__dirname, '..', 'action', 'action.js'), 'utf8')
  const actionHtml = fs.readFileSync(path.join(__dirname, '..', 'action', 'action.html'), 'utf8')

  // 1) 原始身份，而不是成品句子。
  assert.match(action, /conversation\.type = data\.type \|\| ''/)
  assert.match(action, /conversation\.labelSource = data\.label \|\| ''/)
  assert.match(action, /type: '',\r?\n\s*labelSource: '',/)

  // 2) 标签在渲染期解析：内置动作是键，自定义名称不是键（t() 原样返回）。
  assert.match(action, /const label = conversation\.labelSource \? t\(conversation\.labelSource\) : t\('action\.answer\.label\.explain'\)/)
  assert.match(action, /conversation\.label = label/)
  // 翻译分支同样刷新 conversation.label（复制会话时要用）。
  assert.match(action, /conversation\.label = t\('action\.answer\.label\.translate'\)/)

  // 3) 每个状态都写满五个节点，取值与改动前的输出逐字一致。
  const header = action.match(/function renderHeader\(\) \{[\s\S]*?\n\}/)
  assert.ok(header, 'renderHeader() must exist at the top level')
  assert.doesNotMatch(header[0], /EXPLAIN_LABEL/, 'explain 兜底必须在渲染期取键，不能是启动期常量')
  assert.match(header[0], /if \(conversation\.type === ''\) \{[\s\S]*?ACTION_ICONS\.translate[\s\S]*?t\('action\.header\.translating'\)[\s\S]*?t\('action\.answer\.label\.translate'\)[\s\S]*?className = 'badge'[\s\S]*?t\('action\.loading\.requesting'\)/)
  assert.match(header[0], /if \(conversation\.type === 'translate'\) \{[\s\S]*?className = 'badge'[\s\S]*?t\('action\.loading\.translating'\)/)
  assert.match(header[0], /conversation\.type === 'explain' \? ACTION_ICONS\.explain : ACTION_ICONS\.custom/)
  assert.match(header[0], /className = 'badge explain'[\s\S]*?t\('action\.loading\.thinking'\)/)

  // 4) onActionStart 存原始值后重画；广播处理器在 applyTranslations() 之后重画。
  const start = action.match(/onActionStart\(function\(data\) \{[\s\S]*?\n\}\)/)
  assert.ok(start, 'onActionStart() must exist')
  assert.match(start[0], /conversation\.labelSource = data\.label \|\| ''[\s\S]*?renderHeader\(\)/)
  const broadcast = action.match(/window\.actionAPI\.onInterfaceLanguage\(\(language\) => \{[\s\S]*?\n\}\)/)
  assert.ok(broadcast, 'the language broadcast handler must exist')
  assert.match(broadcast[0], /setLanguage\(language\)\s*\n\s*applyTranslations\(\)\s*\n\s*renderHeader\(\)/)
  // 首屏也要语言正确，所以启动时同样重画一次。
  assert.match(action, /^applyTranslations\(\)\r?\nrenderHeader\(\)$/m)

  // 5) data-i18n 属性保留（首屏绘制），只有脚本重画会覆盖它们。
  assert.match(actionHtml, /id="headerTitle" data-i18n="action\.header\.translating"/)
  assert.match(actionHtml, /id="headerBadge" data-i18n="action\.answer\.label\.translate"/)
  assert.match(actionHtml, /id="loadingText" data-i18n="action\.loading\.requesting"/)
})

test('selection toolbar appearance avoids a clipped rectangular shadow', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'selection-window-manager.js'), 'utf8')
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'toolbar', 'toolbar.html'), 'utf8')
  const tokens = fs.readFileSync(path.join(__dirname, '..', 'shared', 'tokens.css'), 'utf8')

  assert.match(manager, /createToolbarWindow\(\)[\s\S]*?hasShadow: false/)
  // The contract is "this strip must not carry an OUTER shadow", because the window
  // is sized exactly to the element and would clip it into a rectangle. That used to
  // be asserted as `box-shadow: inset` in the stylesheet itself; now the strip reads
  // the shared --shadow-bevel token, so the assertion moved to the ACTUAL VALUE: the
  // token must exist and must be inset-only in both themes.
  assert.match(toolbar, /\.toolbar \{[\s\S]*?box-shadow: var\(--shadow-bevel\)/)
  const bevels = tokens.match(/--shadow-bevel:[^;]+;/g) || []
  assert.equal(bevels.length, 2, '--shadow-bevel is declared for both themes')
  for (const declaration of bevels) {
    const layers = declaration.replace('--shadow-bevel:', '').replace(';', '').split(/,(?![^(]*\))/)
    for (const layer of layers) {
      assert.match(layer.trim(), /^inset/, `every --shadow-bevel layer is inset-only, got: ${layer.trim()}`)
    }
  }
  assert.match(toolbar, /\.toolbar \{[\s\S]*?height: 40px/)
  assert.doesNotMatch(toolbar, /box-shadow: 0 4px 24px/)
})
