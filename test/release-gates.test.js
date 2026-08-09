const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { FuseV1Options } = require('@electron/fuses')
const { assertFuseStates } = require('../scripts/verify-electron-fuses')

const root = path.join(__dirname, '..')
const powershell = 'powershell.exe'

function runPowerShell(script, args = [], env = process.env) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8'
  })
}

function createFakeRelease(version = '2.1.0-beta.0') {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-release-gate-'))
  fs.mkdirSync(path.join(dist, 'win-unpacked'))
  fs.writeFileSync(path.join(dist, `Highlighter-Setup-${version}.exe`), 'setup')
  fs.writeFileSync(path.join(dist, `Highlighter-${version}-portable.exe`), 'portable')
  fs.writeFileSync(path.join(dist, `Highlighter-Setup-${version}.exe.blockmap`), 'blockmap')
  fs.writeFileSync(path.join(dist, 'win-unpacked', 'Highlighter.exe'), 'main')
  fs.writeFileSync(path.join(dist, 'beta.yml'), `version: ${version}\npath: Highlighter-Setup-${version}.exe\n`)
  fs.writeFileSync(path.join(dist, 'sbom.cdx.json'), JSON.stringify({
    bomFormat: 'CycloneDX',
    metadata: { component: { version } }
  }))
  return dist
}

test('release fuse policy rejects any downgraded production fuse', () => {
  const wire = {
    version: '1',
    [FuseV1Options.RunAsNode]: 48,
    [FuseV1Options.EnableCookieEncryption]: 49,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 48,
    [FuseV1Options.EnableNodeCliInspectArguments]: 48,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 49,
    [FuseV1Options.OnlyLoadAppFromAsar]: 49,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: 49,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: 49
  }
  assert.equal(assertFuseStates(wire).length, 8)
  assert.throws(() => assertFuseStates({ ...wire, [FuseV1Options.RunAsNode]: 49 }), /RunAsNode expected off/)
})

test('release verifier requires both artifacts and writes auditable hashes', { skip: process.platform !== 'win32' }, (t) => {
  const dist = createFakeRelease()
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }))
  const result = runPowerShell(path.join(root, 'scripts', 'verify-release.ps1'), [
    '-DistDir', dist,
    '-ExpectedVersion', '2.1.0-beta.0',
    '-SkipFuseVerification'
  ])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const hashes = fs.readFileSync(path.join(dist, 'SHA256SUMS.txt'), 'utf8')
  assert.match(hashes, /Highlighter-Setup-2\.1\.0-beta\.0\.exe/)
  assert.match(hashes, /Highlighter-2\.1\.0-beta\.0-portable\.exe/)
  assert.match(hashes, /sbom\.cdx\.json/)
})

test('release verifier rejects a mismatched manifest version', { skip: process.platform !== 'win32' }, (t) => {
  const dist = createFakeRelease()
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dist, 'beta.yml'), 'version: 9.9.9\npath: wrong.exe\n')
  const result = runPowerShell(path.join(root, 'scripts', 'verify-release.ps1'), [
    '-DistDir', dist,
    '-ExpectedVersion', '2.1.0-beta.0',
    '-SkipFuseVerification'
  ])
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /No update manifest matches version/)
})

test('signing preparation validates PFX secrets without writing them', { skip: process.platform !== 'win32' }, () => {
  const env = {
    ...process.env,
    WIN_SIGNING_PROVIDER: 'pfx',
    WIN_SIGNING_PUBLISHER: 'Highlighter Test',
    WIN_CSC_LINK: 'sensitive-pfx-link',
    WIN_CSC_KEY_PASSWORD: 'sensitive-password'
  }
  const result = runPowerShell(path.join(root, 'scripts', 'prepare-release-signing.ps1'), [], env)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.stdout.trim(), 'electron-builder.release.cjs')
  assert.doesNotMatch(result.stdout, /sensitive/)
})

test('signing preparation emits Azure metadata without credentials', { skip: process.platform !== 'win32' }, (t) => {
  const output = path.join(os.tmpdir(), `highlighter-azure-signing-${process.pid}.json`)
  t.after(() => fs.rmSync(output, { force: true }))
  const env = {
    ...process.env,
    WIN_SIGNING_PROVIDER: 'azure',
    WIN_SIGNING_PUBLISHER: 'Highlighter Test',
    WIN_AZURE_ENDPOINT: 'https://example.codesigning.azure.net',
    WIN_AZURE_CERTIFICATE_PROFILE: 'highlighter-profile',
    WIN_AZURE_CODE_SIGNING_ACCOUNT: 'highlighter-account',
    AZURE_TENANT_ID: 'tenant-id',
    AZURE_CLIENT_ID: 'client-id',
    AZURE_CLIENT_SECRET: 'sensitive-client-secret'
  }
  const result = runPowerShell(path.join(root, 'scripts', 'prepare-release-signing.ps1'), ['-OutputPath', output], env)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const config = fs.readFileSync(output, 'utf8')
  assert.match(config, /highlighter-profile/)
  assert.match(config, /electron-builder\.release\.cjs/)
  assert.doesNotMatch(config, /sensitive-client-secret|tenant-id|client-id/)
})

test('release workflows enforce version, native, signing, integrity, and draft gates', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-ci.yml'), 'utf8')
  const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  const config = require('../electron-builder.release.cjs')
  assert.match(ci, /npm run audit:dependencies/)
  assert.match(ci, /npm run check:version/)
  assert.match(ci, /npm run test:long-capture/)
  assert.match(ci, /HIGHLIGHTER_REQUIRE_NATIVE_RUNTIME/)
  assert.match(ci, /npm run verify:package/)
  assert.match(release, /environment: release/)
  assert.match(release, /npm run audit:dependencies/)
  assert.match(release, /npm run verify:release/)
  assert.match(release, /gh release create .*--draft/)
  assert.doesNotMatch(release, /dist\/\*\.yml/)
  assert.equal(config.forceCodeSigning, true)
  assert.equal(config.publish.channel, 'beta')
  assert.equal(config.electronFuses.enableEmbeddedAsarIntegrityValidation, true)
  assert.equal(config.electronFuses.onlyLoadAppFromAsar, true)
})
