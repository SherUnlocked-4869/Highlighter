function buildTrayMenuTemplate({
  gameMode = false,
  screenshotAccelerator = '',
  hasConversation = false,
  executeFunction,
  setGameModeEnabled,
  openHistory,
  openMainWindow,
  showConversation,
  quit
} = {}) {
  if (typeof executeFunction !== 'function') throw new Error('Tray menu requires executeFunction')
  if (typeof setGameModeEnabled !== 'function') throw new Error('Tray menu requires setGameModeEnabled')
  if (typeof openHistory !== 'function') throw new Error('Tray menu requires openHistory')
  if (typeof openMainWindow !== 'function') throw new Error('Tray menu requires openMainWindow')
  if (typeof showConversation !== 'function') throw new Error('Tray menu requires showConversation')
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
    // An unpinned result window hides as soon as it loses focus, and the only
    // other way to bring it back (a new selection) discards the conversation.
    // Without this entry the preserved turns are unreachable.
    { label: '显示划词对话', visible: hasConversation === true, enabled: featureEnabled, click: showConversation },
    { label: '截图历史', click: openHistory },
    { label: '显示主界面', click: openMainWindow },
    { type: 'separator' },
    { label: '退出', click: quit }
  ]
}

module.exports = { buildTrayMenuTemplate }
