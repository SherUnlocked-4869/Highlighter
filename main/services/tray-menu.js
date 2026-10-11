// P0-1-T6: the labels are user-visible UI copy, so they resolve through the
// shared runtime instead of being hard-coded. The template is rebuilt from
// scratch on every language change (the caller re-runs createTrayIcon), so a
// `t()` call at build time is enough — no re-translation pass is needed.
const { t } = require('./i18n-bootstrap')

function buildTrayMenuTemplate({
  gameMode = false,
  screenshotAccelerator = '',
  hasConversation = false,
  executeFunction,
  setGameModeEnabled,
  openHistory,
  openMainWindow,
  showConversation,
  exitClickThrough,
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
  // P0-6-T4: a click-through pin has no keyboard focus, so this entry is the
  // mandatory way out (the global shortcut is suspended in game mode, and the
  // router refuses every feature while game mode is on — see
  // assertGameModeDisabled). It therefore stays enabled in game mode, like the
  // other recovery entries below, and prefers a direct domain call when the
  // host injects one.
  const exitAllClickThrough = typeof exitClickThrough === 'function'
    ? exitClickThrough
    : run('togglePinClickThrough')

  return [
    { label: t('main.tray.screenshot'), accelerator: screenshotAccelerator || undefined, enabled: featureEnabled, click: run('screenshot') },
    { label: t('main.tray.screenshot-full-screen'), enabled: featureEnabled, click: run('screenshotFullScreen') },
    { label: t('main.tray.screenshot-focused-window'), enabled: featureEnabled, click: run('screenshotFocusedWindow') },
    { label: t('main.tray.pin-image'), enabled: featureEnabled, click: run('fixedContent') },
    { label: t('main.tray.video-record'), enabled: featureEnabled, click: run('videoRecord') },
    { label: t('main.tray.local-search'), enabled: featureEnabled, click: run('localSearch') },
    { type: 'separator' },
    {
      label: t('main.tray.game-mode'),
      type: 'checkbox',
      checked: gameMode === true,
      click: () => setGameModeEnabled(gameMode !== true)
    },
    { type: 'separator' },
    // A click-through pin cannot be reached by clicking it, so the bulk exit
    // lives with the always-available entries rather than the pin actions.
    { label: t('main.tray.exit-all-click-through'), enabled: true, click: exitAllClickThrough },
    // An unpinned result window hides as soon as it loses focus, and the only
    // other way to bring it back (a new selection) discards the conversation.
    // Without this entry the preserved turns are unreachable.
    { label: t('main.tray.show-selection-chat'), visible: hasConversation === true, enabled: featureEnabled, click: showConversation },
    { label: t('main.tray.capture-history'), click: openHistory },
    { label: t('main.tray.show-main-window'), click: openMainWindow },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: quit }
  ]
}

module.exports = { buildTrayMenuTemplate }
