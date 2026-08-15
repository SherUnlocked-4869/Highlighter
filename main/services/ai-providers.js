const {
  modelSupportsTask,
  normalizeModelCapabilities,
  taskForFeature
} = require('./ai-model-capabilities')

const DEFAULT_AI_MODEL = 'deepseek-v4-flash'
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const AI_PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses'])
const AI_SETTINGS_SCHEMA_VERSION = 2
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
  const candidates = Array.isArray(providers) ? providers : []
  const fallbackProvider = candidates.find((provider) => provider.id === 'deepseek' && provider.enabled !== false && provider.models?.[0]?.id)
    || candidates.find((provider) => provider.enabled !== false && provider.models?.[0]?.id)
    || candidates.find((provider) => provider.models?.[0]?.id)
  const providerId = cleanText(fallbackProvider?.id, 64)
  const model = cleanText(fallbackProvider?.models?.[0]?.id, 200)
  if (!providerId || !model) return []
  return AI_FEATURES.map((feature) => ({ feature: feature.id, providerId, model }))
}

function normalizeProviderModels(value, context = {}) {
  const models = []
  const ids = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || models.length >= MAX_MODELS_PER_PROVIDER) continue
    const id = cleanText(item.id, 200)
    if (!id || ids.has(id)) continue
    ids.add(id)
    const name = cleanText(item.name, 120) || id
    models.push({
      id,
      name,
      capabilities: normalizeModelCapabilities(item.capabilities, {
        ...context,
        modelId: id,
        modelName: name
      })
    })
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
    const models = normalizeProviderModels(item.models, { providerId: id, baseUrl, protocol })
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
      legacyProvider.models.push({
        id: previousModel,
        name: previousModel,
        capabilities: normalizeModelCapabilities(null, {
          providerId: legacyProvider.id,
          baseUrl: legacyProvider.baseUrl,
          protocol: legacyProvider.protocol,
          modelId: previousModel,
          modelName: previousModel
        })
      })
    }
  }

  return providers
}

function normalizeAiAssignments(value = [], providers = createDefaultProviders(), { fillDefaults = true } = {}) {
  const assignments = []
  const seenFeatures = new Set()
  const validProviderIds = new Set(providers.map((provider) => provider.id))
  const modelOf = (providerId, model, { useProviderDefault = false } = {}) => {
    const provider = providers.find((item) => item.id === providerId)
    const candidate = cleanText(model, 200)
    if (candidate && (provider?.models || []).some((item) => item.id === candidate)) return candidate
    return useProviderDefault ? cleanText(provider?.models?.[0]?.id, 200) : ''
  }

  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object' || assignments.length >= MAX_ASSIGNMENTS) continue
    const feature = cleanText(item.feature, 128)
    if (!feature || seenFeatures.has(feature)) continue
    seenFeatures.add(feature)
    const providerId = cleanText(item.providerId, 64)
    if (!validProviderIds.has(providerId)) continue
    const model = modelOf(providerId, item.model)
    if (!model) continue
    assignments.push({ feature, providerId, model })
  }

  if (fillDefaults) {
    for (const fallback of createDefaultAssignments(providers)) {
      if (seenFeatures.has(fallback.feature)) continue
      if (!validProviderIds.has(fallback.providerId)) continue
      const model = modelOf(fallback.providerId, fallback.model, { useProviderDefault: true })
      if (!model) continue
      seenFeatures.add(fallback.feature)
      assignments.push({ feature: fallback.feature, providerId: fallback.providerId, model })
    }
  }
  return assignments
}

function migrateAiSettings(settings, { legacyApiKey = '' } = {}) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const sourceAi = source.ai && typeof source.ai === 'object' ? source.ai : {}
  const version = Number(sourceAi.schemaVersion) || 0
  if (version >= AI_SETTINGS_SCHEMA_VERSION) return { settings: source, changed: false }

  const rawAssignments = Array.isArray(sourceAi.assignments) ? sourceAi.assignments : []
  const hasExplicitChatAssignment = rawAssignments.some((assignment) => assignment?.feature === 'chat')
  const providers = normalizeAiProviders(source.providers, {
    legacyApiKey: legacyApiKey || source.apiKey
  })
  const assignments = normalizeAiAssignments(rawAssignments, providers)

  if (!hasExplicitChatAssignment) {
    const legacyProviderId = cleanText(sourceAi.providerId, 64)
    const legacyModel = cleanText(sourceAi.model, 200)
    if (legacyProviderId || legacyModel) {
      let provider = providers.find((item) => item.id === legacyProviderId)
      if (!provider && legacyModel) provider = providers.find((item) => item.models.some((model) => model.id === legacyModel))
      provider ||= providers.find((item) => item.id === 'deepseek') || providers[0]
      if (provider && legacyModel && !provider.models.some((model) => model.id === legacyModel) && provider.models.length < MAX_MODELS_PER_PROVIDER) {
        provider.models.push({ id: legacyModel, name: legacyModel })
      }
      const model = legacyModel && provider?.models.some((item) => item.id === legacyModel)
        ? legacyModel
        : provider?.models?.[0]?.id
      if (provider && model) {
        const chatIndex = assignments.findIndex((assignment) => assignment.feature === 'chat')
        const chatAssignment = { feature: 'chat', providerId: provider.id, model }
        if (chatIndex >= 0) assignments[chatIndex] = chatAssignment
        else assignments.push(chatAssignment)
      }
    }
  }

  const ai = {
    ...sourceAi,
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    assignments
  }
  delete ai.providerId
  delete ai.model
  return {
    settings: { ...source, providers, ai },
    changed: true
  }
}

function normalizeAiSettings(settings) {
  const migrated = migrateAiSettings(settings).settings
  const next = { ...migrated }
  const providers = normalizeAiProviders(next.providers)
  next.providers = providers
  next.ai = { ...(next.ai || {}) }
  next.ai.schemaVersion = AI_SETTINGS_SCHEMA_VERSION
  next.ai.assignments = normalizeAiAssignments(next.ai.assignments, providers, { fillDefaults: false })
  delete next.ai.providerId
  delete next.ai.model
  return next
}

function resolveAiAssignment(settings, feature, { fallbackFeature = '' } = {}) {
  const providers = normalizeAiProviders(settings?.providers, {
    legacyApiKey: settings?.apiKey,
    legacyModel: settings?.ai?.model
  })
  const assignments = normalizeAiAssignments(settings?.ai?.assignments, providers, { fillDefaults: false })
  const assignment = assignments.find((item) => item.feature === feature)
    || (fallbackFeature ? assignments.find((item) => item.feature === fallbackFeature) : null)
  if (!assignment) return null
  const provider = providers.find((item) => item.id === assignment.providerId)
  if (!provider || provider.enabled === false || !provider.baseUrl) return null
  const selectedModel = provider.models.find((item) => item.id === assignment.model)
  if (!selectedModel || !modelSupportsTask(selectedModel, taskForFeature(feature))) return null
  const model = selectedModel.id
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
  AI_SETTINGS_SCHEMA_VERSION,
  DEFAULT_AI_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
  MAX_ASSIGNMENTS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  createDefaultAssignments,
  createDefaultDeepSeekProvider,
  createDefaultProviders,
  getProviderDefaultModels,
  migrateAiSettings,
  normalizeAiAssignments,
  normalizeAiProviders,
  normalizeAiSettings,
  normalizeProviderModels,
  resolveAiAssignment,
  resolveToolbarAiProvider
}
