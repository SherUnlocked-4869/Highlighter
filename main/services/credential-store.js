const API_KEY_STORAGE_KEY = 'credentials.apiKey'
const PROVIDER_API_KEYS_STORAGE_KEY = 'credentials.providerApiKeys'
// D02 (plan item 04): provider keys are bound to the endpoint they were saved for. The
// map lives next to the ciphertext so a provider whose address changed can never be handed
// the key that belonged to the old server.
const PROVIDER_ENDPOINTS_STORAGE_KEY = 'credentials.providerEndpoints'

// The two credential kinds share one override table: the master key uses MASTER_CREDENTIAL_ID
// and every provider uses providerCredentialId(id). An override is recorded even when the
// caller's value is empty - "cleared this session" is a decision, not the absence of one.
const MASTER_CREDENTIAL_ID = 'master'

function providerCredentialId(id) {
  const value = typeof id === 'string' ? id.trim() : ''
  return value ? 'provider:' + value : ''
}

// A provider's identity for credential purposes is id + endpoint: the same id pointed at a
// different server is a different credential holder.
function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

// D02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): when Windows
// encryption (DPAPI via Electron safeStorage) is unavailable, a key may still be used -
// but only in this process's memory. Nothing here ever writes a plaintext key to the
// settings store, and a store written before this rule is left exactly as it was so it
// can be migrated (encrypt + verify readback + remove) once encryption returns.
//
// State the UI needs is exposed through getCredentialState(): "no key configured" and
// "a key exists but cannot be decrypted" are different situations and get different copy.
class CredentialStore {
  constructor({ store, safeStorage, onError = () => {} }) {
    if (!store) throw new Error('CredentialStore requires a settings store')
    this.store = store
    this.safeStorage = safeStorage
    this.onError = onError
    // Session-only fallback. A WeakMap is not usable here because the values are plain
    // strings on a long-lived object - a Map would keep them alive just as long, so plain
    // fields make the lifetime obvious.
    this.sessionApiKey = ''
    this.sessionProviderApiKeys = Object.create(null)
    // D02 (04): credentialId -> { value, endpoint }. Presence of the entry is the decision:
    // an entry with value '' means "the user cleared it in this session, do not fall back".
    this.overrides = new Map()
    this.encryptionFailed = false
  }

  isEncryptionAvailable() {
    try {
      return !!this.safeStorage?.isEncryptionAvailable()
    } catch (error) {
      this.onError(error)
      return false
    }
  }

  hasEncryptedApiKey() {
    return typeof this.store.get(API_KEY_STORAGE_KEY, '') === 'string'
      && this.store.get(API_KEY_STORAGE_KEY, '').length > 0
  }

  // ---------------------------------------------------------------- session-only keys
  setSessionApiKey(value) {
    this.sessionApiKey = String(value || '').trim()
    return true
  }

  getSessionApiKey() {
    return this.sessionApiKey
  }

  setSessionProviderApiKeys(providers = []) {
    const next = Object.create(null)
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      const apiKey = String(provider?.apiKey || '').trim()
      if (id && apiKey) next[id] = apiKey
    }
    this.sessionProviderApiKeys = next
    return true
  }

  // ------------------------------------------------------------ session overrides
  // D02 (04): a value that could not be persisted (encryption refused, or the disk write
  // failed) is still the value the user just entered, so it must outrank whatever is on
  // disk. Recording it explicitly - including the empty value - is what keeps a caller from
  // silently using the OLD credential after the user replaced or removed it.
  setSessionOverride(credentialId, value, { endpoint = '' } = {}) {
    const id = typeof credentialId === 'string' ? credentialId.trim() : ''
    if (!id) return false
    const apiKey = String(value === undefined || value === null ? '' : value).trim()
    this.overrides.set(id, { value: apiKey, endpoint: normalizeEndpoint(endpoint) })
    // Keep the legacy convenience fields coherent for callers that still read them.
    if (id === MASTER_CREDENTIAL_ID) this.sessionApiKey = apiKey
    const providerId = id.startsWith('provider:') ? id.slice('provider:'.length) : ''
    if (providerId) {
      if (apiKey) this.sessionProviderApiKeys[providerId] = apiKey
      else delete this.sessionProviderApiKeys[providerId]
    }
    return true
  }

  clearSessionOverride(credentialId) {
    const id = typeof credentialId === 'string' ? credentialId.trim() : ''
    if (!id) return false
    const existed = this.overrides.delete(id)
    if (id === MASTER_CREDENTIAL_ID) this.sessionApiKey = ''
    const providerId = id.startsWith('provider:') ? id.slice('provider:'.length) : ''
    if (providerId) delete this.sessionProviderApiKeys[providerId]
    return existed
  }

  hasSessionOverride(credentialId) {
    return this.overrides.has(typeof credentialId === 'string' ? credentialId.trim() : '')
  }

  // The override value, or null when the credential is not overridden. '' is a real answer
  // (the user cleared it), so a caller must compare against null, not falsiness.
  getSessionOverride(credentialId, { endpoint = null } = {}) {
    const override = this.overrides.get(typeof credentialId === 'string' ? credentialId.trim() : '')
    if (!override) return null
    // An override recorded for one endpoint does not answer for another.
    if (endpoint !== null && override.endpoint !== normalizeEndpoint(endpoint)) return null
    return override.value
  }

  clearSessionSecrets() {
    this.sessionApiKey = ''
    this.sessionProviderApiKeys = Object.create(null)
    this.overrides.clear()
  }

  hasSessionSecrets() {
    if (this.overrides.size > 0) {
      for (const override of this.overrides.values()) {
        if (override.value) return true
      }
    }
    return !!this.sessionApiKey || Object.keys(this.sessionProviderApiKeys).length > 0
  }

  // ---------------------------------------------------------------------- read paths
  // Order: the encrypted copy (the only durable one), then the session fallback, then a
  // caller-supplied legacy plaintext value. A failed decrypt is reported and falls through
  // instead of throwing, so one corrupt blob cannot make the app unusable.
  getApiKey(legacyValue = '') {
    // D02 (04): an explicit override wins over the stored copy, INCLUDING when it is empty
    // (the user cleared the key and the old ciphertext could not be deleted yet).
    const override = this.getSessionOverride(MASTER_CREDENTIAL_ID)
    if (override !== null) return override
    const encrypted = this.store.get(API_KEY_STORAGE_KEY, '')
    if (encrypted) {
      if (this.isEncryptionAvailable()) {
        try {
          return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
        } catch (error) {
          this.onError(error)
        }
      }
    }
    if (this.sessionApiKey) return this.sessionApiKey
    return String(legacyValue || '')
  }

  setApiKey(value) {
    if (!this.isEncryptionAvailable()) return false
    const apiKey = String(value || '').trim()
    if (!apiKey) {
      this.store.delete(API_KEY_STORAGE_KEY)
      return true
    }
    let encrypted
    try {
      encrypted = this.safeStorage.encryptString(apiKey)
    } catch (error) {
      // A profile that reports encryption as available can still refuse to encrypt
      // (locked credential store, broken DPAPI). Never fall back to plaintext.
      this.encryptionFailed = true
      this.onError(error)
      return false
    }
    this.store.set(API_KEY_STORAGE_KEY, Buffer.from(encrypted).toString('base64'))
    this.encryptionFailed = false
    return true
  }

  getProviderApiKeys(providers = []) {
    const stored = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    const encryptedByProvider = stored && typeof stored === 'object' ? stored : {}
    const storedEndpointsRaw = this.store.get(PROVIDER_ENDPOINTS_STORAGE_KEY, {})
    const storedEndpoints = storedEndpointsRaw && typeof storedEndpointsRaw === 'object' ? storedEndpointsRaw : {}
    const keys = {}
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      if (!id) continue
      // D02 (04): precedence is override -> stored ciphertext -> legacy plaintext. The
      // override is only valid for the endpoint it was recorded for; the ciphertext is only
      // valid for the endpoint it was saved for. A provider whose address changed therefore
      // reports NO key instead of the key that belonged to the previous server.
      const override = this.getSessionOverride(providerCredentialId(id), { endpoint: provider.baseUrl })
      if (override !== null) {
        keys[id] = override
        continue
      }
      const encrypted = encryptedByProvider[id]
      if (encrypted && this.isEncryptionAvailable()) {
        const savedEndpoint = storedEndpoints[id] === undefined ? null : normalizeEndpoint(storedEndpoints[id])
        const askedEndpoint = provider.baseUrl === undefined ? null : normalizeEndpoint(provider.baseUrl)
        if (savedEndpoint === null || askedEndpoint === null || savedEndpoint === askedEndpoint) {
          try {
            keys[id] = this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
            continue
          } catch (error) {
            this.onError(error)
          }
        } else {
          // The provider now points somewhere else: the old key does not apply, and using
          // it would hand one server's credential to another.
          keys[id] = ''
          continue
        }
      }
      keys[id] = this.sessionProviderApiKeys[id] || String(provider.apiKey || '')
    }
    return keys
  }

  // Writes ONE provider credential and records the endpoint it belongs to. Returns false when
  // encryption refused, so the caller can keep the session override.
  setProviderApiKey(providerId, value, { endpoint } = {}) {
    if (!this.isEncryptionAvailable()) return false
    const id = typeof providerId === 'string' ? providerId.trim() : ''
    if (!id) return false
    const apiKey = String(value === undefined || value === null ? '' : value).trim()
    if (!apiKey) return this.deleteProviderApiKey(id)
    let encrypted
    try {
      encrypted = this.safeStorage.encryptString(apiKey)
    } catch (error) {
      this.encryptionFailed = true
      this.onError(error)
      return false
    }
    const stored = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    const encryptedByProvider = stored && typeof stored === 'object' ? { ...stored } : {}
    encryptedByProvider[id] = Buffer.from(encrypted).toString('base64')
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    const endpointsRaw = this.store.get(PROVIDER_ENDPOINTS_STORAGE_KEY, {})
    const endpoints = endpointsRaw && typeof endpointsRaw === 'object' ? { ...endpointsRaw } : {}
    if (endpoint !== undefined) endpoints[id] = normalizeEndpoint(endpoint)
    this.store.set(PROVIDER_ENDPOINTS_STORAGE_KEY, endpoints)
    this.encryptionFailed = false
    return true
  }

  // Deletes the durable copy of one credential and verifies it is really gone. Used by the
  // "clear the key" path: a store delete that silently fails must be reported, not assumed.
  deleteApiKey() {
    this.store.delete(API_KEY_STORAGE_KEY)
    return this.store.get(API_KEY_STORAGE_KEY, '') === ''
  }

  deleteProviderApiKey(providerId) {
    const id = typeof providerId === 'string' ? providerId.trim() : ''
    if (!id) return false
    const stored = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    const encryptedByProvider = stored && typeof stored === 'object' ? { ...stored } : {}
    delete encryptedByProvider[id]
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    const endpointsRaw = this.store.get(PROVIDER_ENDPOINTS_STORAGE_KEY, {})
    if (endpointsRaw && typeof endpointsRaw === 'object' && Object.hasOwn(endpointsRaw, id)) {
      const next = { ...endpointsRaw }
      delete next[id]
      this.store.set(PROVIDER_ENDPOINTS_STORAGE_KEY, next)
    }
    const readBack = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    return !(readBack && typeof readBack === 'object' && readBack[id])
  }


  setProviderApiKeys(providers) {
    if (!this.isEncryptionAvailable()) return false
    const encryptedByProvider = {}
    const endpointsByProvider = {}
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      if (!id) continue
      const apiKey = String(provider.apiKey || '').trim()
      if (!apiKey) continue
      try {
        encryptedByProvider[id] = Buffer.from(this.safeStorage.encryptString(apiKey)).toString('base64')
        // Record the endpoint this ciphertext belongs to, so it can never be handed to the
        // same provider id pointed at another server.
        if (provider.baseUrl !== undefined) endpointsByProvider[id] = normalizeEndpoint(provider.baseUrl)
      } catch (error) {
        this.encryptionFailed = true
        this.onError(error)
        return false
      }
    }
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    const storedEndpoints = this.store.get(PROVIDER_ENDPOINTS_STORAGE_KEY, {})
    const mergedEndpoints = storedEndpoints && typeof storedEndpoints === 'object' ? { ...storedEndpoints } : {}
    for (const id of Object.keys(mergedEndpoints)) {
      if (!encryptedByProvider[id]) delete mergedEndpoints[id]
    }
    Object.assign(mergedEndpoints, endpointsByProvider)
    this.store.set(PROVIDER_ENDPOINTS_STORAGE_KEY, mergedEndpoints)
    this.encryptionFailed = false
    return true
  }

  // ------------------------------------------------------------------- state for the UI
  // Cheap enough for a settings-page read, and the only place that inspects the store for
  // plaintext leftovers instead of trusting what the caller passed in.
  // What the settings page needs to tell the user about this session's overrides: which
  // credentials were replaced, and which were cleared. 'set'/'empty' is deliberately not the
  // value itself - the renderer never sees a secret.
  getEffectiveCredentialState() {
    const overrides = {}
    for (const [id, entry] of this.overrides) overrides[id] = entry.value ? 'set' : 'empty'
    return {
      overrides,
      count: this.overrides.size,
      cleared: Object.keys(overrides).filter((id) => overrides[id] === 'empty'),
      replaced: Object.keys(overrides).filter((id) => overrides[id] === 'set')
    }
  }

  getCredentialState() {
    const encryptionAvailable = this.isEncryptionAvailable()
    const settings = this.store.get('settings', {}) || {}
    const legacyApiKey = typeof settings.apiKey === 'string' && settings.apiKey.trim() !== ''
    const legacyProviderKey = Array.isArray(settings.providers)
      && settings.providers.some((provider) => String(provider?.apiKey || '').trim() !== '')
    let decryptFailed = false
    if (encryptionAvailable) {
      const encryptedApiKey = this.store.get(API_KEY_STORAGE_KEY, '')
      const encryptedProviders = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {}) || {}
      const blobs = [encryptedApiKey, ...Object.values(encryptedProviders)].filter(Boolean)
      for (const blob of blobs) {
        try {
          this.safeStorage.decryptString(Buffer.from(blob, 'base64'))
        } catch {
          decryptFailed = true
          break
        }
      }
    }
    return {
      encryptionAvailable,
      decryptFailed,
      // The pre-D02 state: an old build left a key in the settings file. It stays there
      // until encryption can take it over, so the UI asks the user to re-enter or clear it.
      legacyPlaintext: legacyApiKey || legacyProviderKey,
      sessionOnly: this.hasSessionSecrets(),
      // D02 (04): the page explains the restart behaviour from this, so a temporary new
      // value is never presented as if it had been saved.
      sessionOverrides: this.getEffectiveCredentialState(),
      encryptionFailed: this.encryptionFailed === true
    }
  }

  // ------------------------------------------------------------------------ migrations
  migrateLegacyApiKey() {
    const settings = this.store.get('settings', {})
    if (!settings || typeof settings !== 'object' || !Object.hasOwn(settings, 'apiKey')) return false
    const apiKey = String(settings.apiKey || '').trim()
    // No encryption: keep the legacy value where it is. Deleting it would destroy the
    // only copy we could migrate later; rewriting it would create a new plaintext copy.
    if (apiKey && !this.isEncryptionAvailable()) return false
    if (apiKey) {
      if (!this.setApiKey(apiKey)) return false
      // Verify the ciphertext reads back BEFORE removing the plaintext original.
      if (this.getApiKey() !== apiKey) return false
    }
    const migratedSettings = { ...settings }
    delete migratedSettings.apiKey
    this.store.set('settings', migratedSettings)
    return true
  }

  // The same migration for providers[].apiKey, which older builds also wrote to the
  // settings file. All-or-nothing: if any key cannot be encrypted and verified, nothing
  // is removed.
  migrateLegacyProviderApiKeys() {
    const settings = this.store.get('settings', {})
    const providers = Array.isArray(settings?.providers) ? settings.providers : []
    const withKeys = providers.filter((provider) => String(provider?.apiKey || '').trim() !== '')
    if (!withKeys.length) return false
    if (!this.isEncryptionAvailable()) return false
    const stored = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    const encryptedByProvider = stored && typeof stored === 'object' ? { ...stored } : {}
    for (const provider of withKeys) {
      const id = provider.id ? String(provider.id).trim() : ''
      const apiKey = String(provider.apiKey || '').trim()
      if (!id) return false
      let encrypted
      try {
        encrypted = this.safeStorage.encryptString(apiKey)
      } catch (error) {
        this.onError(error)
        return false
      }
      try {
        if (this.safeStorage.decryptString(Buffer.from(encrypted)) !== apiKey) return false
      } catch (error) {
        this.onError(error)
        return false
      }
      encryptedByProvider[id] = Buffer.from(encrypted).toString('base64')
    }
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    this.store.set('settings', {
      ...settings,
      providers: providers.map((provider) => (
        String(provider?.apiKey || '').trim() ? { ...provider, apiKey: '' } : provider
      ))
    })
    return true
  }

  // Called on every save once encryption is available: each session override is retried
  // against the store, verified by DECRYPTING THE NEW ciphertext, and only then dropped. A
  // retry that still fails leaves the override in place, so a request never silently falls
  // back to the value it replaced.
  flushSessionOverrides() {
    if (!this.overrides.size || !this.isEncryptionAvailable()) return false
    let flushed = false
    for (const [id, entry] of [...this.overrides]) {
      const providerId = id.startsWith('provider:') ? id.slice('provider:'.length) : ''
      if (!providerId) {
        if (entry.value) {
          if (this.setApiKey(entry.value) && this.getStoredApiKey() === entry.value) {
            this.clearSessionOverride(id)
            flushed = true
          }
        } else if (this.deleteApiKey()) {
          this.clearSessionOverride(id)
          flushed = true
        }
        continue
      }
      if (entry.value) {
        const endpoint = entry.endpoint || ''
        if (this.setProviderApiKey(providerId, entry.value, { endpoint }) &&
          this.getStoredProviderApiKey(providerId, endpoint) === entry.value) {
          this.clearSessionOverride(id)
          flushed = true
        }
      } else if (this.deleteProviderApiKey(providerId)) {
        this.clearSessionOverride(id)
        flushed = true
      }
    }
    return flushed
  }

  // The decryptable copy for one credential, read STRAIGHT from the store (never the
  // override). 'Verify what was written' must look at the ciphertext, not at the override
  // that is about to be cleared.
  getStoredApiKey() {
    const encrypted = this.store.get(API_KEY_STORAGE_KEY, '')
    if (!encrypted || !this.isEncryptionAvailable()) return ''
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (error) {
      this.onError(error)
      return ''
    }
  }

  getStoredProviderApiKey(providerId, endpoint = '') {
    const id = typeof providerId === 'string' ? providerId.trim() : ''
    if (!id) return ''
    const stored = this.store.get(PROVIDER_API_KEYS_STORAGE_KEY, {})
    const encrypted = stored && typeof stored === 'object' ? stored[id] : ''
    if (!encrypted || !this.isEncryptionAvailable()) return ''
    const endpointsRaw = this.store.get(PROVIDER_ENDPOINTS_STORAGE_KEY, {})
    const endpoints = endpointsRaw && typeof endpointsRaw === 'object' ? endpointsRaw : {}
    if (endpoints[id] !== undefined && endpoint !== undefined &&
      normalizeEndpoint(endpoints[id]) !== normalizeEndpoint(endpoint)) return ''
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (error) {
      this.onError(error)
      return ''
    }
  }

  // Called on a save once encryption is available again: whatever was typed during the
  // session becomes a real encrypted credential (verify readback, then drop the memory copy).
  migrateSessionSecrets() {
    if (!this.hasSessionSecrets() || !this.isEncryptionAvailable()) return false
    let migrated = false
    if (this.sessionApiKey) {
      const apiKey = this.sessionApiKey
      if (this.setApiKey(apiKey) && this.getApiKey() === apiKey) {
        this.sessionApiKey = ''
        migrated = true
      }
    }
    const ids = Object.keys(this.sessionProviderApiKeys)
    if (ids.length) {
      const providers = ids.map((id) => ({ id, apiKey: this.sessionProviderApiKeys[id] }))
      if (this.setProviderApiKeys(providers)) {
        const readBack = this.getProviderApiKeys(providers)
        if (ids.every((id) => readBack[id] === providers.find((provider) => provider.id === id).apiKey)) {
          this.sessionProviderApiKeys = Object.create(null)
          migrated = true
        }
      }
    }
    return migrated
  }
}

module.exports = {
  API_KEY_STORAGE_KEY,
  PROVIDER_API_KEYS_STORAGE_KEY,
  CredentialStore
}
