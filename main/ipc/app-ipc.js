function registerAppIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('App IPC requires ipcMain and controller')

  ipcMain.handle('shell:open-external', (_event, value) => controller.openExternal(value))
  ipcMain.handle('app:execute-function', (_event, { name, payload } = {}) => controller.executeFunction(name, payload))
  ipcMain.handle('app:get-info', () => controller.getInfo())
  ipcMain.handle('app:get-display-diagnostics', () => controller.getDisplayDiagnostics())
  ipcMain.handle('dialog:choose-directory', () => controller.chooseDirectory())
  ipcMain.handle('app:open-data-directory', () => controller.openDataDirectory())
  ipcMain.handle('app:open-save-directory', () => controller.openSaveDirectory())
  ipcMain.handle('ai:complete', (_event, { messages, options } = {}) => controller.completeAi(messages, options))
  ipcMain.handle('ai:translate', (_event, { text, sourceLanguage, targetLanguage } = {}) => (
    controller.translateText(text, sourceLanguage, targetLanguage)
  ))
}

module.exports = {
  registerAppIpc
}
