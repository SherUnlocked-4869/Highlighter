function registerDataRootIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Data root IPC requires ipcMain and controller')

  ipcMain.handle('data-root:get', () => controller.get())
  ipcMain.handle('data-root:open', () => controller.open())
  ipcMain.handle('data-root:change', () => controller.change())
  // D04: local backups are created/restored inside the data-root domain (it owns the writer
  // quiesce gate and the locator switch), so the IPC layer only forwards the request.
  ipcMain.handle('data-root:backup-create', (_event, options) => controller.backupCreate(options))
  ipcMain.handle('data-root:backup-inspect', (_event, directory) => controller.backupInspect(directory))
  ipcMain.handle('data-root:backup-restore', (_event, options) => controller.backupRestore(options))
  ipcMain.handle('data-root:backup-delete', (_event, directory) => controller.backupDelete(directory))
}

module.exports = {
  registerDataRootIpc
}
