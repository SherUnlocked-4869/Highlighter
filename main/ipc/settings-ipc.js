// `preparePatch` is the host's veto/apply hook for settings whose runtime side effect has to
// succeed BEFORE the store changes (A03: shortcut rebinding). It may throw to reject the patch,
// and may return an undo function that runs when the store write itself fails, so the runtime
// never ends up with a binding set the persisted settings do not describe.
function registerSettingsIpc({
  ipcMain,
  settingsService,
  assertWritable,
  onSettingsUpdated = () => {},
  onSettingsReset = () => {},
  preparePatch = null,
  validateApiKey
}) {
  if (!ipcMain || !settingsService) throw new Error('Settings IPC requires ipcMain and settingsService')

  ipcMain.handle('settings:get', () => settingsService.getPublicSettings())
  ipcMain.handle('settings:update', (_event, patch) => {
    assertWritable()
    const undo = typeof preparePatch === 'function' ? preparePatch(patch) : null
    let result
    try {
      result = settingsService.updateSettings(patch)
    } catch (error) {
      try { undo?.() } catch {}
      throw error
    }
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
