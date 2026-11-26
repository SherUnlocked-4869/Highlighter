'use strict'

// H05 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 2.5): the tray
// singleton, its icon swap and the entire context-menu assembly moved out of main.js.
//
// main.js sits at a hard line ceiling (scripts/check-architecture.js), and the code that hit
// it had been squeezed into 300+ character lines: the menu template was one dense block with
// the "rebuild on change" callbacks inlined. The tray owns exactly this state, so it owns the
// module: `refresh()` is the one public entry point (main.js keeps the historical
// `createTrayIcon()` name as a one-line delegation because several contract tests and the
// startup sequence call it by name).
//
// Every collaborator is a resolver, never a value: the first tray build happens in
// startApplication(), long after this controller is constructed, and the domains it reads are
// assigned in dependency order.

const { buildTrayMenuTemplate } = require('../../services/tray-menu')
const { createTrayIconImage } = require('../../services/tray-icon')

function createTrayController({
  Tray,
  Menu,
  app,
  path,
  rootDirectory,
  nativeImage,
  nativeTheme,
  t,
  log,
  getSettings,
  isGameModeEnabled,
  createMainWindow,
  executeFunction,
  getProxyBridge,
  getPinDomain,
  getRecordDomain,
  getSelectionDomain,
  getExportResultService,
  setGameModeEnabled
}) {
  let tray = null
  let trayIconFile = ''

  function destroy() {
    if (!tray) return
    tray.destroy()
    tray = null
    trayIconFile = ''
  }

  function liveRecordingTooltip(settings) {
    const live = getRecordDomain()?.getActiveState?.()
    if (!live) return ''
    if (live.status === 'paused') return t('main.tray.tooltip-recording-paused')
    if (live.status === 'recording') return t('main.tray.tooltip-recording')
    return ''
  }

  function tooltipFor(settings, gameMode, proxyState) {
    const parts = [
      gameMode ? t('main.tray.tooltip-game-mode') : 'Highlighter',
      liveRecordingTooltip(settings),
      proxyState?.running ? t('main.proxy.tooltip-running') : ''
    ]
    return parts.filter(Boolean).join(' · ')
  }

  // A06: the disabled clipboard entry explains where to enable it and the following entry
  // opens that settings route in one step, so a fresh install needs no scavenger hunt.
  function menuTemplate(settings, gameMode, proxyState) {
    const proxyBridge = getProxyBridge()
    const pinDomain = getPinDomain()
    const recordDomain = getRecordDomain()
    const selectionDomain = getSelectionDomain()
    const exportResultService = getExportResultService()
    return buildTrayMenuTemplate({
      gameMode,
      screenshotAccelerator: settings.shortcuts.screenshot,
      clipboardEnabled: settings.clipboard.enabled,
      translationProxy: proxyState,
      setTranslationProxyEnabled: (enabled) => proxyBridge.setEnabled(enabled),
      executeFunction: (name) => {
        executeFunction(name).catch((error) => log('Tray action failed:', name, error.message))
      },
      // P0-6-T4: a click-through pin swallows clicks, and game mode suspends both the router
      // and the global shortcuts, so this entry calls the domain directly - the only recovery
      // path that survives game mode.
      exitClickThrough: () => {
        const exited = pinDomain.exitAllClickThrough()
        log('Click-through exit:', exited)
        return exited
      },
      setGameModeEnabled: (enabled) => {
        try {
          setGameModeEnabled(enabled)
        } catch (error) {
          log('Game mode update failed:', error.message)
          refresh()
        }
      },
      openHistory: () => createMainWindow('history'),
      openClipboardSettings: () => createMainWindow('clipboard-history'),
      openMainWindow: () => createMainWindow('home'),
      hasConversation: selectionDomain.hasConversation(),
      showConversation: () => selectionDomain.showOrRestoreConversation(),
      // Feature A (plan §4.1): the newest live export, so a file whose window is gone (a plain
      // screenshot closes on save) is still reachable. The plan caps the tray at one entry; the
      // service returns exactly that (latestFor() with no owner = newest live receipt).
      recentExport: exportResultService ? exportResultService.latestFor() : null,
      // R2 (contracts §4.1/§4.2): the workbench entry and the live pause/finish entries.
      recording: {
        active: recordDomain.getActiveState(),
        openWorkbench: () => recordDomain.openRecordingWorkbench(),
        pauseResume: () => recordDomain.pauseResumeActive(),
        finish: () => recordDomain.finishActive()
      },
      pinnedDisplays: pinDomain.listPinsByDisplay(),
      recoverablePins: pinDomain.trayRecoveryMenu(),
      openRecentExport: (receipt) => {
        if (!receipt?.resultId) return
        Promise.resolve(exportResultService?.perform({ resultId: receipt.resultId, action: 'open' }))
          .then((result) => {
            if (result?.status === 'failed') log('Tray recent export failed:', result.code)
            refresh()
          })
          .catch((error) => log('Tray recent export failed:', error.message))
      },
      quit: () => app.quit()
    })
  }

  function refresh() {
    const settings = getSettings()
    if (!settings.system.enableTray) {
      destroy()
      return null
    }
    // P1 (2026-10-18 snow migration §12.2): a dark taskbar needs the lighter asset; the choice
    // (including "system" -> nativeTheme) lives in services/tray-icon.js.
    const trayIcon = createTrayIconImage({
      nativeImage,
      directory: path.join(rootDirectory, 'assets'),
      theme: settings.theme,
      systemPrefersDark: nativeTheme.shouldUseDarkColors
    })
    if (!tray) {
      tray = new Tray(trayIcon.image)
      // A01: tray actions run through the same router the shortcuts use, so a failure is
      // reported by one code path.
      tray.on('click', () => {
        if (isGameModeEnabled()) return
        executeFunction('screenshot').catch((error) => log('Tray action failed:', error.message))
      })
      tray.on('double-click', () => createMainWindow('home'))
    } else if (trayIcon.file !== trayIconFile) {
      tray.setImage(trayIcon.image)
    }
    trayIconFile = trayIcon.file
    const gameMode = isGameModeEnabled(settings)
    const proxyBridge = getProxyBridge()
    const proxyState = proxyBridge ? proxyBridge.menuState(settings) : null
    tray.setToolTip(tooltipFor(settings, gameMode, proxyState))
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(settings, gameMode, proxyState)))
    return tray
  }

  return {
    refresh,
    destroy,
    isActive: () => !!tray
  }
}

module.exports = { createTrayController }
