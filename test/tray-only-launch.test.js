const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  LOGIN_ITEM_ARGS,
  START_TO_TRAY_FLAG,
  isStartToTrayLaunch,
  loginItemSettings
} = require('../main/services/tray-only-launch')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

test('the login item marker is only recognised as a whole argument', () => {
  assert.equal(isStartToTrayLaunch(['Highlighter.exe', START_TO_TRAY_FLAG]), true)
  assert.equal(isStartToTrayLaunch([`${START_TO_TRAY_FLAG}=1`]), true)
  assert.equal(isStartToTrayLaunch(['Highlighter.exe']), false)
  assert.equal(isStartToTrayLaunch(['--something-start-to-tray']), false, 'a prefix of another flag must not match')
  assert.equal(isStartToTrayLaunch(null), false)
  assert.equal(isStartToTrayLaunch([], {}), false)
})

test('automation launches never start to the tray', () => {
  assert.equal(isStartToTrayLaunch([START_TO_TRAY_FLAG], { e2e: true }), false)
})

test('login item settings keep the openAtLogin boolean and always carry the marker', () => {
  assert.deepEqual(loginItemSettings(true), { openAtLogin: true, args: [START_TO_TRAY_FLAG] })
  assert.deepEqual(loginItemSettings(false), { openAtLogin: false, args: [START_TO_TRAY_FLAG] })
  assert.deepEqual(loginItemSettings(undefined), { openAtLogin: false, args: [START_TO_TRAY_FLAG] })
  assert.deepEqual([...LOGIN_ITEM_ARGS], [START_TO_TRAY_FLAG])
  // The returned object is fresh, so a caller mutating it cannot poison the module.
  const first = loginItemSettings(true)
  first.args.push('--extra')
  assert.deepEqual(loginItemSettings(true).args, [START_TO_TRAY_FLAG])
})

// Contract: both assembly sites must go through the helper and startup must skip
// the main window for a tray-only launch, otherwise the marker becomes dead code.
test('main.js wires the tray-only launch instead of creating the window unconditionally', () => {
  assert.match(main, /const startToTray = isStartToTrayLaunch\(process\.argv, \{ e2e: e2eContext\.enabled \}\)/)
  assert.match(main, /if \(!startToTray\) createMainWindow\('home'\)/)
  assert.match(main, /app\.setLoginItemSettings\(loginItemSettings\(getSettings\(\)\.system\.autoStart\)\)/)
  assert.doesNotMatch(main, /app\.setLoginItemSettings\(\{ openAtLogin/)
})
