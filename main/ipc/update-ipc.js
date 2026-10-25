'use strict'

// Owns the controller wiring as well as the channels, so main.js only assembles
// dependencies (same shape as createCodingPlanIpcController / createHistoryPdfController).
//
// `getUpdateService` is a provider, not a value: main.js creates the updater
// lazily (electron-updater is only required for a real NSIS install), so building
// the controller must not force that construction.
function createUpdateIpcController({ getUpdateService } = {}) {
  if (typeof getUpdateService !== 'function') throw new TypeError('Update IPC controller requires getUpdateService')
  const service = () => getUpdateService()
  return {
    getStatus: () => service().getStatus(),
    check: (options) => service().check(options),
    download: () => service().download(),
    install: () => service().install(),
    openDownloadPage: () => service().openDownloadPage()
  }
}

function registerUpdateIpc({ ipcMain, updateService }) {
  if (!ipcMain?.handle || !updateService) throw new TypeError('Update IPC requires ipcMain and update service')
  ipcMain.handle('update:status', () => updateService.getStatus())
  ipcMain.handle('update:check', () => updateService.check({ manual: true }))
  ipcMain.handle('update:download', () => updateService.download())
  ipcMain.handle('update:install', () => updateService.install())
  ipcMain.handle('update:open-download-page', () => updateService.openDownloadPage())
}

module.exports = { createUpdateIpcController, registerUpdateIpc }
