'use strict'

const { createCodingPlanProvider } = require('../services/coding-plan-service')

// Owns the controller wiring as well as the channel, so main.js only assembles
// dependencies (same shape as createOcrIpcController).
function createCodingPlanIpcController({
  settingsService,
  testProviderConnection,
  appVersion = '',
  assertWritable = () => {}
}) {
  return {
    createProvider: (input) => {
      assertWritable()
      return createCodingPlanProvider(input, { settingsService, testProviderConnection, appVersion })
    }
  }
}

function registerCodingPlanIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Coding plan IPC requires ipcMain and controller')
  ipcMain.handle('coding-plan:create-provider', (_event, input) => controller.createProvider(input))
}

module.exports = {
  createCodingPlanIpcController,
  registerCodingPlanIpc
}
