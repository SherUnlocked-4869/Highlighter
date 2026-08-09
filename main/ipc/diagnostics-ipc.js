function registerDiagnosticsIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Diagnostics IPC requires ipcMain and controller')

  ipcMain.handle('diagnostics:preview', () => controller.preview())
  ipcMain.handle('diagnostics:export', (_event, options = {}) => controller.export({
    includeCrashDumps: options?.includeCrashDumps === true
  }))
}

module.exports = { registerDiagnosticsIpc }
