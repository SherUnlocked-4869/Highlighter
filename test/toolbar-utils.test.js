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
