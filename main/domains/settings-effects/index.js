'use strict'

function createSettingsEffects(deps) {
  const {
    app,
    registerShortcuts,
    applyGameModeState,
    createTrayIcon,
    getUpdateService,
    ocrServiceRef,
    getOcrService,
    broadcastActionAppearance,
    searchDomain,
    selectionHookServiceRef,
    log
  } = deps

  const updateEffects = [
    {
      id: 'shortcuts',
      when: (patch) => !!patch.shortcuts,
      run: () => registerShortcuts()
    },
    {
      id: 'system.autoStart',
      when: (patch) => patch.system?.autoStart !== undefined,
      run: (_patch, settings) => app.setLoginItemSettings({ openAtLogin: !!settings.system.autoStart })
    },
    {
      id: 'system.gameMode',
      when: (patch) => patch.system?.gameMode !== undefined,
      run: (_patch, settings) => applyGameModeState(settings.system.gameMode, 'settings-update')
    },
    {
      id: 'system.enableTray',
      // gameMode already rebuilds the tray; avoid double work in the same update
      when: (patch) => patch.system?.gameMode === undefined && patch.system?.enableTray !== undefined,
      run: () => createTrayIcon()
    },
    {
      id: 'system.updateChannel',
      when: (patch) => patch.system?.updateChannel !== undefined,
      run: (_patch, settings) => getUpdateService()?.setChannel(settings.system.updateChannel)
    },
    {
      id: 'plugins.ocr.off',
      when: (patch) => patch.plugins?.ocr === false,
      run: () => {
        const service = ocrServiceRef.get()
        if (service) {
          service.stop()
          ocrServiceRef.set(null)
        }
      }
    },
    {
      id: 'plugins.ocr.hotStart',
      when: (patch, settings) => patch.plugins?.ocr === true && !!settings.ocr?.hotStart,
      run: () => getOcrService().ensureStarted().catch((error) => log('OCR hot start failed:', error.message))
    },
    {
      id: 'appearance',
      when: (patch) => patch.theme !== undefined || patch.mainColor !== undefined,
      run: (_patch, settings) => broadcastActionAppearance(settings)
    },
    {
      id: 'search',
      when: (patch) => !!patch.search,
      run: () => searchDomain?.notifySettingsChanged()
    },
    {
      id: 'selectionToolbar.clipboardFallback',
      when: (patch) => patch.selectionToolbar?.clipboardFallback !== undefined,
      run: (_patch, settings) => selectionHookServiceRef.get()?.updateStartOptions({
        enableClipboard: settings.selectionToolbar.clipboardFallback
      })
    }
  ]

  const resetEffects = [
    { id: 'system.gameMode', run: (settings) => applyGameModeState(settings.system.gameMode, 'settings-reset') },
    { id: 'appearance', run: (settings) => broadcastActionAppearance(settings) },
    { id: 'system.updateChannel', run: (settings) => getUpdateService()?.setChannel(settings.system.updateChannel) },
    {
      id: 'selectionToolbar.clipboardFallback',
      run: (settings) => selectionHookServiceRef.get()?.updateStartOptions({
        enableClipboard: settings.selectionToolbar.clipboardFallback
      })
    },
    { id: 'search', run: () => searchDomain?.notifySettingsChanged() }
  ]

  function applyUpdate(patch, settings) {
    for (const effect of updateEffects) {
      if (effect.when(patch, settings)) effect.run(patch, settings)
    }
  }

  function applyReset(settings) {
    for (const effect of resetEffects) {
      effect.run(settings)
    }
  }

  function listUpdateEffectIds() {
    return updateEffects.map((effect) => effect.id)
  }

  return {
    applyUpdate,
    applyReset,
    listUpdateEffectIds,
    updateEffects,
    resetEffects
  }
}

module.exports = {
  createSettingsEffects
}
