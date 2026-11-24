const test = require('node:test')
const assert = require('node:assert/strict')
const { registerSettingsIpc } = require('../main/ipc/settings-ipc')

function createIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers,
    listeners,
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, listener) => listeners.set(channel, listener)
  }
}

function createSettingsService() {
  const redact = (settings) => {
    const result = { ...settings, hasApiKey: !!settings.apiKey }
    delete result.apiKey
    return result
  }
  return {
    getSettings: () => ({ apiKey: 'secret', theme: 'system' }),
    getPublicSettings: (settings = { apiKey: 'secret', theme: 'system' }) => redact(settings),
    updateSettings: (patch) => ({ patch, settings: { apiKey: 'secret', ...patch } }),
    resetSettings: () => ({ apiKey: '', theme: 'system' }),
    prepareProviderConnection: (provider) => ({ ...provider, apiKey: provider.apiKey || 'stored-secret' })
  }
}

test('settings IPC registers the complete settings and credential surface', () => {
  const ipcMain = createIpcMain()
  registerSettingsIpc({
    ipcMain,
    settingsService: createSettingsService(),
    assertWritable() {},
    validateApiKey: async () => true
  })
  assert.deepEqual([...ipcMain.handlers.keys()], [
    'settings:get',
    'settings:update',
    'settings:reset',
    'config:test-connection'
  ])
  assert.deepEqual([...ipcMain.listeners.keys()], [])
})

test('settings IPC applies side effects only after a validated update', () => {
  const ipcMain = createIpcMain()
  const updates = []
  let writableChecks = 0
  registerSettingsIpc({
    ipcMain,
    settingsService: createSettingsService(),
    assertWritable: () => { writableChecks++ },
    onSettingsUpdated: (patch, settings) => updates.push({ patch, settings }),
    validateApiKey: async () => true
  })
  const settings = ipcMain.handlers.get('settings:update')(null, { theme: 'dark' })
  assert.equal(writableChecks, 1)
  assert.equal(settings.theme, 'dark')
  assert.equal(settings.hasApiKey, true)
  assert.equal(Object.hasOwn(settings, 'apiKey'), false)
  assert.deepEqual(updates, [{ patch: { theme: 'dark' }, settings: { apiKey: 'secret', theme: 'dark' } }])
})


test('A03: a shortcut patch is proven before the store changes, and undone if the write fails', () => {
  const ipcMain = createIpcMain()
  let updates = 0
  const service = createSettingsService()
  service.updateSettings = () => { updates++; return { patch: {}, settings: {} } }
  registerSettingsIpc({
    ipcMain,
    settingsService: service,
    assertWritable() {},
    preparePatch: () => { throw new Error('该组合不可用（已被占用），原键 F1 仍然有效') },
    validateApiKey: async () => true
  })
  assert.throws(() => ipcMain.handlers.get('settings:update')(null, { shortcuts: { screenshot: 'F2' } }), /原键 F1/)
  assert.equal(updates, 0, 'a rejected rebind must not reach the store')
})

test('A03: a failed settings write runs the runtime undo', () => {
  const ipcMain = createIpcMain()
  let undone = 0
  const service = createSettingsService()
  service.updateSettings = () => { throw new Error('disk full') }
  registerSettingsIpc({
    ipcMain,
    settingsService: service,
    assertWritable() {},
    preparePatch: () => () => { undone++ },
    validateApiKey: async () => true
  })
  assert.throws(() => ipcMain.handlers.get('settings:update')(null, { shortcuts: { screenshot: 'F2' } }), /disk full/)
  assert.equal(undone, 1, 'the previous registration is restored')
})

test('A03: a non-shortcut patch never calls the runtime hook', () => {
  const ipcMain = createIpcMain()
  let prepared = 0
  registerSettingsIpc({
    ipcMain,
    settingsService: createSettingsService(),
    assertWritable() {},
    preparePatch: (patch) => { if (patch.shortcuts) prepared++; return null },
    validateApiKey: async () => true
  })
  ipcMain.handlers.get('settings:update')(null, { theme: 'light' })
  assert.equal(prepared, 0)
})

test('settings IPC blocks writes during migration', () => {
  const ipcMain = createIpcMain()
  let updated = false
  const service = createSettingsService()
  service.updateSettings = () => { updated = true }
  registerSettingsIpc({
    ipcMain,
    settingsService: service,
    assertWritable: () => { throw new Error('blocked') },
    validateApiKey: async () => true
  })
  assert.throws(() => ipcMain.handlers.get('settings:update')(null, {}), /blocked/)
  assert.equal(updated, false)
})

test('settings IPC never returns plaintext credentials', () => {
  const ipcMain = createIpcMain()
  registerSettingsIpc({
    ipcMain,
    settingsService: createSettingsService(),
    assertWritable() {},
    validateApiKey: async () => true
  })
  const settings = ipcMain.handlers.get('settings:get')()
  assert.equal(settings.hasApiKey, true)
  assert.equal(Object.hasOwn(settings, 'apiKey'), false)
})

test('config test-connection passes provider payloads through without string normalization', async () => {
  const ipcMain = createIpcMain()
  const service = createSettingsService()
  const seen = []
  registerSettingsIpc({
    ipcMain,
    settingsService: service,
    assertWritable() {},
    validateApiKey: async (value) => { seen.push(value); return { ok: true } }
  })
  const provider = { id: 'jbb', baseUrl: 'https://example.com/v1' }
  await ipcMain.handlers.get('config:test-connection')(null, { provider, fetchModels: true })
  assert.deepEqual(seen, [{ provider: { ...provider, apiKey: 'stored-secret' }, fetchModels: true }])
  await ipcMain.handlers.get('config:test-connection')(null, 'sk-legacy')
  assert.equal(seen[1], 'sk-legacy')
})
