function registerHistoryIpc({
  ipcMain,
  historyService,
  copyItem,
  editItem,
  revealItem
}) {
  if (!ipcMain || !historyService) throw new Error('History IPC requires ipcMain and historyService')

  ipcMain.handle('history:list', (_event, filter) => historyService.list(filter))
  ipcMain.handle('history:sources', () => historyService.listSources())
  ipcMain.handle('history:delete', (_event, id) => historyService.delete(id))
  ipcMain.handle('history:clear', () => historyService.clear())
  ipcMain.handle('history:favorite', (_event, { id, favorite } = {}) => (
    historyService.setFavorite(id, favorite)
  ))
  ipcMain.handle('history:copy', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? copyItem(item) : false
  })
  ipcMain.handle('history:edit', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? editItem(item) : false
  })
  ipcMain.handle('history:reveal', (_event, id) => {
    const item = historyService.getItem(id)
    return item ? revealItem(item) : false
  })
}

module.exports = {
  registerHistoryIpc
}
