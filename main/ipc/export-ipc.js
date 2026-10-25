// Export result actions IPC (feature A, plan §4.2).
//
// deps signature (stable; main.js wires this object):
//   ipcMain       the secure ipcMain wrapper (or a plain fake in tests)
//   controller    { performAction(event, payload) -> { status:'done' } | { status:'failed', code } }
//
// Exactly one invoke channel: a renderer result bar addresses a registered export by `resultId`
// and action ('open' | 'copy-path' | 'reveal'); it never passes a path. The controller must derive
// the caller's owner id from the sending window and pass it to the service - the service can only
// compare owner ids, not authenticate a sender.

function registerExportIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Export IPC requires ipcMain and controller')

  ipcMain.handle('export:perform-action', (event, payload) => controller.performAction(event, payload))
}

module.exports = {
  registerExportIpc
}
