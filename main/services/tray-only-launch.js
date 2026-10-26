'use strict'

// M2/W6a: launching the app at login must not cost a renderer for a window the
// user did not ask for. Windows' `getLoginItemSettings()` cannot tell whether
// the current launch came from the login item, so the login item carries an
// explicit argv marker that startup reads. Existing registrations created before
// this change have no marker and therefore keep the old "open the main window"
// behaviour until the next time settings are saved.
const START_TO_TRAY_FLAG = '--start-to-tray'
const LOGIN_ITEM_ARGS = Object.freeze([START_TO_TRAY_FLAG])

function isStartToTrayLaunch(argv = process.argv, { e2e = false } = {}) {
  if (e2e) return false
  const args = Array.isArray(argv) ? argv : []
  return args.some((arg) => {
    const value = String(arg)
    return value === START_TO_TRAY_FLAG || value.startsWith(`${START_TO_TRAY_FLAG}=`)
  })
}

// The single shape both `setLoginItemSettings` call sites use. `args` is honored
// on Windows and macOS; other platforms simply ignore the extra field.
function loginItemSettings(openAtLogin) {
  return { openAtLogin: !!openAtLogin, args: [...LOGIN_ITEM_ARGS] }
}

module.exports = {
  LOGIN_ITEM_ARGS,
  START_TO_TRAY_FLAG,
  isStartToTrayLaunch,
  loginItemSettings
}
