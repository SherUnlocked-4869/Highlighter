const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { verifyHardwareMatrix } = require('../scripts/verify-hardware-matrix')

const root = path.join(__dirname, '..')
const sourceCommit = 'a'.repeat(40)

function matrix() {
  return {
    schemaVersion: 1,
    requiredClaims: [
      { id: 'nsis-check', packageTypes: ['nsis'] },
      { id: 'portable-check', packageTypes: ['portable'] }
    ]
  }
}

function evidence(version, claims, packageType, overrides = {}) {
  return {
    schemaVersion: 1,
    candidate: { version, sourceCommit },
    environment: {
      osFamily: 'windows-11',
      osVersion: '25H2',
      osBuild: '26200.1',
      architecture: 'AMD64',
      sessionType: 'local',
      packageType,
      displays: [
        { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
        { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }
      ]
    },
    artifact: {
      name: packageType === 'nsis'
        ? `Highlighter-Setup-${version}.exe`
        : `Highlighter-${version}-portable.exe`,
      sha256: 'b'.repeat(64),
      signatureStatus: 'Valid',
      publisher: 'Highlighter Test',
      timestampSubject: 'CN=Timestamp Test'
    },
    probes: {
      runtime: {
        status: 'pass',
        nativeRuntimeBuilt: true,
        ocrFilesValidated: true,
        nativeCapture: { required: true, nonBlank: true }
      }
    },
    execution: {
      result: 'pass',
      completedAt: '2026-08-09T00:00:00.000Z',
      claims,
      checks: claims.map((id) => ({ id, result: 'pass', notes: 'checked' })),
      notes: 'Hardware workflow completed.',
      defects: []
    },
    signoff: { reviewer: 'release-reviewer', reviewedAt: '2026-08-09T00:00:00.000Z' },
    ...overrides
  }
}

function writeEvidence(items) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-hardware-matrix-'))
  items.forEach((item, index) => fs.writeFileSync(path.join(directory, `${index}.json`), JSON.stringify(item)))
  return { directory, files: fs.readdirSync(directory).map((name) => path.join(directory, name)) }
}

test('hardware matrix accepts complete signed evidence for one candidate', (t) => {
  const fixture = writeEvidence([
    evidence('2.1.0', ['nsis-check'], 'nsis'),
    evidence('2.1.0', ['portable-check'], 'portable')
  ])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  const result = verifyHardwareMatrix({
    matrix: matrix(),
    evidenceFiles: fixture.files,
    expectedVersion: '2.1.0',
    expectedSourceCommit: sourceCommit,
    changedPathsResolver: () => ['docs/releases/evidence/2.1.0/0.json']
  })
  assert.equal(result.valid, true, result.errors.join('\n'))
  assert.equal(result.coveredClaims.length, 2)
})

test('hardware matrix rejects missing claims, P1 defects, and source drift', (t) => {
  const fixture = writeEvidence([
    evidence('2.1.0', ['nsis-check'], 'nsis', {
      execution: {
        ...evidence('2.1.0', ['nsis-check'], 'nsis').execution,
        defects: [{ severity: 'P1', issueUrl: 'https://example.invalid/1', workaround: '' }]
      }
    })
  ])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  const result = verifyHardwareMatrix({
    matrix: matrix(),
    evidenceFiles: fixture.files,
    expectedVersion: '2.1.0',
    changedPathsResolver: () => ['main.js']
  })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /unresolved P1/)
  assert.match(result.errors.join('\n'), /missing passing evidence for portable-check/)
  assert.match(result.errors.join('\n'), /invalidated by source changes: main\.js/)
})

test('hardware matrix rejects unsigned evidence and the wrong package type', (t) => {
  const unsigned = evidence('2.1.0', ['portable-check'], 'nsis')
  unsigned.artifact.signatureStatus = 'NotSigned'
  const fixture = writeEvidence([unsigned])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  const result = verifyHardwareMatrix({
    matrix: matrix(),
    evidenceFiles: fixture.files,
    expectedVersion: '2.1.0',
    changedPathsResolver: () => []
  })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /does not accept nsis evidence/)
  assert.match(result.errors.join('\n'), /artifact signature must be Valid/)
})

test('production matrix binds DPI and RDP claims to observed environments', (t) => {
  const productionMatrix = JSON.parse(fs.readFileSync(path.join(root, 'config', 'release-hardware-matrix.json'), 'utf8'))
  const record = evidence('2.1.0', ['dpi-200-capture', 'rdp-degraded-capture'], 'nsis')
  const fixture = writeEvidence([record])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))
  const result = verifyHardwareMatrix({
    matrix: productionMatrix,
    evidenceFiles: fixture.files,
    expectedVersion: '2.1.0',
    changedPathsResolver: () => []
  })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /requires scale factor 2/)
  assert.match(result.errors.join('\n'), /requires an rdp session/)
})

test('promotion asset verifier detects hashes and manifest drift', { skip: process.platform !== 'win32' }, (t) => {
  const version = '2.1.0-beta.1'
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-promotion-assets-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const contents = new Map([
    [`Highlighter-Setup-${version}.exe`, 'setup'],
    [`Highlighter-${version}-portable.exe`, 'portable'],
    [`Highlighter-Setup-${version}.exe.blockmap`, 'blockmap'],
    ['beta.yml', `version: ${version}\npath: Highlighter-Setup-${version}.exe\n`],
    ['sbom.cdx.json', JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { version } } })]
  ])
  for (const [name, content] of contents) fs.writeFileSync(path.join(directory, name), content)
  const hashLines = [...contents.keys()].sort().map((name) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')
    return `${hash} *${name}`
  })
  fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), hashLines.join('\n'))

  const script = path.join(root, 'scripts', 'verify-promotion-assets.ps1')
  const valid = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DistDir', directory, '-ExpectedVersion', version, '-SkipSignature'
  ], { encoding: 'utf8' })
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`)

  fs.appendFileSync(path.join(directory, 'beta.yml'), 'tampered: true\n')
  const tampered = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DistDir', directory, '-ExpectedVersion', version, '-SkipSignature'
  ], { encoding: 'utf8' })
  assert.notEqual(tampered.status, 0)
  assert.match(`${tampered.stdout}\n${tampered.stderr}`, /SHA-256 mismatch for beta\.yml/)
})
