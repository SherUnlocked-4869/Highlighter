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
  return {
    getSettings: () => ({ apiKey: 'secret', theme: 'system' }),
    updateSettings: (patch) => ({ patch, settings: { apiKey: 'secret', ...patch } }),
    resetSettings: () => ({ apiKey: '', theme: 'system' }),
    normalizeApiKey: (value) => String(value || '').trim(),
    setApiKey: () => true
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
    'config:get-api-key',
    'config:save-api-key',
    'config:test-connection'
  ])
  assert.deepEqual([...ipcMain.listeners.keys()], ['config:start-hook'])
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
  assert.deepEqual(updates, [{ patch: { theme: 'dark' }, settings }])
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

test('start-hook failures are logged without applying the hook', () => {
  const ipcMain = createIpcMain()
  const messages = []
  let started = false
  registerSettingsIpc({
    ipcMain,
    settingsService: createSettingsService(),
    assertWritable: () => { throw new Error('blocked') },
    onStartHook: () => { started = true },
    validateApiKey: async () => true,
    log: (...values) => messages.push(values)
  })
  ipcMain.listeners.get('config:start-hook')(null, 'sk-value')
  assert.equal(started, false)
  assert.match(messages[0][0], /Rejected selection hook/)
})
