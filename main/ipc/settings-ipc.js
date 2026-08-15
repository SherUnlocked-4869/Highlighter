function registerSettingsIpc({
  ipcMain,
  settingsService,
  assertWritable,
  onSettingsUpdated = () => {},
  onSettingsReset = () => {},
  validateApiKey
}) {
  if (!ipcMain || !settingsService) throw new Error('Settings IPC requires ipcMain and settingsService')

  ipcMain.handle('settings:get', () => settingsService.getPublicSettings())
  ipcMain.handle('settings:update', (_event, patch) => {
    assertWritable()
    const result = settingsService.updateSettings(patch)
    onSettingsUpdated(result.patch, result.settings)
    return settingsService.getPublicSettings(result.settings)
  })
  ipcMain.handle('settings:reset', () => {
    assertWritable()
    const settings = settingsService.resetSettings()
    onSettingsReset(settings)
    return settingsService.getPublicSettings(settings)
  })
  ipcMain.handle('config:test-connection', (_event, input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return validateApiKey(input)
    if (input.provider) {
      return validateApiKey({ ...input, provider: settingsService.prepareProviderConnection(input.provider) })
    }
    return validateApiKey(settingsService.prepareProviderConnection(input))
  })
}

module.exports = {
  registerSettingsIpc
}
