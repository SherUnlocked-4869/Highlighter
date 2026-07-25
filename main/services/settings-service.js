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
    onCredentialError = () => {}
  }) {
    if (!store) throw new Error('SettingsService requires a store')
    if (!defaults || typeof defaults !== 'object') throw new Error('SettingsService requires defaults')
    this.store = store
    this.defaults = defaults
    this.normalizeSettings = normalizeSettings
    this.credentials = new CredentialStore({
      store,
      safeStorage,
      onError: onCredentialError
    })
    this.credentials.migrateLegacyApiKey()
  }

  getSettings() {
    const settings = this.normalizeSettings(mergeSettings(this.defaults, this.store.get('settings', {})))
    settings.apiKey = this.credentials.getApiKey(settings.apiKey)
    return settings
  }

  persistSettings(settings, { updateApiKey = false } = {}) {
    const normalized = this.normalizeSettings(mergeSettings(this.defaults, settings || {}))
    const storedSettings = { ...normalized }
    const encryptionAvailable = this.credentials.isEncryptionAvailable()
    if (encryptionAvailable) {
      if (updateApiKey) this.credentials.setApiKey(normalized.apiKey)
      delete storedSettings.apiKey
    } else if (!updateApiKey) {
      const existingSettings = this.store.get('settings', {})
      if (Object.hasOwn(existingSettings, 'apiKey')) storedSettings.apiKey = existingSettings.apiKey
      else delete storedSettings.apiKey
    }
    this.store.set('settings', storedSettings)
    return this.getSettings()
  }

  updateSettings(patch) {
    const validatedPatch = assertSettingsPatch(patch === undefined ? {} : patch, this.defaults)
    const settings = this.persistSettings(mergeSettings(this.getSettings(), validatedPatch), {
      updateApiKey: Object.hasOwn(validatedPatch, 'apiKey')
    })
    return { patch: validatedPatch, settings }
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
    this.persistSettings(mergeSettings(this.getSettings(), { apiKey }), { updateApiKey: true })
    return true
  }
}

module.exports = {
  SettingsService,
  mergeSettings
}
