function registerUpdateIpc({ ipcMain, updateService }) {
  if (!ipcMain?.handle || !updateService) throw new TypeError('Update IPC requires ipcMain and update service')
  ipcMain.handle('update:status', () => updateService.getStatus())
  ipcMain.handle('update:check', () => updateService.check({ manual: true }))
  ipcMain.handle('update:download', () => updateService.download())
  ipcMain.handle('update:install', () => updateService.install())
  ipcMain.handle('update:open-download-page', () => updateService.openDownloadPage())
}

module.exports = { registerUpdateIpc }
