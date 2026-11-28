const { CredentialStore } = require('./credential-store')
const { assertSettingsPatch } = require('./settings-validation')
const { assertClipboardSettings } = require('./clipboard-settings')
const { assertRegionPreferencesPatch, REGION_PREFERENCES_PATH } = require('../../shared/region-presets')
const { isLoopbackProviderUrl } = require('../../shared/provider-connection')

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Feature B (plan 2026-10-25 §5.2): the settings template can only check the SHAPE of
// screenshot.regionPreferences (the default presets array is empty, and the null
// lastByMode leaves accept anything). The real contract - id uniqueness, name length,
// integer sizes, the pixel budget, the 20-preset cap - is domain logic, so it is
// registered here as a per-path validator for the write path. Registration is
// per-patch-path: a patch that never touches regionPreferences pays nothing.
const REGION_DOMAIN_VALIDATORS = new Map([
  [REGION_PREFERENCES_PATH, assertRegionPreferencesPatch]
])

// D02 (04): the override table is keyed by credential id; the master key and provider keys
// live in the same namespace so one API answers "what would a request use right now".
function providerCredentialIdOf(id) {
  const value = typeof id === 'string' ? id.trim() : ''
  return value ? 'provider:' + value : ''
}

function sameProviderEndpoint(left, right) {
  const normalize = (value) => String(value || '').trim().replace(/\/+$/, '')
  return normalize(left?.baseUrl) === normalize(right?.baseUrl)
}

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
    // F01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 3.1): every
    // getSettings() used to read and parse config.json and decrypt every provider key again.
    // The snapshot below is the effective settings object; it is rebuilt only when the store or
    // a credential changes, and callers must treat it as read-only.
    this.settingsCache = null
    this.credentials = new CredentialStore({
      store,
      safeStorage,
      onError: onCredentialError,
      onChange: () => { this.settingsCache = null }
    })
    this.credentials.migrateLegacyApiKey()
    // D02: older builds also wrote provider keys into the settings file. Encrypt + verify
    // them now if encryption works; otherwise they stay put for a later attempt.
    this.credentials.migrateLegacyProviderApiKeys()
    this.migrateStoredSettings()
  }

  migrateStoredSettings() {
    const stored = this.store.get('settings', {})
    const migration = this.migrateSettings(stored, {
      legacyApiKey: this.credentials.getApiKey(stored?.apiKey)
    })
    if (!migration?.changed || !migration.settings) return false
    // D02 (04): a migration that folds the legacy master key into a provider writes a NEW
    // provider credential, so the intent has to travel with the save - the per-credential
    // rule otherwise leaves the migrated key in memory only.
    const migratedProviders = Array.isArray(migration.settings.providers)
      ? migration.settings.providers
        .filter((provider) => String(provider?.apiKey || '').trim() !== '')
        .map((provider) => ({ id: provider.id, apiKey: provider.apiKey, baseUrl: provider.baseUrl }))
      : []
    this.persistSettings(mergeSettings(this.defaults, migration.settings), {
      credentialIntent: { providers: migratedProviders }
    })
    return true
  }

  getSettings() {
    if (this.settingsCache) return this.settingsCache
    const stored = this.store.get('settings', {})
    const merged = mergeSettings(this.defaults, stored)
    // F01: one shared read pass. The master credential is resolved before normalization (the
    // legacy migration folds it into the provider catalog) and the provider credentials after
    // it; the same pass also publishes the public credential state, so getPublicSettings() no
    // longer decrypts every key a second time.
    const read = this.credentials.createSettingsRead(stored)
    merged.apiKey = this.credentials.getApiKey(merged.apiKey, read)
    const settings = this.normalizeSettings(merged)
    if (Array.isArray(settings.providers)) {
      settings.providers = settings.providers.map((provider) => ({
        ...provider,
        models: Array.isArray(provider.models) ? provider.models.map((model) => ({ ...model })) : provider.models
      }))
      const providerKeys = this.credentials.getProviderApiKeys(settings.providers, read)
      for (const provider of settings.providers) {
        if (provider && Object.hasOwn(providerKeys, provider.id)) provider.apiKey = providerKeys[provider.id]
      }
      if (!settings.apiKey) {
        const deepseek = settings.providers.find((provider) => provider.id === 'deepseek')
        if (deepseek?.apiKey) settings.apiKey = deepseek.apiKey
      }
    }
    this.credentials.finalizeSettingsRead(read)
    this.settingsCache = settings
    return settings
  }

  // F01: every production write goes through this service, so the snapshot is invalidated on
  // each successful write (and by CredentialStore.onChange for session-only credentials). An
  // out-of-band writer of config.json must call this so a stale snapshot is never served.
  invalidateSettingsCache() {
    this.settingsCache = null
  }

  getPublicSettings(settings = this.getSettings()) {
    const publicSettings = { ...settings, hasApiKey: !!settings.apiKey }
    delete publicSettings.apiKey
    // D02: the page has to distinguish "no key" from "a key exists but cannot be
    // decrypted" and from "this key only lives in memory until the app closes". The
    // object carries booleans only - never a secret.
    publicSettings.credentialState = this.credentials.getCredentialState()
    if (Array.isArray(settings.providers)) {
      publicSettings.providers = settings.providers.map((provider) => {
        const publicProvider = { ...provider, hasApiKey: !!provider.apiKey }
        delete publicProvider.apiKey
        return publicProvider
      })
    }
    return publicSettings
  }

  prepareProviderConnection(provider) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new TypeError('供应商配置无效')
    const draft = { ...provider }
    const suppliedApiKey = String(draft.apiKey || '').trim()
    if (suppliedApiKey) return { ...draft, apiKey: suppliedApiKey }
    const current = this.getSettings().providers?.find((item) => item.id === draft.id)
    if (isLoopbackProviderUrl(draft.baseUrl) && (!current?.apiKey || !sameProviderEndpoint(draft, current))) {
      return { ...draft, apiKey: '' }
    }
    if (!current?.apiKey) throw new Error('请先填写 API 密钥')
    const trimEndpoint = (value) => String(value || '').trim().replace(/\/+$/, '')
    if (trimEndpoint(draft.baseUrl) !== trimEndpoint(current.baseUrl)) {
      throw new Error('API 地址已更改，请重新输入 API 密钥后再测试')
    }
    return { ...draft, apiKey: current.apiKey }
  }

  // D02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a key entered
  // while Windows encryption is unavailable is kept in this process only. The rules are:
  //   * no new plaintext ever reaches the store, whatever the caller passed in;
  //   * a pre-existing legacy plaintext value is preserved exactly where it was (it is the
  //     only copy a later migration can encrypt) and is never duplicated to another field;
  //   * once encryption works again, session keys are migrated before anything else is
  //     written, so they stop depending on this process.
  persistSettings(settings, { updateApiKey = false, credentialIntent = null } = {}) {
    const normalized = this.normalizeSettings(mergeSettings(this.defaults, settings || {}))
    const storedSettings = { ...normalized }
    const encryptionAvailable = this.credentials.isEncryptionAvailable()
    const hasProviders = Array.isArray(normalized.providers)
    const existingSettings = this.store.get('settings', {})
    const existingProviders = Array.isArray(existingSettings.providers) ? existingSettings.providers : []
    // D02 (04): a credential is only rewritten when THIS patch touched it. Re-encrypting an
    // untouched provider on every save is how a key that failed to persist for one provider
    // used to roll back another provider's stored value.
    const providerIntents = new Map(
      (Array.isArray(credentialIntent?.providers) ? credentialIntent.providers : [])
        .map((entry) => [String(entry?.id || ''), entry])
    )
    const apiKeyTouched = updateApiKey === true
    if (encryptionAvailable) {
      // A save is the one moment a session value can become durable: retry every pending
      // override, verify the ciphertext that actually landed, and only then drop it.
      this.credentials.flushSessionOverrides()
      if (apiKeyTouched) this.persistMasterCredential(normalized.apiKey)
      delete storedSettings.apiKey
      if (hasProviders) {
        for (const [providerId, intent] of providerIntents) {
          if (providerId) this.persistProviderCredential(providerId, intent)
        }
        storedSettings.providers = normalized.providers.map((provider) => ({ ...provider, apiKey: '' }))
      }
    } else {
      if (apiKeyTouched) {
        // No durable copy is possible; the override is the effective value from now on.
        this.credentials.setSessionOverride('master', normalized.apiKey)
        delete storedSettings.apiKey
      } else if (Object.hasOwn(existingSettings, 'apiKey')) {
        storedSettings.apiKey = existingSettings.apiKey
      } else {
        delete storedSettings.apiKey
      }
      if (hasProviders) {
        for (const [providerId, intent] of providerIntents) {
          if (!providerId) continue
          // Remember the endpoint the temporary value belongs to, so it can never be handed
          // to the same provider id pointed at another server.
          this.credentials.setSessionOverride(providerCredentialIdOf(providerId), intent.apiKey, { endpoint: intent.baseUrl })
        }
        storedSettings.providers = normalized.providers.map((provider) => {
          const existing = existingProviders.find((item) => item?.id === provider?.id)
          // Only a value that was ALREADY on disk survives, and only for the endpoint it
          // was saved for. The key the caller just typed stays in session memory.
          const legacyApiKey = existing && sameProviderEndpoint(provider, existing) ? String(existing.apiKey || '') : ''
          return { ...provider, apiKey: legacyApiKey }
        })
      }
    }
    this.store.set('settings', storedSettings)
    this.invalidateSettingsCache()
    // The stored settings feed legacy-plaintext detection, so the public state is stale even
    // when this save rewrote no credential ciphertext itself.
    this.credentials.invalidateCredentialState()
    return this.getSettings()
  }

  // Writes (or clears) the durable master key and verifies the result before dropping the
  // session override. A refused encryption/delete KEEPS the override, so every caller sees
  // the value the user actually chose instead of the stale copy that is still on disk.
  persistMasterCredential(value) {
    const apiKey = String(value === undefined || value === null ? '' : value).trim()
    if (!apiKey) {
      const deleted = this.credentials.deleteApiKey()
      if (deleted) this.credentials.clearSessionOverride('master')
      else this.credentials.setSessionOverride('master', '')
      return deleted
    }
    const stored = this.credentials.setApiKey(apiKey)
    const verified = stored && this.credentials.getApiKey() === apiKey
    if (verified) this.credentials.clearSessionOverride('master')
    else this.credentials.setSessionOverride('master', apiKey)
    return verified
  }

  // Same rule per provider: encrypt, read back the ciphertext for the SAME endpoint, and
  // only then drop the override. An untouched provider is not rewritten at all.
  persistProviderCredential(providerId, intent = {}) {
    const id = String(providerId || '').trim()
    if (!id) return false
    const credentialId = providerCredentialIdOf(id)
    const apiKey = String(intent.apiKey === undefined || intent.apiKey === null ? '' : intent.apiKey).trim()
    const endpoint = typeof intent.baseUrl === 'string' ? intent.baseUrl : undefined
    if (!apiKey) {
      const deleted = this.credentials.deleteProviderApiKey(id)
      if (deleted) this.credentials.clearSessionOverride(credentialId)
      else this.credentials.setSessionOverride(credentialId, '', { endpoint })
      return deleted
    }
    const stored = this.credentials.setProviderApiKey(id, apiKey, { endpoint })
    const readBack = stored
      ? this.credentials.getProviderApiKeys([{ id, baseUrl: endpoint, apiKey: '' }])
      : {}
    const verified = stored && readBack[id] === apiKey
    if (verified) this.credentials.clearSessionOverride(credentialId)
    else this.credentials.setSessionOverride(credentialId, apiKey, { endpoint })
    return verified
  }

  updateSettings(patch) {
    const validatedPatch = assertSettingsPatch(
      patch === undefined ? {} : patch,
      this.defaults,
      { domainValidators: REGION_DOMAIN_VALIDATORS }
    )
    if (validatedPatch.clipboard) assertClipboardSettings(mergeSettings(this.getSettings().clipboard, validatedPatch.clipboard))
    const preparedPatch = this.prepareCredentialPatch(validatedPatch)
    const deepseekApiKeyPatch = Array.isArray(validatedPatch.providers)
      ? validatedPatch.providers.find((provider) => provider?.id === 'deepseek' && Object.hasOwn(provider, 'apiKey'))?.apiKey
      : undefined
    // D02 (04): the credential intents are derived from the PATCH, not from the merged
    // settings: only the credentials this save touches may be rewritten.
    const providerIntents = (Array.isArray(validatedPatch.providers) ? validatedPatch.providers : [])
      .filter((provider) => provider && typeof provider === 'object' && Object.hasOwn(provider, 'apiKey'))
      .map((provider) => ({
        id: String(provider.id || ''),
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl
      }))
    const settings = this.persistSettings(mergeSettings(this.getSettings(), preparedPatch), {
      updateApiKey: Object.hasOwn(validatedPatch, 'apiKey') || deepseekApiKeyPatch !== undefined,
      credentialIntent: { providers: providerIntents }
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
        return currentProvider && sameProviderEndpoint(provider, currentProvider)
          ? { ...provider, apiKey: currentProvider.apiKey }
          : provider
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
  mergeSettings,
  sameProviderEndpoint
}
