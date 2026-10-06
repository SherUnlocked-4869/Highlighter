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
  normalizeConversation,
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
    conversation: { enabled: true, maxFollowUpTurns: 10, persist: false },
    resultWindow: { width: 550, height: 560 }
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
    { id: 'custom:polish', label: '优化', icon: 'stars', kind: 'ai', prompt: '优化这段话', custom: true },
    { id: 'translate', label: '翻译', icon: 'translate', kind: 'ai', prompt: '翻译提示' },
    { id: 'copy', label: '复制', icon: 'copy', kind: 'local', prompt: '' }
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

test('follow-up conversation settings default on with a whitelisted turn limit', () => {
  assert.deepEqual(normalizeConversation(undefined), { enabled: true, maxFollowUpTurns: 10, persist: false })
  assert.deepEqual(normalizeConversation({}), { enabled: true, maxFollowUpTurns: 10, persist: false })
  // enabled is strictly boolean: neither a truthy string nor 1 turns it on.
  assert.equal(normalizeConversation({ enabled: 'false' }).enabled, true)
  assert.equal(normalizeConversation({ enabled: 0 }).enabled, true)
  assert.equal(normalizeConversation({ enabled: false }).enabled, false)
  // Saving transcripts is opt-in, so only an explicit true enables it.
  assert.equal(normalizeConversation({ persist: true }).persist, true)
  for (const value of ['true', 1, {}]) {
    assert.equal(normalizeConversation({ persist: value }).persist, false, String(value))
  }
  // Only the listed steps are reachable from the settings UI, so anything else
  // falls back to the default rather than to the nearest bound.
  for (const value of [3, 5, 10, 20]) {
    assert.equal(normalizeConversation({ maxFollowUpTurns: value }).maxFollowUpTurns, value)
  }
  for (const value of [0, 4, 7, 11, 100, -3, '5', null, NaN]) {
    assert.equal(normalizeConversation({ maxFollowUpTurns: value }).maxFollowUpTurns, 10, String(value))
  }
  assert.equal(normalizeSelectionToolbar({ conversation: { maxFollowUpTurns: 5 } }).conversation.maxFollowUpTurns, 5)
  assert.equal(normalizeSelectionToolbar({ conversation: 'yes' }).conversation.enabled, true)
  assert.equal(normalizeSelectionToolbar({ conversation: [] }).conversation.maxFollowUpTurns, 10)
})

test('selection result window size is normalized to safe dimensions', () => {  assert.deepEqual(normalizeSelectionToolbar({ resultWindow: { width: 640.4, height: 180 } }).resultWindow, {
    width: 640,
    height: 340
  })
  assert.deepEqual(normalizeSelectionToolbar({ resultWindow: { width: 'invalid', height: Infinity } }).resultWindow, {
    width: 550,
    height: 560
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
  assert.equal(getToolbarWidth(['copy']), 104)
  assert.equal(getToolbarWidth(['copy', 'search', 'translate', 'explain']), 359)
  assert.ok(getToolbarWidth([{ label: '这是一个较长功能' }]) > getToolbarWidth(['copy']))
})

test('toolbar window budget covers the chrome the strip CSS adds', () => {
  // Mirrors toolbar/toolbar.html. 17 is the largest reachable action count:
  // 4 builtin + 1 optional + MAX_CUSTOM_ACTIONS (12).
  // 66 is the measured natural width of a two-character button once the 15px
  // mask icon is in place (padding 20 + border 2 + icon 15 + gap 5 + 2x12px
  // glyphs), and it is the binding constraint: the strip is a flex row inside a
  // frameless window sized to exactly this budget, so a budget that only clears
  // the 62px CSS min-width still shrinks the button below its own content and
  // clips the ends once the overflow passes the window padding.
  const minimum = (count) =>
    14 + 13 + (count - 1) * 5 + (2 * count - 1) * 3 + 66 * count
  for (let count = 1; count <= 17; count += 1) {
    const actions = Array.from({ length: count }, () => 'copy')
    assert.ok(
      getToolbarWidth(actions) >= minimum(count),
      `${count} actions must fit inside the window the manager is told to open`
    )
  }
})
