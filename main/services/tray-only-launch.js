'use strict'

const os = require('node:os')
const path = require('node:path')

// M2/W6a: launching the app at login must not cost a renderer for a window the
// user did not ask for. Windows' `getLoginItemSettings()` cannot tell whether
// the current launch came from the login item, so the login item carries an
// explicit argv marker that startup reads. Existing registrations created before
// this change have no marker and therefore keep the old "open the main window"
// behaviour until the next time settings are saved.
const START_TO_TRAY_FLAG = '--start-to-tray'
const LOGIN_ITEM_ARGS = Object.freeze([START_TO_TRAY_FLAG])

// D05 (2026-11-24 Windows product/architecture review): the residency audit. The
// review asks for an *idempotent* check of the single instance, an Explorer
// restart, sleep/resume and the portable login item, correcting only the gaps
// that reproduce. This module owns the pure decisions; main.js keeps the Electron
// side (Tray, app.get/setLoginItemSettings, powerMonitor) and passes its state in.
// Nothing here creates a tray or registers a login item on its own.

// electron-builder's portable target self-extracts into a throwaway %TEMP%
// directory and starts the real exe from there. `process.execPath` therefore
// changes on every launch, and registering it as the login item targets a path
// Windows may delete; PORTABLE_EXECUTABLE_FILE is the .exe the user actually
// double-clicked and the only persistent target for a portable build.
function resolveLoginItemTarget({ execPath = '', portableExecutableFile = '' } = {}) {
  const portableTarget = typeof portableExecutableFile === 'string' ? portableExecutableFile.trim() : ''
  const portable = portableTarget.length > 0
  const target = portable ? portableTarget : (typeof execPath === 'string' ? execPath.trim() : '')
  return {
    portable,
    path: target,
    persistent: isPersistentLaunchTarget(target)
  }
}

function defaultTempRoots() {
  const roots = [os.tmpdir()]
  for (const value of [process.env.TEMP, process.env.TMP]) {
    if (value) roots.push(value)
  }
  return roots
}

// Case-insensitive on purpose: the Windows shell treats C:\Apps\X.exe and
// c:\apps\x.exe as the same file, and the login item registry value is written
// by the shell. Separators are normalised by path.resolve, and the trailing
// separator is dropped so a directory target compares like a file target.
function normalizeForCompare(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  try {
    return path.resolve(text).toLowerCase().replace(/[\\/]+$/, '')
  } catch {
    return text.toLowerCase()
  }
}

function isPersistentLaunchTarget(target, { tempRoots = defaultTempRoots() } = {}) {
  const text = typeof target === 'string' ? target.trim() : ''
  const normalized = normalizeForCompare(text)
  if (!normalized || !path.isAbsolute(text)) return false
  return !tempRoots.some((root) => {
    const normalizedRoot = normalizeForCompare(root)
    if (!normalizedRoot) return false
    // A temp root can be a prefix with either separator after path.resolve on a
    // foreign platform; checking both keeps the pure function testable.
    return normalized === normalizedRoot ||
      normalized.startsWith(`${normalizedRoot}${path.sep}`) ||
      normalized.startsWith(`${normalizedRoot}/`)
  })
}

function sameLaunchTarget(left, right) {
  const a = normalizeForCompare(left)
  const b = normalizeForCompare(right)
  return a.length > 0 && a === b
}

// The login item has no "current path" API of its own before Electron 29: the
// caller merges `launchItems[0].path` (or the registry read) into `current.path`
// and Windows' `executableWillLaunchAtLogin` into `current.executableWillLaunchAtLogin`.
function reconcileLoginItem({ current = {}, desired = {} } = {}) {
  const make = (action, code, reasons = [], settings = null) => ({
    action,
    changed: action !== 'none' && action !== 'skip',
    code,
    reasons,
    settings
  })
  const wantOpen = desired.openAtLogin === true
  const registered = current.openAtLogin === true || current.executableWillLaunchAtLogin === true
  if (!wantOpen) {
    if (!registered) return make('none', 'IN_SYNC')
    return make('remove', 'DISABLED', ['login item is still registered'], loginItemSettings(false))
  }
  const target = typeof desired.path === 'string' ? desired.path.trim() : ''
  if (target && !isPersistentLaunchTarget(target, { tempRoots: desired.tempRoots })) {
    return make('skip', 'TARGET_NOT_PERSISTENT', [`refusing non-persistent login target: ${target}`])
  }
  const settings = loginItemSettings(true, { path: target })
  if (current.openAtLogin !== true) {
    return make('apply', 'OPEN_AT_LOGIN_OFF', ['openAtLogin is off'], settings)
  }
  if (current.path && target && !sameLaunchTarget(current.path, target)) {
    return make('apply', 'TARGET_DRIFT', [`login item points at ${current.path}, expected ${target}`], settings)
  }
  if (!current.path && current.executableWillLaunchAtLogin === false) {
    return make('apply', 'TARGET_DRIFT', ['Windows reports the registered executable will not launch'], settings)
  }
  const currentArgs = Array.isArray(current.args) ? current.args.map(String) : null
  const desiredArgs = Array.isArray(desired.args) ? desired.args.map(String) : [...LOGIN_ITEM_ARGS]
  if (currentArgs && desiredArgs.some((arg) => !currentArgs.includes(arg))) {
    return make('apply', 'MARKER_MISSING', ['start-to-tray marker is missing'], settings)
  }
  return make('none', 'IN_SYNC')
}

// "One tray icon" is an instance count, not a menu rebuild: the same Tray object
// may repaint or change its tooltip, but a second live icon is always a defect.
function reconcileTrayIcon({ current = {}, desired = {} } = {}) {
  const instances = Math.max(0, Math.floor(Number(current.instances) || 0))
  const make = (action, code, reasons = [], extra = {}) => ({
    action,
    changed: action !== 'none',
    code,
    reasons,
    keep: action === 'destroy' ? 0 : 1,
    ...extra
  })
  if (desired.enabled === false) {
    return instances > 0
      ? make('destroy', 'DISABLED', [`${instances} tray icon(s) alive while the tray is disabled`])
      : make('none', 'IN_SYNC', [], { keep: 0 })
  }
  if (instances > 1) {
    return make('dedupe', 'DUPLICATE_INSTANCES', [`${instances} tray icons are alive; exactly one is allowed`], {
      duplicates: instances - 1
    })
  }
  if (instances === 0) return make('create', 'MISSING', ['no tray icon is alive'])
  if (current.iconVisible === false) {
    return make('restore', 'ICON_NOT_VISIBLE', ['the shell no longer shows the icon (Explorer restart)'])
  }
  const iconFile = typeof desired.iconFile === 'string' ? desired.iconFile : ''
  if (iconFile && typeof current.iconFile === 'string' && current.iconFile && current.iconFile !== iconFile) {
    return make('update', 'ICON_STALE', [`icon ${current.iconFile} != ${iconFile}`])
  }
  if (typeof desired.tooltip === 'string' && typeof current.tooltip === 'string' && current.tooltip !== desired.tooltip) {
    return make('update', 'TOOLTIP_STALE', ['tray tooltip drifted'])
  }
  return make('none', 'IN_SYNC')
}

// Single instance: a secondary process must exit before it owns a window, tray or
// recording session. A second-instance notification while a recording is live may
// only surface what already exists.
function planInstanceAction({ gotLock, event = 'startup', recordingActive = false, mainWindowOpen = false } = {}) {
  if (gotLock !== true) return { action: 'quit', code: 'SECONDARY_INSTANCE' }
  if (event === 'second-instance') {
    if (recordingActive) return { action: 'noop', code: 'RECORDING_ACTIVE' }
    return mainWindowOpen
      ? { action: 'focus', code: 'MAIN_WINDOW_EXISTS' }
      : { action: 'open-main-window', code: 'MAIN_WINDOW_MISSING' }
  }
  return { action: 'none', code: 'PRIMARY_STARTUP' }
}

function reconcileResidency({ loginItem = {}, tray = {}, singleInstance = null, desired = {} } = {}) {
  const login = reconcileLoginItem({ current: loginItem, desired: desired.loginItem || {} })
  const trayPlan = reconcileTrayIcon({ current: tray, desired: desired.tray || {} })
  const corrections = []
  if (login.changed) corrections.push({ kind: 'login-item', action: login.action, code: login.code })
  if (trayPlan.changed) corrections.push({ kind: 'tray', action: trayPlan.action, code: trayPlan.code })
  return {
    loginItem: login,
    tray: trayPlan,
    singleInstance: singleInstance ? planInstanceAction(singleInstance) : null,
    corrections,
    changed: corrections.length > 0
  }
}

function readState(fn) {
  if (typeof fn !== 'function') return {}
  try {
    const value = fn()
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

// The checkpoints the review asks for but this host cannot reproduce: an Explorer
// restart (the shell drops tray icons while the Tray object survives) and a real
// sleep/resume. Both are the same pure reconciliation with a different trigger
// name, so a test double can stand in for each event and the production wiring
// only has to pass the live getters/setters in.
function createResidencyCheckpoints({
  getLoginItem = null,
  applyLoginItem = null,
  getTray = null,
  createTray = null,
  restoreTray = null,
  updateTray = null,
  dedupeTray = null,
  destroyTray = null,
  getInstance = null,
  applyInstance = null,
  desired = {},
  now = Date.now
} = {}) {
  const reports = []
  const apply = (fn, arg) => {
    if (typeof fn !== 'function') return false
    try {
      fn(arg)
      return true
    } catch {
      return false
    }
  }

  function check(kind = 'manual') {
    const plan = reconcileResidency({
      loginItem: readState(getLoginItem),
      tray: readState(getTray),
      singleInstance: typeof getInstance === 'function' ? readState(getInstance) : null,
      desired
    })
    const applied = []
    if (plan.loginItem.action === 'apply' || plan.loginItem.action === 'remove') {
      if (apply(applyLoginItem, plan.loginItem.settings)) applied.push(`login-item:${plan.loginItem.action}`)
    }
    if (plan.tray.action === 'create' && apply(createTray, plan.tray)) applied.push('tray:create')
    if (plan.tray.action === 'restore' && apply(restoreTray, plan.tray)) applied.push('tray:restore')
    if (plan.tray.action === 'update' && apply(updateTray, plan.tray)) applied.push('tray:update')
    if (plan.tray.action === 'dedupe' && apply(dedupeTray, plan.tray)) applied.push('tray:dedupe')
    if (plan.tray.action === 'destroy' && apply(destroyTray, plan.tray)) applied.push('tray:destroy')
    if (plan.singleInstance?.action === 'quit' && apply(applyInstance, plan.singleInstance)) applied.push('instance:quit')
    const report = { kind, at: now(), plan, applied, changed: applied.length > 0 }
    reports.push(report)
    return report
  }

  return {
    check,
    checkSleepResume: () => check('sleep-resume'),
    checkExplorerRestarted: () => check('explorer-restarted'),
    checkSecondInstance: () => check('second-instance'),
    reports
  }
}

function isStartToTrayLaunch(argv = process.argv, { e2e = false } = {}) {
  if (e2e) return false
  const args = Array.isArray(argv) ? argv : []
  return args.some((arg) => {
    const value = String(arg)
    return value === START_TO_TRAY_FLAG || value.startsWith(`${START_TO_TRAY_FLAG}=`)
  })
}

// The single shape both `setLoginItemSettings` call sites use. `args` is honored
// on Windows and macOS; other platforms simply ignore the extra field. D05 adds
// the optional persistent target: a portable build must register the launcher the
// user actually ran, not the self-extracted `process.execPath`.
function loginItemSettings(openAtLogin, { path: launchTarget } = {}) {
  const settings = { openAtLogin: !!openAtLogin, args: [...LOGIN_ITEM_ARGS] }
  if (typeof launchTarget === 'string' && launchTarget.trim()) settings.path = launchTarget.trim()
  return settings
}

module.exports = {
  LOGIN_ITEM_ARGS,
  START_TO_TRAY_FLAG,
  createResidencyCheckpoints,
  isPersistentLaunchTarget,
  isStartToTrayLaunch,
  loginItemSettings,
  planInstanceAction,
  reconcileLoginItem,
  reconcileResidency,
  reconcileTrayIcon,
  resolveLoginItemTarget,
  sameLaunchTarget
}
