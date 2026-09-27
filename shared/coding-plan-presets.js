(function exposeCodingPlanPresets(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.codingPlanPresets = api
})(typeof globalThis === 'object' ? globalThis : window, () => {
  'use strict'

  // Coding plan presets: a plan fixes the baseUrl, protocol and model catalog, so
  // the user only supplies an API key. The catalog is static and ships with the
  // app version (design D4); no remote updates, no vendor SDKs (design D2).
  const CODING_PLAN_PRESETS = Object.freeze([
    Object.freeze({
      id: 'opencode-go',
      name: 'Open Code Go',
      tagline: 'opencode 官方聚合套餐，多厂商模型',
      docsUrl: 'https://opencode.ai/v2/docs/console/go/',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      protocol: 'openai-chat',
      defaultHeaders: Object.freeze({
        'User-Agent': 'highlighter/${appVersion}',
        'x-opencode-session': '${sessionId}'
      }),
      // Models served only on the Anthropic /messages endpoint: not selectable
      // while the provider speaks openai-chat (design D5).
      anthropicOnlyModels: Object.freeze([
        'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
        'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'
      ]),
      // Models served only on the /responses endpoint: filtered for the same
      // reason (design §3.2). Unknown ids stay selectable.
      responsesOnlyModels: Object.freeze([
        'grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna',
        'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'
      ]),
      fallbackModels: Object.freeze([
        Object.freeze({ id: 'kimi-k3', name: 'Kimi K3' }),
        Object.freeze({ id: 'glm-5.3', name: 'GLM 5.3' }),
        Object.freeze({ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }),
        Object.freeze({ id: 'deepseek-v4', name: 'DeepSeek V4' }),
        Object.freeze({ id: 'kimi-k2.6', name: 'Kimi K2.6' }),
        Object.freeze({ id: 'mimo-v2.5', name: 'MiMo V2.5' }),
        Object.freeze({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' })
      ])
    }),
    Object.freeze({
      id: 'glm-coding-plan',
      name: 'GLM Coding Plan',
      tagline: '智谱 coding 订阅，GLM-5.3 系列',
      docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      protocol: 'openai-chat',
      defaultHeaders: Object.freeze({}),
      anthropicOnlyModels: Object.freeze([]),
      responsesOnlyModels: Object.freeze([]),
      fallbackModels: Object.freeze([
        Object.freeze({ id: 'glm-5.3', name: 'GLM 5.3' }),
        Object.freeze({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' })
      ])
    }),
    Object.freeze({
      id: 'minimax-coding-plan',
      name: 'MiniMax Coding Plan',
      tagline: 'MiniMax coding 订阅，M3/M2.x 系列',
      docsUrl: 'https://platform.minimax.cn/docs/guides/text-generation',
      baseUrl: 'https://api.minimax.cn/v1',
      protocol: 'openai-chat',
      defaultHeaders: Object.freeze({}),
      anthropicOnlyModels: Object.freeze([]),
      responsesOnlyModels: Object.freeze([]),
      fallbackModels: Object.freeze([
        Object.freeze({ id: 'MiniMax-M3', name: 'MiniMax M3' }),
        Object.freeze({ id: 'MiniMax-M2.7', name: 'MiniMax M2.7' }),
        Object.freeze({ id: 'MiniMax-M2.5', name: 'MiniMax M2.5' })
      ])
    })
  ])

  // Header templates may only reference these two placeholders. ${apiKey} is
  // deliberately absent: credentials always travel through the SDK's Bearer
  // mechanism, never through a preset header (design NFR-3).
  const HEADER_PLACEHOLDERS = Object.freeze(['appVersion', 'sessionId'])
  const MAX_HEADER_COUNT = 10
  const MAX_HEADER_KEY_LENGTH = 64
  const MAX_HEADER_VALUE_LENGTH = 256
  const FORBIDDEN_HEADER_KEYS = new Set(['authorization'])

  function listCodingPlanPresets() {
    return CODING_PLAN_PRESETS
  }

  function getCodingPlanPreset(id) {
    const key = String(id ?? '').trim()
    if (!key) return null
    return CODING_PLAN_PRESETS.find((preset) => preset.id === key) || null
  }

  function cleanText(value, maximumLength) {
    return String(value ?? '').trim().slice(0, maximumLength)
  }

  function isForbiddenHeaderKey(key) {
    return FORBIDDEN_HEADER_KEYS.has(String(key || '').trim().toLowerCase())
  }

  // Accepts a header map from any source (preset template or persisted provider)
  // and returns the subset that is safe to persist: bounded in count and length,
  // strings only, and never a credential header.
  function sanitizeProviderHeaders(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const headers = {}
    let count = 0
    for (const [rawKey, rawValue] of Object.entries(value)) {
      if (count >= MAX_HEADER_COUNT) break
      const key = cleanText(rawKey, MAX_HEADER_KEY_LENGTH)
      if (!key || isForbiddenHeaderKey(key)) continue
      if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') continue
      const headerValue = cleanText(rawValue, MAX_HEADER_VALUE_LENGTH)
      if (!headerValue) continue
      headers[key] = headerValue
      count += 1
    }
    return headers
  }

  // Substitutes placeholders at request time. ${appVersion} is resolved when the
  // provider is written; ${sessionId} stays unresolved on disk so it rotates per
  // launch instead of freezing into the stored config (design §4.2).
  function resolveRuntimeHeaders(headers, { sessionId = '' } = {}) {
    const source = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {}
    const resolved = {}
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'string') continue
      resolved[key] = value.replace(/\$\{sessionId\}/g, String(sessionId || ''))
    }
    return resolved
  }

  function resolvePresetHeaders(preset, { appVersion = '', sessionId = '' } = {}) {
    const template = preset?.defaultHeaders && typeof preset.defaultHeaders === 'object'
      ? preset.defaultHeaders
      : {}
    const withVersion = {}
    for (const [key, value] of Object.entries(template)) {
      withVersion[key] = String(value ?? '').replace(/\$\{appVersion\}/g, String(appVersion || ''))
    }
    return resolveRuntimeHeaders(withVersion, { sessionId })
  }

  // The header map that actually lands on disk: ${appVersion} is resolved now,
  // while ${sessionId} is deliberately left in place so it rotates per launch
  // instead of freezing into the stored config (design §4.2).
  function storageHeadersForPreset(preset, { appVersion = '' } = {}) {
    const template = preset?.defaultHeaders && typeof preset.defaultHeaders === 'object'
      ? preset.defaultHeaders
      : {}
    const withVersion = {}
    for (const [key, value] of Object.entries(template)) {
      withVersion[key] = String(value ?? '').replace(/\$\{appVersion\}/g, String(appVersion || ''))
    }
    return sanitizeProviderHeaders(withVersion)
  }

  // Drops the endpoint-only models a plan documents as unavailable for the
  // OpenAI-compatible chat endpoint, dedupes ids, and keeps unknown models so a
  // newly added plan model is still selectable (design §3.2).
  function filterPresetModels(models, preset) {
    const blocked = new Set(
      [...(preset?.anthropicOnlyModels || []), ...(preset?.responsesOnlyModels || [])]
        .map((id) => String(id || '').trim().toLowerCase())
        .filter(Boolean)
    )
    const seen = new Set()
    const filtered = []
    for (const item of Array.isArray(models) ? models : []) {
      const id = cleanText(item?.id, 200)
      const normalized = id.toLowerCase()
      if (!id || seen.has(normalized) || blocked.has(normalized)) continue
      seen.add(normalized)
      filtered.push({ id, name: cleanText(item?.name, 120) || id })
    }
    return filtered
  }

  function copyModels(models) {
    return (Array.isArray(models) ? models : []).map((model) => ({ id: model.id, name: model.name }))
  }

  // Single source of truth for "which models does this provider start with".
  // Coding plan providers restore their preset fallback list; DeepSeek and
  // OpenAI keep their well-known catalogs (design §4.6 convergence).
  function defaultModelsForProvider(provider) {
    const preset = provider?.presetId ? getCodingPlanPreset(provider.presetId) : null
    if (preset?.fallbackModels?.length) return copyModels(preset.fallbackModels)
    const id = String(provider?.id || '').toLowerCase()
    const baseUrl = String(provider?.baseUrl || '').toLowerCase()
    if (id === 'deepseek' || baseUrl.includes('deepseek')) return [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
    if (id === 'openai' || baseUrl.includes('openai.com') || baseUrl.includes('api.openai')) {
      return [
        { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4.1', name: 'GPT-4.1' }
      ]
    }
    return []
  }

  return {
    CODING_PLAN_PRESETS,
    HEADER_PLACEHOLDERS,
    MAX_HEADER_COUNT,
    MAX_HEADER_KEY_LENGTH,
    MAX_HEADER_VALUE_LENGTH,
    defaultModelsForProvider,
    filterPresetModels,
    getCodingPlanPreset,
    listCodingPlanPresets,
    resolvePresetHeaders,
    resolveRuntimeHeaders,
    sanitizeProviderHeaders,
    storageHeadersForPreset
  }
})
