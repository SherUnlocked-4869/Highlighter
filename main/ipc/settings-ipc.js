function registerSettingsIpc({
  ipcMain,
  settingsService,
  assertWritable,
  onSettingsUpdated = () => {},
  onSettingsReset = () => {},
  onStartHook = () => {},
  validateApiKey,
  log = () => {}
}) {
  if (!ipcMain || !settingsService) throw new Error('Settings IPC requires ipcMain and settingsService')

  ipcMain.handle('settings:get', () => settingsService.getSettings())
  ipcMain.handle('settings:update', (_event, patch) => {
    assertWritable()
    const result = settingsService.updateSettings(patch)
    onSettingsUpdated(result.patch, result.settings)
    return result.settings
  })
  ipcMain.handle('settings:reset', () => {
    assertWritable()
    const settings = settingsService.resetSettings()
    onSettingsReset(settings)
    return settings
  })
  ipcMain.handle('config:get-api-key', () => settingsService.getSettings().apiKey)
  ipcMain.handle('config:save-api-key', (_event, apiKey) => {
    assertWritable()
    return settingsService.setApiKey(apiKey)
  })
  ipcMain.handle('config:test-connection', (_event, input) => {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : settingsService.normalizeApiKey(input)
    return validateApiKey(value)
  })
  ipcMain.on('config:start-hook', (_event, apiKey) => {
    try {
      assertWritable()
      settingsService.setApiKey(apiKey)
      onStartHook()
    } catch (error) {
      log('Rejected selection hook configuration:', error)
    }
  })
}

module.exports = {
  registerSettingsIpc
}
