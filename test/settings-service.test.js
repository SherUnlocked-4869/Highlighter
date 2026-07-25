const test = require('node:test')
const assert = require('node:assert/strict')
const { SettingsService, mergeSettings } = require('../main/services/settings-service')

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
