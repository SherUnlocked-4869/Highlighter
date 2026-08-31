function registerSearchIpc({ ipcMain, controller }) {
  if (!ipcMain || !controller) throw new Error('Search IPC requires ipcMain and controller')

  ipcMain.handle('search:query', (event, payload) => controller.query(event, payload))
  ipcMain.handle('search:status', (event) => controller.getStatus(event))
  ipcMain.handle('search:ensure-ready', (event) => controller.ensureReady(event))
  ipcMain.handle('search:open-path', (event, payload) => controller.openPath(event, payload))
  ipcMain.handle('search:reveal-path', (event, payload) => controller.revealPath(event, payload))
  ipcMain.handle('search:copy-path', (event, payload) => controller.copyPath(event, payload))
  ipcMain.handle('search:file-icon', (event, payload) => controller.getFileIcon(event, payload))
  ipcMain.on('search:ready', (event) => controller.ready(event))
  ipcMain.on('search:close', (event) => controller.close(event))
}

module.exports = {
  registerSearchIpc
}
