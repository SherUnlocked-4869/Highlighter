'use strict'

const { randomUUID } = require('crypto')
const {
  getCodingPlanPreset,
  filterPresetModels,
  storageHeadersForPreset
} = require('../../shared/coding-plan-presets')
const { MAX_PROVIDERS } = require('./ai-providers')

function cleanText(value, maximumLength = 200) {
  return String(value ?? '').trim().slice(0, maximumLength)
}

function createCodingPlanProviderId() {
  return `provider-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// Appends an ordinal when the plan is added more than once, so the list does not
// show two identical names (design FR-3).
function uniqueProviderName(baseName, providers) {
  const taken = new Set((Array.isArray(providers) ? providers : []).map((provider) => cleanText(provider?.name, 100)))
  if (!taken.has(baseName)) return baseName
  let index = 2
  while (taken.has(`${baseName} ${index}`)) index += 1
  return `${baseName} ${index}`
}

function copyModels(models) {
  return (Array.isArray(models) ? models : []).map((model) => ({ id: model.id, name: model.name }))
}

function describeProbeError(error) {
  const message = String(error?.message || error || '').trim()
  return message || '连接测试失败'
}

/**
 * Creates a provider from a coding plan preset: the preset fixes baseUrl,
 * protocol and request headers, the user only supplies an API key.
 *
 * A failed connection test never blocks the save (design D7). It falls back to
 * the preset's bundled model list and reports `verified: false` plus a warning.
 *
 * @param {{ presetId: string, apiKey: string, displayName?: string }} input
 * @param {{
 *   settingsService: object,
 *   testProviderConnection: Function,
 *   appVersion?: string,
 *   createProviderId?: Function
 * }} deps
 */
async function createCodingPlanProvider(input, deps = {}) {
  const {
    settingsService,
    testProviderConnection,
    appVersion = '',
    createProviderId = createCodingPlanProviderId
  } = deps
  if (!settingsService) throw new Error('缺少设置服务，无法保存 Coding Plan')
  if (typeof testProviderConnection !== 'function') throw new Error('缺少连接测试能力，无法验证 Coding Plan')

  const preset = getCodingPlanPreset(input?.presetId)
  if (!preset) throw new Error('未知的 Coding Plan 预设')
  const apiKey = cleanText(input?.apiKey, 512)
  if (!apiKey) throw new Error('请填写 API 密钥')

  const currentProviders = settingsService.getSettings()?.providers || []
  if (currentProviders.length >= MAX_PROVIDERS) throw new Error(`供应商数量已达上限（${MAX_PROVIDERS}）`)

  const provider = {
    id: createProviderId(),
    presetId: preset.id,
    name: cleanText(input?.displayName, 100) || uniqueProviderName(preset.name, currentProviders),
    baseUrl: preset.baseUrl,
    apiKey,
    protocol: preset.protocol,
    enabled: true,
    builtin: false,
    models: [],
    headers: storageHeadersForPreset(preset, { appVersion }),
    modelsVerified: false
  }

  let verified = false
  let warning = ''
  let models = []
  try {
    // No model is pinned: the probe discovers the live catalog and pings its
    // first entry, which also validates that the key works at all.
    const result = await testProviderConnection({ ...provider, models: [], model: '' }, { fetchModels: true })
    models = filterPresetModels(result?.models, preset)
    verified = models.length > 0
  } catch (error) {
    warning = describeProbeError(error)
  }

  if (!verified) {
    models = copyModels(preset.fallbackModels)
    warning = warning || '连接未验证，模型目录为内置清单'
  }

  provider.models = models
  provider.modelsVerified = verified

  const saved = settingsService.updateSettings({ providers: [...currentProviders, provider] })
  const stored = (saved?.settings?.providers || []).find((item) => item.id === provider.id) || provider
  const { apiKey: _secret, ...publicProvider } = stored

  return {
    ok: true,
    provider: publicProvider,
    verified,
    warning,
    modelsCount: models.length
  }
}

module.exports = {
  createCodingPlanProvider,
  createCodingPlanProviderId,
  uniqueProviderName
}
