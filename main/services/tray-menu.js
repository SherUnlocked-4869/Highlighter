// A06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the tray is a
// two-level menu. The top level keeps the tasks a user reaches for without thinking -
// region capture, the recording workbench, clipboard history, the main window and quit -
// plus the live-capture safety entries. The long tail (the other capture modes and the
// low-frequency tools) moved into two submenus, so a first-run user faces five rows
// instead of a flat list of eleven.
//
// The labels are user-visible UI copy, so they resolve through the shared runtime instead
// of being hard-coded. The template is rebuilt from scratch on every language change (the
// caller re-runs createTrayIcon), so a `t()` call at build time is enough - no
// re-translation pass is needed.
const { t } = require('./i18n-bootstrap')

function buildTrayMenuTemplate({
  gameMode = false,
  clipboardEnabled = false,
  screenshotAccelerator = '',
  hasConversation = false,
  // { running, busy } for the Index-Translate proxy bridge, or null when the
  // host does not own it. Deliberately optional: every existing caller and test
  // builds the template without it, so a required dependency would throw where
  // exitClickThrough below degrades instead. The entry disappears rather than
  // rendering an unusable toggle.
  translationProxy = null,
  setTranslationProxyEnabled,
  // Feature A (plan §4.1): the newest live export receipt `{ resultId, fileName, kind }`, or null.
  // Optional so every existing caller/test keeps building the template without it; the entry simply
  // does not appear when there is nothing to open.
  recentExport = null,
  openRecentExport = null,
  // R2 (docs/plans/2026-11-03-recording-r1-r3-contracts.md §4.1/§4.2): the recording workbench entry
  // and, while a capture is active, the live pause/finish entries. `recording` is
  // `{ active, openWorkbench?, pauseResume?, finish? }` or null (the default for every caller that
  // has no recording domain). Handlers are optional: the entries fall back to `executeFunction`
  // names, which is the same arbitration the control bar buttons use.
  recording = null,
  // A06: route-aware opener for the clipboard settings page. Optional for the same reason the
  // other handlers are: a host that has not wired `createMainWindow('clipboard-history')` yet must
  // still build the menu. Without it the entry opens the main window, whose navigation owns the
  // page - one click more, never a dead item.
  openClipboardSettings = null,
  // A07: the pin domain's per-display pin finder payload:
  // `{ displays: [{ label, pins: [{ id, index, bounds, alwaysOnTop, clickThrough }] }], actions }`.
  // Optional like every other host capability, and the entry only exists while a pin does,
  // so the A06 two-level shape (and every existing caller/test) is unchanged without it.
  pinnedDisplays = null,
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
  // router refuses every feature while game mode is on - see
  // assertGameModeDisabled). It therefore stays enabled in game mode, like the
  // other recovery entries below, and prefers a direct domain call when the
  // host injects one.
  const exitAllClickThrough = typeof exitClickThrough === 'function'
    ? exitClickThrough
    : run('togglePinClickThrough')

  // The proxy bridge is a local HTTP service, not a screen surface, so it is
  // deliberately NOT gated by game mode: a running game is no reason to lose the
  // translation bridge, and toggling it cannot interfere with one.
  const proxyEntry = translationProxy && typeof setTranslationProxyEnabled === 'function'
    ? {
        label: t('main.tray.translation-proxy'),
        type: 'checkbox',
        checked: translationProxy.running === true,
        // While a start/stop is in flight the entry is disabled: a second click
        // cannot be told apart from the first, and the template is a snapshot that
        // main.js rebuilds once the service reports its new state.
        enabled: translationProxy.busy !== true,
        click: () => setTranslationProxyEnabled(translationProxy.running !== true)
      }
    : null

  // R2: the live recording entries. They exist only while a capture is running.
  const recordingInfo = recording && typeof recording === 'object' ? recording : null
  const activeRecording = recordingInfo?.active && typeof recordingInfo.active === 'object' ? recordingInfo.active : null
  // A01 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a live capture
  // always has a way out. Game mode suspends the summon entries and the global hotkeys,
  // and the control bar can be covered by a fullscreen game, so these two entries stay
  // enabled regardless of `featureEnabled` and sit at the very top of the menu (A06): a
  // recording in progress outranks every summon action in the list. `finish` is the first
  // entry (the safe exit), `pause/resume` the second, exactly like the control bar.
  // `finishActive()` keeps its own session-state check, so a stale menu cannot seal twice.
  // Starting a NEW capture still obeys game mode (the workbench entry stays gated).
  const liveRecordingEntries = activeRecording && (activeRecording.status === 'recording' || activeRecording.status === 'paused')
    ? [
        {
          label: t('main.tray.recording-finish'),
          enabled: true,
          click: typeof recordingInfo.finish === 'function' ? recordingInfo.finish : run('recordFinish')
        },
        {
          label: activeRecording.status === 'paused' ? t('main.tray.recording-resume') : t('main.tray.recording-pause'),
          enabled: true,
          click: typeof recordingInfo.pauseResume === 'function' ? recordingInfo.pauseResume : run('recordPauseResume')
        },
        { type: 'separator' }
      ]
    : []

  // A06: with the clipboard feature off the entry stays visible - hiding it read as a
  // missing feature - but it cannot open a window the domain refused to create. Electron's
  // `sublabel` and `toolTip` are both macOS-only MenuItem fields (electron.d.ts marks them
  // `@platform darwin`), so on Windows the hint has to travel in the label itself; the
  // dedicated settings entry directly below is the second half of the same signpost.
  const clipboardEntry = clipboardEnabled === true
    ? { label: t('clipboard.title'), enabled: featureEnabled, click: run('openClipboardHistory') }
    : { label: t('main.tray.clipboard-disabled'), enabled: false, click: run('openClipboardHistory') }
  const clipboardSettingsEntry = {
    label: t('main.tray.open-clipboard-settings'),
    click: typeof openClipboardSettings === 'function' ? openClipboardSettings : openMainWindow
  }

  // A07: pinned images > display > pin > locate / un-top / exit click-through. The display group names
  // arrive already localized (services/pin-geometry.js displayLabel()); this layer owns the
  // action copy and the same fallback arbitration as recording/proxy: a direct domain call
  // when the host injects one, otherwise the router name through executeFunction.
  const pinGroups = pinnedDisplays && Array.isArray(pinnedDisplays.displays)
    ? pinnedDisplays.displays.filter((group) => group && Array.isArray(group.pins) && group.pins.length > 0)
    : []
  const pinActions = pinnedDisplays && pinnedDisplays.actions && typeof pinnedDisplays.actions === 'object'
    ? pinnedDisplays.actions
    : {}
  const pinClick = (name, ...args) => () => {
    const handler = pinActions[name]
    return typeof handler === 'function' ? handler(...args) : run(name)()
  }
  const pinItemLabel = (pin) => {
    const index = Math.max(0, Math.round(Number(pin?.index) || 0))
    const width = Math.max(0, Math.round(Number(pin?.bounds?.width) || 0))
    const height = Math.max(0, Math.round(Number(pin?.bounds?.height) || 0))
    // Click-through is the one state a user cannot discover by clicking the window:
    // the label has to carry it, because the label is the only way back to that pin.
    return pin?.clickThrough === true
      ? t('main.tray.pin-item-click-through', { index, width, height })
      : t('main.tray.pin-item', { index, width, height })
  }
  const pinCount = pinGroups.reduce((total, group) => total + group.pins.length, 0)
  const pinnedDisplaysEntry = pinGroups.length
    ? {
        label: t('main.tray.pinned-displays', { count: pinCount }),
        // Window management, not a capture summon: like the tools submenu this stays
        // usable in game mode, where a click-through pin has no other way out.
        enabled: true,
        submenu: pinGroups.map((group) => ({
          label: typeof group.label === 'string' && group.label
            ? group.label
            : t('main.tray.pinned-displays', { count: group.pins.length }),
          submenu: group.pins.map((pin) => ({
            label: pinItemLabel(pin),
            submenu: [
              { label: t('main.tray.pin-focus'), click: pinClick('focusPin', pin.id) },
              {
                // The item states the value it wants, so a stale menu snapshot cannot
                // flip a pin that was just toggled somewhere else.
                label: pin?.alwaysOnTop === false
                  ? t('main.tray.pin-always-on-top-on')
                  : t('main.tray.pin-always-on-top-off'),
                click: pinClick('togglePinAlwaysOnTop', pin.id, pin?.alwaysOnTop === false)
              },
              {
                label: t('main.tray.pin-exit-click-through'),
                // Nothing to exit for an opaque pin; disabling the item says so.
                enabled: pin?.clickThrough === true,
                click: pinClick('exitPinClickThrough', pin.id)
              }
            ]
          }))
        }))
      }
    : null

  // A06: the other capture modes. All of them summon a capture window, so they follow the
  // same game-mode gate as the region entry; the parent is gated too, because a submenu
  // whose every child is disabled is just a slower dead end.
  const captureModesEntry = {
    label: t('main.tray.more-screenshot-modes'),
    enabled: featureEnabled,
    submenu: [
      { label: t('main.tray.screenshot-full-screen'), enabled: featureEnabled, click: run('screenshotFullScreen') },
      { label: t('main.tray.screenshot-focused-window'), enabled: featureEnabled, click: run('screenshotFocusedWindow') },
      // Long capture presets the region selection's auto action, so it is a capture mode
      // rather than a separate tool.
      { label: t('main.tray.screenshot-long'), enabled: featureEnabled, click: run('screenshotLong') },
      // The tray has no prompt, so the router's own default (3 seconds) applies; the copy
      // deliberately names the mode instead of a number it does not own.
      { label: t('main.tray.screenshot-delay'), enabled: featureEnabled, click: run('screenshotDelay') }
    ]
  }

  // A06: low-frequency tools. The parent stays enabled in game mode on purpose: the
  // click-through exit and the proxy toggle below are recovery/diagnostic entries that
  // must remain reachable while every summon item in this list is greyed out.
  const toolsEntry = {
    label: t('main.tray.tools'),
    enabled: true,
    submenu: [
      { label: t('main.tray.local-search'), enabled: featureEnabled, click: run('localSearch') },
      { label: t('main.tray.pin-image'), enabled: featureEnabled, click: run('fixedContent') },
      ...(proxyEntry ? [proxyEntry] : []),
      { type: 'separator' },
      // A click-through pin cannot be reached by clicking it, so the bulk exit
      // lives with the always-available entries rather than the pin actions.
      { label: t('main.tray.exit-all-click-through'), enabled: true, click: exitAllClickThrough },
      // An unpinned result window hides as soon as it loses focus, and the only
      // other way to bring it back (a new selection) discards the conversation.
      // Without this entry the preserved turns are unreachable.
      { label: t('main.tray.show-selection-chat'), visible: hasConversation === true, enabled: featureEnabled, click: showConversation },
      // Feature A (plan §4.1/§4.3 A3): the most recent exported file, reachable after its window is
      // gone (a plain screenshot closes on save). Exactly one entry, newest first - the plan caps the
      // tray at a single recent item so this cannot become a second history surface. The entry is
      // APPENDED only when there IS a live receipt: a `visible:false` item still occupies a slot in
      // some platform menu implementations, and it would also keep the label list below honest.
      ...(recentExport && typeof openRecentExport === 'function'
        ? [{
            label: t('main.tray.recent-export', { fileName: recentExport.fileName || '' }),
            click: () => openRecentExport(recentExport)
          }]
        : [])
    ]
  }

  return [
    // A01/A06: the live capture group is the first thing in the menu; see above.
    ...liveRecordingEntries,
    { label: t('main.tray.screenshot'), accelerator: screenshotAccelerator || undefined, enabled: featureEnabled, click: run('screenshot') },
    // R2 (contracts §4.1): the regular recording entry is the workbench; the fullscreen quick start
    // stays reachable through its own command / shortcut (`recordFullscreen`, legacy `videoRecord`).
    {
      label: t('main.tray.recording-workbench'),
      enabled: featureEnabled,
      click: recordingInfo && typeof recordingInfo.openWorkbench === 'function' ? recordingInfo.openWorkbench : run('openRecording')
    },
    clipboardEntry,
    // Only while the feature is off: with it on, the label needs no explanation and the
    // main window already owns the page.
    ...(clipboardEnabled === true ? [] : [clipboardSettingsEntry]),
    // A07: only while a pin exists - a first-run menu never grows a dead parent.
    ...(pinnedDisplaysEntry ? [pinnedDisplaysEntry] : []),
    captureModesEntry,
    toolsEntry,
    { type: 'separator' },
    {
      label: t('main.tray.game-mode'),
      type: 'checkbox',
      checked: gameMode === true,
      click: () => setGameModeEnabled(gameMode !== true)
    },
    { label: t('main.tray.capture-history'), click: openHistory },
    { label: t('main.tray.show-main-window'), click: openMainWindow },
    { type: 'separator' },
    { label: t('main.tray.quit'), click: quit }
  ]
}

module.exports = { buildTrayMenuTemplate }
