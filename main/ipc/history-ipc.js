function registerHistoryIpc({
  ipcMain,
  historyService,
  copyItem,
  copyPathItem,
  editItem,
  openItem,
  chooseExportDirectory
}) {
  if (!ipcMain || !historyService) throw new Error('History IPC requires ipcMain and historyService')

  ipcMain.handle('history:list', (_event, filter) => historyService.list(filter))
  ipcMain.handle('history:thumbnail', (_event, id) => historyService.getThumbnail(id))
  ipcMain.handle('history:sources', () => historyService.listSources())
  ipcMain.handle('history:stats', () => historyService.stats())
  ipcMain.handle('history:delete', (_event, id) => historyService.delete(id))
  ipcMain.handle('history:delete-many', (_event, ids) => historyService.deleteMany(ids))
  ipcMain.handle('history:clear', () => historyService.clear())
  ipcMain.handle('history:cleanup', () => historyService.cleanup())
  ipcMain.handle('history:export', async (_event, ids) => {
    const directory = await chooseExportDirectory()
    return directory ? historyService.exportMany(ids, directory) : { canceled: true }
  })
  ipcMain.handle('history:copy', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? copyItem(item) : false
  })
  ipcMain.handle('history:edit', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? editItem(item) : false
  })
  ipcMain.handle('history:open', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? openItem(item) : false
  })
  ipcMain.handle('history:copy-path', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? copyPathItem(item) : false
  })
}

module.exports = {
  registerHistoryIpc
}
