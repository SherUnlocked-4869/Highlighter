// D05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the
// log-in/tray residency audit. Explorer-restart and sleep/resume cannot be
// reproduced on this host, so their checkpoints run against injectable doubles.
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const {
  createResidencyCheckpoints,
  isPersistentLaunchTarget,
  loginItemSettings,
  planInstanceAction,
  reconcileLoginItem,
  reconcileResidency,
  reconcileTrayIcon,
  resolveLoginItemTarget,
  sameLaunchTarget
} = require('../main/services/tray-only-launch')

const APP_TARGET = 'C:\\Apps\\Highlighter\\Highlighter.exe'
const ICON = 'C:\\Apps\\Highlighter\\assets\\icon.png'

// Electron's Windows `getLoginItemSettings` answers both questions separately:
// `openAtLogin` (is the Run entry there) and `executableWillLaunchAtLogin` (does the
// registered path still exist / launch). The caller merges the registered path
// into `current.path`; the pure reconciler treats them as independent evidence.
function currentLogin(overrides = {}) {
  return {
    openAtLogin: true,
    executableWillLaunchAtLogin: true,
    path: APP_TARGET,
    args: ['--start-to-tray'],
    ...overrides
  }
}

const desiredLogin = Object.freeze({ openAtLogin: true, path: APP_TARGET })

test('the login item target is the portable launcher, not the throwaway exec path', () => {
  const portable = resolveLoginItemTarget({
    execPath: path.join(os.tmpdir(), 'highlighter-portable', 'Highlighter.exe'),
    portableExecutableFile: 'D:\\Portable\\Highlighter.exe'
  })
  assert.deepEqual(portable, { portable: true, path: 'D:\\Portable\\Highlighter.exe', persistent: true })

  const installed = resolveLoginItemTarget({ execPath: APP_TARGET })
  assert.deepEqual(installed, { portable: false, path: APP_TARGET, persistent: true })

  // electron-builder's portable target self-extracts into %TEMP% on every launch;
  // that path must never become the login item.
  const extracted = resolveLoginItemTarget({ execPath: path.join(os.tmpdir(), '2b9e', 'Highlighter.exe') })
  assert.equal(extracted.portable, false)
  assert.equal(extracted.persistent, false)
})

test('persistence also covers an explicitly injected temp root and rejects relative paths', () => {
  assert.equal(isPersistentLaunchTarget('C:\\Apps\\Highlighter.exe'), true)
  assert.equal(isPersistentLaunchTarget('D:\\Cache\\Highlighter.exe', { tempRoots: ['D:\\Cache'] }), false)
  assert.equal(isPersistentLaunchTarget('D:\\Cachex\\Highlighter.exe', { tempRoots: ['D:\\Cache'] }), true)
  assert.equal(isPersistentLaunchTarget('Highlighter.exe'), false)
  assert.equal(isPersistentLaunchTarget(''), false)
  assert.equal(isPersistentLaunchTarget(null), false)
})

test('login target comparison is Windows case- and separator-insensitive', () => {
  assert.equal(sameLaunchTarget(APP_TARGET, APP_TARGET.toLowerCase()), true)
  assert.equal(sameLaunchTarget('C:\\Apps/Highlighter/Highlighter.exe', APP_TARGET), true)
  assert.equal(sameLaunchTarget(APP_TARGET, 'D:\\Apps\\Highlighter.exe'), false)
  assert.equal(sameLaunchTarget('', ''), false)
})

test('a correct login item is left alone (idempotent, no operation)', () => {
  const plan = reconcileLoginItem({ current: currentLogin(), desired: desiredLogin })
  assert.equal(plan.action, 'none')
  assert.equal(plan.changed, false)
  assert.equal(plan.code, 'IN_SYNC')
  assert.equal(plan.settings, null)
  // Re-running the check on the same state is still a no-op, never a rewrite.
  assert.deepEqual(reconcileLoginItem({ current: currentLogin(), desired: desiredLogin }), plan)
})

test('a drifted login target, a missing marker and a missing registration are corrected', () => {
  const drift = reconcileLoginItem({
    current: currentLogin({ path: 'D:\\Old\\Highlighter.exe' }),
    desired: desiredLogin
  })
  assert.equal(drift.action, 'apply')
  assert.equal(drift.code, 'TARGET_DRIFT')
  assert.equal(drift.settings.path, APP_TARGET)
  assert.equal(drift.settings.openAtLogin, true)

  const marker = reconcileLoginItem({
    current: currentLogin({ args: [] }),
    desired: desiredLogin
  })
  assert.equal(marker.action, 'apply')
  assert.equal(marker.code, 'MARKER_MISSING')

  const off = reconcileLoginItem({ current: currentLogin({ openAtLogin: false }), desired: desiredLogin })
  assert.equal(off.action, 'apply')
  assert.equal(off.code, 'OPEN_AT_LOGIN_OFF')

  // Windows says the registered executable will not launch even though the Run
  // entry exists: that is the same drift, without a path to compare.
  const dead = reconcileLoginItem({
    current: currentLogin({ path: '', executableWillLaunchAtLogin: false }),
    desired: desiredLogin
  })
  assert.equal(dead.action, 'apply')
  assert.equal(dead.code, 'TARGET_DRIFT')
})

test('disabling autostart removes a registered login item and does nothing otherwise', () => {
  const remove = reconcileLoginItem({ current: currentLogin(), desired: { openAtLogin: false } })
  assert.equal(remove.action, 'remove')
  assert.equal(remove.changed, true)
  assert.deepEqual(remove.settings, loginItemSettings(false))

  const none = reconcileLoginItem({
    current: currentLogin({ openAtLogin: false, executableWillLaunchAtLogin: false }),
    desired: { openAtLogin: false }
  })
  assert.equal(none.action, 'none')
  assert.equal(none.changed, false)
})

test('a portable build refuses to register a non-persistent target', () => {
  const extracted = path.join(os.tmpdir(), 'portable-1234', 'Highlighter.exe')
  const plan = reconcileLoginItem({
    current: currentLogin({ openAtLogin: false }),
    desired: { openAtLogin: true, path: extracted }
  })
  assert.equal(plan.action, 'skip')
  assert.equal(plan.changed, false)
  assert.equal(plan.code, 'TARGET_NOT_PERSISTENT')
  assert.equal(plan.settings, null)

  // The actual portable launcher path is accepted and written to `settings.path`.
  const portable = reconcileLoginItem({
    current: currentLogin({ openAtLogin: false }),
    desired: { openAtLogin: true, path: 'D:\\Portable\\Highlighter.exe' }
  })
  assert.equal(portable.action, 'apply')
  assert.equal(portable.settings.path, 'D:\\Portable\\Highlighter.exe')
})

test('loginItemSettings keeps its legacy shape and only adds path when asked', () => {
  assert.deepEqual(loginItemSettings(true), { openAtLogin: true, args: ['--start-to-tray'] })
  assert.deepEqual(loginItemSettings(false, { path: APP_TARGET }), {
    openAtLogin: false,
    args: ['--start-to-tray'],
    path: APP_TARGET
  })
  assert.deepEqual(loginItemSettings(undefined), { openAtLogin: false, args: ['--start-to-tray'] })
})

test('one live tray icon is the only valid state; duplicates are deduped to one', () => {
  const desired = { enabled: true, iconFile: ICON }
  assert.equal(reconcileTrayIcon({ current: { instances: 1, iconFile: ICON }, desired }).action, 'none')

  const duplicate = reconcileTrayIcon({ current: { instances: 3, iconFile: ICON }, desired })
  assert.equal(duplicate.action, 'dedupe')
  assert.equal(duplicate.code, 'DUPLICATE_INSTANCES')
  assert.equal(duplicate.keep, 1)
  assert.equal(duplicate.duplicates, 2)

  const missing = reconcileTrayIcon({ current: { instances: 0 }, desired })
  assert.equal(missing.action, 'create')

  const disabled = reconcileTrayIcon({ current: { instances: 1 }, desired: { enabled: false } })
  assert.equal(disabled.action, 'destroy')
  assert.equal(disabled.keep, 0)

  const alreadyOff = reconcileTrayIcon({ current: { instances: 0 }, desired: { enabled: false } })
  assert.equal(alreadyOff.action, 'none')
})

test('an Explorer restart or a stale icon repaints the same Tray instead of creating another', () => {
  const visible = reconcileTrayIcon({
    current: { instances: 1, iconFile: ICON, iconVisible: false },
    desired: { enabled: true, iconFile: ICON }
  })
  assert.equal(visible.action, 'restore')
  assert.equal(visible.code, 'ICON_NOT_VISIBLE')
  assert.equal(visible.keep, 1)

  const stale = reconcileTrayIcon({
    current: { instances: 1, iconFile: 'old.png' },
    desired: { enabled: true, iconFile: ICON }
  })
  assert.equal(stale.action, 'update')
  assert.equal(stale.code, 'ICON_STALE')
  assert.equal(stale.keep, 1, 'an update reuses the one icon, it does not add one')
})

test('a secondary launch always quits and a second-instance during recording changes nothing', () => {
  assert.deepEqual(planInstanceAction({ gotLock: false }), { action: 'quit', code: 'SECONDARY_INSTANCE' })
  assert.deepEqual(planInstanceAction({ gotLock: true }), { action: 'none', code: 'PRIMARY_STARTUP' })
  assert.deepEqual(
    planInstanceAction({ gotLock: true, event: 'second-instance', recordingActive: true }),
    { action: 'noop', code: 'RECORDING_ACTIVE' }
  )
  assert.deepEqual(
    planInstanceAction({ gotLock: true, event: 'second-instance', mainWindowOpen: true }),
    { action: 'focus', code: 'MAIN_WINDOW_EXISTS' }
  )
  // Ten simultaneous launches: exactly one owns the app, the other nine quit.
  const launches = [true, ...Array(9).fill(false)].map((gotLock) => planInstanceAction({ gotLock }))
  assert.equal(launches.filter((plan) => plan.action !== 'quit').length, 1)
  assert.equal(launches.filter((plan) => plan.code === 'SECONDARY_INSTANCE').length, 9)
})

test('reconcileResidency reports only the parts that drifted', () => {
  const inSync = reconcileResidency({
    loginItem: currentLogin(),
    tray: { instances: 1, iconFile: ICON },
    desired: { loginItem: desiredLogin, tray: { enabled: true, iconFile: ICON } }
  })
  assert.equal(inSync.changed, false)
  assert.deepEqual(inSync.corrections, [])

  const loginOnly = reconcileResidency({
    loginItem: currentLogin({ path: 'D:\\Old\\Highlighter.exe' }),
    tray: { instances: 1, iconFile: ICON },
    desired: { loginItem: desiredLogin, tray: { enabled: true, iconFile: ICON } }
  })
  assert.equal(loginOnly.changed, true)
  assert.deepEqual(loginOnly.corrections, [{ kind: 'login-item', action: 'apply', code: 'TARGET_DRIFT' }])
  assert.equal(loginOnly.tray.action, 'none')
})

// The checkpoints stand in for the events this host cannot reproduce: an Explorer
// restart (the shell drops the icon while the Tray object survives) and a real
// sleep/resume (the login item and the icon may be repaired while suspended). The
// doubles below are the only "shell"; the production wiring passes the real
// getters/setters in.
function createFakeResidency({ loginItem = currentLogin(), tray = { instances: 1, iconFile: ICON, iconVisible: true } } = {}) {
  const state = { loginItem: { ...loginItem }, tray: { ...tray }, calls: [] }
  const desired = { loginItem: desiredLogin, tray: { enabled: true, iconFile: ICON } }
  const checkpoints = createResidencyCheckpoints({
    getLoginItem: () => state.loginItem,
    applyLoginItem: (settings) => {
      state.calls.push(['login-item', settings])
      state.loginItem = {
        ...state.loginItem,
        openAtLogin: settings.openAtLogin,
        args: settings.args,
        path: settings.path || state.loginItem.path,
        executableWillLaunchAtLogin: settings.openAtLogin
      }
    },
    getTray: () => state.tray,
    createTray: () => {
      state.calls.push(['tray:create'])
      state.tray = { ...state.tray, instances: 1, iconVisible: true, iconFile: ICON }
    },
    restoreTray: () => {
      state.calls.push(['tray:restore'])
      state.tray = { ...state.tray, iconVisible: true }
    },
    updateTray: () => {
      state.calls.push(['tray:update'])
      state.tray = { ...state.tray, iconFile: ICON }
    },
    dedupeTray: () => {
      state.calls.push(['tray:dedupe'])
      state.tray = { ...state.tray, instances: 1 }
    },
    destroyTray: () => {
      state.calls.push(['tray:destroy'])
      state.tray = { ...state.tray, instances: 0 }
    },
    getInstance: () => ({ gotLock: true }),
    applyInstance: () => state.calls.push(['instance:quit']),
    desired,
    now: () => 42
  })
  return { state, checkpoints, desired }
}

test('a sleep/resume check is idempotent: it repairs drift once and then does nothing', () => {
  const { state, checkpoints } = createFakeResidency({
    loginItem: currentLogin({ path: 'D:\\Old\\Highlighter.exe' })
  })
  const first = checkpoints.checkSleepResume()
  assert.equal(first.kind, 'sleep-resume')
  assert.equal(first.changed, true)
  assert.deepEqual(first.applied, ['login-item:apply'])
  assert.equal(state.loginItem.path, APP_TARGET)

  const second = checkpoints.checkSleepResume()
  assert.equal(second.changed, false)
  assert.deepEqual(second.applied, [])
  assert.equal(checkpoints.reports.length, 2)
})

test('an Explorer-restart check restores the single icon and a duplicate count is deduped', () => {
  const explorer = createFakeResidency({ tray: { instances: 1, iconFile: ICON, iconVisible: false } })
  const restored = explorer.checkpoints.checkExplorerRestarted()
  assert.deepEqual(restored.applied, ['tray:restore'])
  assert.equal(explorer.state.tray.iconVisible, true)
  assert.equal(explorer.checkpoints.checkExplorerRestarted().changed, false)

  const duplicated = createFakeResidency({ tray: { instances: 2, iconFile: ICON, iconVisible: true } })
  const deduped = duplicated.checkpoints.check()
  assert.deepEqual(deduped.applied, ['tray:dedupe'])
  assert.equal(duplicated.state.tray.instances, 1)
  // Exactly one icon remains and a repeat check is a no-op.
  assert.equal(duplicated.checkpoints.check().changed, false)
  assert.equal(duplicated.state.tray.instances, 1)
})

test('the checkpoints never create a second tray when one is already correct', () => {
  const { state, checkpoints } = createFakeResidency()
  checkpoints.check()
  checkpoints.checkSleepResume()
  checkpoints.checkExplorerRestarted()
  assert.deepEqual(state.calls, [])
  assert.equal(state.tray.instances, 1)
  assert.equal(checkpoints.reports.every((report) => report.changed === false), true)
})

test('a missing or stale icon is created/repainted once through the checkpoint callbacks', () => {
  const missing = createFakeResidency({ tray: { instances: 0, iconFile: ICON, iconVisible: true } })
  assert.deepEqual(missing.checkpoints.check().applied, ['tray:create'])
  assert.equal(missing.state.tray.instances, 1)
  assert.equal(missing.checkpoints.check().changed, false)

  const stale = createFakeResidency({ tray: { instances: 1, iconFile: 'old.png', iconVisible: true } })
  assert.deepEqual(stale.checkpoints.check().applied, ['tray:update'])
  assert.equal(stale.state.tray.iconFile, ICON)
  assert.equal(stale.checkpoints.check().changed, false)
})

test('disabling the tray destroys the live icon through the checkpoint and stays idempotent', () => {
  let instances = 1
  const calls = []
  const checkpoints = createResidencyCheckpoints({
    getLoginItem: () => ({ openAtLogin: false }),
    getTray: () => ({ instances }),
    destroyTray: () => {
      calls.push('destroy')
      instances = 0
    },
    desired: { loginItem: { openAtLogin: false }, tray: { enabled: false } }
  })
  const first = checkpoints.check()
  assert.deepEqual(first.applied, ['tray:destroy'])
  assert.equal(instances, 0)
  assert.equal(checkpoints.check().changed, false)
  assert.deepEqual(calls, ['destroy'])
})
