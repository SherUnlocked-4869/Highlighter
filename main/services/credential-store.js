const API_KEY_STORAGE_KEY = 'credentials.apiKey'
const PROVIDER_API_KEYS_STORAGE_KEY = 'credentials.providerApiKeys'

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

  clearSessionSecrets() {
    this.sessionApiKey = ''
    this.sessionProviderApiKeys = Object.create(null)
  }

  hasSessionSecrets() {
    return !!this.sessionApiKey || Object.keys(this.sessionProviderApiKeys).length > 0
  }

  // ---------------------------------------------------------------------- read paths
  // Order: the encrypted copy (the only durable one), then the session fallback, then a
  // caller-supplied legacy plaintext value. A failed decrypt is reported and falls through
  // instead of throwing, so one corrupt blob cannot make the app unusable.
  getApiKey(legacyValue = '') {
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
    const keys = {}
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      if (!id) continue
      const encrypted = encryptedByProvider[id]
      if (encrypted && this.isEncryptionAvailable()) {
        try {
          keys[id] = this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
          continue
        } catch (error) {
          this.onError(error)
        }
      }
      keys[id] = this.sessionProviderApiKeys[id] || String(provider.apiKey || '')
    }
    return keys
  }

  setProviderApiKeys(providers) {
    if (!this.isEncryptionAvailable()) return false
    const encryptedByProvider = {}
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      if (!id) continue
      const apiKey = String(provider.apiKey || '').trim()
      if (!apiKey) continue
      try {
        encryptedByProvider[id] = Buffer.from(this.safeStorage.encryptString(apiKey)).toString('base64')
      } catch (error) {
        this.encryptionFailed = true
        this.onError(error)
        return false
      }
    }
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    this.encryptionFailed = false
    return true
  }

  // ------------------------------------------------------------------- state for the UI
  // Cheap enough for a settings-page read, and the only place that inspects the store for
  // plaintext leftovers instead of trusting what the caller passed in.
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
