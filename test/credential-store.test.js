const test = require('node:test')
const assert = require('node:assert/strict')
const { API_KEY_STORAGE_KEY, PROVIDER_API_KEYS_STORAGE_KEY, CredentialStore } = require('../main/services/credential-store')

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

test('encrypts provider API keys separately and removes keys for deleted providers', () => {
  const store = new MemoryStore()
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage() })
  const providers = [
    { id: 'deepseek', apiKey: 'sk-deepseek' },
    { id: 'jbb', apiKey: 'sk-jbb' }
  ]
  assert.equal(credentials.setProviderApiKeys(providers), true)
  assert.equal(store.get(PROVIDER_API_KEYS_STORAGE_KEY).jbb.length > 0, true)
  assert.equal(store.get(PROVIDER_API_KEYS_STORAGE_KEY).jbb, Buffer.from('encrypted:sk-jbb').toString('base64'))
  assert.deepEqual(credentials.getProviderApiKeys(providers), { deepseek: 'sk-deepseek', jbb: 'sk-jbb' })

  credentials.setProviderApiKeys([{ id: 'deepseek', apiKey: 'sk-rotated' }])
  assert.deepEqual(credentials.getProviderApiKeys(providers.map((provider) => ({ ...provider, apiKey: '' }))), { deepseek: 'sk-rotated', jbb: '' })
})

test('D02: session-only keys survive a settings read but never touch the store', () => {
  const store = new MemoryStore()
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage(false) })
  credentials.setSessionApiKey('sk-session')
  credentials.setSessionProviderApiKeys([{ id: 'deepseek', apiKey: 'sk-provider-session' }])
  assert.equal(credentials.getApiKey(''), 'sk-session')
  assert.deepEqual(credentials.getProviderApiKeys([{ id: 'deepseek', apiKey: '' }]), { deepseek: 'sk-provider-session' })
  assert.equal(JSON.stringify([...store.values.entries()]).includes('sk-session'), false)
  const state = credentials.getCredentialState()
  assert.equal(state.sessionOnly, true)
  assert.equal(state.encryptionAvailable, false)
})

test('D02: the session key outranks a legacy plaintext value, which stays readable otherwise', () => {
  const store = new MemoryStore({ settings: { apiKey: 'sk-legacy' } })
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage(false) })
  assert.equal(credentials.getApiKey('sk-legacy'), 'sk-legacy')
  credentials.setSessionApiKey('sk-newer')
  assert.equal(credentials.getApiKey('sk-legacy'), 'sk-newer')
  assert.equal(credentials.getCredentialState().legacyPlaintext, true)
})

test('D02: migration verifies the ciphertext before deleting the plaintext original', () => {
  const store = new MemoryStore({ settings: { apiKey: 'sk-legacy' } })
  const safeStorage = createSafeStorage()
  // A store that "encrypts" into a blob it cannot read back: the plaintext must survive.
  safeStorage.decryptString = () => 'something-else'
  const credentials = new CredentialStore({ store, safeStorage })
  assert.equal(credentials.migrateLegacyApiKey(), false)
  assert.equal(store.get('settings').apiKey, 'sk-legacy')
})

test('D02: session keys become encrypted credentials once encryption is available', () => {
  const store = new MemoryStore()
  const unavailable = new CredentialStore({ store, safeStorage: createSafeStorage(false) })
  unavailable.setSessionApiKey('sk-promote')
  assert.equal(store.get(API_KEY_STORAGE_KEY, ''), '')

  const available = new CredentialStore({ store, safeStorage: createSafeStorage(true) })
  // The new store instance starts empty; carry the session secret across the way the
  // settings service does (same process, same CredentialStore in production).
  available.setSessionApiKey('sk-promote')
  assert.equal(available.migrateSessionSecrets(), true)
  assert.ok(store.get(API_KEY_STORAGE_KEY))
  assert.equal(available.getSessionApiKey(), '')
  assert.equal(available.getApiKey(), 'sk-promote')
})

test('D02: provider migration is all-or-nothing and blank values stay untouched', () => {
  const provider = { id: 'deepseek', apiKey: 'sk-provider-legacy' }
  const store = new MemoryStore({ settings: { providers: [provider, { id: 'other', apiKey: '' }] } })
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage() })
  assert.equal(credentials.migrateLegacyProviderApiKeys(), true)
  assert.equal(store.get('settings').providers[0].apiKey, '')
  assert.equal(store.get(PROVIDER_API_KEYS_STORAGE_KEY).deepseek.length > 0, true)
  assert.equal(credentials.getProviderApiKeys([{ id: 'deepseek', apiKey: '' }]).deepseek, 'sk-provider-legacy')
  assert.equal(credentials.migrateLegacyProviderApiKeys(), false)
})

test('provider API keys fall back to plaintext values when encryption is unavailable', () => {
  const store = new MemoryStore()
  const credentials = new CredentialStore({ store, safeStorage: createSafeStorage(false) })
  const providers = [{ id: 'deepseek', apiKey: 'sk-plaintext' }]
  assert.equal(credentials.setProviderApiKeys(providers), false)
  assert.deepEqual(credentials.getProviderApiKeys(providers), { deepseek: 'sk-plaintext' })
})
