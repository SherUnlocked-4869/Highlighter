function registerShortcutIpc({ ipcMain, shortcutService }) {
  if (!ipcMain || !shortcutService) {
    throw new Error('Shortcut IPC requires ipcMain and shortcutService')
  }

  ipcMain.handle('shortcuts:status', () => shortcutService.getStatuses())
}

module.exports = {
  registerShortcutIpc
}
