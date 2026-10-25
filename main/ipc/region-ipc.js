// Region reuse + size preset IPC registration (feature B, plan §5.2).
//
// deps signature (stable; main.js wires this object):
//   ipcMain     the secure ipcMain wrapper (or a plain fake in tests)
//   controller  main/ipc/region-ipc-controller.js -> createRegionController(...)
//
// Four invoke channels, all declared for the `capture` role in main/services/ipc-security.js.
// There is deliberately no `region:record-last` channel: the remembered region is a
// domain-internal write (plan §5.2), so nothing here accepts a desktop rectangle.

function registerRegionIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Region IPC requires ipcMain and controller')

  ipcMain.handle('region:get-preferences', (event, payload) => controller.getPreferences(event, payload))
  ipcMain.handle('region:resolve', (event, payload) => controller.resolve(event, payload))
  ipcMain.handle('region:save-preset', (event, payload) => controller.savePreset(event, payload))
  ipcMain.handle('region:delete-preset', (event, payload) => controller.deletePreset(event, payload))
}

module.exports = {
  registerRegionIpc
}
