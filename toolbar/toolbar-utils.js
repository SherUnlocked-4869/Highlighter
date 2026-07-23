const DEFAULT_SELECTION_TOOLBAR = Object.freeze({
  enabled: true,
  buttons: Object.freeze({ copy: true, search: true, translate: true, explain: true }),
  searchEngine: 'bing'
})

const TOOLBAR_ACTION_ORDER = Object.freeze(['copy', 'search', 'translate', 'explain'])
const SEARCH_URLS = Object.freeze({
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  google: 'https://www.google.com/search?q='
})

function getVisibleToolbarActions(config = DEFAULT_SELECTION_TOOLBAR) {
  if (!config?.enabled) return []
  const buttons = config.buttons || {}
  return TOOLBAR_ACTION_ORDER.filter((action) => buttons[action] !== false)
}

function buildSearchUrl(engine, text) {
  const prefix = SEARCH_URLS[engine] || SEARCH_URLS.bing
  return `${prefix}${encodeURIComponent(String(text || ''))}`
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
