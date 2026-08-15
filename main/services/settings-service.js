const { CredentialStore } = require('./credential-store')
const { assertSettingsPatch } = require('./settings-validation')

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function mergeSettings(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const output = { ...(target || {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    output[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(output[key], value)
      : value
  }
  return output
}

class SettingsService {
  constructor({
    store,
    safeStorage,
    defaults,
    normalizeSettings = (settings) => settings,
    migrateSettings = () => ({ changed: false }),
    onCredentialError = () => {}
  }) {
    if (!store) throw new Error('SettingsService requires a store')
    if (!defaults || typeof defaults !== 'object') throw new Error('SettingsService requires defaults')
    this.store = store
    this.defaults = defaults
    this.normalizeSettings = normalizeSettings
    this.migrateSettings = migrateSettings
    this.credentials = new CredentialStore({
      store,
      safeStorage,
      onError: onCredentialError
    })
    this.credentials.migrateLegacyApiKey()
    this.migrateStoredSettings()
  }

  migrateStoredSettings() {
    const stored = this.store.get('settings', {})
    const migration = this.migrateSettings(stored, {
      legacyApiKey: this.credentials.getApiKey(stored?.apiKey)
    })
    if (!migration?.changed || !migration.settings) return false
    this.persistSettings(mergeSettings(this.defaults, migration.settings))
    return true
  }

  getSettings() {
    const merged = mergeSettings(this.defaults, this.store.get('settings', {}))
    const legacyApiKey = this.credentials.getApiKey(merged.apiKey)
    merged.apiKey = legacyApiKey
    const settings = this.normalizeSettings(merged)
    if (Array.isArray(settings.providers)) {
      settings.providers = settings.providers.map((provider) => ({
        ...provider,
        models: Array.isArray(provider.models) ? provider.models.map((model) => ({ ...model })) : provider.models
      }))
      const providerKeys = this.credentials.getProviderApiKeys(settings.providers)
      for (const provider of settings.providers) {
        if (provider && Object.hasOwn(providerKeys, provider.id)) provider.apiKey = providerKeys[provider.id]
      }
      if (!settings.apiKey) {
        const deepseek = settings.providers.find((provider) => provider.id === 'deepseek')
        if (deepseek?.apiKey) settings.apiKey = deepseek.apiKey
      }
    }
    return settings
  }

  persistSettings(settings, { updateApiKey = false } = {}) {
    const normalized = this.normalizeSettings(mergeSettings(this.defaults, settings || {}))
    const storedSettings = { ...normalized }
    const encryptionAvailable = this.credentials.isEncryptionAvailable()
    const hasProviders = Array.isArray(normalized.providers)
    if (encryptionAvailable) {
      if (updateApiKey) this.credentials.setApiKey(normalized.apiKey)
      delete storedSettings.apiKey
      if (hasProviders) {
        this.credentials.setProviderApiKeys(normalized.providers)
        storedSettings.providers = normalized.providers.map((provider) => ({ ...provider, apiKey: '' }))
      }
    } else {
      if (!updateApiKey) {
        const existingSettings = this.store.get('settings', {})
        if (Object.hasOwn(existingSettings, 'apiKey')) storedSettings.apiKey = existingSettings.apiKey
        else delete storedSettings.apiKey
      }
      if (hasProviders) {
        const existingSettings = this.store.get('settings', {})
        const existingProviders = Array.isArray(existingSettings.providers) ? existingSettings.providers : []
        storedSettings.providers = normalized.providers.map((provider) => {
          const existing = existingProviders.find((item) => item?.id === provider?.id)
          return { ...provider, apiKey: provider.apiKey || (existing?.apiKey || '') }
        })
      }
    }
    this.store.set('settings', storedSettings)
    return this.getSettings()
  }

  updateSettings(patch) {
    const validatedPatch = assertSettingsPatch(patch === undefined ? {} : patch, this.defaults)
    const preparedPatch = this.prepareCredentialPatch(validatedPatch)
    const deepseekApiKeyPatch = Array.isArray(validatedPatch.providers)
      ? validatedPatch.providers.find((provider) => provider?.id === 'deepseek' && Object.hasOwn(provider, 'apiKey'))?.apiKey
      : undefined
    const settings = this.persistSettings(mergeSettings(this.getSettings(), preparedPatch), {
      updateApiKey: Object.hasOwn(validatedPatch, 'apiKey') || deepseekApiKeyPatch !== undefined
    })
    return { patch: validatedPatch, settings }
  }

  prepareCredentialPatch(patch) {
    const next = { ...patch }
    const current = this.getSettings()
    const currentProviders = new Map((current.providers || []).map((provider) => [provider.id, provider]))
    if (Array.isArray(next.providers)) {
      next.providers = next.providers.map((provider) => {
        if (!provider || typeof provider !== 'object') return provider
        if (Object.hasOwn(provider, 'apiKey')) return provider
        const currentProvider = currentProviders.get(provider.id)
        return currentProvider ? { ...provider, apiKey: currentProvider.apiKey } : provider
      })
      const deepseekPatch = next.providers.find((provider) => provider?.id === 'deepseek' && Object.hasOwn(provider, 'apiKey'))
      if (deepseekPatch) next.apiKey = deepseekPatch.apiKey
    } else if (Object.hasOwn(next, 'apiKey') && !Object.hasOwn(next, 'providers') && currentProviders.size) {
      next.providers = [...(current.providers || [])].map((provider) => (
        provider.id === 'deepseek' ? { ...provider, apiKey: next.apiKey } : provider
      ))
    }
    return next
  }

  resetSettings() {
    return this.persistSettings(this.normalizeSettings(mergeSettings(this.defaults, {})), {
      updateApiKey: true
    })
  }

  normalizeApiKey(value) {
    return assertSettingsPatch({ apiKey: value }, this.defaults).apiKey.trim()
  }

  setApiKey(value) {
    const apiKey = this.normalizeApiKey(value)
    this.updateSettings({ apiKey })
    return true
  }
}

module.exports = {
  SettingsService,
  mergeSettings
}
