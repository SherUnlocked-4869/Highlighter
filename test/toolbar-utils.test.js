const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TRANSLATE_PROMPT,
  buildSearchUrl,
  getToolbarActionDefinition,
  getToolbarWidth,
  getVisibleToolbarActionDefinitions,
  getVisibleToolbarActions,
  normalizeSelectionToolbar
} = require('../toolbar/toolbar-utils')

test('default selection toolbar enables all built-ins with editable prompts and stable order', () => {
  assert.deepEqual(DEFAULT_SELECTION_TOOLBAR, {
    enabled: true,
    clipboardFallback: false,
    buttons: { copy: true, search: true, translate: true, explain: true },
    order: ['copy', 'search', 'translate', 'explain'],
    prompts: {
      translate: DEFAULT_TRANSLATE_PROMPT,
      explain: DEFAULT_EXPLAIN_PROMPT
    },
    customActions: [],
    searchEngine: 'bing',
    translateLanguages: { source: 'auto', target: '中文' },
    resultWindow: { width: 550, height: 520 }
  })
  assert.deepEqual(getVisibleToolbarActions(DEFAULT_SELECTION_TOOLBAR), [
    'copy', 'search', 'translate', 'explain'
  ])
})

test('legacy toolbar settings gain defaults without losing disabled buttons or search engine', () => {
  const normalized = normalizeSelectionToolbar({
    enabled: true,
    buttons: { copy: false, search: true, translate: false, explain: true },
    searchEngine: 'google'
  })

  assert.deepEqual(normalized.order, ['copy', 'search', 'translate', 'explain'])
  assert.equal(normalized.buttons.copy, false)
  assert.equal(normalized.buttons.translate, false)
  assert.equal(normalized.searchEngine, 'google')
  assert.equal(normalized.clipboardFallback, false)
  assert.deepEqual(normalized.translateLanguages, { source: 'auto', target: '中文' })
  assert.equal(normalized.prompts.translate, DEFAULT_TRANSLATE_PROMPT)
  assert.equal(normalized.prompts.explain, DEFAULT_EXPLAIN_PROMPT)
  assert.deepEqual(normalized.customActions, [])
})

test('clipboard fallback is opt-in only', () => {
  assert.equal(normalizeSelectionToolbar({ clipboardFallback: true }).clipboardFallback, true)
  assert.equal(normalizeSelectionToolbar({ clipboardFallback: 1 }).clipboardFallback, false)
  assert.equal(normalizeSelectionToolbar({ clipboardFallback: 'true' }).clipboardFallback, false)
})

test('translate languages keep whitelisted values and fall back per field', () => {
  assert.deepEqual(normalizeSelectionToolbar({
    translateLanguages: { source: '日文', target: '英文' }
  }).translateLanguages, { source: '日文', target: '英文' })
  assert.deepEqual(normalizeSelectionToolbar({
    translateLanguages: { source: '韩文' }
  }).translateLanguages, { source: '韩文', target: '中文' })
  assert.deepEqual(normalizeSelectionToolbar({
    translateLanguages: { source: '法文', target: '俄文' }
  }).translateLanguages, { source: 'auto', target: '中文' })
  assert.deepEqual(normalizeSelectionToolbar({}).translateLanguages, { source: 'auto', target: '中文' })
})

test('visible actions follow configured order and include enabled custom AI actions', () => {
  const config = normalizeSelectionToolbar({
    enabled: true,
    buttons: { copy: true, search: false, translate: true, explain: false },
    order: ['custom:polish', 'translate', 'copy', 'search', 'explain', 'custom:summarize'],
    prompts: { translate: '翻译提示', explain: '解释提示' },
    customActions: [
      { id: 'polish', name: '优化', prompt: '优化这段话', enabled: true },
      { id: 'summarize', name: '总结', prompt: '总结这段话', enabled: false }
    ]
  })

  assert.deepEqual(getVisibleToolbarActions(config), ['custom:polish', 'translate', 'copy'])
  assert.deepEqual(getVisibleToolbarActionDefinitions(config), [
    { id: 'custom:polish', label: '优化', icon: '✦', kind: 'ai', prompt: '优化这段话', custom: true },
    { id: 'translate', label: '翻译', icon: '译', kind: 'ai', prompt: '翻译提示' },
    { id: 'copy', label: '复制', icon: '⧉', kind: 'local', prompt: '' }
  ])
})

test('normalization rejects malformed custom actions and repairs incomplete order', () => {
  const config = normalizeSelectionToolbar({
    order: ['custom:valid', 'custom:missing', 'copy', 'copy'],
    prompts: { translate: '', explain: '' },
    customActions: [
      { id: 'valid', name: ' 优化 ', prompt: ' 优化这段话 ', enabled: true },
      { id: '../bad', name: '越界', prompt: '提示词' },
      { id: 'empty', name: '', prompt: '提示词' },
      { id: 'valid', name: '重复', prompt: '提示词' }
    ],
    searchEngine: 'unknown'
  })

  assert.deepEqual(config.customActions, [
    { id: 'valid', name: '优化', prompt: '优化这段话', enabled: true }
  ])
  assert.deepEqual(config.order, ['custom:valid', 'copy', 'search', 'translate', 'explain'])
  assert.equal(config.prompts.translate, DEFAULT_TRANSLATE_PROMPT)
  assert.equal(config.prompts.explain, DEFAULT_EXPLAIN_PROMPT)
  assert.equal(config.searchEngine, 'bing')
  assert.equal(getToolbarActionDefinition(config, 'custom:missing'), null)
})

test('selection result window size is normalized to safe dimensions', () => {
  assert.deepEqual(normalizeSelectionToolbar({ resultWindow: { width: 640.4, height: 180 } }).resultWindow, {
    width: 640,
    height: 300
  })
  assert.deepEqual(normalizeSelectionToolbar({ resultWindow: { width: 'invalid', height: Infinity } }).resultWindow, {
    width: 550,
    height: 520
  })
})

test('disabled toolbar and disabled buttons produce no visible actions', () => {
  assert.deepEqual(getVisibleToolbarActions({ enabled: false }), [])
  assert.deepEqual(getVisibleToolbarActions({
    enabled: true,
    buttons: { copy: false, search: false, translate: false, explain: false }
  }), [])
})

test('search URLs encode text and unknown engines fall back to Bing', () => {
  const query = '划词 a&b'
  assert.equal(buildSearchUrl('bing', query), 'https://www.bing.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('baidu', query), 'https://www.baidu.com/s?wd=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('google', query), 'https://www.google.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
  assert.equal(buildSearchUrl('unknown', query), 'https://www.bing.com/search?q=%E5%88%92%E8%AF%8D%20a%26b')
})

test('toolbar width grows by stable slots and accommodates longer custom labels', () => {
  assert.equal(getToolbarWidth([]), 0)
  assert.equal(getToolbarWidth(['copy']), 90)
  assert.equal(getToolbarWidth(['copy', 'search', 'translate', 'explain']), 300)
  assert.ok(getToolbarWidth([{ label: '这是一个较长功能' }]) > getToolbarWidth(['copy']))
})
