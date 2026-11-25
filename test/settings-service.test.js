const test = require('node:test')
const assert = require('node:assert/strict')
const { SettingsService, mergeSettings } = require('../main/services/settings-service')
const { createDefaultAssignments, createDefaultProviders, migrateAiSettings, normalizeAiSettings } = require('../main/services/ai-providers')

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

const defaults = {
  apiKey: '',
  theme: 'system',
  compact: false,
  system: { autoStart: true, runLog: true },
  screenshot: { historyDirectory: 'history', historyLimit: 200 }
}

test('settings service migrates credentials and merges partial updates', () => {
  const store = new MemoryStore({
    settings: { apiKey: 'sk-legacy-value', theme: 'dark', system: { autoStart: false } }
  })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults
  })
  assert.equal(store.get('settings').apiKey, undefined)
  const result = service.updateSettings({ compact: true, system: { runLog: false } })
  assert.deepEqual(result.patch, { compact: true, system: { runLog: false } })
  assert.equal(result.settings.apiKey, 'sk-legacy-value')
  assert.equal(result.settings.theme, 'dark')
  assert.deepEqual(result.settings.system, { autoStart: false, runLog: false })
  assert.equal(store.get('settings').apiKey, undefined)
})

test('settings service resets encrypted credentials and defaults', () => {
  const store = new MemoryStore()
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults
  })
  service.setApiKey('sk-new-value')
  service.updateSettings({ theme: 'dark' })
  const settings = service.resetSettings()
  assert.equal(settings.apiKey, '')
  assert.equal(settings.theme, 'system')
})

test('D02: without system encryption a legacy plaintext key stays put but is never duplicated', () => {
  const store = new MemoryStore({ settings: { apiKey: 'sk-fallback', theme: 'dark' } })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(false),
    defaults
  })
  service.updateSettings({ compact: true })
  // The pre-upgrade value is still exactly where it was (it is the only copy a later
  // migration can encrypt) and it was not copied anywhere else.
  assert.equal(store.get('settings').apiKey, 'sk-fallback')
  assert.equal(service.getSettings().apiKey, 'sk-fallback')
  assert.equal(JSON.stringify(store.get('settings')).split('sk-fallback').length - 1, 1)
  assert.equal(service.getPublicSettings().credentialState.legacyPlaintext, true)
})

test('D02: a key entered without system encryption never reaches the store', () => {
  const store = new MemoryStore()
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(false),
    defaults
  })
  const settings = service.updateSettings({ apiKey: 'sk-session-only' }).settings
  assert.equal(settings.apiKey, 'sk-session-only')
  assert.equal(service.getSettings().apiKey, 'sk-session-only')
  const persisted = JSON.stringify(store.get('settings'))
  assert.equal(persisted.includes('sk-session-only'), false)
  const pub = service.getPublicSettings()
  assert.equal(pub.hasApiKey, true)
  assert.equal(pub.credentialState.sessionOnly, true)
  assert.equal(pub.credentialState.encryptionAvailable, false)
})

test('D02: provider keys entered without system encryption stay in session memory', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-v4-flash' }] }
  }
  const store = new MemoryStore()
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(false),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-provider-session', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }]
  })
  assert.equal(service.getSettings().providers[0].apiKey, 'sk-provider-session')
  assert.equal(service.getSettings().apiKey, 'sk-provider-session')
  const persisted = JSON.stringify(store.get('settings'))
  assert.equal(persisted.includes('sk-provider-session'), false)
  assert.equal(store.get('settings').providers[0].apiKey, '')
})

test('D02: a legacy provider plaintext key is kept until encryption can take it over', () => {
  const provider = { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-legacy-provider', models: [] }
  const providerDefaults = { apiKey: '', providers: [{ ...provider, apiKey: '' }] }
  const unavailable = new MemoryStore({ settings: { providers: [provider] } })
  const service = new SettingsService({ store: unavailable, safeStorage: createSafeStorage(false), defaults: providerDefaults })
  assert.equal(unavailable.get('settings').providers[0].apiKey, 'sk-legacy-provider')
  assert.equal(service.getSettings().providers[0].apiKey, 'sk-legacy-provider')

  const available = new MemoryStore({ settings: { providers: [provider] } })
  const migrated = new SettingsService({ store: available, safeStorage: createSafeStorage(), defaults: providerDefaults })
  assert.equal(available.get('settings').providers[0].apiKey, '')
  assert.equal(migrated.getSettings().providers[0].apiKey, 'sk-legacy-provider')
  assert.equal(JSON.stringify(available.get('settings')).includes('sk-legacy-provider'), false)
})

test('D02: an encrypting profile that refuses to encrypt falls back to session memory, not plaintext', () => {
  const store = new MemoryStore()
  const safeStorage = createSafeStorage()
  safeStorage.encryptString = () => { throw new Error('DPAPI locked') }
  const service = new SettingsService({ store, safeStorage, defaults })
  const settings = service.updateSettings({ apiKey: 'sk-refused' }).settings
  assert.equal(settings.apiKey, 'sk-refused')
  assert.equal(JSON.stringify(store.get('settings')).includes('sk-refused'), false)
  assert.equal(service.getPublicSettings().credentialState.encryptionFailed, true)
  assert.equal(service.getPublicSettings().credentialState.sessionOnly, true)
})

test('D02: a corrupt encrypted blob is reported apart from "no key configured"', () => {
  const store = new MemoryStore({ 'credentials.apiKey': Buffer.from('corrupt').toString('base64') })
  const safeStorage = createSafeStorage()
  safeStorage.decryptString = () => { throw new Error('decrypt failed') }
  const service = new SettingsService({ store, safeStorage, defaults })
  const pub = service.getPublicSettings()
  assert.equal(pub.hasApiKey, false)
  assert.equal(pub.credentialState.decryptFailed, true)
  assert.equal(pub.credentialState.legacyPlaintext, false)
})

test('settings service rejects invalid IPC-shaped patches', () => {
  const service = new SettingsService({
    store: new MemoryStore(),
    safeStorage: createSafeStorage(),
    defaults
  })
  assert.throws(() => service.updateSettings({ unknown: true }), /不支持的设置项/)
  assert.throws(() => service.updateSettings({ compact: 'yes' }), /类型无效/)
})

test('mergeSettings ignores prototype pollution keys', () => {
  const patch = Object.create(null)
  Object.defineProperty(patch, '__proto__', { value: { polluted: true }, enumerable: true })
  patch.theme = 'dark'
  const result = mergeSettings(defaults, patch)
  assert.equal(result.theme, 'dark')
  assert.equal({}.polluted, undefined)
})

test('settings service encrypts provider API keys and keeps them out of plaintext settings', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-v4-flash' }] }
  }
  const store = new MemoryStore()
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-provider-key', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }]
  })
  assert.equal(store.get('settings').providers[0].apiKey, '')
  assert.equal(service.getSettings().providers[0].apiKey, 'sk-provider-key')
  assert.equal(service.getSettings().apiKey, 'sk-provider-key')
})

test('settings service preserves omitted provider API keys on partial provider patches', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-v4-flash' }] }
  }
  const store = new MemoryStore()
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-provider-key', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }]
  })
  service.updateSettings({
    providers: [{ id: 'deepseek', name: 'DeepSeek 新名称', baseUrl: 'https://api.deepseek.com' }]
  })
  assert.equal(service.getSettings().providers[0].name, 'DeepSeek 新名称')
  assert.equal(service.getSettings().providers[0].apiKey, 'sk-provider-key')
})

test('settings service does not carry a stored key to a changed endpoint', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'custom', name: 'Custom', baseUrl: 'https://old.example/v1', apiKey: '', models: [{ id: 'model', name: 'Model' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'custom', model: 'model' }] }
  }
  const service = new SettingsService({
    store: new MemoryStore(),
    safeStorage: createSafeStorage(),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'custom', name: 'Custom', baseUrl: 'https://old.example/v1', apiKey: 'sk-old', models: [{ id: 'model', name: 'Model' }] }]
  })
  service.updateSettings({
    providers: [{ id: 'custom', name: 'Custom', baseUrl: 'https://new.example/v1', models: [{ id: 'model', name: 'Model' }] }]
  })
  assert.equal(service.getSettings().providers[0].apiKey, '')
})

test('public settings expose credential presence without plaintext values', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: '', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'deepseek', model: 'deepseek-v4-flash' }] }
  }
  const service = new SettingsService({
    store: new MemoryStore(),
    safeStorage: createSafeStorage(),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-provider-key', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }]
  })
  const settings = service.getPublicSettings()
  assert.equal(settings.hasApiKey, true)
  assert.equal(Object.hasOwn(settings, 'apiKey'), false)
  assert.equal(settings.providers[0].hasApiKey, true)
  assert.equal(Object.hasOwn(settings.providers[0], 'apiKey'), false)
  assert.doesNotMatch(JSON.stringify(settings), /sk-provider-key/)
})

test('connection drafts reuse stored keys only for the stored endpoint', () => {
  const providerDefaults = {
    apiKey: '',
    providers: [
      { id: 'custom', name: 'Custom', baseUrl: 'https://api.example/v1', apiKey: '', models: [{ id: 'model', name: 'Model' }] }
    ],
    ai: { assignments: [{ feature: 'chat', providerId: 'custom', model: 'model' }] }
  }
  const service = new SettingsService({
    store: new MemoryStore(),
    safeStorage: createSafeStorage(),
    defaults: providerDefaults
  })
  service.updateSettings({
    providers: [{ id: 'custom', name: 'Custom', baseUrl: 'https://api.example/v1', apiKey: 'sk-stored', models: [{ id: 'model', name: 'Model' }] }]
  })
  assert.equal(service.prepareProviderConnection({ id: 'custom', baseUrl: 'https://api.example/v1/' }).apiKey, 'sk-stored')
  assert.throws(
    () => service.prepareProviderConnection({ id: 'custom', baseUrl: 'https://attacker.example/v1' }),
    /API 地址已更改/
  )
  assert.equal(service.prepareProviderConnection({ id: 'custom', baseUrl: 'https://new.example/v1', apiKey: 'sk-new' }).apiKey, 'sk-new')
})

test('settings service migrates legacy DeepSeek settings into the provider catalog', () => {
  const defaults = {
    apiKey: '',
    providers: createDefaultProviders(),
    ai: {
      schemaVersion: 2,
      maxTokens: 4096,
      temperature: 0.7,
      targetLanguage: '中文',
      assignments: createDefaultAssignments(createDefaultProviders())
    }
  }
  const store = new MemoryStore({
    settings: { apiKey: 'sk-legacy-key', ai: { model: 'legacy-custom-model' } }
  })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(),
    defaults,
    migrateSettings: migrateAiSettings,
    normalizeSettings: normalizeAiSettings
  })
  const settings = service.getSettings()
  assert.equal(settings.providers[0].apiKey, 'sk-legacy-key')
  assert.ok(settings.providers[0].models.some((model) => model.id === 'legacy-custom-model'))
  assert.equal(settings.ai.assignments.find((assignment) => assignment.feature === 'chat').model, 'legacy-custom-model')
  assert.equal(settings.ai.schemaVersion, 2)
  assert.equal(Object.hasOwn(settings.ai, 'providerId'), false)
  assert.equal(Object.hasOwn(settings.ai, 'model'), false)
  assert.equal(store.get('settings').ai.schemaVersion, 2)
})

// ---------------------------------------------------------------------------
// D02 (plan item 04): a value that only reached the session must be the effective one.
// ---------------------------------------------------------------------------

function createProviders(apiKey = 'sk-provider-old') {
  return [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://deepseek.example', models: [], apiKey },
    { id: 'jbb', name: 'JBB', baseUrl: 'https://jbb.example', models: [], apiKey: 'sk-jbb-old' }
  ]
}

const providerDefaults = {
  ...defaults,
  providers: [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://deepseek.example', models: [], apiKey: '' },
    { id: 'jbb', name: 'JBB', baseUrl: 'https://jbb.example', models: [], apiKey: '' }
  ]
}

test('D02 (04): the new key is what callers see after the store refused to overwrite the old one', () => {
  const store = new MemoryStore()
  const safeStorage = createSafeStorage()
  const service = new SettingsService({ store, safeStorage, defaults })
  service.updateSettings({ apiKey: 'sk-old-value' })
  assert.equal(service.getSettings().apiKey, 'sk-old-value')
  // The old ciphertext decrypts fine; only the NEW write fails.
  const realEncrypt = safeStorage.encryptString
  let refuse = true
  safeStorage.encryptString = (value) => {
    if (refuse) throw new Error('DPAPI locked')
    return realEncrypt(value)
  }
  service.updateSettings({ apiKey: 'sk-new-value' })
  assert.equal(service.getSettings().apiKey, 'sk-new-value', 'the effective key must be the one the user just entered')
  assert.equal(service.getPublicSettings().hasApiKey, true)
  // …and the request-building path uses the same value.
  assert.equal(service.prepareProviderConnection({
    id: 'deepseek',
    baseUrl: 'https://deepseek.example',
    apiKey: 'sk-new-value'
  }).apiKey, 'sk-new-value')
  // The session hint says the value is temporary.
  const state = service.getPublicSettings().credentialState
  assert.equal(state.sessionOnly, true)
  assert.deepEqual(state.sessionOverrides.overrides, { master: 'set' })
  // The old ciphertext is still there for a later verified write.
  assert.ok(store.get('credentials.apiKey'))
  // Encryption works again: the next save verifies the new ciphertext and drops the override.
  refuse = false
  service.updateSettings({ compact: true })
  assert.equal(service.getSettings().apiKey, 'sk-new-value')
  assert.deepEqual(service.getPublicSettings().credentialState.sessionOverrides.overrides, {})
  assert.equal(safeStorage.decryptString(Buffer.from(store.get('credentials.apiKey'), 'base64')), 'sk-new-value')
})

test('D02 (04): clearing the key never falls back to the decrypted old value', () => {
  const store = new MemoryStore()
  const safeStorage = createSafeStorage()
  const service = new SettingsService({ store, safeStorage, defaults })
  service.updateSettings({ apiKey: 'sk-old-value' })
  // The delete cannot reach the store this time (a locked/read-only profile).
  const realDelete = store.delete.bind(store)
  let refuseDelete = true
  store.delete = (key) => {
    if (refuseDelete && key === 'credentials.apiKey') return
    realDelete(key)
  }
  const cleared = service.updateSettings({ apiKey: '' }).settings
  assert.equal(cleared.apiKey, '', 'the cleared value is the effective one for this session')
  assert.equal(service.getPublicSettings().hasApiKey, false)
  assert.deepEqual(service.getPublicSettings().credentialState.sessionOverrides.cleared, ['master'])
  // The durable copy is still there (the delete failed), so the user is told to retry.
  assert.ok(store.get('credentials.apiKey'))
  // A successful save deletes it, verifies the deletion and drops the override.
  refuseDelete = false
  service.updateSettings({ compact: true })
  assert.equal(store.get('credentials.apiKey'), undefined)
  assert.equal(service.getSettings().apiKey, '')
  assert.deepEqual(service.getPublicSettings().credentialState.sessionOverrides.overrides, {})
})

test('D02 (04): only the edited provider changes; the others keep their stored keys', () => {
  const store = new MemoryStore()
  const safeStorage = createSafeStorage()
  const service = new SettingsService({ store, safeStorage, defaults: providerDefaults })
  service.updateSettings({ providers: createProviders() })
  const storedBefore = JSON.parse(JSON.stringify(store.get('credentials.providerApiKeys')))
  assert.equal(safeStorage.decryptString(Buffer.from(storedBefore.jbb, 'base64')), 'sk-jbb-old')

  // The user edits only DeepSeek's key.
  const patched = createProviders().map((provider) => (
    provider.id === 'deepseek' ? { ...provider, apiKey: 'sk-deepseek-new' } : { id: provider.id }
  ))
  const result = service.updateSettings({ providers: patched })
  assert.equal(result.settings.providers.find((p) => p.id === 'deepseek').apiKey, 'sk-deepseek-new')
  assert.equal(result.settings.providers.find((p) => p.id === 'jbb').apiKey, 'sk-jbb-old', 'the untouched provider keeps its credential')
  const storedAfter = store.get('credentials.providerApiKeys')
  assert.equal(storedAfter.jbb, storedBefore.jbb, 'the untouched ciphertext is not rewritten')
  assert.equal(safeStorage.decryptString(Buffer.from(storedAfter.deepseek, 'base64')), 'sk-deepseek-new')
})

test('D02 (04): a provider key that failed to persist wins in the same request and never leaks to another endpoint', () => {
  const store = new MemoryStore()
  const safeStorage = createSafeStorage()
  const service = new SettingsService({ store, safeStorage, defaults: providerDefaults })
  service.updateSettings({ providers: createProviders() })
  const realEncrypt = safeStorage.encryptString
  safeStorage.encryptString = () => { throw new Error('DPAPI locked') }
  const patched = createProviders().map((provider) => (
    provider.id === 'deepseek' ? { ...provider, apiKey: 'sk-deepseek-session' } : { id: provider.id }
  ))
  safeStorage.encryptString = realEncrypt
  safeStorage.encryptString = (value) => value === 'sk-deepseek-session' ? (() => { throw new Error('DPAPI locked') })() : realEncrypt(value)
  const result = service.updateSettings({ providers: patched })
  assert.equal(result.settings.providers.find((p) => p.id === 'deepseek').apiKey, 'sk-deepseek-session')
  assert.equal(service.prepareProviderConnection({
    id: 'deepseek',
    baseUrl: 'https://deepseek.example',
    apiKey: 'sk-deepseek-session'
  }).apiKey, 'sk-deepseek-session')
  // The old ciphertext is still in place and is what the store would decrypt…
  assert.ok(store.get('credentials.providerApiKeys').deepseek)
  // …but it does not answer for a provider pointed at another server: the changed address
  // is refused outright instead of silently reusing the old server's credential.
  assert.throws(
    () => service.prepareProviderConnection({ id: 'deepseek', baseUrl: 'https://other.example' }),
    /API 地址已更改|请先填写 API 密钥/
  )
})
