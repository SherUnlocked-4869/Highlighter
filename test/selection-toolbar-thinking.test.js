const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  DEFAULT_TOOLBAR_THINKING,
  buildOpenUrl,
  getToolbarActionDefinition,
  getToolbarActionThinking,
  getVisibleToolbarActions,
  isLocalToolbarAction,
  normalizeSelectionToolbar,
  normalizeToolbarThinking
} = require('../toolbar/toolbar-utils')
const { buildToolbarStreamRequest } = require('../deepseek')

test('thinking levels map to DeepSeek thinking mode requests', () => {
  const off = buildToolbarStreamRequest('划词文本', '提示词', { thinking: 'off' })
  assert.equal(off.temperature, 0.3)
  assert.equal(Object.hasOwn(off, 'reasoning_effort'), false)
  assert.deepEqual(off.extra_body, { thinking: { type: 'disabled' } })

  const low = buildToolbarStreamRequest('划词文本', '提示词', { thinking: 'low' })
  assert.equal(low.reasoning_effort, 'low')
  assert.deepEqual(low.extra_body, { thinking: { type: 'enabled' } })
  assert.equal(Object.hasOwn(low, 'temperature'), false)

  const high = buildToolbarStreamRequest('划词文本', '提示词', { thinking: 'high' })
  assert.equal(high.reasoning_effort, 'high')
  assert.deepEqual(high.extra_body, { thinking: { type: 'enabled' } })

  const max = buildToolbarStreamRequest('划词文本', '提示词', { thinking: 'max' })
  assert.equal(max.reasoning_effort, 'max')
  assert.deepEqual(max.extra_body, { thinking: { type: 'enabled' } })
  assert.equal(Object.hasOwn(max, 'temperature'), false)
})

test('toolbar thinking settings normalize to known levels with stable defaults', () => {
  assert.deepEqual(DEFAULT_TOOLBAR_THINKING, { translate: 'off', explain: 'high' })
  assert.deepEqual(normalizeToolbarThinking({ translate: 'low', explain: 'strange' }), {
    translate: 'low',
    explain: 'high'
  })
  assert.deepEqual(normalizeToolbarThinking({ translate: 'max', explain: 'off' }), {
    translate: 'max',
    explain: 'off'
  })
  assert.deepEqual(normalizeToolbarThinking(undefined), { translate: 'off', explain: 'high' })
})

test('built-in and custom AI actions resolve their configured thinking levels', () => {
  const toolbar = normalizeSelectionToolbar({
    customActions: [
      { id: 'polish', name: '优化', prompt: '优化这段话', thinking: 'low' },
      { id: 'deep', name: '深度分析', prompt: '深入分析这段话', thinking: 'max' },
      { id: 'legacy', name: '旧功能', prompt: '处理这段话' }
    ]
  })
  const thinking = { translate: 'low', explain: 'off' }

  assert.equal(getToolbarActionThinking(toolbar, thinking, 'translate'), 'low')
  assert.equal(getToolbarActionThinking(toolbar, thinking, 'explain'), 'off')
  assert.equal(getToolbarActionThinking(toolbar, thinking, 'custom:polish'), 'low')
  assert.equal(getToolbarActionThinking(toolbar, thinking, 'custom:deep'), 'max')
  assert.equal(getToolbarActionThinking(toolbar, thinking, 'custom:legacy'), 'high')
  assert.equal(getToolbarActionThinking(toolbar, thinking, 'copy'), 'off')
})

test('optional open action joins the toolbar only when configured into the order', () => {
  const enabled = normalizeSelectionToolbar({ order: ['copy', 'open'] })
  assert.deepEqual(getVisibleToolbarActions(enabled), ['copy', 'open', 'search', 'translate', 'explain'])
  assert.deepEqual(getToolbarActionDefinition(enabled, 'open'), {
    id: 'open',
    label: '跳转',
    icon: '↗',
    kind: 'local',
    prompt: ''
  })
  assert.equal(isLocalToolbarAction('open'), true)

  const legacy = normalizeSelectionToolbar({ buttons: { copy: true, search: true, translate: true, explain: true } })
  assert.deepEqual(legacy.order, ['copy', 'search', 'translate', 'explain'])
})

test('open action treats the selection as a browser destination without validating it', () => {
  assert.equal(buildOpenUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(buildOpenUrl('example.com'), 'http://example.com')
  assert.equal(buildOpenUrl('example.com/路径'), 'http://example.com/%E8%B7%AF%E5%BE%84')
  assert.equal(buildOpenUrl('  '), '')
})

test('config page exposes thinking controls and the optional open action', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.js'), 'utf8')
  assert.match(script, /id="translateThinking"/)
  assert.match(script, /id="explainThinking"/)
  assert.match(script, /data-custom-thinking/)
  assert.match(script, /value="max">最高/)
  assert.match(script, /toolbarThinking/)
  assert.match(script, /open: \{ label: '跳转'/)
})

test('main process resolves thinking per action and opens links for the open action', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /requestOptions\.thinking = getToolbarActionThinking\(/)
  assert.match(main, /toolbarThinking: \{ \.\.\.DEFAULT_TOOLBAR_THINKING \}/)
  assert.match(main, /else if \(action === 'open'\)/)
  assert.match(main, /buildOpenUrl\(text\)/)
})
