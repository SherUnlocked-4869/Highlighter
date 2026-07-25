const DEFAULT_TRANSLATE_PROMPT = '你是一个专业的翻译助手。请将用户输入的任何语言翻译成中文。对于中文输入，翻译成英文。只输出翻译结果，不要添加任何额外说明或解释。'
const DEFAULT_EXPLAIN_PROMPT = '你是一个知识渊博的解说专家。请对用户提供的文本进行深入分析和解读：\n\n### 核心要点\n先用一句话概括核心内容。\n\n### 详细解释\n对文本中的关键概念、术语、背景进行详细解释，帮助用户全面理解。如果涉及专业知识，请进行通俗易懂的说明。\n\n### 延伸知识\n补充相关的背景信息、实际应用场景或有趣的引申知识点。\n\n请使用中文回答，内容充实但不冗长，层次分明。'

const BUILTIN_TOOLBAR_ACTIONS = Object.freeze({
  copy: Object.freeze({ id: 'copy', label: '复制', icon: '⧉', kind: 'local' }),
  search: Object.freeze({ id: 'search', label: '搜索', icon: '⌕', kind: 'local' }),
  translate: Object.freeze({ id: 'translate', label: '翻译', icon: '译', kind: 'ai' }),
  explain: Object.freeze({ id: 'explain', label: '解释', icon: '?', kind: 'ai' })
})

const TOOLBAR_ACTION_ORDER = Object.freeze(Object.keys(BUILTIN_TOOLBAR_ACTIONS))
const LOCAL_TOOLBAR_ACTIONS = new Set(['copy', 'search'])
const AI_TOOLBAR_ACTIONS = new Set(['translate', 'explain'])
const SEARCH_URLS = Object.freeze({
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  google: 'https://www.google.com/search?q='
})
const SEARCH_ENGINES = new Set(Object.keys(SEARCH_URLS))
const CUSTOM_ACTION_PREFIX = 'custom:'
const MAX_CUSTOM_ACTIONS = 12
const MAX_CUSTOM_NAME_LENGTH = 16
const MAX_PROMPT_LENGTH = 6000

const DEFAULT_SELECTION_TOOLBAR = Object.freeze({
  enabled: true,
  buttons: Object.freeze({ copy: true, search: true, translate: true, explain: true }),
  order: TOOLBAR_ACTION_ORDER,
  prompts: Object.freeze({
    translate: DEFAULT_TRANSLATE_PROMPT,
    explain: DEFAULT_EXPLAIN_PROMPT
  }),
  customActions: Object.freeze([]),
  searchEngine: 'bing'
})

function cleanText(value, maximumLength) {
  return String(value ?? '').trim().slice(0, maximumLength)
}

function customActionKey(id) {
  return `${CUSTOM_ACTION_PREFIX}${id}`
}

function parseCustomActionKey(action) {
  const value = String(action || '')
  return value.startsWith(CUSTOM_ACTION_PREFIX) ? value.slice(CUSTOM_ACTION_PREFIX.length) : ''
}

function normalizeCustomActions(value) {
  if (!Array.isArray(value)) return []
  const actions = []
  const ids = new Set()
  for (const item of value) {
    if (!item || typeof item !== 'object' || actions.length >= MAX_CUSTOM_ACTIONS) continue
    const id = cleanText(item.id, 64)
    const name = cleanText(item.name, MAX_CUSTOM_NAME_LENGTH)
    const prompt = cleanText(item.prompt, MAX_PROMPT_LENGTH)
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id) || !name || !prompt) continue
    ids.add(id)
    actions.push({ id, name, prompt, enabled: item.enabled !== false })
  }
  return actions
}

function normalizeSelectionToolbar(value = {}) {
  const config = value && typeof value === 'object' ? value : {}
  const buttons = {}
  for (const action of TOOLBAR_ACTION_ORDER) buttons[action] = config.buttons?.[action] !== false

  const translatePrompt = cleanText(config.prompts?.translate, MAX_PROMPT_LENGTH) || DEFAULT_TRANSLATE_PROMPT
  const explainPrompt = cleanText(config.prompts?.explain, MAX_PROMPT_LENGTH) || DEFAULT_EXPLAIN_PROMPT
  const customActions = normalizeCustomActions(config.customActions)
  const validActions = new Set([
    ...TOOLBAR_ACTION_ORDER,
    ...customActions.map((action) => customActionKey(action.id))
  ])
  const order = []
  for (const action of Array.isArray(config.order) ? config.order : TOOLBAR_ACTION_ORDER) {
    if (validActions.has(action) && !order.includes(action)) order.push(action)
  }
  for (const action of validActions) {
    if (!order.includes(action)) order.push(action)
  }

  return {
    enabled: config.enabled !== false,
    buttons,
    order,
    prompts: { translate: translatePrompt, explain: explainPrompt },
    customActions,
    searchEngine: SEARCH_ENGINES.has(config.searchEngine) ? config.searchEngine : 'bing'
  }
}

function getVisibleToolbarActions(config = DEFAULT_SELECTION_TOOLBAR) {
  const normalized = normalizeSelectionToolbar(config)
  if (!normalized.enabled) return []
  const customActions = new Map(normalized.customActions.map((action) => [customActionKey(action.id), action]))
  return normalized.order.filter((action) => {
    if (Object.hasOwn(normalized.buttons, action)) return normalized.buttons[action]
    return customActions.get(action)?.enabled === true
  })
}

function getToolbarActionDefinition(config, action) {
  const normalized = normalizeSelectionToolbar(config)
  const builtin = BUILTIN_TOOLBAR_ACTIONS[action]
  if (builtin) {
    return {
      ...builtin,
      prompt: AI_TOOLBAR_ACTIONS.has(action) ? normalized.prompts[action] : ''
    }
  }
  const customId = parseCustomActionKey(action)
  const custom = normalized.customActions.find((item) => item.id === customId)
  if (!custom) return null
  return {
    id: customActionKey(custom.id),
    label: custom.name,
    icon: '✦',
    kind: 'ai',
    prompt: custom.prompt,
    custom: true
  }
}

function getVisibleToolbarActionDefinitions(config = DEFAULT_SELECTION_TOOLBAR) {
  return getVisibleToolbarActions(config)
    .map((action) => getToolbarActionDefinition(config, action))
    .filter(Boolean)
}

function buildSearchUrl(engine, text) {
  const prefix = SEARCH_URLS[engine] || SEARCH_URLS.bing
  return `${prefix}${encodeURIComponent(String(text || ''))}`
}

function getToolbarWidth(actions) {
  if (!Array.isArray(actions) || !actions.length) return 0
  return 20 + actions.reduce((width, action) => {
    const label = typeof action === 'object' ? action?.label : BUILTIN_TOOLBAR_ACTIONS[action]?.label
    const characters = Array.from(String(label || '')).length
    return width + Math.max(70, Math.min(126, 42 + characters * 14))
  }, 0)
}

function isLocalToolbarAction(action) {
  return LOCAL_TOOLBAR_ACTIONS.has(action)
}

function isAiToolbarAction(action, config = DEFAULT_SELECTION_TOOLBAR) {
  if (AI_TOOLBAR_ACTIONS.has(action)) return true
  return getToolbarActionDefinition(config, action)?.kind === 'ai'
}

module.exports = {
  BUILTIN_TOOLBAR_ACTIONS,
  CUSTOM_ACTION_PREFIX,
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_SELECTION_TOOLBAR,
  DEFAULT_TRANSLATE_PROMPT,
  MAX_CUSTOM_ACTIONS,
  MAX_CUSTOM_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  TOOLBAR_ACTION_ORDER,
  buildSearchUrl,
  customActionKey,
  getToolbarActionDefinition,
  getToolbarWidth,
  getVisibleToolbarActionDefinitions,
  getVisibleToolbarActions,
  isAiToolbarAction,
  isLocalToolbarAction,
  normalizeSelectionToolbar,
  parseCustomActionKey
}
