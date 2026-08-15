const test = require('node:test')
const assert = require('node:assert/strict')
const { SettingsService, mergeSettings } = require('../main/services/settings-service')
const { createDefaultAssignments, createDefaultProviders, normalizeAiSettings } = require('../main/services/ai-providers')

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

test('settings service preserves plaintext fallback without system encryption', () => {
  const store = new MemoryStore({ settings: { apiKey: 'sk-fallback', theme: 'dark' } })
  const service = new SettingsService({
    store,
    safeStorage: createSafeStorage(false),
    defaults
  })
  service.updateSettings({ compact: true })
  assert.equal(store.get('settings').apiKey, 'sk-fallback')
  assert.equal(service.getSettings().apiKey, 'sk-fallback')
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

test('settings service migrates legacy DeepSeek settings into the provider catalog', () => {
  const defaults = {
    apiKey: '',
    providers: createDefaultProviders(),
    ai: {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
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
    normalizeSettings: normalizeAiSettings
  })
  const settings = service.getSettings()
  assert.equal(settings.providers[0].apiKey, 'sk-legacy-key')
  assert.ok(settings.providers[0].models.some((model) => model.id === 'legacy-custom-model'))
  assert.equal(settings.ai.assignments.find((assignment) => assignment.feature === 'chat').model, 'legacy-custom-model')
})
