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
  assert.ok(ALLOWLIST.size > 0, 'the audit gate must carry a reviewable allowlist')
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
  assert.equal(packageJson.overrides['onnxruntime-node']['adm-zip'], '0.6.0')

  assertMinimumVersion('adm-zip', '0.6.0')
  assertMinimumVersion('brace-expansion', '1.1.18')
  assertMinimumVersion('fast-uri', '3.1.7')
  assertMinimumVersion('js-yaml', '4.3.2')
  assertMinimumVersion('tar', '7.5.21')
  assertMinimumVersion('undici', '6.28.0')
  assertMinimumVersion('@xmldom/xmldom', '0.8.15')
})
