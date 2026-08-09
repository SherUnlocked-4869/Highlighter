const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { DiagnosticsService } = require('../main/services/diagnostics-service')

async function withTempDirectory(callback) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-diagnostics-'))
  try {
    return await callback(directory)
  } finally {
    await fsp.rm(directory, { recursive: true, force: true })
  }
}

function createService(root) {
  const logs = path.join(root, 'logs')
  const runtime = path.join(root, 'runtime')
  const crashDumps = path.join(runtime, 'crash-dumps')
  const componentPath = path.join(root, 'components', 'SmartSelect.exe')
  const logFile = path.join(logs, 'app.log')
  const apiKey = 'sk-DiagnosticsCanary99'
  const prompt = 'CANARY_PROMPT_NEVER_EXPORT'
  const userProfile = 'C:\\Users\\CanaryUser'
  fs.mkdirSync(path.dirname(componentPath), { recursive: true })
  fs.mkdirSync(logs, { recursive: true })
  fs.mkdirSync(crashDumps, { recursive: true })
  fs.writeFileSync(componentPath, 'component-binary')
  fs.writeFileSync(logFile, [
    `api=${apiKey}`,
    'Authorization: Bearer bearer-canary-value',
    'apiKey=legacy-arbitrary-key',
    `prompt=${prompt}`,
    JSON.stringify({ event: 'legacy-request-error', details: { content: 'CANARY_AI_BODY_NEVER_EXPORT' } }),
    `failure at ${userProfile}\\Documents\\capture.png`,
    `managed path ${root}\\history\\secret.png`
  ].join('\n'))
  fs.writeFileSync(path.join(crashDumps, 'renderer.dmp'), Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(path.join(runtime, 'session.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId: 'previous-session',
    version: '2.1.0-beta.0',
    startedAt: '2026-08-08T12:00:00.000Z',
    state: 'running'
  }))

  const service = new DiagnosticsService({
    sessionId: 'current-session',
    version: '2.1.0-beta.0',
    paths: {
      dataRoot: root,
      logs,
      logFile,
      runtime,
      crashDumps,
      userProfile,
      temp: path.join(root, 'temp'),
      resources: path.join(root, 'resources'),
      appRoot: path.join(root, 'app')
    },
    screen: {
      getAllDisplays: () => [{
        id: 1,
        label: 'Display 1',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1.25,
        rotation: 0,
        internal: false
      }]
    },
    getAppInfo: () => ({ name: 'Highlighter', version: '2.1.0-beta.0', packaged: true, installType: 'nsis' }),
    getComponents: () => [{ name: 'SmartSelect', path: componentPath }],
    getSensitiveValues: () => [apiKey, prompt],
    getUpdateStatus: () => ({ status: 'not-configured', lastError: null }),
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    platform: 'win32',
    architecture: 'x64',
    versions: { electron: '43.2.0', chrome: '144.0.0.0', node: '24.0.0' },
    system: { release: () => '10.0.26100', version: () => 'Windows 11 Pro' }
  })
  return { service, apiKey, prompt, userProfile, componentPath, logFile, runtime }
}

test('runtime session markers detect unclean exits and are atomically marked clean', async () => {
  await withTempDirectory(async (root) => {
    const { service, runtime } = createService(root)
    const session = service.startSession()
    assert.equal(session.previousExit.clean, false)
    assert.equal(session.previousExit.exitType, 'unclean')

    const running = JSON.parse(await fsp.readFile(path.join(runtime, 'session.json'), 'utf8'))
    assert.equal(running.sessionId, 'current-session')
    assert.equal(running.state, 'running')
    const exits = JSON.parse(await fsp.readFile(path.join(runtime, 'process-exits.json'), 'utf8'))
    assert.equal(exits[0].details.reason, 'previous-session-unclean')

    assert.equal(service.markClean('quit'), true)
    assert.equal(service.markClean('quit'), false)
    const clean = JSON.parse(await fsp.readFile(path.join(runtime, 'session.json'), 'utf8'))
    assert.equal(clean.state, 'clean')
    assert.equal(clean.exitType, 'quit')
    assert.equal(fs.readdirSync(runtime).some((name) => name.endsWith('.tmp') || name.endsWith('.bak')), false)
  })
})

test('diagnostic preview summarizes components, displays, exits, logs, and local privacy state', async () => {
  await withTempDirectory(async (root) => {
    const { service, componentPath } = createService(root)
    service.startSession()
    service.recordProcessExit('renderer', {
      reason: 'crashed',
      url: 'file:///C:/Users/CanaryUser/app/config.html?token=url-canary'
    })
    const preview = await service.preview()

    assert.equal(preview.privacy.offline, true)
    assert.equal(preview.privacy.automaticUpload, false)
    assert.equal(preview.privacy.crashDumpsIncluded, false)
    assert.equal(preview.application.installType, 'nsis')
    assert.equal(preview.displays[0].scaleFactor, 1.25)
    assert.equal(preview.components[0].exists, true)
    assert.equal(preview.components[0].path.includes('%DATA_ROOT%'), true)
    assert.equal(preview.components[0].sha256, crypto.createHash('sha256').update(fs.readFileSync(componentPath)).digest('hex'))
    assert.equal(preview.session.previousExit.exitType, 'unclean')
    assert.equal(preview.processExits.at(-1).details.url.includes('%USERPROFILE%'), true)
    assert.equal(preview.processExits.at(-1).details.url.includes('url-canary'), false)
    assert.equal(preview.logs[0].name, 'app.log')
    assert.equal(preview.crashDumps.available, 1)
  })
})

test('diagnostic ZIP redacts canaries and paths while excluding media, config, and crash dumps by default', async () => {
  await withTempDirectory(async (root) => {
    const { service, apiKey, prompt, userProfile } = createService(root)
    service.startSession()
    const outputPath = path.join(root, 'diagnostics.zip')
    const result = await service.exportZip(outputPath)
    const archive = new AdmZip(outputPath)
    const names = archive.getEntries().map((entry) => entry.entryName)
    const text = archive.getEntries().map((entry) => entry.getData().toString('utf8')).join('\n')

    assert.equal(result.crashDumpsIncluded, false)
    assert.deepEqual(names.sort(), ['README.txt', 'logs/app.log', 'summary.json'])
    assert.doesNotMatch(text, new RegExp(apiKey))
    assert.doesNotMatch(text, /bearer-canary-value/)
    assert.doesNotMatch(text, /legacy-arbitrary-key/)
    assert.doesNotMatch(text, new RegExp(prompt))
    assert.doesNotMatch(text, /CANARY_AI_BODY_NEVER_EXPORT/)
    assert.doesNotMatch(text, new RegExp(userProfile.replace(/\\/g, '\\\\'), 'i'))
    assert.doesNotMatch(text, new RegExp(root.replace(/\\/g, '\\\\'), 'i'))
    assert.match(text, /%DATA_ROOT%|%USERPROFILE%/)
    assert.equal(names.some((name) => /config|history|screenshot|recording|ocr/i.test(name)), false)
    assert.equal(names.some((name) => name.endsWith('.dmp')), false)
  })
})

test('diagnostic ZIP includes local crash dumps only after explicit opt-in', async () => {
  await withTempDirectory(async (root) => {
    const { service } = createService(root)
    service.startSession()
    const outputPath = path.join(root, 'diagnostics-with-dump.zip')
    const result = await service.exportZip(outputPath, { includeCrashDumps: true })
    const archive = new AdmZip(outputPath)

    assert.equal(result.crashDumpsIncluded, true)
    assert.ok(archive.getEntry('crash-dumps/renderer.dmp'))
    const summary = JSON.parse(archive.getEntry('summary.json').getData().toString('utf8'))
    assert.equal(summary.privacy.crashDumpsIncluded, true)
    assert.equal(summary.crashDumps.included, true)
  })
})
