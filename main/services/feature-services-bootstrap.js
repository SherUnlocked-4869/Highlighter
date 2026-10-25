// Feature A/B service bootstrap (docs/plans/2026-10-25-snow-apps-feature-development-plan.md §4/§5).
//
// Both services are created inside `initializeStore()` - after `settingsService` exists and before
// any window can ask for them - but neither needs to be written out in main.js: main.js is a hard
// line ceiling, and this is pure assembly. Keeping the construction here also keeps the two
// decisions that actually matter (the crypto preset id, and the injected display provider) next to
// the comment explaining them, instead of buried in the assembly layer.
//
// Neither service requires Electron at module scope: `shell`/`clipboard`/`screen` all arrive as
// arguments, which is what lets this module be unit-tested in plain node.

const crypto = require('node:crypto')
const { createExportResultService } = require('./export-result-service')
const { createRegionPreferences } = require('./region-preferences')
const { createDisplayProvider, createRegionController } = require('../ipc/region-ipc-controller')
const { createExportActionResultController } = require('../ipc/export-action-controller')
const { registerExportIpc } = require('../ipc/export-ipc')
const { registerRegionIpc } = require('../ipc/region-ipc')

// Feature A: the export-result registry. It owns no timers and no files - it registers metadata for
// files this process just wrote and performs open/copy-path/reveal on them.
function createExportResultForApp({ path, fs, shell, clipboard, log }) {
  return createExportResultService({ path, fs, shell, clipboard, log })
}

// Feature B: presets + remembered regions live in `screenshot.regionPreferences`.
function createRegionPreferencesForApp({ getSettings, settingsService, log, screen }) {
  if (!settingsService || typeof settingsService.updateSettings !== 'function') {
    throw new TypeError('Region preferences bootstrap requires settingsService')
  }
  return createRegionPreferences({
    getSettings,
    updateSettings: (patch) => settingsService.updateSettings(patch),
    log,
    // A crypto uuid rather than the module's timestamp+counter fallback: the counter resets each
    // process, so the fallback is only unique by retrying against the stored list. A uuid is
    // collision-proof by construction and stays well under the 64-character id limit.
    createId: () => `preset-${crypto.randomUUID()}`,
    // The service never queries Electron itself; this is the only place display data enters it.
    getDisplays: createDisplayProvider({
      screen,
      dipToScreenRect: screen.dipToScreenRect,
      getCursorPoint: () => screen.getCursorScreenPoint()
    })
  })
}

// Feature A IPC (plan §4.2/A2): the result bar's open / address / open-folder actions. The controller
// attributes the sender to a WebContents-scoped owner id and revokes that owner when the contents are
// destroyed, so a closed window's results stop being actionable.
//
// IMPORTANT: the services are created inside initializeStore(), which runs AFTER the IPC surface is
// registered at module load. Both registrars therefore take *resolvers*, not instances - binding an
// instance here would capture `null` and every action would fail at runtime.
function registerExportFeatureIpc({ ipcMain, getExportResultService, BrowserWindow, log = () => {} }) {
  if (typeof getExportResultService !== 'function') {
    throw new TypeError('Export feature IPC requires a getExportResultService resolver')
  }
  const controller = createExportActionResultController({
    service: {
      perform: (...args) => getExportResultService()?.perform(...args) || { status: 'failed', code: 'result-expired' },
      revokeOwner: (...args) => getExportResultService()?.revokeOwner(...args) || 0
    },
    BrowserWindow,
    log
  })
  registerExportIpc({ ipcMain, controller })
  return controller
}

// Feature B IPC (plan §5.2/B2): presets + last-region resolution. `capture` is the only role that may
// call these channels - the remembered region is written by the domain, never by a renderer.
// Resolvers for the same construction-order reason as Feature A.
function registerRegionFeatureIpc({ ipcMain, getRegionPreferences, limits, log = () => {} }) {
  if (typeof getRegionPreferences !== 'function') {
    throw new TypeError('Region feature IPC requires a getRegionPreferences resolver')
  }
  const preferences = {
    read: () => getRegionPreferences()?.read() || { schemaVersion: 1, lastByMode: { capture: null, record: null }, presets: [] },
    resolveInput: (...args) => getRegionPreferences()?.resolveInput(...args) || { ok: false, code: 'unavailable' },
    savePreset: (...args) => getRegionPreferences()?.savePreset(...args) || { ok: false, code: 'unavailable' },
    deletePreset: (...args) => getRegionPreferences()?.deletePreset(...args) || { ok: false, code: 'unavailable' }
  }
  registerRegionIpc({
    ipcMain,
    controller: createRegionController({ preferences, limits, log })
  })
  return true
}

module.exports = {
  createExportResultForApp,
  createRegionPreferencesForApp,
  registerExportFeatureIpc,
  registerRegionFeatureIpc
}
