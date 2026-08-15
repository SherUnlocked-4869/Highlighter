const DEFAULT_AI_MODEL = 'deepseek-v4-flash'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const AI_PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses'])
const MAX_PROVIDERS = 20
const MAX_MODELS_PER_PROVIDER = 100
const MAX_ASSIGNMENTS = 100

const AI_FEATURES = Object.freeze([
  Object.freeze({ id: 'chat', label: 'AI 对话' }),
  Object.freeze({ id: 'translation', label: '翻译工具' }),
  Object.freeze({ id: 'ocr-translate', label: '截图 OCR 翻译' }),
  Object.freeze({ id: 'toolbar:translate', label: '划词翻译' }),
  Object.freeze({ id: 'toolbar:explain', label: '划词解释' })
])

function cleanText(value, maximumLength = 200) {
  return String(value ?? '').trim().slice(0, maximumLength)
}

function createDefaultDeepSeekProvider() {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    apiKey: '',
    protocol: 'openai-chat',
    enabled: true,
    builtin: true,
    models: [{ id: DEFAULT_AI_MODEL, name: 'DeepSeek V4 Flash' }]
  }
}

function createDefaultProviders() {
  return [createDefaultDeepSeekProvider()]
}

function createDefaultAssignments(providers = createDefaultProviders()) {
  const fallbackProvider = providers.find((provider) => provider.id === 'deepseek') || providers[0]
  const providerId = fallbackProvider?.id || 'deepseek'
  const model = fallbackProvider?.models?.[0]?.id || DEFAULT_AI_MODEL
  return AI_FEATURES.map((feature) => ({ feature: feature.id, providerId, model }))
}

function normalizeProviderModels(value) {
  const models = []
  const ids = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || models.length >= MAX_MODELS_PER_PROVIDER) continue
    const id = cleanText(item.id, 200)
    if (!id || ids.has(id)) continue
    ids.add(id)
    models.push({ id, name: cleanText(item.name, 120) || id })
  }
  return models
}

function normalizeAiProviders(value = [], { legacyApiKey = '', legacyModel = '' } = {}) {
  const providers = []
  const ids = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || providers.length >= MAX_PROVIDERS) continue
    const id = cleanText(item.id, 64)
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) continue
    ids.add(id)
    const name = cleanText(item.name, 100) || id
    const baseUrl = cleanText(item.baseUrl, 2048)
    const apiKey = cleanText(item.apiKey, 512)
    const protocol = AI_PROTOCOLS.includes(item.protocol) ? item.protocol : AI_PROTOCOLS[0]
    const models = normalizeProviderModels(item.models)
    providers.push({
      id,
      name,
      baseUrl,
      apiKey,
      protocol,
      enabled: item.enabled !== false,
      builtin: id === 'deepseek' && baseUrl === DEFAULT_DEEPSEEK_BASE_URL && item.builtin !== false,
      models
    })
  }

  if (!providers.length) providers.push(createDefaultDeepSeekProvider())

  const legacyKey = cleanText(legacyApiKey, 512)
  if (legacyKey) {
    const legacyProvider = providers.find((provider) => provider.id === 'deepseek') || providers[0]
    if (!legacyProvider.apiKey) legacyProvider.apiKey = legacyKey
  }

  const previousModel = cleanText(legacyModel, 200)
  if (previousModel) {
    const legacyProvider = providers.find((provider) => provider.id === 'deepseek') || providers[0]
    if (legacyProvider.models.length < MAX_MODELS_PER_PROVIDER && !legacyProvider.models.some((model) => model.id === previousModel)) {
      legacyProvider.models.push({ id: previousModel, name: previousModel })
    }
  }

  return providers
}

function normalizeAiAssignments(value = [], providers = createDefaultProviders()) {
  const assignments = []
  const seenFeatures = new Set()
  const validProviderIds = new Set(providers.map((provider) => provider.id))
  const modelOf = (providerId, model) => {
    const provider = providers.find((item) => item.id === providerId)
    const candidate = cleanText(model, 200)
    if (candidate && (provider?.models || []).some((item) => item.id === candidate)) return candidate
    return provider?.models?.[0]?.id || DEFAULT_AI_MODEL
  }

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || assignments.length >= MAX_ASSIGNMENTS) continue
    const feature = cleanText(item.feature, 128)
    if (!feature || seenFeatures.has(feature)) continue
    const providerId = cleanText(item.providerId, 64)
    if (!validProviderIds.has(providerId)) continue
    const model = modelOf(providerId, item.model)
    if (!model) continue
    seenFeatures.add(feature)
    assignments.push({ feature, providerId, model })
  }

  for (const fallback of createDefaultAssignments(providers)) {
    if (seenFeatures.has(fallback.feature)) continue
    if (!validProviderIds.has(fallback.providerId)) continue
    const model = modelOf(fallback.providerId, fallback.model)
    if (!model) continue
    seenFeatures.add(fallback.feature)
    assignments.push({ feature: fallback.feature, providerId: fallback.providerId, model })
  }
  return assignments
}

function normalizeAiSettings(settings) {
  const next = { ...(settings || {}) }
  const providers = normalizeAiProviders(next.providers, {
    legacyApiKey: next.apiKey,
    legacyModel: next.ai?.model
  })
  next.providers = providers
  next.ai = { ...(next.ai || {}) }
  next.ai.assignments = normalizeAiAssignments(next.ai.assignments, providers)

  const legacyModel = cleanText(next.ai.model, 200)
  if (legacyModel) {
    const modelOwner = providers.find((provider) => provider.models.some((model) => model.id === legacyModel))
      || providers.find((provider) => provider.id === 'deepseek')
      || providers[0]
    if (modelOwner) {
      const chatIndex = next.ai.assignments.findIndex((assignment) => assignment.feature === 'chat')
      const chatAssignment = { feature: 'chat', providerId: modelOwner.id, model: legacyModel }
      if (chatIndex >= 0) next.ai.assignments[chatIndex] = chatAssignment
      else next.ai.assignments.push(chatAssignment)
      next.ai.providerId = modelOwner.id
    }
  }
  return next
}

function resolveAiAssignment(settings, feature, { fallbackFeature = '' } = {}) {
  const providers = normalizeAiProviders(settings?.providers, {
    legacyApiKey: settings?.apiKey,
    legacyModel: settings?.ai?.model
  })
  const assignments = normalizeAiAssignments(settings?.ai?.assignments, providers)
  const assignment = assignments.find((item) => item.feature === feature)
    || (fallbackFeature ? assignments.find((item) => item.feature === fallbackFeature) : null)
  const provider = providers.find((item) => item.id === assignment?.providerId) || providers[0]
  if (!provider) return null
  const model = assignment?.model || provider.models?.[0]?.id || settings?.ai?.model || DEFAULT_AI_MODEL
  return { ...provider, model, apiKey: provider.apiKey }
}

function resolveToolbarAiProvider(settings, actionId) {
  if (actionId === 'translate') return resolveAiAssignment(settings, 'toolbar:translate')
  if (actionId === 'explain') return resolveAiAssignment(settings, 'toolbar:explain')
  if (String(actionId || '').startsWith('custom:')) {
    return resolveAiAssignment(settings, actionId, { fallbackFeature: 'toolbar:explain' })
  }
  return resolveAiAssignment(settings, 'chat', { fallbackFeature: 'toolbar:explain' })
}

function getProviderDefaultModels(provider) {
  const id = String(provider?.id || '').toLowerCase()
  const baseUrl = String(provider?.baseUrl || '').toLowerCase()
  if (id === 'deepseek' || baseUrl.includes('deepseek')) {
    return [{ id: DEFAULT_AI_MODEL, name: 'DeepSeek V4 Flash' }]
  }
  if (id === 'openai' || baseUrl.includes('openai.com') || baseUrl.includes('api.openai')) {
    return [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4.1', name: 'GPT-4.1' }
    ]
  }
  return []
}

module.exports = {
  AI_FEATURES,
  AI_PROTOCOLS,
  DEFAULT_AI_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
  MAX_ASSIGNMENTS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  createDefaultAssignments,
  createDefaultDeepSeekProvider,
  createDefaultProviders,
  getProviderDefaultModels,
  normalizeAiAssignments,
  normalizeAiProviders,
  normalizeAiSettings,
  normalizeProviderModels,
  resolveAiAssignment,
  resolveToolbarAiProvider
}
