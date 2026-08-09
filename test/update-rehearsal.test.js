const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_UPDATE_FAILURE_PROBE='

test('real Electron updater failures preserve the current version and user data', { timeout: 70000 }, (t) => {
  const rehearsalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-update-failure-test-'))
  t.after(() => fs.rmSync(rehearsalRoot, { recursive: true, force: true }))
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-update-failures.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 65000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_UPDATE_FAILURE_ROOT: rehearsalRoot
    }
  })
  assert.equal(
    result.status,
    0,
    `Electron update rehearsal failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Update rehearsal did not return JSON.\nstdout:\n${result.stdout}`)
  const report = JSON.parse(line.slice(resultPrefix.length))
  assert.equal(report.updaterVersion, '6.8.9')
  assert.deepEqual(report.scenarios.map((scenario) => scenario.name), [
    'invalid-manifest',
    '404',
    'interrupted-download',
    'signature-mismatch',
    'disk-full'
  ])
  assert.deepEqual(report.scenarios.map((scenario) => scenario.errorCode), [
    'update-metadata-invalid',
    'network-error',
    'network-error',
    'signature-invalid',
    'disk-full'
  ])
  assert.ok(report.scenarios.every((scenario) => scenario.currentBinaryPreserved))
  assert.ok(report.scenarios.every((scenario) => scenario.userDataPreserved))
  assert.ok(report.scenarios.every((scenario) => !scenario.installTriggered))
  assert.ok(report.scenarios.every((scenario) => scenario.cachedExecutableCount === 0))
  assert.ok(report.requests.filter((request) => request === '/latest.yml').length >= 5)
  assert.equal(report.requests.includes('/beta.yml'), false)
})
