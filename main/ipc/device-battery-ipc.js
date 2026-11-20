'use strict'

function registerDeviceBatteryIpc({ ipcMain, getSnapshot, refresh }) {
  ipcMain.handle('device-battery:snapshot', (_event, ...args) => {
    if (args.length) throw new TypeError('Unexpected device battery arguments')
    return getSnapshot()
  })
  ipcMain.handle('device-battery:refresh', (_event, ...args) => {
    if (args.length) throw new TypeError('Unexpected device battery arguments')
    return refresh()
  })
}

module.exports = { registerDeviceBatteryIpc }
