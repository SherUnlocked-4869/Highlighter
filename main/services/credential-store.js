const API_KEY_STORAGE_KEY = 'credentials.apiKey'
const PROVIDER_API_KEYS_STORAGE_KEY = 'credentials.providerApiKeys'

class CredentialStore {
  constructor({ store, safeStorage, onError = () => {}, maxDecryptedEntries = 100 }) {
    if (!store) throw new Error('CredentialStore requires a settings store')
    this.store = store
    this.safeStorage = safeStorage
    this.onError = onError
    this.apiKeyCache = null
    this.decryptedProviderKeys = new Map()
    this.maxDecryptedEntries = Math.max(1, Number(maxDecryptedEntries) || 100)
  }

  clearDecryptionCache() {
    this.apiKeyCache = null
    this.decryptedProviderKeys.clear()
  }

  decryptCached(encrypted) {
    const cached = this.decryptedProviderKeys.get(encrypted)
    if (cached !== undefined) {
      this.decryptedProviderKeys.delete(encrypted)
      this.decryptedProviderKeys.set(encrypted, cached)
      return cached
    }
    const decrypted = this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    this.decryptedProviderKeys.set(encrypted, decrypted)
    // Bound the cache so rotated/removed keys do not accumulate plaintext for
    // the whole process lifetime; clearDecryptionCache is also invoked on
    // system suspend/lock so secrets do not sit in memory while idle.
    if (this.decryptedProviderKeys.size > this.maxDecryptedEntries) {
      this.decryptedProviderKeys.delete(this.decryptedProviderKeys.keys().next().value)
    }
    return decrypted
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

  getApiKey(legacyValue = '') {
    const encrypted = this.store.get(API_KEY_STORAGE_KEY, '')
    if (!encrypted) return String(legacyValue || '')
    if (!this.isEncryptionAvailable()) return String(legacyValue || '')
    if (this.apiKeyCache && this.apiKeyCache.encrypted === encrypted) return this.apiKeyCache.value
    try {
      const value = this.decryptCached(encrypted)
      this.apiKeyCache = { encrypted, value }
      return value
    } catch (error) {
      this.onError(error)
      return String(legacyValue || '')
    }
  }

  setApiKey(value) {
    if (!this.isEncryptionAvailable()) return false
    const apiKey = String(value || '').trim()
    if (!apiKey) {
      this.store.delete(API_KEY_STORAGE_KEY)
      this.clearDecryptionCache()
      return true
    }
    const encrypted = this.safeStorage.encryptString(apiKey)
    this.store.set(API_KEY_STORAGE_KEY, Buffer.from(encrypted).toString('base64'))
    this.clearDecryptionCache()
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
          keys[id] = this.decryptCached(encrypted)
        } catch (error) {
          this.onError(error)
          this.decryptedProviderKeys.delete(encrypted)
          keys[id] = String(provider.apiKey || '')
        }
      } else {
        keys[id] = String(provider.apiKey || '')
      }
    }
    return keys
  }

  setProviderApiKeys(providers = []) {
    if (!this.isEncryptionAvailable()) return false
    const encryptedByProvider = {}
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = provider?.id ? String(provider.id).trim() : ''
      if (!id) continue
      const apiKey = String(provider.apiKey || '').trim()
      if (!apiKey) continue
      const encrypted = this.safeStorage.encryptString(apiKey)
      encryptedByProvider[id] = Buffer.from(encrypted).toString('base64')
    }
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
    this.clearDecryptionCache()
    return true
  }

  migrateLegacyApiKey() {
    const settings = this.store.get('settings', {})
    if (!settings || typeof settings !== 'object' || !Object.hasOwn(settings, 'apiKey')) return false
    const apiKey = String(settings.apiKey || '').trim()
    if (apiKey && !this.setApiKey(apiKey)) return false
    const migratedSettings = { ...settings }
    delete migratedSettings.apiKey
    this.store.set('settings', migratedSettings)
    this.clearDecryptionCache()
    return true
  }
}

module.exports = {
  API_KEY_STORAGE_KEY,
  PROVIDER_API_KEYS_STORAGE_KEY,
  CredentialStore
}
