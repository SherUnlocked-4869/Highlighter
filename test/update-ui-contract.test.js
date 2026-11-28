const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const settingsDefaults = fs.readFileSync(path.join(root, 'main', 'services', 'settings-defaults.js'), 'utf8')
const settingsNormalize = fs.readFileSync(path.join(root, 'main', 'services', 'settings-normalize.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const updateIpc = fs.readFileSync(path.join(root, 'main', 'ipc', 'update-ipc.js'), 'utf8')
const updateDomain = fs.readFileSync(path.join(root, 'main', 'domains', 'update', 'index.js'), 'utf8')
const config = readConfigSource()

test('main process owns updater lifecycle, diagnostics, channel settings, and install gate', () => {
  assert.match(settingsDefaults, /updateChannel: 'stable'/)
  assert.match(settingsNormalize, /normalized\.system\.updateChannel = normalized\.system\.updateChannel === 'beta' \? 'beta' : 'stable'/)
  // D06: the lifecycle moved to main/domains/update, so main.js only assembles the
  // dependencies; the state machine still lives in main/services/update-service.js.
  assert.match(updateDomain, /new UpdateService\(\{/)
  assert.match(updateDomain, /getInstallType\(\)[\s\S]*require\('electron-updater'\)\.autoUpdater/)
  assert.match(main, /canInstall: async \(\) => getUpdateInstallReadiness\(\)/)
  assert.match(main, /markSessionClean\('update-install'\)/)
  assert.match(main, /getUpdateStatus: \(\) => getUpdateDomain\(\)\.getStatus\(\)/)
  assert.match(main, /initializeDiagnostics\(\)[\s\S]*getUpdateDomain\(\)\.deferStart\(\)/)
  assert.match(updateDomain, /function deferStart\(\)[\s\S]*if \(!autoCheckEnabled\(\)\) return false[\s\S]*resolve\(\)\.start\(\)/)
  // The five fixed operations moved to main/ipc/update-ipc.js (main.js line
  // budget); each still resolves the lazily created service through main.js's
  // resolver, so the updater is not constructed until it is really needed.
  assert.match(updateIpc, /getStatus: \(\) => service\(\)\.getStatus\(\)/)
  // H05: registration lives in main/ipc/index.js.
  const ipcIndex = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'index.js'), 'utf8')
  assert.match(ipcIndex, /updateService: createUpdateIpcController\(\{[\s\S]*getUpdateService: \(\) => resolveUpdateService\(\)/)
  assert.match(main, /app\.on\('will-quit',[\s\S]*updateDomain\?\.dispose\(\)/)
})

test('D01: the scheduled check is opt-in and defaults to off', () => {
  assert.match(settingsDefaults, /autoCheckUpdates: false/)
  assert.match(settingsNormalize, /normalized\.system\.autoCheckUpdates = normalized\.system\.autoCheckUpdates === true/)
  // The startup path returns before arming a timer, so a default install never even
  // constructs electron-updater (a manual check still resolves it on demand).
  assert.match(updateDomain, /function deferStart\(\) \{[\s\S]*?if \(!autoCheckEnabled\(\)\) return false/)
  assert.match(updateDomain, /autoCheckEnabled: autoCheckEnabled\(\)/)
  assert.match(updateDomain, /const installType = getInstallType\(\)[\s\S]*if \(installType === 'nsis'\)/)
  // The switch itself lives on the update card and writes the same setting.
  assert.match(config, /data-switch="autoCheckUpdates" data-group="system"/)
  assert.match(config, /'config\.about\.auto-check-updates'/)
})

test('preload and the General settings page expose fixed update actions without renderer URLs', () => {
  for (const channel of ['update:status', 'update:check', 'update:download', 'update:install', 'update:open-download-page']) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'\\)`))
  }
  assert.match(preload, /ipcRenderer\.on\('update:status'/)
  assert.match(config, /window\.electronAPI\.getUpdateStatus\(\)/)
  assert.match(config, /window\.electronAPI\.onUpdateStatus/)
  assert.match(config, /window\.electronAPI\.checkForUpdates\(\)/)
  assert.match(config, /window\.electronAPI\.downloadUpdate\(\)/)
  assert.match(config, /window\.electronAPI\.installUpdate\(\)/)
  assert.match(config, /status\.channel === 'beta'/)
  assert.match(config, /escapeHtml\(status\.releaseNotes\)/)
  assert.doesNotMatch(config, /electronAPI\.openExternal\([^)]*status/)
})
