function buildTrayMenuTemplate({
  gameMode = false,
  screenshotAccelerator = '',
  executeFunction,
  setGameModeEnabled,
  openHistory,
  openMainWindow,
  quit
} = {}) {
  if (typeof executeFunction !== 'function') throw new Error('Tray menu requires executeFunction')
  if (typeof setGameModeEnabled !== 'function') throw new Error('Tray menu requires setGameModeEnabled')
  if (typeof openHistory !== 'function') throw new Error('Tray menu requires openHistory')
  if (typeof openMainWindow !== 'function') throw new Error('Tray menu requires openMainWindow')
  if (typeof quit !== 'function') throw new Error('Tray menu requires quit')

  const featureEnabled = gameMode !== true
  const run = (name) => () => executeFunction(name)

  return [
    { label: '截图', accelerator: screenshotAccelerator || undefined, enabled: featureEnabled, click: run('screenshot') },
    { label: '截取全屏', enabled: featureEnabled, click: run('screenshotFullScreen') },
    { label: '截取焦点窗口', enabled: featureEnabled, click: run('screenshotFocusedWindow') },
    { label: '固定图片到屏幕', enabled: featureEnabled, click: run('fixedContent') },
    { label: '视频录制', enabled: featureEnabled, click: run('videoRecord') },
    { label: '本地搜索', enabled: featureEnabled, click: run('localSearch') },
    { type: 'separator' },
    {
      label: '游戏模式',
      type: 'checkbox',
      checked: gameMode === true,
      click: () => setGameModeEnabled(gameMode !== true)
    },
    { type: 'separator' },
    { label: '截图历史', click: openHistory },
    { label: '显示主界面', click: openMainWindow },
    { type: 'separator' },
    { label: '退出', click: quit }
  ]
}

module.exports = { buildTrayMenuTemplate }
