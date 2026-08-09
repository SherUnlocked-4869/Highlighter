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
const resultPrefix = 'HIGHLIGHTER_RUNTIME_PROBE='

test('fresh installs explicitly provision the pinned Electron binary', () => {
  assert.equal(projectPackage.devDependencies.electron, '43.2.0')
  assert.equal(projectPackage.scripts.postinstall, 'install-electron --no')
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
  assert.ok(probe.modules.sharp.pngBytes > 0)
  assert.equal(probe.components.smartSelect.name, 'SmartSelect.exe')
  assert.equal(probe.components.ocrSidecar.name, 'HighlighterOcrSidecar.exe')
  assert.equal(probe.components.onnxRuntime.name, 'onnxruntime.dll')
  assert.equal(probe.components.ffmpeg.name, 'ffmpeg.exe')
  assert.equal(probe.components.ffmpeg.exists, true)
  assert.ok(probe.components.ffmpeg.size > 0)
  assert.ok(probe.displays.length >= 1)

  if (process.env.HIGHLIGHTER_REQUIRE_CAPTURE_RUNTIME === '1') {
    assert.equal(probe.captureRuntime.required, true)
    assert.ok(probe.captureRuntime.nativeDisplayCount >= 1)
    assert.ok(probe.captureRuntime.width > 0)
    assert.ok(probe.captureRuntime.height > 0)
    assert.equal(probe.captureRuntime.nonBlank, true)
  }

  if (probe.components.nativeRuntimeBuilt || process.env.HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME === '1') {
    assert.equal(probe.components.nativeRuntimeBuilt, true)
    assert.equal(probe.components.ocrFilesValidated, true)
  }
})
