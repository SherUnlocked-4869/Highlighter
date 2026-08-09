const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const AdmZip = require('adm-zip')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const resultPrefix = 'HIGHLIGHTER_DIAGNOSTICS_RUNTIME_PROBE='

test('real Electron main process previews and exports offline diagnostics, then records a clean exit', { timeout: 45000 }, (t) => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-diagnostics-runtime-'))
  const userData = path.join(probeRoot, 'user-data')
  const outputPath = path.join(probeRoot, 'diagnostics.zip')
  t.after(() => fs.rmSync(probeRoot, { recursive: true, force: true }))

  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-diagnostics-runtime.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 40000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_DIAGNOSTICS_USER_DATA: userData,
      HIGHLIGHTER_DIAGNOSTICS_OUTPUT: outputPath
    }
  })

  assert.equal(
    result.status,
    0,
    `Diagnostics runtime probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Diagnostics runtime probe did not return JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  assert.equal(probe.crashUploadEnabled, false)
  assert.deepEqual(probe.renderer.apiKeys, ['exportDiagnostics', 'getDisplayDiagnostics', 'previewDiagnostics'])
  assert.equal(probe.renderer.preview.privacy.offline, true)
  assert.equal(probe.renderer.preview.privacy.automaticUpload, false)
  assert.equal(probe.renderer.preview.application.installType, 'development')
  assert.equal(probe.renderer.exportCompleted, true)
  assert.equal(fs.existsSync(outputPath), true)

  const archive = new AdmZip(outputPath)
  assert.ok(archive.getEntry('summary.json'))
  assert.equal(archive.getEntries().some((entry) => entry.entryName.endsWith('.dmp')), false)
  const summary = JSON.parse(archive.getEntry('summary.json').getData().toString('utf8'))
  assert.equal(summary.privacy.crashDumpsIncluded, false)
  const marker = JSON.parse(fs.readFileSync(path.join(userData, 'runtime', 'session.json'), 'utf8'))
  assert.equal(marker.state, 'clean')
  assert.equal(marker.exitType, 'quit')
  const logEntries = fs.readFileSync(path.join(userData, 'app.log'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(logEntries.some((entry) => entry.event === 'session-start'))
  assert.ok(logEntries.some((entry) => entry.event === 'session-end' && entry.details.exitType === 'quit'))
})
