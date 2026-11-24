'use strict'

// D01 / D06 (docs/reviews/2026-11-24-windows-product-architecture-review.md §D01/§D06):
// the updater's assembly lives here instead of main.js - the "one switch controls whether
// a timer exists" rule is a domain rule, not an assembly detail, and main.js's line
// budget only has room for wiring. main/services/update-service.js keeps the state
// machine; this module owns the lifecycle (lazy construction, the opt-in scheduler and
// the single teardown) so both the IPC path and the settings effect share one instance.
//
// Offline by default: nothing here touches the network unless a manual check or the
// user's explicit "auto check updates" call reaches the service. The startup path only
// arms a timer when the setting is already true, and it does not even require
// electron-updater otherwise.

const { UpdateService } = require('../../services/update-service')

// Same 2 s the previous deferUpdateServiceStart() waited for: the window/tray come first.
const DEFAULT_START_DELAY_MS = 2000

function createUpdateDomain({
  app,
  getSettings,
  getInstallType,
  openDownloadPage,
  canInstall = async () => ({ ok: true }),
  prepareInstall = async () => {},
  notify = () => {},
  log = () => {},
  autoCheckAtStartup = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  startDelayMs = DEFAULT_START_DELAY_MS
} = {}) {
  if (!app || typeof app.getVersion !== 'function') throw new TypeError('Update domain requires an app')
  if (typeof getSettings !== 'function') throw new TypeError('Update domain requires getSettings')
  if (typeof getInstallType !== 'function') throw new TypeError('Update domain requires getInstallType')

  let service = null
  let startTimer = null

  function autoCheckEnabled() {
    if (typeof autoCheckAtStartup === 'boolean') return autoCheckAtStartup
    return getSettings()?.system?.autoCheckUpdates === true
  }

  function resolve() {
    if (service) return service
    const installType = getInstallType()
    let updater = null
    if (installType === 'nsis') {
      try { updater = require('electron-updater').autoUpdater } catch (error) {
        log('Unable to initialize update client:', error.message || String(error))
      }
    }
    service = new UpdateService({
      updater,
      currentVersion: app.getVersion(),
      installType,
      channel: getSettings().system.updateChannel,
      autoCheckEnabled: autoCheckEnabled(),
      openDownloadPage,
      canInstall,
      prepareInstall,
      notify,
      log
    })
    return service
  }

  function peek() {
    return service
  }

  // D01: the startup path. No opt-in means no timer and no construction, so a default
  // install makes zero update requests while it idles. A manual check still resolves the
  // service on demand and authorises exactly one request.
  function deferStart() {
    if (!autoCheckEnabled()) return false
    if (startTimer) return false
    startTimer = setTimeoutFn(() => {
      startTimer = null
      try { resolve().start() } catch (error) { log('Update service start failed:', error?.message || String(error)) }
    }, startDelayMs)
    startTimer?.unref?.()
    return true
  }

  function getStatus() {
    return service ? service.getStatus() : { status: 'not-configured', error: null }
  }

  function dispose() {
    if (startTimer) clearTimeoutFn(startTimer)
    startTimer = null
    if (service) {
      service.dispose()
      service = null
    }
  }

  return { resolve, peek, deferStart, getStatus, dispose, autoCheckEnabled }
}

module.exports = { createUpdateDomain, DEFAULT_START_DELAY_MS }
