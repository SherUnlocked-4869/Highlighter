const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { load } = require('js-yaml')
const { scripts, build } = require('../package.json')
const release = require('../electron-builder.release.cjs')

const root = path.resolve(__dirname, '..')
const helperName = 'HighlighterDeviceBattery.exe'

function workflow(file) {
  return load(fs.readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'))
}

function checkBuildOrder(steps, buildCommand) {
  const sdkIndex = steps.findIndex(step => step.uses?.startsWith('actions/setup-dotnet@'))
  const buildIndex = steps.findIndex(step => step.run === buildCommand)
  assert.ok(sdkIndex >= 0 && buildIndex > sdkIndex, `${buildCommand} must follow .NET SDK setup`)
  assert.equal(steps[sdkIndex].with['dotnet-version'], '10.0.404')
  return [steps[sdkIndex], steps[buildIndex]]
}

test('native build and both x64 release targets use the complete battery publish directory', () => {
  // 8416120 switched every npm PowerShell step from Windows PowerShell 5.1 to pwsh 7; the gate
  // pins the new interpreter so the build cannot silently fall back to 5.1's ANSI decoding.
  assert.match(scripts['build:device-battery'], /^pwsh -NoProfile -File native\/device-battery\/build\.ps1$/)
  assert.ok(scripts['build:native'].split(' && ').includes('npm run build:device-battery'))
  const resource = {
    from: 'native/device-battery/bin',
    to: 'native/device-battery'
  }
  for (const config of [build, release]) {
    assert.deepEqual(config.extraResources.filter(entry => entry.to === resource.to), [resource])
    for (const target of ['nsis', 'portable']) {
      assert.ok(config.win.target.some(entry => entry.target === target && entry.arch.includes('x64')))
    }
  }
})

test('PR builds and smokes only the battery helper; package and releases build through native scripts', () => {
  const ci = workflow('windows-ci.yml')
  assert.ok(ci.on.pull_request)
  const [prSdk, prBuild] = checkBuildOrder(ci.jobs.quality.steps, 'npm run build:device-battery -- -Verify')
  assert.equal(prSdk.if, "github.event_name == 'pull_request'")
  assert.equal(prBuild.if, prSdk.if)
  assert.ok(!ci.jobs.quality.steps.some(step => step.run === 'npm run build:native'))
  assert.equal(ci.jobs.package.if, "github.event_name != 'pull_request'")
  for (const [job, verification] of [
    [ci.jobs.package, 'npm run verify:package'],
    [workflow('release.yml').jobs.release, 'npm run verify:release'],
    [workflow('unsigned-release.yml').jobs.release, 'npm run verify:package']
  ]) {
    const [sdk, nativeBuild] = checkBuildOrder(job.steps, 'npm run build:native')
    assert.equal(sdk.if, undefined)
    const verifyIndex = job.steps.findIndex(step => step.run === verification)
    assert.ok(verifyIndex > job.steps.indexOf(nativeBuild), `${verification} must follow native build`)
  }
})

function runStaticVerifier(t, { missingFile, machine = 0x8664 }) {
  const dist = fs.mkdtempSync(path.join(root, '.tmp-device-battery-package-'))
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }))
  const unpacked = path.join(dist, 'win-unpacked')
  const clipboard = path.join(unpacked, 'resources', 'native', 'clipboard')
  const battery = path.join(unpacked, 'resources', 'native', 'device-battery')
  fs.mkdirSync(clipboard, { recursive: true })
  fs.mkdirSync(battery, { recursive: true })
  const setup = 'Highlighter-Setup-1.0.0.exe'
  for (const file of [
    path.join(dist, setup),
    path.join(dist, `${setup}.blockmap`),
    path.join(dist, 'Highlighter-1.0.0-portable.exe'),
    path.join(unpacked, 'Highlighter.exe'),
    path.join(clipboard, 'HighlighterClipboard.exe'),
    path.join(clipboard, 'build-info.json')
  ]) fs.writeFileSync(file, 'fixture')

  // Only the verifier's static checks are under test: no fake binary is ever run.
  const pe = Buffer.alloc(0x46)
  pe.writeUInt16LE(0x5a4d, 0)
  pe.writeInt32LE(0x40, 0x3c)
  pe.writeUInt32LE(0x4550, 0x40)
  pe.writeUInt16LE(machine, 0x44)
  fs.writeFileSync(path.join(battery, helperName), pe)
  for (const file of [
    'HighlighterDeviceBattery.dll', 'HighlighterDeviceBattery.deps.json',
    'HighlighterDeviceBattery.runtimeconfig.json', 'hostfxr.dll', 'hostpolicy.dll',
    'coreclr.dll', 'WindowsBase.dll', 'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll'
  ]) {
    if (file !== missingFile) fs.writeFileSync(path.join(battery, file), 'fixture')
  }

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-release.ps1'),
    '-DistDir', dist, '-ExpectedVersion', '1.0.0', '-SkipFuseVerification', '-SkipManifest', '-SkipSbom'
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.ifError(result.error)
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.replace(/\s+/g, ' ') }
}

test('release verifier rejects a missing battery runtime even without execution probes', { skip: process.platform !== 'win32' }, t => {
  const result = runStaticVerifier(t, { missingFile: 'coreclr.dll' })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Device battery self-contained runtime file is missing or empty: .*coreclr\.dll/)
})

test('release verifier rejects an x86 battery app host', { skip: process.platform !== 'win32' }, t => {
  const result = runStaticVerifier(t, { machine: 0x014c })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Device battery sidecar is not an x64 PE executable/)
})
