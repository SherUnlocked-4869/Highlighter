const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const electronPath = require('electron')
const installedElectron = require('electron/package.json')
const projectPackage = require('../package.json')
const packageLock = require('../package-lock.json')
const resultPrefix = 'HIGHLIGHTER_RUNTIME_PROBE='

test('runtime stays on the WeType-compatible Electron release', () => {
  // Electron 42+ causes WeType 2.1.1.6 to reinterpret Chrome CF_HTML bytes
  // as UTF-16 whenever the Electron window regains focus. Keep this exact pin
  // until the real Chrome -> Highlighter focus probe passes on a newer runtime.
  assert.equal(projectPackage.devDependencies.electron, '41.10.3')
  assert.equal(packageLock.packages['node_modules/electron'].version, '41.10.3')
  assert.equal(installedElectron.version, '41.10.3')
  assert.equal(projectPackage.scripts.postinstall, undefined)
})

test('Electron loads Node-API modules and resolves packaged native components', { timeout: 45000 }, (t) => {
  const probeDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-electron-runtime-test-'))
  t.after(() => fs.rmSync(probeDataRoot, { recursive: true, force: true }))
  const result = spawnSync(electronPath, [path.join(root, 'scripts', 'probe-electron-runtime.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 40000,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: '0',
      HIGHLIGHTER_RUNTIME_PROBE_DATA_ROOT: probeDataRoot
    }
  })

  assert.equal(
    result.status,
    0,
    `Electron runtime probe failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith(resultPrefix))
  assert.ok(line, `Electron runtime probe did not return JSON.\nstdout:\n${result.stdout}`)
  const probe = JSON.parse(line.slice(resultPrefix.length))

  assert.equal(probe.versions.electron, installedElectron.version)
  assert.equal(probe.platform.name, 'win32')
  assert.equal(probe.platform.arch, 'x64')
  assert.equal(probe.modules.selectionHook.loaded, true)
  assert.equal(probe.modules.selectionHook.initiallyRunning, false)
  assert.equal(probe.modules.sharp.loaded, true)
  assert.equal(probe.modules.sharp.version, '0.35.3')
  assert.ok(probe.modules.sharp.libvipsVersion)
  assert.ok(probe.modules.sharp.pngBytes > 0)
  assert.equal(probe.components.smartSelect.name, 'SmartSelect.exe')
  assert.equal(probe.components.scrollDriver.name, 'ScrollDriver.exe')
  assert.equal(probe.components.ocrSidecar.name, 'HighlighterOcrSidecar.exe')
  assert.equal(probe.components.onnxRuntime.name, 'onnxruntime.dll')
  assert.equal(probe.components.ffmpeg.name, 'ffmpeg.exe')
  assert.equal(probe.components.ffmpeg.exists, true)
  assert.ok(probe.components.ffmpeg.size > 0)
  assert.equal(probe.preloads.length, 10)
  for (const preload of probe.preloads) {
    assert.equal(preload.sandboxed, true, `${preload.preload} did not run in a sandbox`)
    assert.ok(preload.exposedKeys > 0, `${preload.preload} did not expose its API`)
  }
  assert.equal(probe.localPages.length, 10)
  for (const page of probe.localPages) {
    assert.deepEqual(page.preloadErrors, [], `${page.page} preload failed`)
    assert.deepEqual(page.cspMessages, [], `${page.page} violated its CSP`)
  }
  assert.match(probe.actionSecurity.csp, /default-src 'none'/)
  assert.equal(probe.actionSecurity.domPurify, true)
  assert.equal(probe.actionSecurity.xss, 0)
  assert.equal(probe.actionSecurity.dangerousElements, 0)
  assert.equal(probe.actionSecurity.eventAttributes, 0)
  assert.equal(probe.actionSecurity.dangerousLinks, 0)
  assert.match(probe.actionSecurity.html, /href="https:\/\/example\.com\/docs"/)
  assert.deepEqual(probe.actionSecurity.preloadErrors, [])
  assert.deepEqual(probe.actionSecurity.cspMessages, [])
  assert.equal(probe.ipcSecurity.policyCount, 97)
  assert.equal(probe.ipcSecurity.allowedChannel, 'settings:get')
  assert.equal(probe.ipcSecurity.crossPageResult.blocked, true)
  assert.match(probe.ipcSecurity.crossPageResult.error, /IPC sender not authorized/)
  assert.ok(probe.ipcSecurity.blockedReasons.includes('page-not-allowed'))
  assert.ok(probe.displays.length >= 1)

  if (probe.components.nativeRuntimeBuilt || process.env.HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME === '1') {
    assert.equal(probe.components.nativeRuntimeBuilt, true)
    assert.equal(probe.components.ocrFilesValidated, true)
  }
})
