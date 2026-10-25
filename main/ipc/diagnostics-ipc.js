'use strict'

const { t } = require('../services/i18n-bootstrap')

// Owns the controller wiring as well as the channels, so main.js only assembles
// dependencies (same shape as createCodingPlanIpcController / createHistoryPdfController).
//
// Every collaborator is injected and resolved lazily: `getDiagnosticsService` and
// `getMainWindow` are providers because the service is built during startup and
// the window may have been closed (or not created yet) when a request arrives.
// `dialog`, `app` and `path` are passed in rather than required, so this module
// never imports Electron at module scope and stays unit-testable.
//
// Copy rule (check-i18n): the save dialog's user-visible strings come from the
// locale tables, never from a literal here.
function createDiagnosticsIpcController({
  getDiagnosticsService,
  getMainWindow = () => null,
  dialog,
  app,
  path
} = {}) {
  if (typeof getDiagnosticsService !== 'function') throw new TypeError('Diagnostics IPC controller requires getDiagnosticsService')
  if (!dialog || typeof dialog.showSaveDialog !== 'function') throw new TypeError('Diagnostics IPC controller requires a dialog')
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Diagnostics IPC controller requires app')
  if (!path || typeof path.join !== 'function') throw new TypeError('Diagnostics IPC controller requires path')

  const requireService = () => {
    const service = getDiagnosticsService()
    if (!service) throw new Error('诊断服务尚未就绪')
    return service
  }

  return {
    preview: () => requireService().preview(),
    export: async ({ includeCrashDumps = false } = {}) => {
      const service = requireService()
      const date = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(getMainWindow(), {
        title: t('main.diagnostics.export-title'),
        defaultPath: path.join(app.getPath('documents'), `Highlighter-Diagnostics-${date}.zip`),
        filters: [{ name: t('main.diagnostics.export-filter'), extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      const exported = await service.exportZip(result.filePath, { includeCrashDumps })
      return { canceled: false, ...exported }
    }
  }
}

function registerDiagnosticsIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Diagnostics IPC requires ipcMain and controller')

  ipcMain.handle('diagnostics:preview', () => controller.preview())
  ipcMain.handle('diagnostics:export', (_event, options = {}) => controller.export({
    includeCrashDumps: options?.includeCrashDumps === true
  }))
}

module.exports = { createDiagnosticsIpcController, registerDiagnosticsIpc }
