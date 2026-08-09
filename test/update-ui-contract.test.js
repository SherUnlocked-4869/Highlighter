const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
const config = fs.readFileSync(path.join(root, 'config/config.js'), 'utf8')

test('main process owns updater lifecycle, diagnostics, channel settings, and install gate', () => {
  assert.match(main, /updateChannel: 'stable'/)
  assert.match(main, /normalized\.system\.updateChannel = normalized\.system\.updateChannel === 'beta' \? 'beta' : 'stable'/)
  assert.match(main, /new UpdateService\(\{[\s\S]*getUpdateInstallReadiness[\s\S]*markSessionClean\('update-install'\)/)
  assert.match(main, /getUpdateStatus: \(\) => updateService\?\.getStatus\(\)/)
  assert.match(main, /initializeUpdateService\(\)[\s\S]*initializeDiagnostics\(\)[\s\S]*updateService\.start\(\)/)
  assert.match(main, /app\.on\('will-quit',[\s\S]*updateService\?\.dispose\(\)/)
})

test('preload and about page expose fixed update actions without renderer URLs', () => {
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
