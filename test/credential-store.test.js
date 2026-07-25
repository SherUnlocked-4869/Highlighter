const test = require('node:test')
const assert = require('node:assert/strict')
const { API_KEY_STORAGE_KEY, CredentialStore } = require('../main/services/credential-store')

class MemoryStore {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values))
  }

  get(key, fallback) {
    return this.values.has(key) ? this.values.get(key) : fallback
  }

  set(key, value) {
    this.values.set(key, value)
  }

  delete(key) {
    this.values.delete(key)
  }
}

function createSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
}

test('migrates a legacy API key out of plaintext settings', () => {
  const store = new MemoryStore({ settings: { theme: 'dark', apiKey: 'sk-legacy-key' } })
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage() })
  assert.equal(credentials.migrateLegacyApiKey(), true)
  assert.deepEqual(store.get('settings'), { theme: 'dark' })
  assert.notEqual(store.get(API_KEY_STORAGE_KEY), 'sk-legacy-key')
  assert.equal(credentials.getApiKey(), 'sk-legacy-key')
})

test('retains a legacy API key when system encryption is unavailable', () => {
  const settings = { apiKey: 'sk-legacy-key' }
  const store = new MemoryStore({ settings })
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage(false) })
  assert.equal(credentials.migrateLegacyApiKey(), false)
  assert.deepEqual(store.get('settings'), settings)
  assert.equal(credentials.getApiKey(settings.apiKey), 'sk-legacy-key')
})

test('clears an encrypted API key without leaving plaintext data', () => {
  const store = new MemoryStore()
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage() })
  assert.equal(credentials.setApiKey('sk-new-key'), true)
  assert.equal(credentials.getApiKey(), 'sk-new-key')
  assert.equal(credentials.setApiKey(''), true)
  assert.equal(store.get(API_KEY_STORAGE_KEY, ''), '')
})

test('reports corrupt encrypted data and falls back without deleting it', () => {
  const errors = []
  const store = new MemoryStore({ [API_KEY_STORAGE_KEY]: Buffer.from('corrupt').toString('base64') })
  const safeStorage = createSafeStorage()
  safeStorage.decryptString = () => { throw new Error('decrypt failed') }
  const credentials = new CredentialStore({ store, safeStorage, onError: (error) => errors.push(error.message) })
  assert.equal(credentials.getApiKey('legacy'), 'legacy')
  assert.deepEqual(errors, ['decrypt failed'])
  assert.ok(store.get(API_KEY_STORAGE_KEY))
})
