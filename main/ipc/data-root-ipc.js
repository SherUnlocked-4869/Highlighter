function registerDataRootIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Data root IPC requires ipcMain and controller')

  ipcMain.handle('data-root:get', () => controller.get())
  ipcMain.handle('data-root:open', () => controller.open())
  ipcMain.handle('data-root:change', () => controller.change())
}

module.exports = {
  registerDataRootIpc
}
