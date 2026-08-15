const API_KEY_STORAGE_KEY = 'credentials.apiKey'
const PROVIDER_API_KEYS_STORAGE_KEY = 'credentials.providerApiKeys'

class CredentialStore {
  constructor({ store, safeStorage, onError = () => {} }) {
    if (!store) throw new Error('CredentialStore requires a settings store')
    this.store = store
    this.safeStorage = safeStorage
    this.onError = onError
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
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
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
      return true
    }
    const encrypted = this.safeStorage.encryptString(apiKey)
    this.store.set(API_KEY_STORAGE_KEY, Buffer.from(encrypted).toString('base64'))
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
        } catch (error) {
          this.onError(error)
          keys[id] = String(provider.apiKey || '')
        }
      } else {
        keys[id] = String(provider.apiKey || '')
      }
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
      const encrypted = this.safeStorage.encryptString(apiKey)
      encryptedByProvider[id] = Buffer.from(encrypted).toString('base64')
    }
    this.store.set(PROVIDER_API_KEYS_STORAGE_KEY, encryptedByProvider)
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
    return true
  }
}

module.exports = {
  API_KEY_STORAGE_KEY,
  PROVIDER_API_KEYS_STORAGE_KEY,
  CredentialStore
}
