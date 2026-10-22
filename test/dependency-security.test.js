const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const packageJson = require('../package.json')
const lockfile = require('../package-lock.json')

function compareVersions(left, right) {
  const leftParts = left.split(/[.-]/).slice(0, 3).map(Number)
  const rightParts = right.split(/[.-]/).slice(0, 3).map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

function resolvedVersions(name) {
  const suffix = `/node_modules/${name}`
  return Object.entries(lockfile.packages)
    .filter(([location]) => location === `node_modules/${name}` || location.endsWith(suffix))
    .map(([, metadata]) => metadata.version)
    .filter(Boolean)
}

function assertMinimumVersion(name, minimum) {
  const versions = resolvedVersions(name)
  assert.ok(versions.length > 0, `${name} must be present in package-lock.json`)
  for (const version of versions) {
    assert.ok(
      compareVersions(version, minimum) >= 0,
      `${name}@${version} is below the audited minimum ${minimum}`
    )
  }
}

test('dependency audit is a required CI and release gate', () => {
  assert.equal(packageJson.scripts['audit:dependencies'], 'node scripts/audit-dependencies.js')
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'windows-ci.yml'), 'utf8')
  const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(ci, /npm run audit:dependencies/)
  assert.match(release, /npm run audit:dependencies/)
})

test('dependency audit allowlist is explicit, reasoned, and time-boxed', () => {
  const { ALLOWLIST, collectFindings, severityRank } = require('../scripts/audit-dependencies')
  // The list may be empty when the tree is clean - it is empty as of 2026-09-27.
  // What must hold is that the mechanism is reviewable and that any entry it does
  // carry is explicit, reasoned and time-boxed.
  assert.ok(ALLOWLIST instanceof Map, 'the audit gate must expose its allowlist for review')
  for (const [key, entry] of ALLOWLIST) {
    assert.match(key, /^[^|]+\|https:\/\/github\.com\/advisories\/GHSA-/, `allowlist key must be package|advisory-url: ${key}`)
    assert.ok(entry.reason && entry.reason.length > 40, `allowlist entry needs a substantive reason: ${key}`)
    assert.match(entry.reviewBy, /^\d{4}-\d{2}-\d{2}$/, `allowlist entry needs a review date: ${key}`)
  }
  assert.equal(severityRank('moderate'), 2)
  assert.equal(severityRank('high'), 3)
  assert.ok(severityRank('unknown') > severityRank('critical'))
  const findings = collectFindings({
    vulnerabilities: {
      demo: {
        severity: 'high',
        via: [{ severity: 'high', title: 'demo', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }]
      }
    }
  })
  assert.deepEqual(findings, [{
    name: 'demo',
    severity: 'high',
    title: 'demo',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc'
  }])
})

test('native runtime and build dependencies stay on audited versions', () => {
  // 0.35.4 patches the libheif advisories (GHSA-rgj7-g3m4-5g8c) that fail the
  // moderate audit gate; it is a patch bump inside the previous ^0.35.3 range.
  assert.equal(packageJson.dependencies.sharp, '0.35.4')
  assert.equal(packageJson.devDependencies['@electron/rebuild'], '4.2.0')
  assert.equal(packageJson.devDependencies['onnxruntime-node'], '1.27.0')
  // 0.6.1 is the first version outside both adm-zip advisory ranges
  // (GHSA-vwc7-r8mq-g2x9 <=0.6.0 and GHSA-7q85-xj36-vmfc <0.6.1).
  assert.equal(packageJson.overrides['onnxruntime-node']['adm-zip'], '0.6.1')

  assertMinimumVersion('adm-zip', '0.6.1')
  assertMinimumVersion('brace-expansion', '1.1.18')
  assertMinimumVersion('fast-uri', '3.1.7')
  assertMinimumVersion('js-yaml', '4.3.2')
  assertMinimumVersion('tar', '7.5.21')
  assertMinimumVersion('undici', '6.28.0')
  assertMinimumVersion('@xmldom/xmldom', '0.8.15')
})

// The Electron shell is the one dependency whose advisories move the audit gate
// on their own schedule: upstream publishes against whatever 43.x we happen to
// pin, and each one needs a specific patch version. Pinning the floor here means
// a rollback to an older 43.x fails a plain unit test instead of only turning CI
// red at the audit step. 43.8.1 is the floor set by GHSA-jr5w-w6x2-84p9, the TLS
// advisory npm cannot see (repository-only, absent from the bulk endpoint);
// 43.7.0 by GHSA-fw47-9c62-h3vw, and 43.4.1/43.5.0 by the four sandbox ones.
test('the Electron shell stays above every 43.x advisory floor', () => {
  assert.equal(packageJson.devDependencies.electron, '43.8.3')
  assertMinimumVersion('electron', '43.8.1')
})
